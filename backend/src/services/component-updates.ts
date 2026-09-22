/**
 * component-updates.ts
 * Madar — Unified update facade over the two supervised components:
 * opencode (npm, fast) and code-server (deb, heavy).
 *
 * Status aggregation never throws (a network failure degrades `latest` /
 * `upToDate` to null). Applies are serialized through withFileLockAsync and
 * single-flight guarded by the components' own in-flight flags plus persisted
 * execution states, so a second apply while one runs returns a clean
 * "An update is already running" conflict for the route to 409.
 *
 * `all` runs opencode FIRST, then code-server: opencode is a seconds-long,
 * low-risk npm swap restarting into the supervised loop, while code-server is
 * a ~200 MB download + dpkg + boot-verify cycle — the cheap win must land
 * before the risky one, and a code-server failure must never hold up the
 * agent surface (opencode). If opencode fails, the batch short-circuits so
 * the admin fixes it before spending bandwidth on code-server.
 */
import fs from 'fs';
import path from 'path';

import { probeOpencodeVersion, probeOpencodeServer, fetchLatestVersion, clearLatestVersionCache, isUpdateRunning, performOpencodeUpdate, rollbackOpencodeTo, waitForOpencodeBoot, currentOpencodePid } from './opencode-api';
import * as codeServer from './code-server-update';
import { applyStateMachine, semverCompare, semverEquals, parseCliVersion, isSupportedArch, type ApplyEvent, type ApplyState } from './updates-core';
import { runOpencodeApply, type ApplyStep } from './opencode-apply-core';
import { withFileLockAsync } from './write-queue';
import { recordAudit, type AuditEvent } from './audit-store';

export type ComponentId = 'opencode' | 'code-server' | 'all';

export interface ComponentStatus {
  id: 'opencode' | 'code-server';
  current: string | null;
  latest: string | null;
  upToDate: boolean | null;
  updateRunning: boolean;
  applyState: ApplyState;
  error?: string;
  /** true when a failed update was rolled back to the previous version. */
  rolledBack?: boolean;
  channelUnlocked?: boolean;
}

export interface UpdatesStatus {
  components: ComponentStatus[];
  checkedAt: string | null;
}

interface Actor {
  ip?: string;
  userId?: string;
}

export interface ApplyOutcome {
  ok: boolean;
  error?: string;
}

const VALID_STATES: ApplyState[] = [
  'idle', 'downloading', 'verifying', 'installing', 'restarting',
  'verifying-boot', 'ok', 'failed', 'rollback',
];
const EXEC_STATES: ApplyState[] = [
  'downloading', 'verifying', 'installing', 'restarting', 'verifying-boot', 'rollback',
];

function dataDir(): string {
  return process.env.WSD_DATA_DIR || '/app/data';
}

function updatesDir(): string {
  return path.join(dataDir(), 'updates');
}

function opencodeStateFile(): string {
  return path.join(updatesDir(), 'opencode.json');
}

function appendLog(line: string): void {
  try {
    fs.mkdirSync(updatesDir(), { recursive: true });
    fs.appendFileSync(path.join(updatesDir(), 'update.log'), `${new Date().toISOString()} ${line}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    /* update logging is best-effort */
  }
}

function lastCheckFile(): string {
  return path.join(updatesDir(), 'last-check.json');
}

function readLastCheck(): string | null {
  try {
    const j = JSON.parse(fs.readFileSync(lastCheckFile(), 'utf8'));
    if (j && typeof j === 'object' && typeof (j as { at?: unknown }).at === 'string') {
      return (j as { at: string }).at;
    }
  } catch {
    /* never checked */
  }
  return null;
}

function writeLastCheck(at: string): void {
  try {
    fs.mkdirSync(updatesDir(), { recursive: true });
    fs.writeFileSync(lastCheckFile(), JSON.stringify({ at }), { encoding: 'utf8', mode: 0o600 });
  } catch {
    /* last-check persistence is best-effort */
  }
}

// ── opencode apply-state persistence ───────────────────────────

export interface OpencodeUpdateState {
  applyState: ApplyState;
  currentVersion?: string;
  targetVersion?: string;
  error?: string;
  rolledBack?: boolean;
  startedAt?: string;
  updatedAt?: string;
}

function readOpencodeState(): OpencodeUpdateState {
  try {
    const j = JSON.parse(fs.readFileSync(opencodeStateFile(), 'utf8'));
    if (!j || typeof j !== 'object') return { applyState: 'idle' };
    const s = j as Partial<OpencodeUpdateState>;
    const state: OpencodeUpdateState = { applyState: 'idle' };
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

async function persistOpencodeState(state: OpencodeUpdateState): Promise<void> {
  fs.mkdirSync(updatesDir(), { recursive: true });
  await withFileLockAsync('update:opencode-state', async () => {
    fs.writeFileSync(opencodeStateFile(), JSON.stringify(state, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
  });
}

// ── Status ──────────────────────────────────────────────────────

export async function getUpdatesStatus(): Promise<UpdatesStatus> {
  const checkedAt = readLastCheck();
  const [openCodeCur, openCodeReg, csCur, csRel] = await Promise.all([
    probeOpencodeVersion(),
    fetchLatestVersion(),
    codeServer.probeCurrentVersion().catch(() => null),
    codeServer.fetchLatestRelease().catch(() => null),
  ]);

  const ocVersion = openCodeCur.version === 'unknown' ? null : openCodeCur.version;
  const ocLatest = openCodeReg.latest;
  const ocState = readOpencodeState();

  // Late-boot reconciliation (opencode only): the boot-verification window
  // can elapse while the new binary is still coming up — if the component is
  // NOW running the registry latest AND the web server answers, the update
  // landed (slow boot, not a broken binary) and the persisted failed/boot
  // state must flip to ok instead of telling the admin to restart the box.
  // ocVersion is raw CLI stdout (may carry a `v` prefix / annotations) —
  // normalize before the semver comparisons, and mirror the boot verifier's
  // web gate: a server still serving a DIFFERENT version keeps polling, a
  // server reporting no version passes on reachability alone.
  const ocNormalized = ocVersion === null ? null : parseCliVersion(ocVersion) ?? ocVersion;
  if (
    ocState.applyState === 'failed' &&
    /boot/i.test(ocState.error ?? '') &&
    ocNormalized !== null &&
    ocLatest !== null &&
    semverEquals(ocNormalized, ocLatest)
  ) {
    const web = await probeOpencodeServer();
    if (
      web.ok &&
      (typeof web.version !== 'string' || !web.version || semverEquals(web.version, ocNormalized))
    ) {
      const next: OpencodeUpdateState = {
        ...ocState,
        applyState: 'ok',
        targetVersion: ocNormalized,
        rolledBack: false,
        error: undefined,
        updatedAt: new Date().toISOString(),
      };
      await persistOpencodeState(next);
      ocState.applyState = 'ok';
      ocState.error = undefined;
      ocState.rolledBack = false;
      ocState.targetVersion = ocNormalized;
    }
  }

  const csVersion = csCur;
  const csLatest = csRel?.version ?? null;
  const csState = codeServer.getCodeServerUpdateState();

  const components: ComponentStatus[] = [
    {
      id: 'opencode',
      current: ocVersion,
      latest: ocLatest,
      upToDate: ocVersion === null || ocLatest === null ? null : ocVersion === ocLatest,
      updateRunning: isUpdateRunning() || EXEC_STATES.includes(ocState.applyState),
      applyState: ocState.applyState,
      error: ocState.error,
      rolledBack: ocState.rolledBack,
      channelUnlocked: openCodeReg.channelUnlocked,
    },
    {
      id: 'code-server',
      current: csVersion,
      latest: csLatest,
      upToDate: csVersion === null || csLatest === null ? null : csVersion === csLatest,
      updateRunning: codeServer.isUpdateRunning() || EXEC_STATES.includes(csState.applyState),
      applyState: csState.applyState,
      error: csState.error,
      rolledBack: csState.rolledBack,
      channelUnlocked: isSupportedArch(process.arch),
    },
  ];
  return { components, checkedAt };
}

/**
 * Synchronous pre-apply downgrade gate (runs in the request flow BEFORE the
 * background apply / 202): rejects when the REGISTRY's latest is not strictly
 * newer than the installed version. Reads the version probe and the registry
 * with caches bypassed (`force`) in BOTH branches so a stale cached `latest`
 * — e.g. a newer release cached seconds ago while the registry now serves an
 * older tag — can never sneak past the gate. `latest === null` (registry
 * unreachable/parse failure) → 503 `registry_unreachable`: we cannot verify,
 * so we refuse to guess. An unknown installed version (probe failure) →
 * allow: the backend apply declines with its own honest "no rollback
 * baseline" error. `all` is exempt — every component gates itself inside its
 * own apply.
 */
export async function downgradeVerdict(
  component: 'opencode' | 'code-server',
): Promise<{ status: number; error: string } | null> {
  if (component === 'opencode') {
    const [info, reg] = await Promise.all([probeOpencodeVersion(true), fetchLatestVersion(true)]);
    const current = info.version === 'unknown' ? null : info.version;
    const latest = reg.latest;
    if (latest === null) {
      return { status: 503, error: 'Update registry is unreachable — cannot verify the target version' };
    }
    if (current === null) return null;
    const cmp = semverCompare(latest, current);
    if (!Number.isNaN(cmp) && cmp <= 0) {
      return {
        status: 400,
        error: `Already up to date — opencode is at ${current}, registry latest is ${latest} (no downgrades)`,
      };
    }
    return null;
  }

  const [current, release] = await Promise.all([
    codeServer.probeCurrentVersion(true),
    codeServer.fetchLatestRelease(true),
  ]);
  const latest = release?.version ?? null;
  if (latest === null) {
    return { status: 503, error: 'Update registry is unreachable — cannot verify the target version' };
  }
  if (current === null) return null;
  const cmp = semverCompare(latest, current);
  if (!Number.isNaN(cmp) && cmp <= 0) {
    return {
      status: 400,
      error: `Already up to date — code-server is at ${current}, registry latest is ${latest} (no downgrades)`,
    };
  }
  return null;
}

/** Bypass every cache (code-server release/probe AND the opencode npm 60s
 * TTL) and report fresh status (audited). */
export async function checkNow(actor?: Actor): Promise<UpdatesStatus> {
  codeServer.clearCaches();
  clearLatestVersionCache();
  writeLastCheck(new Date().toISOString());
  const status = await getUpdatesStatus();
  recordAudit('updates-check', true, actor?.ip, actor?.userId);
  return status;
}

export interface UpdateLogResult {
  log: string;
  truncated: boolean;
  bytes: number;
}

const UPDATE_LOG_MAX_BYTES = 16 * 1024;
const UPDATE_LOG_MAX_LINES = 200;

export function readUpdateLog(): UpdateLogResult {
  try {
    const file = path.join(updatesDir(), 'update.log');
    const total = fs.statSync(file).size;
    if (total === 0) return { log: '', truncated: false, bytes: 0 };
    let text: string;
    let truncated = false;
    if (total > UPDATE_LOG_MAX_BYTES) {
      truncated = true;
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(UPDATE_LOG_MAX_BYTES);
        const n = fs.readSync(fd, buf, 0, UPDATE_LOG_MAX_BYTES, total - UPDATE_LOG_MAX_BYTES);
        text = buf.subarray(0, n).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
      const nl = text.indexOf('\n');
      if (nl !== -1) text = text.slice(nl + 1);
    } else {
      text = fs.readFileSync(file, 'utf8');
    }
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length > UPDATE_LOG_MAX_LINES) {
      truncated = true;
      text = lines.slice(-UPDATE_LOG_MAX_LINES).join('\n');
    } else {
      text = lines.join('\n');
    }
    return { log: text, truncated, bytes: Buffer.byteLength(text, 'utf8') };
  } catch {
    return { log: '', truncated: false, bytes: 0 };
  }
}

// ── Apply orchestration ─────────────────────────────────────────

/** true when ANY component has a live in-flight update (flag or persisted exec state). */
export function isUpdateInProgress(): boolean {
  if (isUpdateRunning()) return true;
  if (codeServer.isUpdateRunning()) return true;
  return EXEC_STATES.includes(readOpencodeState().applyState);
}

let applyClaimed = false;

/**
 * Route-facing entry: synchronous conflict check then fire-and-forget apply.
 * `applyClaimed` closes the same-tick race between two rapid requests before
 * the components' own in-flight flags have been raised inside the lock.
 */
export function beginApply(component: ComponentId, actor?: Actor): { started: boolean; error?: string } {
  if (applyClaimed || isUpdateInProgress()) {
    return { started: false, error: 'An update is already running' };
  }
  applyClaimed = true;
  void applyComponent(component, actor).finally(() => {
    applyClaimed = false;
  });
  return { started: true };
}

/**
 * Serialized apply for one component (or 'all'). Returns the conflict early;
 * the route turns it into a 409. Auditing happens here (per component event),
 * so direct callers get the same trail as the HTTP path.
 */
export function applyComponent(component: ComponentId, actor?: Actor): Promise<ApplyOutcome> {
  if (isUpdateInProgress()) {
    return Promise.resolve({ ok: false, error: 'An update is already running' });
  }
  return withFileLockAsync('update:apply', async () => {
    if (isUpdateInProgress()) {
      return { ok: false, error: 'An update is already running' };
    }
    try {
      if (component === 'opencode') return await applyOpencode(actor);
      if (component === 'code-server') return await applyCodeServer(actor);
      if (component === 'all') return await applyAll(actor);
      return { ok: false, error: `Unknown component: ${component}` };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });
}

/** Sequential: opencode first (fast, low-risk), then code-server. */
async function applyAll(actor?: Actor): Promise<ApplyOutcome> {
  const oc = await applyOpencode(actor);
  if (!oc.ok) return oc;
  return applyCodeServer(actor);
}

async function applyCodeServer(actor?: Actor): Promise<ApplyOutcome> {
  const result = await codeServer.applyCodeServerUpdate();
  recordAudit(result.ok ? 'code-server-update' : 'code-server-update-failed', result.ok, actor?.ip, actor?.userId);
  // The rollback event's `ok` describes the ROLLBACK ITSELF: true when the
  // failed update was rolled back cleanly (rolledBack:true), false when the
  // rollback also failed (rolledBack:false). The update's own failure is
  // already carried by the -failed event above.
  if (result.rolledBack === true) {
    recordAudit('code-server-update-rollback', true, actor?.ip, actor?.userId);
  } else if (result.rolledBack === false) {
    recordAudit('code-server-update-rollback', false, actor?.ip, actor?.userId);
  }
  return { ok: result.ok, error: result.error };
}

/**
 * opencode apply: thin wrapper over the import-free decision core
 * (opencode-apply-core.ts) which drives npm + the supervised restart through
 * injected deps and boots/rolls back with REAL probes. Every opencode side
 * effect lands here: state machine persistence (opencode.json) + audit rows,
 * exactly as the offline core tests describe.
 */
export async function applyOpencode(actor?: Actor): Promise<ApplyOutcome> {
  const startedAt = new Date().toISOString();
  let state: OpencodeUpdateState = { applyState: 'idle', startedAt, updatedAt: startedAt };
  await persistOpencodeState(state);
  const log = (line: string) => appendLog(`[opencode] ${line}`);
  const setState = async (patch: Partial<OpencodeUpdateState>): Promise<void> => {
    state = { ...state, ...patch, updatedAt: new Date().toISOString() };
    await persistOpencodeState(state);
  };
  const step = async (event: ApplyStep): Promise<void> => {
    state = {
      ...state,
      applyState: applyStateMachine(state.applyState, event as ApplyEvent),
      updatedAt: new Date().toISOString(),
    };
    await persistOpencodeState(state);
  };
  const audit = (event: AuditEvent, ok: boolean) => recordAudit(event, ok, actor?.ip, actor?.userId);

  try {
    return await runOpencodeApply(
      {
        probeBaseline: async () => (await probeOpencodeVersion(true)).version,
        fetchTarget: async () => (await fetchLatestVersion(true)).latest,
        isDowngrade: (target, baseline) =>
          target !== null &&
          !Number.isNaN(semverCompare(target, baseline)) &&
          semverCompare(target, baseline) <= 0,
        currentPid: () => currentOpencodePid(),
        performUpdate: () => performOpencodeUpdate(),
        boot: (target, oldPid) => waitForOpencodeBoot(target, oldPid),
        rollback: (version, oldPid) => rollbackOpencodeTo(version, oldPid),
      },
      { log, setState, step, audit },
    );
  } catch (err: any) {
    // State-machine or persistence surprise — same honest failed terminal as
    // the in-flow failures (raw detail stays in the 0600 update log).
    log(`failed: ${err.message}`);
    try {
      await step('error' as ApplyStep);
    } catch {
      /* already terminal */
    }
    await setState({ error: err.message });
    recordAudit('opencode-update-failed', false, actor?.ip, actor?.userId);
    return { ok: false, error: err.message };
  }
}

// ── Boot reconciliation ─────────────────────────────────────────

/** Flip opencode + code-server updates left mid-flight by a restart to failed. */
export function reconcileStaleStates(): void {
  codeServer.reconcileStaleState();
  const oc = readOpencodeState();
  if (EXEC_STATES.includes(oc.applyState)) {
    const next: OpencodeUpdateState = {
      ...oc,
      applyState: applyStateMachine(oc.applyState, 'error'),
      error: 'Interrupted by server restart',
      updatedAt: new Date().toISOString(),
    };
    void persistOpencodeState(next);
  }
}