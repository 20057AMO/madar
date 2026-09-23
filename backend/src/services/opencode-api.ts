import { execFile, execFileSync } from 'child_process';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs';

import { assertAllowedUpdateBase, isStrictPublisherVersion, semverEquals, parseSemver } from './updates-core';
import { bootTimeoutMs } from './code-server-update';

/**
 * Unified opencode integration layer.
 *
 * Every runtime call to opencode (session management, version probing,
 * self-update) goes through here so a future major version only needs new
 * implementations behind the same facade. The SUPPORTED_MAJORS gate drives
 * the Studio update channel: majors we have not adapted are never offered.
 */

const PORT = process.env.WSD_OPENCODE_PORT || '4096';

function baseUrl(): string {
  return process.env.WSD_OPENCODE_URL || `http://localhost:${PORT}`;
}

/** Directory holding the user-level opencode config (agents, skills, json). */
export function opencodeConfigDir(): string {
  return (
    process.env.OPENCODE_CONFIG_DIR ||
    path.join(os.homedir(), '.config', 'opencode')
  );
}

function dataDir(): string {
  return process.env.WSD_DATA_DIR || '/app/data';
}

/** Majors this integration layer is verified against. Extend to unlock v2. */
export const SUPPORTED_MAJORS: number[] = [1];

let cachedMajor: number | null = null;
let cachedVersion: string | null = null;

export interface VersionInfo {
  version: string;
  major: number | null;
  supported: boolean;
}

/**
 * Probe the installed opencode CLI version (`opencode --version`).
 *
 * Non-force calls (status surfaces) degrade to the last-known cached version
 * when the CLI does not answer, so transient hiccups never blank the UI.
 * `force = true` bypasses the cache entirely and reports the honest 'unknown'
 * on failure — boot-verification must never mistake a stale warm cache for a
 * freshly-restarted binary (that produced a FALSE "new version is live" while
 * opencode sat in a crash-loop).
 */
export function probeOpencodeVersion(force = false): Promise<VersionInfo> {
  return new Promise((resolve) => {
    execFile('opencode', ['--version'], { timeout: 8000 }, (err, stdout) => {
      if (!err && stdout.trim()) {
        cachedVersion = stdout.trim();
        const m = /(\d+)\./.exec(cachedVersion);
        if (m) cachedMajor = Number(m[1]);
        resolve({
          version: cachedVersion,
          major: cachedMajor,
          supported: cachedMajor === null ? false : SUPPORTED_MAJORS.includes(cachedMajor),
        });
        return;
      }
      resolve({
        version: force || cachedVersion === null ? 'unknown' : cachedVersion,
        major: cachedMajor,
        supported: cachedMajor === null ? false : SUPPORTED_MAJORS.includes(cachedMajor),
      });
    });
  });
}

// ── Session integration ────────────────────────────────────────────────
// V1 server contract: GET /session?directory=, POST /session?directory=,
// DELETE /session/:id. A future V2 branch replaces these three primitives.

async function v1ListSessions(directory: string): Promise<Array<{ id?: unknown }>> {
  const r = await fetch(`${baseUrl()}/session?directory=${encodeURIComponent(directory)}`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!r.ok) return [];
  const j = await r.json().catch(() => []);
  return Array.isArray(j) ? j : [];
}

async function v1CreateSession(directory: string): Promise<void> {
  await fetch(`${baseUrl()}/session?directory=${encodeURIComponent(directory)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(3000),
  });
}

async function v1DeleteSession(id: string): Promise<void> {
  await fetch(`${baseUrl()}/session/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(3000),
  });
}

/** Create an opencode session for a workspace directory (best-effort). */
export function createOpencodeSession(slug: string): void {
  const directory = path.join(
    process.env.WSD_PROJECTS_DIR || '/workspaces',
    slug,
  );
  seedOpencodeProjectId(directory);
  v1CreateSession(directory).catch(() => {
    /* opencode not ready yet — startup sync in entrypoint covers it */
  });
}

/** Ensure at least one session exists for the project (no duplicates). */
export function ensureOpencodeSession(slug: string): void {
  const directory = path.join(
    process.env.WSD_PROJECTS_DIR || '/workspaces',
    slug,
  );
  v1ListSessions(directory)
    .then((sessions) => {
      if (sessions.length > 0) return;
      createOpencodeSession(slug);
    })
    .catch(() => {
      // opencode unreachable or unexpected shape — plain registration is
      // idempotent enough for this purpose.
      createOpencodeSession(slug);
    });
}

/** Best-effort cleanup of sessions bound to a deleted project's directory. */
export function unregisterOpencodeProjectSessions(slug: string): void {
  const directory = path.join(
    process.env.WSD_PROJECTS_DIR || '/workspaces',
    slug,
  );
  v1ListSessions(directory)
    .then((sessions) => {
      for (const s of sessions) {
        if (!s || typeof s.id !== 'string') continue;
        v1DeleteSession(s.id).catch(() => {});
      }
    })
    .catch(() => {
      /* non-fatal */
    });
}

// ── Delegate integration (project → agent run) ─────────────────────────
// One-shot "send a prompt to a named subagent and collect the result"
// contract, verified against opencode-ai@1.18.22 (Step 0):
//   1. POST /session?directory=…            → { id: sessionID }
//   2. POST /api/session/<id>/agent         → 204   (agent/model in the
//                                                    prompt body are silently
//                                                    ignored — switch first)
//   3. POST /api/session/<id>/prompt        → { data: { admittedSeq, … } }
//   4. GET  /api/session/<id>/history       → poll until `step.ended`;
//      final text in `text.ended` events (data.text), agent/model in the
//      `step.started` event. The server emits numbered composite names
//      (`session.next.step.ended.2`) — applyEvent normalizes them to the
//      abstract vocabulary above; a drain that never emits `step.started`
//      within ~60s is reported as started:false instead of a full timeout.
// All functions fail soft (null/throw → caller decides); never crash the
// request flow when opencode is down.

export interface OpencodeProbe {
  ok: boolean;
  version?: string;
}

/** Live reachability + optional version of the opencode web server. */
export function probeOpencodeServer(): Promise<OpencodeProbe> {
  return fetch(`${baseUrl()}/global/health`, { signal: AbortSignal.timeout(2500) })
    .then(async (r) => {
      if (!r.ok) return { ok: false };
      const j = (await r.json().catch(() => null)) as any;
      return typeof j?.version === 'string'
        ? { ok: true, version: j.version }
        : { ok: true };
    })
    .catch(() => ({ ok: false }));
}

/** Create a session and return its id (null when unreachable/odd shape). */
export async function v1CreateSessionId(directory: string): Promise<string | null> {
  const r = await fetch(`${baseUrl()}/session?directory=${encodeURIComponent(directory)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) return null;
  const j = (await r.json().catch(() => null)) as any;
  const id = j?.id ?? j?.data?.id;
  return typeof id === 'string' && id ? id : null;
}

/**
 * Switch the session to a named agent (mandatory — agent/model in the prompt
 * body are ignored) and enqueue the prompt. Returns the admitted sequence
 * number for the result collector; throws on transport/HTTP failure.
 */
export async function v1SendMessage(
  sessionId: string,
  prompt: string,
  agent?: string,
  signal?: AbortSignal,
): Promise<number | null> {
  if (agent) {
    const a = await fetch(`${baseUrl()}/api/session/${encodeURIComponent(sessionId)}/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
    });
    if (!a.ok) {
      throw new Error(`Failed to select agent '${agent}': HTTP ${a.status}`);
    }
  }
  const r = await fetch(`${baseUrl()}/api/session/${encodeURIComponent(sessionId)}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: { text: prompt } }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`Failed to send prompt: HTTP ${r.status}`);
  const j = (await r.json().catch(() => null)) as any;
  const seq = j?.data?.admittedSeq;
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : null;
}

export interface CollectResult {
  text: string;
  agent?: string;
  model?: string;
  finish?: string;
  cost?: number | null;
  tokens?: number | null;
  files?: string[];
  /** true when a `step.started` event was observed (agent accepted the run). */
  started: boolean;
  /** true when a `step.ended` event was observed (vs. the timeout budget). */
  ended: boolean;
}

/** Recursively find event objects ({type, data}) inside a history payload. */
function walkEvents(node: unknown, seen: Set<unknown>, out: Array<Record<string, unknown>>): void {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) walkEvents(item, seen, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.type === 'string' && obj.data && typeof obj.data === 'object') {
    out.push(obj);
  }
  for (const v of Object.values(obj)) walkEvents(v, seen, out);
}

/**
 * Normalize composite event names back to the abstract vocabulary the
 * collector matches. opencode-ai@1.18.22 broadcasts numbered names such as
 * `session.next.step.ended.2` / `session.next.text.ended.1` (the numeric
 * suffix is not stable), while this facade polls for `step.ended` /
 * `text.ended`. Already-normalized names pass through unchanged.
 */
function normalizeEventType(type: string): string {
  let t = type;
  if (t.startsWith('session.next.')) t = t.slice('session.next.'.length);
  const m = /^(.*)\.\d+$/.exec(t);
  return m ? m[1] : t; // session.next.step.ended.2 → step.ended
}

function applyEvent(ev: Record<string, unknown>, acc: CollectResult): void {
  const type = normalizeEventType(ev.type as string);
  const data = (ev.data ?? {}) as Record<string, unknown>;
  if (type === 'text.ended' && typeof data.text === 'string') {
    acc.text += data.text;
  } else if (type === 'step.started') {
    acc.started = true;
    if (typeof data.agent === 'string') acc.agent = data.agent;
    // opencode publishes the model as {id, providerID} — keep the id; some
    // versions send the plain string.
    const model = data.model;
    if (typeof model === 'string') {
      acc.model = model;
    } else if (model && typeof model === 'object') {
      const id = (model as Record<string, unknown>).id;
      if (typeof id === 'string' || typeof id === 'number') acc.model = String(id);
    }
  } else if (type === 'step.ended') {
    acc.ended = true;
    const finish = data.finish as Record<string, unknown> | string | undefined;
    if (finish && typeof finish === 'object' && typeof finish.reason === 'string') {
      acc.finish = finish.reason;
    } else if (typeof finish === 'string') {
      acc.finish = finish;
    }
    if (typeof data.cost === 'number') acc.cost = data.cost;
    // opencode publishes the token usage as {input, output} — sum them; some
    // versions send the plain number.
    const tokens = data.tokens;
    if (typeof tokens === 'number') {
      acc.tokens = tokens;
    } else if (tokens && typeof tokens === 'object') {
      const t = tokens as Record<string, unknown>;
      if (typeof t.input === 'number' && typeof t.output === 'number') {
        acc.tokens = t.input + t.output;
      }
    }
    if (Array.isArray(data.files)) {
      const list = data.files.filter((f): f is string => typeof f === 'string');
      if (list.length) acc.files = [...(acc.files ?? []), ...list];
    }
  }
}

/**
 * Poll the session history until the step ends or the timeout budget is
 * exhausted, accumulating the assistant text. Never throws — a broken
 * response is recorded into the returned object.
 */
export async function v1CollectResult(
  sessionId: string,
  admittedSeq: number | null,
  timeoutMs: number = 300_000,
  signal?: AbortSignal,
  onProgress?: (acc: CollectResult) => void,
): Promise<CollectResult> {
  const acc: CollectResult = {
    text: '',
    cost: null,
    tokens: null,
    started: false,
    ended: false,
  };
  const pollStartedAt = Date.now();
  // When the prompt was admitted but no `step.started` ever arrives, the
  // drain is stalled — the run never began server-side. Bail after a short
  // budget with started:false instead of burning the whole timeout on a lost
  // run; the caller turns that into an honest "did not start" error.
  const startStallMs = Math.min(60_000, Math.max(1000, timeoutMs));
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  // Ignored on purpose — kept to document the facade contract above.
  void admittedSeq;
  while (Date.now() < deadline) {
    if (signal?.aborted) break;
    try {
      const r = await fetch(`${baseUrl()}/api/session/${encodeURIComponent(sessionId)}/history`, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(Math.min(5000, Math.max(1000, deadline - Date.now())))])
          : AbortSignal.timeout(Math.min(5000, Math.max(1000, deadline - Date.now()))),
      });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        const seen = new Set<unknown>();
        const events: Array<Record<string, unknown>> = [];
        walkEvents(j, seen, events);
        for (const ev of events) applyEvent(ev, acc);
        if (acc.ended) return acc;
        if (!acc.started && Date.now() - pollStartedAt >= startStallMs) return acc;
        onProgress?.(acc);
      }
    } catch {
      /* transient poll failure — keep polling until the deadline */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return acc;
}

/**
 * CLI fallback for the session path (restricted to editor+ write-capable
 * agents by the caller): `opencode run "<msg>" --session <id> --attach
 * <url> --dir <dir> --format json`. --agent is deliberately NEVER used —
 * it bypasses the agent's permission denies.
 */
export async function cliDelegate(
  message: string,
  sessionId: string,
  workspaceDir: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'opencode',
      ['run', message, '--session', sessionId, '--attach', baseUrl(), '--dir', workspaceDir, '--format', 'json'],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) {
          reject(new Error(`opencode CLI failed: ${err.message}`));
          return;
        }
        // Aggregate assistant text from the JSONL event stream; fall back to
        // the raw stdout tail when nothing structured parses.
        let text = '';
        for (const line of String(stdout).split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed);
            if (obj && typeof obj === 'object') {
              if (typeof obj.text === 'string') text += obj.text;
              const content = obj.content;
              if (Array.isArray(content)) {
                for (const part of content) {
                  if (part && typeof part.text === 'string') text += part.text;
                }
              }
            }
          } catch {
            text += trimmed + '\n';
          }
        }
        resolve(text.trim() || String(stdout).trim());
      },
    );
  });
}

/** Seed <dir>/.git/opencode with a deterministic project id (V1 resolution). */
function seedOpencodeProjectId(dir: string): void {
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) {
      execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    }
    const sha = crypto
      .createHash('sha1')
      .update(path.basename(dir))
      .digest('hex');
    fs.writeFileSync(path.join(dir, '.git', 'opencode'), sha);
  } catch {
    /* best effort — startup sync in entrypoint covers it */
  }
}

// ── Update machinery (Studio Update button backend) ─────────────────────

let updateInFlight = false;

export function isUpdateRunning(): boolean {
  return updateInFlight;
}

export interface RegistryInfo {
  latest: string | null;
  latestMajor: number | null;
  channelUnlocked: boolean;
}

/**
 * npm registry base (overridable for mirrors/proxies). HTTPS is mandatory
 * outside WSD_TESTING=1 (the suite container's local mock); the host must
 * pass the update-host blocklist so a mirror can never be pointed at
 * cloud-metadata / link-local. A rejected value throws — the endpoints
 * degrade to `latest: null` and the boot warning names the env var.
 */
function npmBase(): string {
  return assertAllowedUpdateBase(
    process.env.WSD_UPDATE_NPM_REGISTRY || 'https://registry.npmjs.org',
    'WSD_UPDATE_NPM_REGISTRY',
    process.env.WSD_TESTING === '1',
  );
}

let latestVersionCache: { at: number; data: RegistryInfo } = {
  at: 0,
  data: { latest: null, latestMajor: null, channelUnlocked: false },
};
const LATEST_VERSION_CACHE_MS = 60_000;

/** Invalidate the short npm-registry cache (manual refresh / apply gates). */
export function clearLatestVersionCache(): void {
  latestVersionCache = { at: 0, data: { latest: null, latestMajor: null, channelUnlocked: false } };
}

/**
 * Latest published version on npm (1.x `latest` dist-tag), short 60s TTL
 * mirroring code-server's release cache (every status poll must not hammer
 * the registry). `force` bypasses the cache — used by the apply downgrade
 * gate so a stale `latest` can never sneak a downgrade past the check.
 */
export function fetchLatestVersion(force = false): Promise<RegistryInfo> {
  const now = Date.now();
  if (!force && latestVersionCache.at > 0 && now - latestVersionCache.at < LATEST_VERSION_CACHE_MS) {
    return Promise.resolve(latestVersionCache.data);
  }
  const fail = (): RegistryInfo => {
    const info: RegistryInfo = { latest: null, latestMajor: null, channelUnlocked: false };
    latestVersionCache = { at: Date.now(), data: info };
    return info;
  };
  return fetch(`${npmBase()}/opencode-ai/latest`, {
    signal: AbortSignal.timeout(8000),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: any) => {
      // Strict publisher format only — a forged range/dist-tag from a
      // registry response (`1.99.0 || 2.0.0`, `latest`, `../evil`) must
      // never reach the npm install argv and must never fake a comparison.
      const latest = isStrictPublisherVersion(j?.version) ? String(j.version).trim() : null;
      const latestMajor = latest ? parseInt(latest, 10) : null;
      const info: RegistryInfo = {
        latest,
        latestMajor,
        channelUnlocked:
          latestMajor !== null && SUPPORTED_MAJORS.includes(latestMajor),
      };
      latestVersionCache = { at: Date.now(), data: info };
      return info;
    })
    .catch(() => fail());
}

export interface UpdateResult {
  ok: boolean;
  updatedTo?: string;
  restarted?: boolean;
  error?: string;
  bootFailed?: boolean;
}

/**
 * Install a PINNED opencode version via npm, restart the supervised web
 * process into it and verify the new binary boots (CLI version + web server
 * + supervised-pid change — the same checks `waitForOpencodeBoot` applies to
 * interactive updates and rollbacks). Single-flight; refuses non-publisher
 * version strings (injection/range forms) and majors outside
 * SUPPORTED_MAJORS before a byte moves.
 *
 * Shared primitive behind three callers:
 *  - performOpencodeUpdate (registry latest → install);
 *  - rollbackOpencodeTo (reinstall the pinned baseline after a failed boot);
 *  - the boot-time re-apply (updates-boot.ts) restoring a persisted 'ok'
 *    version that a container rebuild discarded.
 *
 * The supervised-pid snapshot for the boot-verify pid-change check is taken
 * BEFORE npm runs (a rollback is always invoked after the failed update's own
 *  restart, so the pid captured at rollback entry is the broken child —
 *  requiring a change from it is behaviorally equivalent to demanding a change
 *  from the pre-update pid: both are necessarily different from the revived
 *  child). Returns `ok:false, bootFailed:true` with the boot error when the
 *  new binary never comes up — callers (not this function) decide whether to
 *  roll back; npm failures keep plain `ok:false` without `bootFailed`.
 */
export function installOpencodeVersion(target: string): Promise<UpdateResult> {
  if (!isStrictPublisherVersion(target)) {
    return Promise.resolve({ ok: false, error: `Invalid target version: ${target}` });
  }
  const parsed = parseSemver(target);
  if (parsed === null || !SUPPORTED_MAJORS.includes(parsed.major)) {
    return Promise.resolve({
      ok: false,
      error: `opencode ${target} is not supported by this Madar build yet`,
    });
  }
  if (updateInFlight) {
    return Promise.resolve({ ok: false, error: 'An update is already running' });
  }
  updateInFlight = true;
  const done = (r: UpdateResult): UpdateResult => {
    updateInFlight = false;
    return r;
  };
  const pidBefore = currentOpencodePid(); // captured BEFORE npm / the restart
  try {
    // npm cache is set to the shared data dir (docker-compose
    // `npm_config_cache: /app/data/.npm`); create it 0700 so `_cacache` url
    // metadata (token-bearing tarball URLs under a private registry) never
    // sits world-readable on the volume.
    fs.mkdirSync(process.env.npm_config_cache || path.join(os.homedir(), '.npm'), { recursive: true, mode: 0o700 });
  } catch {
    /* npm handles its own cache when the dir is unusable */
  }

  return new Promise<UpdateResult>((resolve) => {
    execFile(
      'npm',
      ['install', '-g', `opencode-ai@${target}`, '--no-fund', '--no-audit'],
      { timeout: 180_000 },
      (err) => {
        if (err) {
          resolve(done({ ok: false, error: `npm install failed: ${err.message}` }));
          return;
        }
        restartSupervisedWeb().then(() => {
          waitForOpencodeBoot(target, pidBefore).then((bootedVersion) => {
            if (bootedVersion === null) {
              resolve(
                done({
                  ok: false,
                  bootFailed: true,
                  error: `Updated opencode ${target} did not boot within ${Math.round(bootTimeoutMs() / 1000)}s — the supervisor keeps reviving it; check the update log`,
                }),
              );
              return;
            }
            resolve(done({ ok: true, updatedTo: target, restarted: true }));
          });
        });
      },
    );
  });
}

/**
 * Install the newest compatible release inside the container and restart
 * the supervised opencode web process into it. Single-flight; refuses
 * unsupported target majors via the caller-side gate as well as here.
 * Installs, restarts AND boot-verifies (via installOpencodeVersion) — the
 * apply core re-verifies through its own `boot` dep (idempotent: the binary
 * already booted), and reports `ok:false` honestly when that probe fails.
 */
export function performOpencodeUpdate(): Promise<UpdateResult> {
  if (updateInFlight) {
    return Promise.resolve({ ok: false, error: 'An update is already running' });
  }
  return fetchLatestVersion()
    .then((reg) => {
      if (!reg.latest || !reg.channelUnlocked) {
        return {
          ok: false,
          error: `Latest release (${reg.latest ?? 'unknown'}) is not supported by this Madar build yet`,
        } satisfies UpdateResult;
      }
      return installOpencodeVersion(reg.latest);
    })
    .catch((e: Error): UpdateResult => ({ ok: false, error: e.message }));
}

/**
 * Reinstall a pinned opencode version and restart the supervised web process
 * into it — used by the unified update facade to roll opencode back after a
 * failed boot-to-new-version. Delegates to installOpencodeVersion (same
 * install + restart + boot-verify path); `oldPid` is kept for the facade's
 * signature but the install captures the supervised pid itself at rollback
 * entry — that pid is the update's broken child, so demanding a change from
 * it is equivalent to demanding a change from the pre-update pid.
 */
export function rollbackOpencodeTo(currentVersion: string, oldPid?: number): Promise<UpdateResult> {
  if (!isStrictPublisherVersion(currentVersion)) {
    return Promise.resolve({ ok: false, error: `Invalid rollback version: ${currentVersion}` });
  }
  void oldPid;
  return installOpencodeVersion(currentVersion);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Currently-running supervised opencode child pid, or undefined when the
 * pid file is missing/unparseable. Read BEFORE an update/rollback so boot
 * verification can demand that the pid actually changed.
 */
export function currentOpencodePid(): number | undefined {
  try {
    const raw = fs.readFileSync(path.join(dataDir(), 'opencode-web.pid'), 'utf8').trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 1 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Boot verification used by the apply core and rollbackOpencodeTo:
 * polls until the CLI probes as `targetVersion` AND the web server answers
 * AND (when `oldPid` is known) the supervised child pid changed — or the
 * boot window elapses (null). The CLI probe is FORCED (cache-bypass) so a
 * stale warm cache can never fake a fresh binary, and the web check skips
 * nothing: a server still serving an older version keeps polling. A server
 * that reports no version passes the web gate on reachability alone (the
 * pid-change + CLI version still bind it).
 */
export function waitForOpencodeBoot(
  targetVersion: string | null,
  oldPid?: number,
  timeoutMs?: number,
): Promise<string | null> {
  if (!targetVersion) return Promise.resolve(null); // no target → can never boot-verify
  const deadline = Date.now() + (timeoutMs ?? bootTimeoutMs());
  const poll = async (): Promise<string | null> => {
    if (Date.now() > deadline) return null;
    const cli = await probeOpencodeVersion(true);
    if (cli.version !== 'unknown' && semverEquals(cli.version, targetVersion)) {
      const web = await probeOpencodeServer();
      if (web.ok) {
        if (typeof web.version === 'string' && web.version && !semverEquals(web.version, targetVersion)) {
          await sleepMs(1000);
          return poll();
        }
        if (oldPid !== undefined) {
          const nowPid = currentOpencodePid();
          if (nowPid !== undefined && nowPid === oldPid) {
            // Supervisor never restarted into the new binary — keep waiting.
            await sleepMs(1000);
            return poll();
          }
        }
        return cli.version;
      }
    }
    await sleepMs(1000);
    return poll();
  };
  return poll();
}

/**
 * Process identity guard (project-serve pattern) for the supervised opencode
 * child: a stale/rewritten pid file must never make us SIGTERM an unrelated
 * process. opencode's native binary reports comm `opencode`; the npm shim
 * (and the JS fallback) run as `node` with the component path in args. The
 * Madar backend itself is also a `node dist/index.js` process, so a bare
 * `comm === 'node'` would let a reused PID kill OUR OWN server — that exact
 * shape is refused. Returns true only for a plausible opencode child.
 */
function isOpencodeProcess(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'comm=', '-o', 'args='], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(false);
      const line = String(stdout).trim();
      if (!line) return resolve(false);
      const [comm, ...rest] = line.split(/\s+/);
      const args = rest.join(' ');
      if (comm === 'opencode') return resolve(true);
      if (comm !== 'node') return resolve(false);
      if (args.includes('dist/index.js')) return resolve(false); // the Madar backend
      resolve(args.includes('opencode'));
    });
  });
}

/**
 * Kill the supervised opencode child so entrypoint revives it (new binary).
 * Refuses (false) when the pid file is missing/stale or the target is not a
 * genuine opencode process.
 */
export function restartSupervisedWeb(): Promise<boolean> {
  const pid = currentOpencodePid();
  if (pid === undefined) return Promise.resolve(false);
  return isOpencodeProcess(pid).then((isOurs) => {
    if (!isOurs) {
      try {
        // Best-effort detail to the update log (0600).
        fs.appendFileSync(
          path.join(updatesDirName(), 'update.log'),
          `${new Date().toISOString()} [opencode] restart guard: pid ${pid} is not an opencode process — refusing to SIGTERM\n`,
          { encoding: 'utf8', mode: 0o600 },
        );
      } catch {
        /* update logging is best-effort */
      }
      return false;
    }
    try {
      process.kill(pid, 'SIGTERM');
      return true;
    } catch {
      /* process already gone — the supervisor will revive it anyway */
      return false;
    }
  });
}

function updatesDirName(): string {
  return path.join(dataDir(), 'updates');
}
