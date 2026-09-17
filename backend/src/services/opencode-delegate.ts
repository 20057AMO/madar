/**
 * opencode-delegate.ts
 * Madar — "Run an opencode subagent on my project" orchestration.
 *
 * The user picks a roster agent and types a prompt from the project page; the
 * service creates a fresh opencode web session on the project's workspace,
 * switches it to the named agent (agent/model in the prompt body are ignored
 * by opencode), sends the prompt and polls the history until the step ends —
 * all through the unified facade in opencode-api.ts. A restricted CLI fallback
 * (editor+ write-capable agents only, explicit opt-in flag, attached to the
 * REAL named-agent session — it never creates a base-agent `--session new`)
 * rescues the case where the session path fails; it NEVER uses `--agent`
 * (that bypasses permission denies).
 *
 * Security posture:
 *  - Capability classification from LIVE agent frontmatter (`edit: deny` AND
 *    `bash: deny` → readonly; any bash-capable agent is a writer). Readonly
 *    agents run for viewer+; write agents require editor+ via
 *    checkProjectAccess — enforced HERE, not in the router.
 *  - Singleflight per project slug (409 on overlap), double-checked AFTER the
 *    probe so no await gap lets parallel requests both insert; global cap.
 *  - Forced run timeout (WSD_DELEGATE_TIMEOUT_MS, default 5 min) via an
 *    AbortController wired into every facade fetch.
 *  - History persists per project (opencode-delegate-store) + activity feed
 *    (`agent_run`) + audit entries.
 */
import path from 'path';

import { HttpError } from './opencode-delegate-core';
import {
  agentCapability,
  buildDelegatePrompt,
  sanitizeDelegatePrompt,
  validAgentName,
  type DelegateCapability,
} from './opencode-delegate-core';
import {
  cliDelegate,
  probeOpencodeServer,
  v1CollectResult,
  v1CreateSessionId,
  v1SendMessage,
  type CollectResult,
} from './opencode-api';
import { getAgent } from './opencode-studio';
import { checkProjectAccess } from '../middleware/auth';
import { loadMeta } from './projects-meta';
import { recordActivity } from './project-activity';
import { recordAudit } from './audit-store';
import {
  appendDelegation,
  updateDelegation,
  deleteDelegation,
  getDelegation,
  listDelegations,
  type DelegationEntry,
} from './opencode-delegate-store';
import type { UserRole } from './user-store';

const WORKSPACES_ROOT = process.env.WSD_PROJECTS_DIR || '/workspaces';

/** Global cap on concurrently-running agent tasks across ALL projects. */
export const MAX_CONCURRENT = 2;

/** Per-run forced timeout (ms) — env-overridable, 5 min default. */
const TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.WSD_DELEGATE_TIMEOUT_MS) || 300_000,
);

export interface DelegationUser {
  id: string;
  username: string;
  role: UserRole;
}

export interface StartDelegationOptions {
  /** Explicit flag: allow the CLI fallback when the session path fails. */
  allowCliFallback: boolean;
  /** Client IP for auditing. */
  ip?: string;
}

export interface StartDelegationResult {
  id: string;
  agent: string;
  capability: DelegateCapability;
  status: 'running';
  createdAt: string;
}

export interface DelegationActiveState {
  state: 'running';
  entryId: string;
  agent: string;
  startedAt: string;
  tail: string[];
}

export interface DelegationIdleState {
  state: 'idle';
}

interface ActiveTask {
  slug: string;
  entryId: string;
  agent: string;
  capability: DelegateCapability;
  startedAt: string;
  tail: string[];
  controller: AbortController;
  timer: NodeJS.Timeout;
}

const activeTasks = new Map<string, ActiveTask>();

function lastLines(text: string, n: number): string[] {
  return String(text ?? '')
    .split('\n')
    .map((l) => l.trimEnd())
    .slice(-n);
}

/** Always-create a fresh session id for a workspace dir via the facade. */
async function createSession(workspaceDir: string): Promise<string | null> {
  return v1CreateSessionId(workspaceDir);
}

/**
 * Launch a delegation and return immediately — the run happens in the
 * background and its result lands in the per-project store + activity feed.
 * Errors surface synchronously (400/403/404/409/429/503).
 */
export async function startDelegation(
  slug: string,
  input: { agent?: unknown; prompt?: unknown },
  user: DelegationUser,
  opts: StartDelegationOptions,
): Promise<StartDelegationResult> {
  const clean = String(slug ?? '').replace(/[^a-z0-9._-]+/gi, '').slice(0, 64);
  if (!clean || clean === '.' || clean === '..') {
    throw new HttpError(404, 'Project not found');
  }
  if (!loadMeta(clean)) throw new HttpError(404, 'Project not found');

  const prompt = sanitizeDelegatePrompt(input.prompt);

  const agentName = typeof input.agent === 'string' ? input.agent.trim() : '';
  if (!validAgentName(agentName)) {
    throw new HttpError(404, `Agent '${agentName || '(empty)'}' not found`);
  }

  // Live roster + live frontmatter — the capability is classified from what
  // opencode will actually load, so an editor edit is reflected immediately.
  let agentContent: string;
  try {
    agentContent = getAgent(agentName).content;
  } catch {
    throw new HttpError(404, `Agent '${agentName}' not found`);
  }
  const capability = agentCapability(agentContent);

  // Capability-gated project access — HERE, not in the router.
  const { allowed } = checkProjectAccess(
    user.id,
    user.role,
    clean,
    capability === 'readonly' ? 'viewer' : 'editor',
  );
  if (!allowed) {
    throw new HttpError(403, 'Access denied to this project');
  }

  const probe = await probeOpencodeServer();
  if (!probe.ok) {
    throw new HttpError(503, 'opencode_offline');
  }

  // Singleflight, double-checked AFTER the probe — the probe is the last
  // await before the insertion, so the checks below and `activeTasks.set()`
  // form one atomic section (no await between them): two parallel requests
  // that both passed the pre-probe state can never both insert for the same
  // project (TOCTOU-safe).
  if (activeTasks.has(clean)) {
    throw new HttpError(409, 'An agent task is already running for this project');
  }
  if (activeTasks.size >= MAX_CONCURRENT) {
    throw new HttpError(429, `Too many concurrent agent tasks (max ${MAX_CONCURRENT})`);
  }

  const meta = loadMeta(clean);
  const entry: DelegationEntry = {
    id: `d-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}-${Math.random()
      .toString(36)
      .slice(2, 8)
      .padEnd(6, '0')}`,
    agent: agentName,
    capability,
    prompt,
    status: 'running',
    createdAt: new Date().toISOString(),
    userId: user.id,
    actorName: user.username,
  };
  appendDelegation(clean, entry);

  recordActivity(clean, 'agent_run', {
    userId: user.id,
    actorName: user.username,
    details: { agent: agentName, status: 'started' },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const task: ActiveTask = {
    slug: clean,
    entryId: entry.id,
    agent: agentName,
    capability,
    startedAt: entry.createdAt,
    tail: [],
    controller,
    timer,
  };
  activeTasks.set(clean, task);

  void runDelegation(clean, entry.id, user, opts, capability, agentName, prompt, task);

  return { id: entry.id, agent: agentName, capability, status: 'running', createdAt: entry.createdAt };
}

async function runDelegation(
  slug: string,
  entryId: string,
  user: DelegationUser,
  opts: StartDelegationOptions,
  capability: DelegateCapability,
  agentName: string,
  prompt: string,
  task: ActiveTask,
): Promise<void> {
  const startedAt = Date.now();
  const workspaceDir = path.join(WORKSPACES_ROOT, slug);
  const meta = loadMeta(slug);
  const message = buildDelegatePrompt(slug, meta?.name, agentName, prompt);
  const remaining = () => Math.max(1000, TIMEOUT_MS - (Date.now() - startedAt));

  // CLI fallback is the RESCUE path (session web API down): restricted to
  // write-capable agents (which already implies editor+ access) via the
  // explicit allowCliFallback flag, and NEVER uses `--agent` — that flag
  // bypasses the agent's permission denies. A fallback only fires when the
  // message was NOT yet admitted, so a delegate never runs twice. It attaches
  // to the REAL session passed in (already switched to the named agent) —
  // `opencode run --session new` would create a BASE-agent session with full
  // permissions, silently bypassing the named agent's constraints, so the
  // fallback refuses to run without a real session.
  const tryCli = (sessionId: string | null): Promise<string> => {
    if (!opts.allowCliFallback || capability !== 'write' || !sessionId) {
      throw new Error('opencode session unavailable');
    }
    return cliDelegate(message, sessionId, workspaceDir, remaining()).catch((e: Error) => {
      throw new Error(`CLI fallback failed: ${e.message}`);
    });
  };

  const finish = (status: 'done' | 'failed', extra: Partial<DelegationEntry>) => {
    const durationMs = Date.now() - startedAt;
    updateDelegation(slug, entryId, {
      status,
      finishedAt: new Date().toISOString(),
      durationMs,
      ...extra,
    });
    recordActivity(slug, 'agent_run', {
      userId: user.id,
      actorName: user.username,
      details: { agent: agentName, ok: status === 'done' ? 1 : 0, durationMs },
    });
    recordAudit(
      status === 'done' ? 'agent-run' : 'agent-run-failed',
      status === 'done',
      opts.ip,
      user.id,
    );
  };

  try {
    let sessionId: string | null = null;
    try {
      sessionId = await createSession(workspaceDir);
    } catch {
      sessionId = null;
    }
    if (!sessionId) {
      // No session was ever created — the CLI fallback cannot attach to the
      // named agent (`--session new` would run as the BASE agent with full
      // permissions beyond what the writer agent's constraints allow), so the
      // run fails closed instead of silently escalating.
      throw new Error('opencode session unavailable');
    }

    let admittedSeq: number | null = null;
    try {
      admittedSeq = await v1SendMessage(sessionId, message, agentName, task.controller.signal);
    } catch {
      admittedSeq = null;
    }
    if (admittedSeq === null) {
      // The message never ran — rescue via CLI attached to the SAME session,
      // which is already switched to the named agent. A fresh `--session new`
      // would run as the base agent with full permissions, so the real id is
      // the only admissible fallback target.
      const text = await tryCli(sessionId);
      task.tail = lastLines(text, 30);
      finish('done', { result: { text } });
      return;
    }

    const result = await v1CollectResult(sessionId, admittedSeq, remaining(), task.controller.signal, (acc) => {
      task.tail = lastLines(acc.text, 30);
    });

    // Distinguish a run that NEVER started from one that merely overran. A
    // CLI wake-up for the stalled case was considered and rejected: the
    // prompt was already admitted server-side, so re-running would double
    // the execution — the honest outcome is a precise failure instead.
    const timeoutError = result.started
      ? 'Timed out waiting for the agent'
      : 'opencode did not start (drain stalled)';

    if (task.controller.signal.aborted) {
      // Forced timeout — the agent WAS admitted and may still be working,
      // so no CLI rerun (would double-run). Persist the partial text.
      task.tail = lastLines(result.text || task.tail.join('\n'), 30);
      finish('failed', {
        error: timeoutError,
        ...(result.text ? { result: { text: result.text, agent: result.agent, model: result.model, finish: result.finish } } : {}),
      });
      return;
    }
    if (!result.ended) {
      finish('failed', {
        error: timeoutError,
        ...(result.text ? { result: { text: result.text, agent: result.agent, model: result.model, finish: result.finish } } : {}),
      });
      return;
    }

    task.tail = lastLines(result.text, 30);
    finish('done', {
      result: {
        text: result.text,
        ...(result.agent ? { agent: result.agent } : {}),
        ...(result.model ? { model: result.model } : {}),
        ...(result.finish ? { finish: result.finish } : {}),
        ...(result.cost !== null && result.cost !== undefined ? { cost: result.cost } : {}),
        ...(result.tokens !== null && result.tokens !== undefined ? { tokens: result.tokens } : {}),
        ...(result.files?.length ? { files: result.files } : {}),
      },
    });
  } catch (err: any) {
    task.tail = lastLines(task.tail.join('\n'), 30);
    finish('failed', {
      error: String(err?.message || 'Agent task failed').slice(0, 1000),
    });
  } finally {
    clearTimeout(task.timer);
    activeTasks.delete(slug);
  }
}

/** Live state of the project's active task (or idle). */
export function getDelegationState(slug: string): DelegationActiveState | DelegationIdleState {
  const task = activeTasks.get(String(slug ?? '').replace(/[^a-z0-9._-]+/gi, '').slice(0, 64));
  if (!task) return { state: 'idle' };
  return {
    state: 'running',
    entryId: task.entryId,
    agent: task.agent,
    startedAt: task.startedAt,
    tail: task.tail.slice(-30),
  };
}

export { listDelegations, getDelegation, deleteDelegation };
export type { DelegationEntry };

export { HttpError };