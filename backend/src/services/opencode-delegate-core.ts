/**
 * opencode-delegate-core.ts
 * Madar — Pure rules for delegating a task to an opencode subagent from the
 * project page. Import-free on purpose (node --test loads it directly,
 * mirroring serve-core.ts / janitor-core.ts / snapshots-schedule.ts): no
 * fs/dockerode imports, just plain types + pure functions, so the capability
 * classification, prompt-budget and id rules are deterministically
 * unit-testable without a container.
 */

/** HTTP error with a status code — mirrors serve-core's local HttpError
 * (kept here so this module stays import-free). The route layer maps it to
 * the response. */
export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

export type DelegateCapability = 'readonly' | 'write';

/** Hard ceiling on a single delegation prompt (chars). */
export const DELEGATE_PROMPT_MAX = 20_000;

/** Hard ceiling on stored delegation entries per project. */
export const DELEGATIONS_MAX_ENTRIES = 20;

/**
 * Classify an agent's capability from its live frontmatter.
 * Safe by default (fail-closed): 'readonly' requires BOTH `edit: deny` AND
 * `bash: deny` under the agent's `permission:` block — a bash-capable agent
 * (even with edits denied) can execute root commands inside the container,
 * so it is a WRITER and stays editor-gated. Every other agent (no permission
 * block, an allow for either tool, a deny for an unknown/future tool, or a
 * deny in a place opencode would not honor) is treated as a WRITER so any
 * executable surface can never sneak past the editor gate as 'readonly'.
 */
export function agentCapability(frontmatter: string): DelegateCapability {
  const fm = String(frontmatter ?? '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fm);
  const body = m ? m[1] : fm;
  let editDenied = false;
  let bashDenied = false;
  const lines = body.split('\n');
  let inPermission = false;
  for (const rawLine of lines) {
    if (!inPermission) {
      // opencode also accepts the flow form `permission: {edit: deny, …}`.
      const flow = /^permission:[ \t]*\{([^}]*)\}[ \t]*$/i.exec(rawLine.trim());
      if (flow) {
        const inner = flow[1];
        const edit = /edit:[ \t]*(deny|false|no)/i.test(inner);
        const bash = /bash:[ \t]*(deny|false|no)/i.test(inner);
        // An explicit allow of either tool defeats the readonly claim.
        if (/edit:[ \t]*(allow|true|yes)/i.test(inner) || /bash:[ \t]*(allow|true|yes)/i.test(inner)) {
          return 'write';
        }
        return edit && bash ? 'readonly' : 'write';
      }
      if (/^permission:[ \t]*$/.test(rawLine)) {
        inPermission = true;
      }
      continue;
    }
    // An unindented non-empty line ends the permission block.
    if (/^\S/.test(rawLine) && rawLine.trim()) {
      inPermission = false;
      continue;
    }
    const trimmed = rawLine.trim();
    if (/^edit:[ \t]*(deny|false|no)\b/.test(trimmed)) editDenied = true;
    else if (/^bash:[ \t]*(deny|false|no)\b/.test(trimmed)) bashDenied = true;
    else if (/^edit:[ \t]*(allow|true|yes)\b/.test(trimmed)) editDenied = false;
    else if (/^bash:[ \t]*(allow|true|yes)\b/.test(trimmed)) bashDenied = false;
    // A deny of any OTHER tool is a future executable surface — it can never
    // grant readonly on its own; the block stays write (fail-closed).
  }
  return editDenied && bashDenied ? 'readonly' : 'write';
}

/**
 * Trim + hard-cap a delegation prompt. Empty/null/junk input is rejected
 * with a 400-style HttpError; oversized prompts are truncated, not dropped.
 */
export function sanitizeDelegatePrompt(text: unknown): string {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) throw new HttpError(400, 'Prompt is required');
  return s.slice(0, DELEGATE_PROMPT_MAX);
}

const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Validate a delegation agent name (kebab-case, roster-style). */
export function validAgentName(name: unknown): boolean {
  return typeof name === 'string' && AGENT_NAME_RE.test(name);
}

/**
 * Template selection by agent-name keyword (review / test / debug / plan),
 * falling back to a generic task template. The agent's own authored prompt
 * wins on specifics — these only shape the default working mode when the
 * user's prompt does not.
 */
function templateForAgent(agent: string): string {
  const a = agent.toLowerCase();
  if (/(review|auditor|audit)/.test(a)) {
    return DELEGATE_PROMPT_TEMPLATES.review;
  }
  if (a.includes('test')) return DELEGATE_PROMPT_TEMPLATES.test;
  if (a.includes('debug')) return DELEGATE_PROMPT_TEMPLATES.debug;
  if (/(architect|plan)/.test(a)) return DELEGATE_PROMPT_TEMPLATES.plan;
  return DELEGATE_PROMPT_TEMPLATES.generic;
}

export const DELEGATE_PROMPT_TEMPLATES = {
  review: `Working mode: audit the relevant code, then report concrete findings (severity + file:line references). Prefer suggestions over applying changes.`,
  test: `Working mode: cover the behavior with tests where they are missing. Follow the repository's existing test conventions; verify your work runs before finishing.`,
  debug: `Working mode: diagnose the reported problem first (root cause before fix), reproduce if possible, then apply the minimal fix and re-verify.`,
  plan: `Working mode: produce a concrete, file-level plan (steps, order, risks) grounded in the repository's actual structure — do not name files that do not exist.`,
  generic: `Working mode: complete the task in the repository's established conventions. Verify your work (type-check/build/tests) where applicable before reporting.`,
} as const;

/**
 * Wrap a user prompt into a full delegation message: force the agent to read
 * the project charter + planning-board mirror FIRST (so Madar's WSD_PROJECT.md
 * and the WSD_CANVAS.md board drive agent work), then the task, then a
 * per-agent working-mode default.
 */
export function buildDelegatePrompt(
  slug: string,
  projectName: string | undefined,
  agent: string,
  prompt: string,
): string {
  const safeName = String(projectName || slug).slice(0, 200);
  const safeSlug = String(slug ?? '').slice(0, 64);
  return [
    `You are working inside the project "${safeName}" (slug "${safeSlug}").`,
    ``,
    `## Preparation (mandatory)`,
    `1. Read /workspace/WSD_PROJECT.md — the project's goals, architecture and working rules.`,
    `2. If /workspace/WSD_CANVAS.md exists, read it — the current planning board mirror.`,
    `3. Inspect the workspace layout (top-level files + entry points) before acting.`,
    ``,
    `## Task`,
    prompt,
    ``,
    templateForAgent(agent),
  ].join('\n');
}

/** Stable-ish unique delegation id — `d-<rand6>-<rand6>` (activity-style). */
export function delegateEntryId(): string {
  return `d-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}-${Math.random()
    .toString(36)
    .slice(2, 8)
    .padEnd(6, '0')}`;
}

/**
 * Prune a delegation list to its `max` NEWEST entries, oldest→newest order
 * preserved (mirrors capActivity / appendActivity in activity-core).
 */
export function capDelegations<T extends { id: string }>(entries: T[] | null | undefined, max: number = DELEGATIONS_MAX_ENTRIES): T[] {
  const list = Array.isArray(entries) ? entries : [];
  const cap = Math.trunc(Number.isFinite(max) ? max : DELEGATIONS_MAX_ENTRIES);
  if (cap <= 0) return [];
  return list.slice(-Math.min(cap, list.length));
}