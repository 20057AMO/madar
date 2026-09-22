/**
 * code-server-update.ts
 * Madar — Orchestration for supervised code-server self-updates.
 *
 * Layer on top of the import-free updates-core pure rules (S1): probes the
 * installed version, resolves the latest GitHub release, streams the .deb
 * with SHA-256 verification, installs via dpkg and rides the entrypoint
 * supervision loop (S2) through a restart + boot-verify, rolling back to the
 * previous deb when the new binary fails to come up.
 *
 * Live state is persisted to $DATA_DIR/updates/code-server.json (0600, via
 * withFileLockAsync) and every run appends a line to $DATA_DIR/updates/update.log.
 */
import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';

import {
  parseCliVersion,
  parseCodeServerRelease,
  assetDebName,
  checksumMatches,
  compatGate,
  freeSpaceGate,
  assertSafeDebName,
  assertAllowedUpdateBase,
  applyStateMachine,
  freshApplyState,
  type ApplyEvent,
  type ApplyState,
} from './updates-core';
import { withFileLockAsync } from './write-queue';

const execFileAsync = promisify(execFile);

export interface UpdateResult {
  ok: boolean;
  updatedTo?: string;
  restarted?: boolean;
  error?: string;
  rolledBack?: boolean;
}

export interface CodeServerUpdateState {
  applyState: ApplyState;
  currentVersion?: string;
  targetVersion?: string;
  error?: string;
  rolledBack?: boolean;
  startedAt?: string;
  updatedAt?: string;
}

export interface ReleaseInfo {
  version: string;
  debUrl: string;
  digest: string | null;
  /** Asset size in bytes (from the same GitHub payload when available). */
  debSizeBytes?: number;
}

const VALID_STATES: ApplyState[] = [
  'idle', 'downloading', 'verifying', 'installing', 'restarting',
  'verifying-boot', 'ok', 'failed', 'rollback',
];
const EXEC_STATES: ApplyState[] = [
  'downloading', 'verifying', 'installing', 'restarting', 'verifying-boot', 'rollback',
];

const DEFAULT_MAX_BYTES = 400 * 1024 * 1024; // real deb ~233MB
const DEFAULT_BOOT_TIMEOUT_MS = 90_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const DPKG_TIMEOUT_MS = 180_000;
const VERSION_CACHE_MS = 30_000;
const RELEASE_CACHE_MS = 10 * 60_000;

function dataDir(): string {
  return process.env.WSD_DATA_DIR || '/app/data';
}

function updatesDir(): string {
  return path.join(dataDir(), 'updates');
}

function stateFile(): string {
  return path.join(updatesDir(), 'code-server.json');
}

function logFile(): string {
  return path.join(updatesDir(), 'update.log');
}

function pidFile(): string {
  return path.join(dataDir(), 'code-server.pid');
}

/**
 * Hard cap on a .deb download. A junk env value falls back to the default —
 * with a console.warn so a misconfigured deployment is visible in server
 * logs instead of silently applying different-than-expected limits.
 */
export function maxBytes(): number {
  const n = Number(process.env.WSD_UPDATES_MAX_BYTES);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  if (process.env.WSD_UPDATES_MAX_BYTES !== undefined) {
    console.warn(`[updates] WSD_UPDATES_MAX_BYTES is not a positive number (got ${JSON.stringify(process.env.WSD_UPDATES_MAX_BYTES)}) — using default ${DEFAULT_MAX_BYTES}`);
  }
  return DEFAULT_MAX_BYTES;
}

/**
 * Boot-verification budget. Exported so the offline rules can assert the
 * same env-fallback contract the orchestrator runs on.
 */
export function bootTimeoutMs(): number {
  const n = Number(process.env.WSD_UPDATE_BOOT_TIMEOUT_MS);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  if (process.env.WSD_UPDATE_BOOT_TIMEOUT_MS !== undefined) {
    console.warn(`[updates] WSD_UPDATE_BOOT_TIMEOUT_MS is not a positive number (got ${JSON.stringify(process.env.WSD_UPDATE_BOOT_TIMEOUT_MS)}) — using default ${DEFAULT_BOOT_TIMEOUT_MS}`);
  }
  return DEFAULT_BOOT_TIMEOUT_MS;
}

/** True only under the test/CI container (relaxed security budgets). */
export function isTesting(): boolean {
  return process.env.WSD_TESTING === '1';
}

/**
 * GitHub API base. HTTPS is mandatory outside WSD_TESTING=1 (the suite
 * container mirrors the API locally); the host must pass the update-host
 * blocklist (never cloud-metadata / link-local).
 */
export function githubBase(): string {
  return assertAllowedUpdateBase(
    process.env.WSD_UPDATE_GITHUB_BASE || 'https://api.github.com',
    'WSD_UPDATE_GITHUB_BASE',
    isTesting(),
  );
}

/**
 * Release-asset download base (rollback deb + asset URL construction).
 * Same transport + host safety as `githubBase()`.
 */
export function downloadBase(): string {
  return assertAllowedUpdateBase(
    process.env.WSD_UPDATE_DOWNLOAD_BASE || 'https://github.com/coder/code-server/releases',
    'WSD_UPDATE_DOWNLOAD_BASE',
    isTesting(),
  );
}

// Diagnostics at module load: a misconfigured mirror must be visible in the
// server log (the endpoint error paths swallow details by design).
try {
  githubBase();
  downloadBase();
} catch (e: any) {
  console.warn(`[updates] ${e.message}`);
}

// ── Version probing (short cache; force bypasses for boot-verify polls) ──

let versionCache: { at: number; version: string | null } = { at: 0, version: null };

export async function probeCurrentVersion(force = false): Promise<string | null> {
  const now = Date.now();
  if (force === false && versionCache.at > 0 && now - versionCache.at < VERSION_CACHE_MS) {
    return versionCache.version;
  }
  return new Promise((resolve) => {
    execFile('code-server', ['--version'], { timeout: 8000 }, (err, stdout) => {
      const version = !err && stdout ? parseCliVersion(stdout) : null;
      versionCache = { at: Date.now(), version };
      resolve(version);
    });
  });
}

// ── Latest release (10-min cache — GitHub unauthenticated = 60 req/h) ──

let releaseCache: { at: number; data: ReleaseInfo | null } = { at: 0, data: null };

export async function fetchLatestRelease(force = false): Promise<ReleaseInfo | null> {
  const now = Date.now();
  if (force === false && releaseCache.at > 0 && now - releaseCache.at < RELEASE_CACHE_MS) {
    return releaseCache.data;
  }
  const data: ReleaseInfo | null = await fetch(
    `${githubBase()}/repos/coder/code-server/releases/latest`,
    {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000),
    },
  )
    .then((r) => (r.ok ? r.json() : null))
    .then((j: unknown) => {
      try {
        const base = parseCodeServerRelease(j, process.arch);
        if (!base) return null;
        // Transport + host guard on the asset URL straight from the GitHub
        // payload — a hostile/mirror response must never redirect the
        // downloader at cloud-metadata or over plaintext. Rejected releases
        // surface as `latest: null` (the UI reads "unavailable", never hangs).
        try {
          assertAllowedUpdateBase(base.debUrl, 'browser_download_url', isTesting());
        } catch (e: any) {
          console.warn(`[updates] rejecting GitHub asset URL: ${e.message}`);
          return null;
        }
        // parseCodeServerRelease drops the asset size — re-extract it from the
        // same payload so the free-space preflight can use the real byte count
        // instead of the worst-case cap.
        let size: number | undefined;
        if (j && typeof j === 'object') {
          const obj = j as Record<string, unknown>;
          const assets = obj.assets;
          if (Array.isArray(assets)) {
            const expected = assetDebName(base.version, process.arch);
            const asset = assets.find((a) => a && typeof a === 'object' && (a as Record<string, unknown>).name === expected) as Record<string, unknown> | undefined;
            if (typeof asset?.size === 'number') size = asset.size;
          }
        }
        return { ...base, ...(size !== undefined ? { debSizeBytes: size } : {}) };
      } catch {
        return null;
      }
    })
    .catch(() => null);
  releaseCache = { at: Date.now(), data };
  return data;
}

// ── Download + verification ─────────────────────────────────────────────

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stream a .deb to dest with a hard byte cap and incremental SHA-256.
 * With a digest the checksum is authoritative; without one the file is
 * validated structurally via `dpkg-deb --info` (a real deb parses). Both
 * failing → error and the partial file is removed.
 */
export async function downloadDeb(
  url: string,
  dest: string,
  expectedSha: string | null,
  bytesCap: number,
): Promise<void> {
  // Defense in depth: every download URL (release asset, rollback baseline)
  // passes the same transport + host guard again before a single byte moves
  // — even a supply-chain-tainted release response cannot move the fetch.
  assertAllowedUpdateBase(url, 'update download URL', isTesting());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download the release package: HTTP ${res.status}`);
  }
  const hash = crypto.createHash('sha256');
  let received = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc: string, cb: (err: Error | null, data?: Buffer) => void) {
      received += chunk.length;
      if (received > bytesCap) {
        return cb(new Error(`Download exceeds the size cap (${bytesCap} bytes)`));
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as unknown as import('stream/web').ReadableStream), meter, fs.createWriteStream(dest));
  } catch (err) {
    fs.rmSync(dest, { force: true });
    throw err;
  }
  if (expectedSha && expectedSha.length > 0) {
    const hex = hash.digest('hex');
    const expectedHex = expectedSha.startsWith('sha256:') ? expectedSha.slice('sha256:'.length) : expectedSha;
    if (!checksumMatches(hex, expectedHex)) {
      fs.rmSync(dest, { force: true });
      throw new Error('SHA-256 checksum mismatch — download rejected');
    }
  } else {
    try {
      await execFileAsync('dpkg-deb', ['--info', dest], { timeout: 30_000 });
    } catch {
      fs.rmSync(dest, { force: true });
      throw new Error('Download could not be verified (no digest and dpkg-deb rejected the file)');
    }
  }
}

/**
 * Link formatter for the (0600, server-side-only) update log: host + path
 * only. GitHub asset URLs carry short-lived signed query parameters and the
 * rollback URL embeds the current version string — neither belongs in a log
 * entry, and neither `?token=...` nor any other query fragment may ever be
 * persisted.
 */
function urlForLog(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return '(invalid url)';
  }
}

// ── Restart + boot verify ───────────────────────────────────────────────

function currentPid(): number | undefined {
  try {
    const raw = fs.readFileSync(pidFile(), 'utf8').trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 1 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Process identity guard (project-serve pattern): the pid file must point at
 * a genuine live code-server child before we SIGTERM it. code-server 4.x
 * runs as `node <bin>/code-server` (shebang exec), and the container-test
 * fakes are `node -e '...http server...'` — so comm alone is insufficient:
 * a `node dist/index.js` (the Madar backend itself) is the exact process a
 * reused pid must NEVER kill, and is refused by its args.
 */
function isCodeServerProcess(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'comm=', '-o', 'args='], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(false);
      const line = String(stdout).trim();
      if (!line) return resolve(false);
      const [comm, ...rest] = line.split(/\s+/);
      const args = rest.join(' ');
      if (comm === 'code-server') return resolve(true);
      if (comm !== 'node') return resolve(false);
      if (args.includes('dist/index.js')) return resolve(false); // the Madar backend
      // `ps args` repeats argv[0] — for the real bin `/usr/bin/code-server…`
      // matches the include; `node -e '…'` container-test fakes put `-e` in
      // argv[1] (rest[1]) while rest[0] is the executable name. A substring
      // test would also match innocuous `not-e`-style args, so compare the
      // exact token after argv[0].
      resolve(args.includes('code-server') || rest[1] === '-e');
    });
  });
}

/**
 * Result of a supervised-child restart attempt. A refusal (`reason:
 * 'refused'`) means the pid file pointed at a process that is NOT our
 * code-server child — we must never signal it. `missing` means there is no
 * pid file at all (the container supervisor will apply the installed deb on
 * its next restart).
 */
export interface RestartResult {
  ok: boolean;
  oldPid?: number;
  reason?: 'missing' | 'refused';
  pid?: number;
}

/**
 * SIGTERM the supervised code-server child so entrypoint revives it.
 * Returns {ok:false, reason:'missing'|'refused'} instead of killing blind —
 * a stale pid must never terminate an unrelated process.
 */
async function restartCodeServer(): Promise<RestartResult> {
  const before = currentPid();
  if (before === undefined) return { ok: false, reason: 'missing' };
  const isOurs = await isCodeServerProcess(before);
  if (!isOurs) {
    appendLog(
      `restart guard: pid ${before} is not a code-server process — refusing to SIGTERM`,
    );
    return { ok: false, reason: 'refused', pid: before };
  }
  try {
    process.kill(before, 'SIGTERM');
  } catch {
    /* process already gone — the supervisor will revive it anyway */
  }
  return { ok: true, oldPid: before };
}

function tcpProbe(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * Poll until the NEW binary reports the target version, the socket on
 * 127.0.0.1:8080 answers AND the live process is no longer the pre-restart
 * PID (the version binary is swapped by dpkg before the old server dies, so
 * version+TCP alone could race ahead of the actual restart).
 */
async function waitForBoot(targetVersion: string, oldPid?: number): Promise<boolean> {
  const deadline = Date.now() + bootTimeoutMs();
  while (Date.now() < deadline) {
    const [version, tcp, pid] = await Promise.all([
      probeCurrentVersion(true),
      tcpProbe('127.0.0.1', 8080),
      Promise.resolve(currentPid()),
    ]);
    if (
      version === targetVersion &&
      tcp &&
      (oldPid === undefined || (pid !== undefined && pid !== oldPid))
    ) {
      return true;
    }
    await sleep(1000);
  }
  return false;
}

function freeSpaceIn(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

// ── State persistence ───────────────────────────────────────────────────

export function getCodeServerUpdateState(): CodeServerUpdateState {
  try {
    const j = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (!j || typeof j !== 'object') return { applyState: 'idle' };
    const s = j as Partial<CodeServerUpdateState>;
    const state: CodeServerUpdateState = { applyState: 'idle' };
    if (typeof s.applyState === 'string' && VALID_STATES.includes(s.applyState as ApplyState)) {
      state.applyState = s.applyState as ApplyState;
    }
    if (typeof s.currentVersion === 'string') state.currentVersion = s.currentVersion;
    if (typeof s.targetVersion === 'string') state.targetVersion = s.targetVersion;
    if (typeof s.error === 'string') state.error = s.error;
    if (typeof s.rolledBack === 'boolean') state.rolledBack = s.rolledBack;
    if (typeof s.startedAt === 'string') state.startedAt = s.startedAt;
    if (typeof s.updatedAt === 'string') state.updatedAt = s.updatedAt;
    return state;
  } catch {
    return { applyState: 'idle' };
  }
}

async function persistState(state: CodeServerUpdateState): Promise<void> {
  fs.mkdirSync(updatesDir(), { recursive: true });
  await withFileLockAsync('update:code-server-state', async () => {
    fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
  });
}

function appendLog(line: string): void {
  try {
    fs.mkdirSync(updatesDir(), { recursive: true });
    fs.appendFileSync(logFile(), `${new Date().toISOString()} ${line}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    /* update logging is best-effort */
  }
}

export function clearCaches(): void {
  versionCache = { at: 0, version: null };
  releaseCache = { at: 0, data: null };
}

/** Flip an update left mid-flight by a server restart to `failed`. */
export function reconcileStaleState(): void {
  const s = getCodeServerUpdateState();
  if (!EXEC_STATES.includes(s.applyState)) return;
  void withFileLockAsync('update:code-server-state', async () => {
    const cur = getCodeServerUpdateState();
    if (!EXEC_STATES.includes(cur.applyState)) return;
    const next: CodeServerUpdateState = {
      ...cur,
      applyState: applyStateMachine(cur.applyState, 'error'),
      error: 'Interrupted by server restart',
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(stateFile(), JSON.stringify(next, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
  });
}

// ── Single-flight ------------------------------------------------

let updateInFlight = false;

/** true while an apply is running in this process OR a persisted exec state is live. */
export function isUpdateRunning(): boolean {
  return updateInFlight || EXEC_STATES.includes(getCodeServerUpdateState().applyState);
}

function gateErrorMessage(reason: string | undefined): string {
  switch (reason) {
    case 'unsupported-arch':
      // Name the ACTUAL platform (never a guessed one): x64 maps to
      // `amd64` in the asset name, arm64 stays `arm64`.
      return `No code-server update package for this platform (${process.arch}); supported platforms: x64 (amd64) and arm64`;
    case 'not-newer':
      return 'Already running the latest code-server version';
    case 'too-large':
      return 'The release package exceeds the configured size cap';
    default:
      return 'Update preflight check failed';
  }
}

// ── Full apply ---------------------------------------------------

export function applyCodeServerUpdate(): Promise<UpdateResult> {
  return new Promise<UpdateResult>((resolveOuter) => {
    if (updateInFlight) {
      resolveOuter({ ok: false, error: 'An update is already running' });
      return;
    }
    updateInFlight = true;
    const startedAt = new Date().toISOString();
    let state: CodeServerUpdateState = {
      ...freshApplyState(getCodeServerUpdateState()),
      startedAt,
      updatedAt: startedAt,
    };
    let newDeb = '';
    let currentDeb = '';

    const persist = async (patch: Partial<CodeServerUpdateState>): Promise<void> => {
      state = { ...state, ...patch };
      await persistState(state);
    };
    const step = async (event: ApplyEvent): Promise<ApplyState> => {
      state.applyState = applyStateMachine(state.applyState, event);
      await persistState(state);
      return state.applyState;
    };
    const done = (r: UpdateResult): void => {
      updateInFlight = false;
      if (!r.ok) {
        // Every failure path funnels through here (preflight, download, dpkg,
        // boot-fail, rollback-fail) — persist the failure reason and the
        // rollback fact into the state file so the status surface can tell the
        // admin WHAT broke and whether the previous version was restored.
        const patch: Partial<CodeServerUpdateState> = { updatedAt: new Date().toISOString() };
        if (r.error !== undefined) patch.error = r.error;
        if (r.rolledBack !== undefined) patch.rolledBack = r.rolledBack;
        persist(patch)
          .catch(() => { /* state persistence is best-effort at a terminal state */ })
          .finally(() => resolveOuter(r));
        return;
      }
      resolveOuter(r);
    };
    const log = (line: string) => appendLog(`[code-server] ${line}`);

    /** Restore the previous deb and verify IT boots. Honest both ways: a
     * rollback we cannot verify (stale refused pid, dead supervisor) is a
     * failure with `rolledBack:false` — never a silent success. */
    const attemptRollback = async (
      rollbackVersion: string,
      oldPid: number | undefined,
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        await execFileAsync('dpkg', ['-i', currentDeb], { timeout: DPKG_TIMEOUT_MS });
        const rp = await restartCodeServer();
        const rollbackOk = await waitForBoot(rollbackVersion, rp.ok ? rp.oldPid : oldPid);
        return rollbackOk ? { ok: true } : { ok: false, error: 'the rollback binary did not boot or restart was refused' };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    };

    (async () => {
      try {
        await step('start'); // → downloading

        const current = await probeCurrentVersion(true);
        if (!current) {
          await step('error');
          log(`failed: cannot determine current version (no rollback baseline)`);
          return done({
            ok: false,
            error: 'Cannot determine the current code-server version — refusing to update without a rollback baseline',
          });
        }
        await persist({ currentVersion: current });

        const release = await fetchLatestRelease(true);
        if (!release) {
          await step('error');
          log(`failed: could not fetch the latest release`);
          return done({ ok: false, error: 'Could not fetch the latest code-server release' });
        }
        await persist({ targetVersion: release.version });

        const gate = compatGate({
          current,
          target: release.version,
          arch: process.arch,
          maxBytes: maxBytes(),
          debSizeBytes: release.debSizeBytes,
        });
        if (!gate.ok) {
          await step('error');
          log(`preflight rejected: ${gate.reason}`);
          return done({ ok: false, error: gateErrorMessage(gate.reason) });
        }

        // Free-space preflight: new deb + rollback deb ≈ 2× the package.
        const neededBytes = (release.debSizeBytes ?? maxBytes()) * 2;
        const freeBytes = freeSpaceIn(updatesDir());
        if (freeBytes !== null && !freeSpaceGate(freeBytes, neededBytes)) {
          await step('error');
          log(`preflight rejected: not enough free space`);
          return done({ ok: false, error: 'Not enough free disk space for the update (2× the package size is required)' });
        }

        const debName = assetDebName(release.version, process.arch);
        const currentDebName = assetDebName(current, process.arch);
        if (!assertSafeDebName(debName) || !assertSafeDebName(currentDebName)) {
          await step('error');
          return done({ ok: false, error: 'Refusing to write a non-standard deb filename' });
        }
        newDeb = path.join(updatesDir(), debName);
        currentDeb = path.join(updatesDir(), currentDebName);

        log(`downloading ${release.version} (${urlForLog(release.debUrl)})`);
        await downloadDeb(release.debUrl, newDeb, release.digest, maxBytes());

        log(`downloading rollback baseline ${current} (${urlForLog(`${downloadBase()}/download/v${current}/${currentDebName}`)})`);
        await downloadDeb(
          `${downloadBase()}/download/v${current}/${currentDebName}`,
          currentDeb,
          null,
          maxBytes(),
        );

        await step('downloaded'); // → verifying
        // Verification ran inside downloadDeb (checksum or dpkg-deb); mark it.
        await step('verified'); // → installing

        log(`installing ${release.version}`);
        try {
          await execFileAsync('dpkg', ['-i', newDeb], { timeout: DPKG_TIMEOUT_MS });
        } catch (err: any) {
          await step('error');
          // dpkg usually rejects a broken package before touching the live one;
          // defensively restore the previous deb and revive the IDE anyway.
          // The raw dpkg output stays in the update log — never the API client.
          const msg = `dpkg install failed: ${err.message}`;
          log(`failed: ${msg} — attempting defensive rollback`);
          try {
            await execFileAsync('dpkg', ['-i', currentDeb], { timeout: DPKG_TIMEOUT_MS });
            await restartCodeServer();
            log('defensive rollback to previous deb completed');
          } catch (rbErr: any) {
            log(`defensive rollback also failed: ${rbErr.message}`);
          }
          return done({ ok: false, error: 'The package install failed (previous version restored)' });
        }

        await step('installed'); // → restarting
        const restart = await restartCodeServer();
        log(`restarting via $DATA_DIR/code-server.pid (pid=${restart.oldPid ?? (restart.reason === 'missing' ? 'no pid file' : 'refused')})`);

        // Missing pid: no supervised child exists at all — a container
        // restart applies the installed deb. Never claim a restart that did
        // not happen: ok:false, honest message, no rollback (the deb is a
        // good install; only the reboot is pending).
        if (!restart.ok && restart.reason === 'missing') {
          await step('error');
          const msg = 'installed but not restarted — no code-server pid file (the IDE process is not running under supervision); the new version applies when the IDE starts';
          log(`failed: ${msg}`);
          return done({ ok: false, error: msg });
        }

        // Restart REFUSED (stale pid): the supervisor was never signalled, so
        // the new deb sits installed but unbooted — treated exactly like a
        // boot failure: roll the previous version back.
        if (!restart.ok) {
          await step('restarted'); // restarting → verifying-boot
          await step('boot-fail'); // → rollback
          log(`restart refused for pid ${restart.pid} — rolling back to ${current}`);
          const rollback = await attemptRollback(current, restart.pid);
          if (rollback.ok) {
            await step('rollback-ok'); // → failed (update did not succeed)
            await persist({ rolledBack: true });
            log(`rolled back to ${current}`);
            return done({
              ok: false,
              error: `Update to ${release.version} could not be restarted — rolled back to ${current}`,
              rolledBack: true,
            });
          }
          await step('rollback-fail'); // → failed
          return done({
            ok: false,
            error: `Update to ${release.version} could not be restarted and the rollback to ${current} also failed`,
            rolledBack: false,
          });
        }

        await step('restarted'); // → verifying-boot
        const bootOk = await waitForBoot(release.version, restart.oldPid);
        if (!bootOk) {
          await step('boot-fail'); // → rollback
          log(`boot verification failed for ${release.version} — rolling back to ${current}`);
          const rollback = await attemptRollback(current, restart.oldPid);
          if (rollback.ok) {
            await step('rollback-ok'); // → failed (update did not succeed)
            await persist({ rolledBack: true });
            log(`rolled back to ${current}`);
            return done({
              ok: false,
              error: `Update to ${release.version} failed to boot — rolled back to ${current}`,
              rolledBack: true,
            });
          }
          await step('rollback-fail'); // → failed
          return done({
            ok: false,
            error: `Update to ${release.version} failed and the rollback to ${current} also failed to boot${rollback.error ? ` (${rollback.error})` : ''}`,
            rolledBack: false,
          });
        }

        await step('boot-ok'); // → ok
        await persist({ currentVersion: release.version, error: undefined, rolledBack: false, updatedAt: new Date().toISOString() });
        log(`updated ${current} → ${release.version}`);
        return done({ ok: true, updatedTo: release.version, restarted: true });
      } catch (err: any) {
        try {
          await step('error');
        } catch {
          /* already terminal */
        }
        // Raw error detail (fs paths, network errors, registry details) stays
        // in the update log (0600, server-side) — the API client gets a safe
        // generic message with no internals.
        log(`failed: ${err.message}`);
        await persist({ error: err.message });
        return done({ ok: false, error: 'The update failed unexpectedly — see the update log for details' });
      } finally {
        try {
          for (const f of [newDeb, currentDeb]) {
            if (f) fs.rmSync(f, { force: true });
          }
        } catch {
          /* deb cleanup is best-effort */
        }
      }
    })();
  });
}