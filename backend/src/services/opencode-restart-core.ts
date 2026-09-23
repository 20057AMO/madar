/**
 * opencode-restart-core.ts
 * Madar — Pure restart-sequence rules for the supervised opencode web child.
 *
 * Import-free on purpose (node --test loads it directly, mirroring
 * opencode-apply-core.ts / alerts-core.ts / serve-core.ts): opencode-api.ts
 * binds the REAL primitives (pid-file read, ps probe, process.kill, sleep)
 * to the injected deps below.
 *
 * The defect this fixes: a SIGTERM alone can be ABSORBED by a young
 * supervised child mid-bootstrap — the child survives and keeps serving the
 * OLD binary while the caller's boot-verify burns its whole window waiting
 * for a restart that never happened. The sequence probes the child, sends
 * SIGTERM, verifies ACTUAL death by polling the pid file for a revived
 * (different) pid, escalates to SIGKILL when the child survived, logs every
 * step, and returns an honest verdict so the caller fails fast instead of
 * silently gambling on a process that still answers.
 */

export type RestartVerdict =
  | { ok: true; newPid: number }
  | { ok: false; reason: 'missing' | 'refused' | 'survived' | 'no-revival'; detail?: string };

export interface RestartPrimitives {
  /** Current supervised-child pid from the pid file (undefined when absent). */
  readPid: () => number | undefined;
  /** True when `pid` is genuinely our opencode child (never an unrelated reuse). */
  probeIsOurs: (pid: number) => Promise<boolean>;
  /** Send a terminating signal to `pid` (never throws — a raced exit revives anyway). */
  kill: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  /** True when `pid` is no longer a live process (kill-0 semantics). */
  pidGone: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  /** Step lines ("SIGTERM sent to pid N", "exited on SIGTERM …",
   * "survived — escalating to SIGKILL", "FAILED …"). */
  log?: (line: string) => void;
  /** ps-probe attempts before refusing (default 3). */
  probeAttempts?: number;
  /** pause between failed probe attempts (default 500ms). */
  probeRetryMs?: number;
  /** window to observe a revival after SIGTERM (default 5000ms). */
  sigtermWaitMs?: number;
  /** window to observe a revival after SIGKILL (default 10000ms). */
  sigkillWaitMs?: number;
}

/** How often the pid file is polled while waiting for the revived child. */
const POLL_MS = 250;

async function pollForRevived(p: RestartPrimitives, pid: number, waitMs: number): Promise<number | null> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await p.sleep(POLL_MS);
    const current = p.readPid();
    if (current !== undefined && current !== pid) return current;
  }
  return null;
}

/**
 * Run the supervised-child restart sequence: probe the child → SIGTERM →
 * poll for the revived pid → escalate to SIGKILL → poll again → honest
 * verdict. Never throws.
 */
export async function runRestartSequence(p: RestartPrimitives): Promise<RestartVerdict> {
  const attempts = p.probeAttempts ?? 3;
  const probeRetryMs = p.probeRetryMs ?? 500;
  const sigtermWaitMs = p.sigtermWaitMs ?? 5000;
  const sigkillWaitMs = p.sigkillWaitMs ?? 10000;
  const log = p.log ?? (() => {});

  // The pid file is rewritten by the entrypoint via shell `>` (O_TRUNC-then-
  // write) and `rm -f`ed at boot — a single sample can land in the truncate
  // window and see '' → undefined. Re-sample at the probe cadence before
  // declaring the child missing (symmetric with the ps-probe retries below).
  let pid = p.readPid();
  for (let i = 0; pid === undefined && i < attempts; i += 1) {
    await p.sleep(probeRetryMs);
    pid = p.readPid();
  }
  if (pid === undefined) {
    const detail = 'no supervised opencode pid on record';
    log(`FAILED: ${detail} — nothing to restart`);
    return { ok: false, reason: 'missing', detail };
  }

  let isOurs = false;
  for (let i = 0; i < attempts; i += 1) {
    if (await p.probeIsOurs(pid)) {
      isOurs = true;
      break;
    }
    log(`ps probe attempt ${i + 1}/${attempts} failed for pid ${pid}`);
    if (i < attempts - 1) await p.sleep(probeRetryMs);
  }
  if (!isOurs) {
    const detail = `ps probe failed after ${attempts} attempts`;
    log(`FAILED: ${detail} (pid ${pid} is not a confirmed opencode child)`);
    return { ok: false, reason: 'refused', detail };
  }

  log(`SIGTERM sent to pid ${pid}`);
  p.kill(pid, 'SIGTERM');
  const termRevived = await pollForRevived(p, pid, sigtermWaitMs);
  if (termRevived !== null) {
    log(`pid ${pid} exited on SIGTERM — supervisor revived it as ${termRevived}`);
    return { ok: true, newPid: termRevived };
  }

  log(`pid ${pid} survived SIGTERM — escalating to SIGKILL`);
  if (p.pidGone(pid)) {
    // died on SIGTERM — never signal a dead (possibly recycled) pid; fall through to the revival poll
  } else if (await p.probeIsOurs(pid)) {
    p.kill(pid, 'SIGKILL');
  } else {
    log(`FAILED: pid ${pid} no longer a confirmed opencode child — refusing SIGKILL`);
    return { ok: false, reason: 'refused', detail: 'pid identity changed before SIGKILL' };
  }
  const killRevived = await pollForRevived(p, pid, sigkillWaitMs);
  if (killRevived !== null) {
    log(`pid ${pid} killed with SIGKILL — supervisor revived it as ${killRevived}`);
    return { ok: true, newPid: killRevived };
  }

  if (p.pidGone(pid)) {
    const detail = `pid ${pid} is gone but no revived child appeared within the restart budget`;
    log(`FAILED: ${detail}`);
    return { ok: false, reason: 'no-revival', detail };
  }
  const detail = `pid ${pid} still alive after SIGTERM and SIGKILL — the supervisor never revived a new child`;
  log(`FAILED: ${detail}`);
  return { ok: false, reason: 'survived', detail };
}