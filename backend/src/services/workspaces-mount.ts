/**
 * workspaces-mount.ts
 * Madar — the wired sibling of the pure workspaces-mount-core.ts: resolve the
 * host-side bind source for project containers, physically audit the
 * /workspaces mount, and refuse honestly when it is broken.
 *
 * The daemon resolves a project container's bind source on the Docker Desktop
 * VM, not inside this container, so the string docker-manager passes MUST be a
 * real host path. It used to come from WSD_WORKSPACES_HOST_DIR, which compose
 * defaulted to "${PWD}/workspaces" — ${PWD} is an inherited shell variable, not a
 * value compose computes, so it was absent in cmd/PowerShell and stale after the
 * repo was renamed/moved. A stale value is WORSE than none: the daemon happily
 * mounts whatever exists at that string, so every project file lands in a
 * directory nobody looks at, /workspaces reads as `d?????????`, and nothing
 * reports it (the IDE status answered `running:true` the whole time).
 *
 * So: env override first (operators on UNC / WSL-distro paths still need it),
 * then a derivation from /proc/self/mountinfo that the kernel keeps correct, and
 * a physical audit on top of both — because a decoded path only means something
 * if the mount actually works. Every failure mode reports an honest state + one
 * operator-facing sentence (mountHint), never a fake 'ok'.
 */
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

import { recordAudit } from './audit-store';
import {
  MOUNT_CANARY_FILE,
  canaryToken,
  classifyMountError,
  mountHint,
  publicMountInfo,
  mountRefusalCode,
  resolveHostDir,
  type MountReason,
  type MountVerification,
  type WorkspaceMountInfo,
  type WorkspaceMountState,
} from './workspaces-mount-core';

export { MOUNT_CANARY_FILE, canaryToken, mountHint, publicMountInfo, mountRefusalCode };
export type { MountVerification, WorkspaceMountInfo, WorkspaceMountState };

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
/** Last boot-time host-path verification verdict (survives a restart). */
const VERDICT_FILE = path.join(DATA_DIR, 'workspaces-mount.json');
/** In-container mount point (compose maps ./workspaces here, relatively). */
const MOUNT_POINT = process.env.WSD_PROJECTS_DIR || '/workspaces';
const MOUNTINFO_FILE = '/proc/self/mountinfo';
/** Same image project containers use, so the probe never triggers a pull. */
const PROBE_IMAGE = process.env.WSD_WORKSPACE_IMAGE || 'wsd/workspace:latest';
const PROBE_TIMEOUT_MS = 30_000;

export const MOUNT_AUDIT_MS = Math.max(30_000, Number(process.env.WSD_MOUNT_AUDIT_MS) || 10 * 60 * 1000);
/**
 * Boot-time host-path proof. ON by default and deliberately NOT read from .env:
 * an unset value must mean "verify", never "skip the check" (the same lesson
 * the ${PWD} default taught). WSD_VERIFY_MOUNT=0 opts out.
 */
const VERIFY_ENABLED = String(process.env.WSD_VERIFY_MOUNT ?? '1') !== '0';

interface PersistedVerdict {
  hostPath: string | null;
  verification: MountVerification;
  checkedAt: string;
}

let cached: WorkspaceMountInfo | null = null;
let cachedAtMs = 0;
let persisted: PersistedVerdict | null | undefined;

function readMountinfo(): string {
  try {
    return fs.readFileSync(MOUNTINFO_FILE, 'utf8');
  } catch {
    return '';
  }
}

/** env override first, then the mountinfo derivation — never a guess. */
function resolveNow() {
  return resolveHostDir({
    envValue: process.env.WSD_WORKSPACES_HOST_DIR,
    mountinfoText: readMountinfo(),
    mountPoint: MOUNT_POINT,
  });
}

/** Map an fs failure onto the state vocabulary ('missing' is its own state). */
function stateForIoReason(reason: MountReason): WorkspaceMountState {
  if (reason === 'no_such_directory') return 'missing';
  if (reason === 'not_a_directory') return 'not_a_directory';
  return 'unreadable';
}

/**
 * Does the mount actually WORK? stat, readdir, then a write canary.
 *
 * Writability is part of the verdict on purpose: a read-only bind passes every
 * read check and then breaks project creation with files nobody can see, which
 * is the same silent-failure class as the stale bind source.
 */
function physicalCheck(): { state: WorkspaceMountState; reason: MountReason | null } {
  try {
    if (!fs.statSync(MOUNT_POINT).isDirectory()) return { state: 'not_a_directory', reason: 'not_a_directory' };
  } catch (err) {
    const reason = classifyMountError(err);
    return { state: stateForIoReason(reason), reason };
  }
  try {
    fs.readdirSync(MOUNT_POINT);
  } catch (err) {
    const reason = classifyMountError(err);
    return { state: stateForIoReason(reason), reason };
  }

  const canary = path.join(MOUNT_POINT, MOUNT_CANARY_FILE);
  const token = canaryToken(`${Date.now()}`);
  try {
    fs.writeFileSync(canary, token, { encoding: 'utf8', mode: 0o600 });
  } catch {
    return { state: 'unreadable', reason: 'not_writable' };
  }
  try {
    if (fs.readFileSync(canary, 'utf8') !== token) return { state: 'unreadable', reason: 'canary_mismatch' };
  } catch (err) {
    const reason = classifyMountError(err);
    return { state: stateForIoReason(reason), reason };
  } finally {
    try {
      fs.unlinkSync(canary);
    } catch {
      /* best-effort: a leftover dotfile is ignored by the janitor */
    }
  }
  return { state: 'ok', reason: null };
}

function readPersisted(): PersistedVerdict | null {
  if (persisted !== undefined) return persisted;
  try {
    const parsed = JSON.parse(fs.readFileSync(VERDICT_FILE, 'utf8'));
    const v = parsed?.verification;
    persisted =
      v === 'proved' || v === 'refuted' || v === 'unknown'
        ? { hostPath: typeof parsed?.hostPath === 'string' ? parsed.hostPath : null, verification: v, checkedAt: String(parsed?.checkedAt || '') }
        : null;
  } catch {
    persisted = null;
  }
  return persisted;
}

function persist(info: WorkspaceMountInfo): void {
  persisted = { hostPath: info.hostPath, verification: info.verification, checkedAt: info.checkedAt };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(VERDICT_FILE, JSON.stringify(persisted, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch {
    /* the verdict cache is best-effort — the next boot re-verifies */
  }
}

/** One audit pass: resolve, physically check, rebuild the honest payload. */
function auditMount(): WorkspaceMountInfo {
  const resolved = resolveNow();
  const prev = readPersisted();
  // A persisted verdict only describes the path it was taken for — a changed
  // path (or a first boot) is 'unknown', never a carried-over 'proved'.
  const verification =
    prev && prev.hostPath === resolved.hostPath ? prev.verification : 'unknown';

  const { state, reason } = resolved.hostPath
    ? physicalCheck()
    : { state: 'unresolved' as WorkspaceMountState, reason: resolved.reason };

  const info: WorkspaceMountInfo = {
    state,
    hostPath: resolved.hostPath,
    source: resolved.source,
    reason,
    hint: mountHint(state, reason, resolved.hostPath, MOUNT_POINT),
    checkedAt: new Date().toISOString(),
    verification,
  };

  // Audit only on a TRANSITION (or the first broken observation at boot) so a
  // 10-minute sweep can never flood the 100-entry security log.
  if (state !== (cached?.state ?? 'ok')) {
    recordAudit('mount-audit', state === 'ok', undefined, undefined, {
      state,
      hostPath: info.hostPath,
      source: info.source,
    });
    if (state === 'ok') console.log(`[workspaces] bind mount ok (${info.hostPath}, via ${info.source})`);
    else console.warn(`[workspaces] bind mount ${state}: ${info.hint}`);
  }

  cached = info;
  cachedAtMs = Date.now();
  return info;
}

/**
 * The honest mount verdict. Cached for MOUNT_AUDIT_MS, then re-audited on
 * demand — so a project created right after the operator fixes the mount is not
 * refused against a stale verdict.
 */
export function getWorkspaceMount(): WorkspaceMountInfo {
  if (!cached || Date.now() - cachedAtMs >= MOUNT_AUDIT_MS) return auditMount();
  return cached;
}

/**
 * Prove the decoded path is the SAME directory this container writes to: drop a
 * canary through the bind, then ask a throwaway container mounting the decoded
 * path to look for it. A visible non-zero exit refutes the path; an inability
 * to run the container at all (no docker binary, timeout) is 'unknown'.
 *
 * ASYNC on purpose: a synchronous `execFileSync` blocks the single Node event
 * loop for the whole 30 s ceiling, so every HTTP request and WebSocket frame
 * stalls while the probe container boots. This never rejects — a probe can only
 * ever produce a verdict, never an exception.
 */
function runProbeContainer(hostPath: string): Promise<MountVerification> {
  return new Promise<MountVerification>((resolve) => {
    try {
      execFile(
        'docker',
        ['run', '--rm', '-v', `${hostPath}:/probe`, PROBE_IMAGE, 'test', '-f', `/probe/${MOUNT_CANARY_FILE}`],
        { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (err) => {
          // Only the probe's OWN failure code (test(1) on a missing canary)
          // refutes the path. Docker reserves 125+ for "could not run the
          // container" (daemon down, image missing, bad mount), a ceiling kill
          // leaves no status at all, and a missing docker binary fails to spawn
          // — all of which are the absence of an answer, never a refutation.
          if (!err) return resolve('proved');
          resolve((err as { status?: number | null }).status === 1 ? 'refuted' : 'unknown');
        },
      );
    } catch {
      resolve('unknown');
    }
  });
}

let verifyInFlight: Promise<WorkspaceMountInfo> | null = null;

async function runVerification(): Promise<WorkspaceMountInfo> {
  const info = cached ?? auditMount();
  if (!VERIFY_ENABLED || !info.hostPath) return info;

  const canary = path.join(MOUNT_POINT, MOUNT_CANARY_FILE);
  const token = canaryToken(`${Date.now()}:${info.hostPath}`);
  let wrote = false;
  try {
    fs.writeFileSync(canary, token, { encoding: 'utf8', mode: 0o600 });
    wrote = true;
  } catch {
    wrote = false;
  }
  const verification = wrote ? await runProbeContainer(info.hostPath) : 'unknown';
  if (wrote) {
    try {
      fs.unlinkSync(canary);
    } catch {
      /* best-effort */
    }
  }

  const next: WorkspaceMountInfo = { ...info, verification };
  cached = next;
  cachedAtMs = Date.now();
  persist(next);
  if (verification !== 'unknown') {
    console.log(`[workspaces] host path ${info.hostPath} ${verification} by probe container`);
  }
  return next;
}

/**
 * Boot/sweep host-path proof. Singleflighted, never rejects and never throws:
 * concurrent callers share the one in-flight probe instead of spawning several
 * probe containers, and a failure degrades to the current verdict.
 */
export function verifyHostPath(): Promise<WorkspaceMountInfo> {
  if (verifyInFlight) return verifyInFlight;
  const run: Promise<WorkspaceMountInfo> = runVerification()
    .catch((err: any) => {
      console.warn('[workspaces] mount verification failed:', err?.message || err);
      return getWorkspaceMount();
    })
    .finally(() => {
      verifyInFlight = null;
    });
  verifyInFlight = run;
  return run;
}

/** Boot + every MOUNT_AUDIT_MS. Fire-and-forget: never blocks or fails boot. */
export function startWorkspaceMountAudit(): () => void {
  const boot = setTimeout(() => {
    void verifyHostPath();
  }, 5_000);
  const timer = setInterval(() => {
    try {
      const info = auditMount();
      // Re-prove whenever the verdict is not already a positive proof: a
      // 'refuted' verdict now REFUSES project creation, so an operator who fixes
      // the bind must not have to restart the app to get creation back, and an
      // 'unknown' verdict (docker was unavailable) would otherwise never
      // recover. 'proved' is the steady state, so the steady state costs no
      // extra container runs.
      if (info.verification !== 'proved') void verifyHostPath();
    } catch (err: any) {
      console.warn('[workspaces] mount audit failed:', err?.message || err);
    }
  }, MOUNT_AUDIT_MS);
  timer.unref?.();
  console.log(
    `[Madar] Workspaces mount: audit every ${Math.round(MOUNT_AUDIT_MS / 1000)}s, ` +
      `host-path verification ${VERIFY_ENABLED ? 'on' : 'off'}`,
  );
  return () => {
    clearTimeout(boot);
    clearInterval(timer);
  };
}
