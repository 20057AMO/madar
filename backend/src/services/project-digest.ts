/**
 * project-digest.ts
 * Madar — Scheduled project-intelligence digest orchestration.
 *
 * The pure rules (interval/parse/signature/prompt) live in digest-core.ts; the
 * durable history lives in project-digest-store.ts. This module wires them to
 * the real project meta store, the AI context builders and the streaming chat
 * engine, and runs the background sweep that turns a due schedule into a
 * generated digest.
 *
 * Contract notes:
 *   - `runDigest` AWAITS its run and resolves the final DigestEntry; the sweep
 *     uses it and counts generations.
 *   - `startDigest` runs the same synchronous preflight gates but returns the
 *     fresh `running` entry immediately, finishing the generation in the
 *     background — the shape the POST route needs for an instant 201.
 *   - The router/boot wiring (routes + startDigestAutomation) lives in index.ts;
 *     this file only exposes the callable surface.
 */
import fs from 'fs';
import path from 'path';

import {
  HttpError,
  DEFAULT_DIGEST_CONFIG,
  sanitizeDigestConfig,
  computeDueDigests,
  buildDigestPrompt,
  parseDigestOutput,
  buildDigestSourceSignature,
  hasDigestSignal,
  digestEntryId,
  safeDigestErrorLabel,
  type DigestConfig,
  type DigestSourceParts,
  type ParsedDigest,
} from './digest-core';
import type { ChatMessage, StreamHandlers, RunControl } from './chat-types';
import { streamChat } from './ollama-chat';
import { getChatConfig, buildSystemPrompt, type ChatConfig } from './chat-config';
import { getProviderMeta } from './provider-store';
import { canonicalProjectSlug } from './project-slug-core';
import { loadMeta, updateMeta, listMetaSlugs, type ProjectMeta } from './projects-meta';
import { getUserInfo } from './user-store';
import { recordActivity, listActivity, loadActivity } from './project-activity';
import { formatNotesForContext, notesSignature } from './project-notes';
import { formatCanvasForContext, canvasSignature } from './project-canvas';
import { getProjectContext, safeWorkspaceDir, IGNORED_DIRS } from './project-context';
import { resolveContainedPath } from './workspace-paths-core';
import {
  listDigests as storeListDigests,
  getDigest as storeGetDigest,
  deleteDigest as storeDeleteDigest,
  appendDigest,
  updateDigest,
  reconcileRunningDigests,
  type DigestEntry,
  type DigestTrigger,
} from './project-digest-store';

const WORKSPACES_ROOT = process.env.WSD_PROJECTS_DIR || '/workspaces';

/** Global cap on concurrent digest runs across all projects. */
export const MAX_CONCURRENT = 2;

const TIMEOUT_MS = Math.max(10_000, Number(process.env.WSD_DIGEST_TIMEOUT_MS) || 120_000);
const SWEEP_MS = Math.max(10_000, Number(process.env.WSD_DIGEST_SWEEP_MS) || 5 * 60_000);

const SIGNATURE_FILE_CAP = 5000;
const ACTIVITY_CONTEXT_LIMIT = 30;

export type { DigestEntry, DigestTrigger } from './project-digest-store';

export interface DigestConfigView extends DigestConfig {
  lastDigestAt: string | null;
}

/**
 * Injectable seam (mirrors chat-team-bot's TeamChatBotDeps): the real module
 * uses the real streaming engine / provider probe / clock; tests can inject a
 * fake. Pass null to restore the production defaults.
 */
export interface DigestEngine {
  stream?: typeof streamChat;
  hasProvider?: () => boolean;
  now?: () => number;
}
let engineOverride: DigestEngine | null = null;
export function setDigestEngine(engine: DigestEngine | null): void {
  engineOverride = engine;
}

function engineStream(): typeof streamChat {
  return engineOverride?.stream || streamChat;
}

function now(): number {
  return engineOverride?.now ? engineOverride.now() : Date.now();
}

/**
 * A provider that could actually answer: the one chat-config RESOLVES to must
 * be enabled AND (has a key OR is ollama — local ollama is legitimately
 * keyless). Mirrors chat-team-bot.hasUsableProvider.
 */
export function hasUsableProvider(): boolean {
  if (engineOverride?.hasProvider) return engineOverride.hasProvider();
  const p = getProviderMeta(getChatConfig().provider);
  return !!p && p.enabled && (p.apiKeyMasked !== '' || p.type === 'ollama');
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Current digest config for a project (defaults when unset). */
export function getDigestConfig(slug: unknown): DigestConfigView {
  const clean = canonicalProjectSlug(slug);
  const meta = clean ? loadMeta(clean) : null;
  const cfg = sanitizeDigestConfig((meta?.digest ?? null) as Record<string, unknown> | null, DEFAULT_DIGEST_CONFIG);
  return { ...cfg, lastDigestAt: meta?.lastDigestAt || null };
}

/**
 * Merge + persist a digest config. Only validated fields are applied (junk
 * falls back to the previous value). Enabling (or shortening the interval)
 * schedules an immediate sweep so the first digest lands promptly.
 */
export function setDigestConfig(
  slug: unknown,
  input: Record<string, unknown>,
  userId?: string,
): DigestConfigView {
  const clean = canonicalProjectSlug(slug);
  if (!clean) throw new HttpError(404, 'Project not found');
  const existing = loadMeta(clean);
  if (!existing) throw new HttpError(404, 'Project not found');

  const prev = sanitizeDigestConfig((existing.digest ?? null) as Record<string, unknown> | null, DEFAULT_DIGEST_CONFIG);
  const next = sanitizeDigestConfig(input ?? {}, prev);

  const saved = updateMeta(clean, (m) => {
    m.digest = next;
  });

  recordActivity(clean, 'digest_config', {
    userId,
    details: { enabled: next.enabled ? 1 : 0, intervalMin: next.intervalMin },
  });

  if (next.enabled) scheduleDigestSweep();

  return { enabled: next.enabled, intervalMin: next.intervalMin, lastDigestAt: saved.lastDigestAt || null };
}

// ---------------------------------------------------------------------------
// History (thin wrappers over the store, folding the slug + recording deletes)
// ---------------------------------------------------------------------------

export function listDigests(
  slug: unknown,
  opts: { limit?: number; offset?: number } = {},
): { entries: DigestEntry[]; total: number } {
  const clean = canonicalProjectSlug(slug);
  if (!clean) return { entries: [], total: 0 };
  return storeListDigests(clean, opts);
}

export function getDigest(slug: unknown, id: unknown): DigestEntry | undefined {
  const clean = canonicalProjectSlug(slug);
  if (!clean) return undefined;
  return storeGetDigest(clean, id);
}

export function deleteDigest(slug: unknown, id: unknown, userId?: string): boolean {
  const clean = canonicalProjectSlug(slug);
  if (!clean || typeof id !== 'string' || !id) return false;
  const removed = storeDeleteDigest(clean, id);
  if (removed) recordActivity(clean, 'digest_deleted', { userId, details: { id } });
  return removed;
}

export { reconcileRunningDigests };

// ---------------------------------------------------------------------------
// Source assembly (for the prompt + the change signature)
// ---------------------------------------------------------------------------

/** `mtimeMs:size` of the project's WSD_PROJECT.md (goals) — '' when absent. */
function goalsSignature(clean: string): string {
  try {
    const p = resolveContainedPath(WORKSPACES_ROOT, clean, 'WSD_PROJECT.md', { mustExist: true });
    const st = fs.statSync(p);
    return `${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    return '';
  }
}

/** Bounded recursive file count over the workspace (links and ignored dirs skipped). */
function countWorkspaceFiles(clean: string, cap: number = SIGNATURE_FILE_CAP): number {
  let base: string;
  try {
    base = safeWorkspaceDir(clean);
  } catch {
    return 0;
  }
  let count = 0;
  const stack: string[] = [base];
  try {
    while (stack.length && count < cap) {
      const dir = stack.pop() as string;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (count >= cap) break;
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if (!IGNORED_DIRS.has(e.name)) stack.push(path.join(dir, e.name));
        } else if (e.isFile()) {
          count++;
        }
      }
    }
  } catch {
    /* best-effort */
  }
  return count;
}

/** The change-detector parts for a project (equal inputs ⇒ equal signature). */
function collectSourceParts(clean: string): DigestSourceParts & {
  notesSignature: string;
  canvasSignature: string;
  activityLastAt: string;
  goalsMtime: string;
  fileCount: number;
} {
  let activityLastAt = '';
  try {
    const feed = loadActivity(clean);
    if (feed.length) activityLastAt = String(feed[feed.length - 1]?.at || '');
  } catch {
    /* best-effort */
  }
  let notesSig = '';
  try {
    notesSig = notesSignature(clean);
  } catch {
    /* best-effort */
  }
  let canvasSig = '';
  try {
    canvasSig = canvasSignature(clean);
  } catch {
    /* best-effort */
  }
  return {
    notesSignature: notesSig,
    canvasSignature: canvasSig,
    activityLastAt,
    goalsMtime: goalsSignature(clean),
    fileCount: countWorkspaceFiles(clean),
  };
}

/** Recent activity rendered as flat lines for the digest prompt. */
function renderActivity(clean: string): string {
  try {
    const { entries } = listActivity(clean, { limit: ACTIVITY_CONTEXT_LIMIT });
    if (!entries.length) return '';
    return [...entries]
      .reverse()
      .map((e) => {
        const who = e.actorName || e.userId || 'system';
        const detail = e.details ? ` ${JSON.stringify(e.details)}` : '';
        return `- ${e.at} ${who}: ${e.action}${detail}`;
      })
      .join('\n');
  } catch {
    return '';
  }
}

/** Best-effort project context text (files/goals/notes/canvas block). */
async function contextText(clean: string): Promise<string> {
  try {
    const ctx = await getProjectContext(clean);
    return ctx?.text || '';
  } catch {
    return '';
  }
}

function stampLastDigestAt(clean: string): void {
  try {
    updateMeta(clean, (m) => {
      m.lastDigestAt = new Date().toISOString();
    });
  } catch {
    /* best-effort — a missing stamp only affects the sweep cadence */
  }
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const activeDigests = new Set<string>();

export interface RunDigestOptions {
  trigger: DigestTrigger;
  userId?: string;
}

/**
 * Preflight gates shared by runDigest (awaits) and startDigest (fire-and-forget).
 * Synchronous on purpose: there is no `await` between a gate passing and
 * `beginDigest` claiming the slot, so an interleaved second request can never
 * race the singleflight.
 *
 * Throws (nothing persisted):
 *   404 Project not found      unknown/empty slug
 *   409 Digest already running  singleflight per project
 *   429 Too many digests running  global MAX_CONCURRENT
 *   503 provider_unavailable    no usable provider configured
 */
function digestPreflight(slug: unknown): { clean: string; meta: ProjectMeta } {
  const clean = canonicalProjectSlug(slug);
  if (!clean) throw new HttpError(404, 'Project not found');
  const meta = loadMeta(clean);
  if (!meta) throw new HttpError(404, 'Project not found');

  if (activeDigests.has(clean)) throw new HttpError(409, 'Digest already running');
  if (activeDigests.size >= MAX_CONCURRENT) throw new HttpError(429, 'Too many digests running');
  if (!hasUsableProvider()) throw new HttpError(503, 'provider_unavailable');
  return { clean, meta };
}

/** Append the `running` row and claim the per-project singleflight slot. */
function beginDigest(clean: string, opts: RunDigestOptions): { entry: DigestEntry; chat: ChatConfig } {
  const chat = getChatConfig();
  const actorName = opts.userId ? getUserInfo(opts.userId)?.username : undefined;

  const entry: DigestEntry = {
    id: digestEntryId(),
    createdAt: new Date().toISOString(),
    trigger: opts.trigger,
    status: 'running',
    summary: '',
    blockers: [],
    nextSteps: [],
    provider: chat.provider,
    model: chat.model,
    ...(opts.userId ? { userId: opts.userId } : {}),
    ...(actorName ? { actorName } : {}),
  };
  appendDigest(clean, entry);
  activeDigests.add(clean);
  return { entry, chat };
}

/**
 * The generation body shared by both entry points. Never throws for a
 * generation failure — it is recorded as a `failed` row on the same entry and
 * the singleflight slot is always released in `finally`.
 */
async function generateDigest(
  clean: string,
  meta: ProjectMeta,
  entry: DigestEntry,
  opts: RunDigestOptions,
  chat: ChatConfig,
): Promise<DigestEntry> {
  const provider = chat.provider;
  const model = chat.model;
  const startedAt = now();
  try {
    const parts = collectSourceParts(clean);
    const signature = buildDigestSourceSignature(parts);
    const files = await contextText(clean);
    const prompt = buildDigestPrompt({
      slug: clean,
      name: meta.name || clean,
      goals: null,
      notes: formatNotesForContext(clean),
      canvas: formatCanvasForContext(clean),
      activity: renderActivity(clean),
      files,
    });

    let timedOut = false;
    const control: RunControl = { cancelled: false, abort: null };
    const handlers: StreamHandlers = { onDelta: () => {}, onDone: () => {}, onError: () => {} };
    const timer = setTimeout(() => {
      timedOut = true;
      control.cancelled = true;
      try {
        control.abort?.();
      } catch {
        /* ignore */
      }
    }, TIMEOUT_MS);

    let text = '';
    try {
      text = await engineStream()([{ role: 'user', content: prompt }] as ChatMessage[], handlers, control, {
        system: buildSystemPrompt(chat),
        provider,
        model,
      });
    } catch (err: any) {
      if (timedOut) throw new Error('Digest generation timed out');
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }

    if (!text || !text.trim()) throw new Error('Digest model returned no output');

    const parsed: ParsedDigest = parseDigestOutput(text);
    const finishedAt = new Date().toISOString();
    const durationMs = now() - startedAt;
    const updated = updateDigest(clean, entry.id, {
      status: 'done',
      finishedAt,
      durationMs,
      summary: parsed.summary,
      blockers: parsed.blockers,
      nextSteps: parsed.nextSteps,
      sourceSignature: signature,
      provider,
      model,
    });
    const ok = updated?.status === 'done';
    if (ok) stampLastDigestAt(clean);
    recordActivity(clean, 'digest_generated', {
      userId: opts.userId,
      details: { trigger: opts.trigger, ok: ok ? 1 : 0, durationMs },
    });
    return updated || entry;
  } catch (err: any) {
    const finishedAt = new Date().toISOString();
    const durationMs = now() - startedAt;
    // Never persist the raw message — an upstream failure can echo the
    // provider/proxy response body (or request context). A fixed label keeps
    // the API's non-empty `error` contract without leaking anything.
    const message = safeDigestErrorLabel(err);
    const updated = updateDigest(clean, entry.id, {
      status: 'failed',
      finishedAt,
      durationMs,
      error: message,
    });
    recordActivity(clean, 'digest_generated', {
      userId: opts.userId,
      details: { trigger: opts.trigger, ok: 0, durationMs },
    });
    return updated || { ...entry, status: 'failed', finishedAt, durationMs, error: message };
  } finally {
    activeDigests.delete(clean);
  }
}

/**
 * Run one digest end-to-end and resolve the final entry (used by the sweep,
 * which wants to await completion and count generations).
 *
 * Throws the preflight gates (404/409/429/503) synchronously; never throws for a
 * generation failure — that is recorded as a `failed` row.
 */
export async function runDigest(slug: unknown, opts: RunDigestOptions): Promise<DigestEntry> {
  const { clean, meta } = digestPreflight(slug);
  const { entry, chat } = beginDigest(clean, opts);
  return generateDigest(clean, meta, entry, opts, chat);
}

/**
 * Kick off a digest and return the freshly-appended `running` entry immediately
 * so the HTTP route can answer 201 while the model runs in the background. The
 * synchronous preflight gates still throw (404/409/429/503); the generation
 * itself never throws — the background promise updates the SAME entry to
 * `done`/`failed` via the shared generation core.
 */
export function startDigest(slug: unknown, opts: RunDigestOptions): DigestEntry {
  const { clean, meta } = digestPreflight(slug);
  const { entry, chat } = beginDigest(clean, opts);
  void generateDigest(clean, meta, entry, opts, chat).catch((err) => {
    // Defensive only: generateDigest catches engine failures internally and
    // records them on the entry. This guards against a bug in that path so a
    // background rejection can never reach an unhandled-rejection handler.
    console.error(`[digest] background generation crashed for ${clean}: ${safeDigestErrorLabel(err)}`);
  });
  return entry;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let sweeping = false;

/**
 * One sweep pass: generate a digest for every due project whose source has
 * changed since its last digest. A project whose source signature is unchanged
 * skips regeneration but still gets `lastDigestAt` stamped, so the sweep does
 * not re-walk its workspace every pass; a failed or refused generation stamps
 * too, so a persistent failure (or an empty store) backs off to the configured
 * interval instead of retrying every sweep. Re-entrancy-guarded, per-project
 * isolated — a failing project never aborts the sweep. Returns the number of
 * digests generated. Never throws.
 */
export async function runDigestSweep(nowMs: number = now()): Promise<number> {
  if (sweeping) return 0;
  sweeping = true;
  let generated = 0;
  try {
    if (!hasUsableProvider()) return 0;
    const infos = listMetaSlugs().map((slug) => {
      const meta = loadMeta(slug);
      return {
        slug,
        digest: meta?.digest ?? null,
        lastDigestAt: meta?.lastDigestAt ?? null,
      };
    });

    for (const slug of computeDueDigests(infos, nowMs)) {
      try {
        const parts = collectSourceParts(slug);
        const signature = buildDigestSourceSignature(parts);
        if (
          !hasDigestSignal({
            notes: parts.notesSignature,
            canvas: parts.canvasSignature,
            activity: parts.activityLastAt,
            goals: parts.goalsMtime,
            files: parts.fileCount,
          })
        ) {
          // Nothing to summarise. Stamp anyway so an empty store is not
          // re-walked every sweep — the interval then governs the next scan.
          // (No real project reaches this branch: `created`/`digest_config`
          // activity is always present once a schedule exists.)
          stampLastDigestAt(slug);
          continue;
        }
        const latest = storeListDigests(slug, { limit: 1 }).entries[0];
        if (latest?.status === 'done' && latest.sourceSignature && latest.sourceSignature === signature) {
          stampLastDigestAt(slug);
          continue;
        }
        const entry = await runDigest(slug, { trigger: 'schedule' });
        generated++;
        // A generation failure is recorded on the entry (never thrown), so the
        // sweep would otherwise retry a persistently-failing project every pass.
        // Stamp on the failed terminal outcome to back off to the interval.
        if (entry?.status === 'failed') stampLastDigestAt(slug);
      } catch (err: any) {
        // Preflight refusal (409/429/503) or an unexpected error: stamp so a
        // persistent condition backs off to the interval instead of every sweep.
        stampLastDigestAt(slug);
        console.warn(`[digest] generation failed for ${slug}: ${safeDigestErrorLabel(err)}`);
      }
    }
  } finally {
    sweeping = false;
  }
  return generated;
}

let deferTimer: NodeJS.Timeout | null = null;

/** Schedule a one-shot sweep shortly after a schedule flips on. */
export function scheduleDigestSweep(delayMs: number = 5000): void {
  if (deferTimer) clearTimeout(deferTimer);
  deferTimer = setTimeout(() => {
    deferTimer = null;
    void runDigestSweep();
  }, Math.max(500, delayMs));
}

/** Boot entry point: periodic digest sweeps (one deferred pass at boot). */
export function startDigestAutomation(): void {
  const interval = setInterval(() => void runDigestSweep(), SWEEP_MS);
  interval.unref?.();
  console.log(`[Madar] Digest automation: sweep interval ${Math.round(SWEEP_MS / 1000)}s`);
  scheduleDigestSweep();
}
