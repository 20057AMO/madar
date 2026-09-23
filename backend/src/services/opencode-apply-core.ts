/**
 * opencode-apply-core.ts
 * Import-free decision core for the opencode apply lifecycle (mirrors
 * janitor-core / serve-core / snapshots-schedule / alerts-core): no imports
 * at all, so `node --test` can load it offline. The UI flow lives in
 * component-updates.applyOpencode which binds the REAL opencode-api
 * functions + the state-machine/audit sinks to these injected deps.
 *
 * Covers the review-critical wiring:
 *  - refuses EARLY when the forced baseline probe cannot determine the
 *    running version (a rollback needs a pinned version to reinstall);
 *  - drives a boot-verification step (CLI + web + pid-change via the
 *    injected `boot`) and on failure rolls back to the baseline with the
 *    PRE-update supervised pid so the rollback demands a changed child;
 *  - reports rolledBack:true only when the rollback itself succeeded, and
 *    EXPLICITLY rolledBack:false when it failed (never a stale value);
 *  - emits the audit pair for every terminal verdict.
 */

export type ApplyStep =
  | 'start'
  | 'downloaded'
  | 'verified'
  | 'installed'
  | 'restarted'
  | 'boot-fail'
  | 'boot-ok'
  | 'rollback-ok'
  | 'rollback-fail';

export interface ApplyStatePatch {
  applyState?: string;
  currentVersion?: string;
  targetVersion?: string;
  error?: string;
  rolledBack?: boolean;
}

/** Side-effect-free-ish boundary: all external interactions are injected. */
export interface OpencodeApplyDeps {
  /** FORCED version probe ('unknown' when the CLI cannot answer). */
  probeBaseline(): Promise<string>;
  /** Registry latest (null when unreachable/invalid). */
  fetchTarget(): Promise<string | null>;
  /** Semantic "target ≤ baseline" predicate injected by the caller. */
  isDowngrade(target: string | null, baseline: string): boolean;
  /** Supervised child pid captured BEFORE the update — boot/rollback demand
   * a DIFFERENT pid so a stale warm probe can never fake a fresh binary. */
  currentPid(): number | undefined;
  performUpdate(): Promise<{ ok: boolean; error?: string; bootFailed?: boolean }> | { ok: boolean; error?: string; bootFailed?: boolean };
  /** Poll until the new binary is live; null on timeout. */
  boot(target: string | null, oldPid?: number): Promise<string | null>;
  rollback(version: string, oldPid?: number): Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string };
}

/** Side effects the caller must persist/emit (state machine, audit, log). */
export interface OpencodeApplyEffects {
  log(line: string): void;
  setState(patch: ApplyStatePatch): Promise<void> | void;
  step(event: ApplyStep): Promise<void> | void;
  /** Caller maps `event` onto its real audit vocabulary. */
  audit(event: string, ok: boolean): void;
}

export interface OpencodeApplyOutcome {
  ok: boolean;
  error: string;
}

export const BASELINE_UNKNOWN_ERROR =
  'Cannot determine the current opencode version — refusing to update without a rollback baseline';

export async function runOpencodeApply(
  deps: OpencodeApplyDeps,
  fx: OpencodeApplyEffects,
): Promise<OpencodeApplyOutcome> {
  const baseline = await deps.probeBaseline();

  if (baseline === 'unknown') {
    // No pinned baseline ⇒ no rollback path ⇒ refuse before npm moves a byte.
    fx.log(`failed: ${BASELINE_UNKNOWN_ERROR}`);
    fx.setState({ applyState: 'failed', error: BASELINE_UNKNOWN_ERROR });
    fx.audit('opencode-update-failed', false);
    return { ok: false, error: BASELINE_UNKNOWN_ERROR };
  }
  fx.setState({ currentVersion: baseline });
  await fx.step('start'); // → downloading

  // Downgrade gate INSIDE the apply (race-window lock after the route gate).
  const target = await deps.fetchTarget();
  if (target !== null && deps.isDowngrade(target, baseline)) {
    const err = `Already up to date — opencode is at ${baseline}, registry latest is ${target} (no downgrades)`;
    fx.log(`failed: ${err}`);
    fx.setState({ applyState: 'failed', error: err });
    fx.audit('opencode-update-failed', false);
    return { ok: false, error: err };
  }

  fx.log(`installing latest (npm, baseline ${baseline})`);
  // Capture the supervised pid BEFORE npm touches anything — the rollback
  // boot-verification must demand a DIFFERENT pid than this one.
  const oldPid = deps.currentPid();
  const performed = await deps.performUpdate();
  if (!performed.ok && performed.bootFailed !== true) {
    const err = performed.error || 'opencode update failed';
    fx.log(`failed: ${err}`);
    fx.setState({ applyState: 'failed', error: err });
    fx.audit('opencode-update-failed', false);
    return { ok: false, error: err };
  }
  if (!performed.ok) {
    // bootFailed: the primitive DID install + restart — only its internal
    // boot verify failed. Walk the machine through the real steps; the boot
    // probe below either confirms a slow boot (safety net) or drives the
    // boot-fail → rollback branch as before the refactor.
    fx.log(`install reported boot failure: ${performed.error ?? 'unknown error'} — re-verifying before rollback`);
  }

  // npm performed download+checksum+install in one op — the state machine
  // steps now reflect what actually happened.
  await fx.step('downloaded'); // → verifying
  await fx.step('verified'); // → installing
  await fx.step('installed'); // → restarting
  await fx.step('restarted'); // → verifying-boot

  const booted = await deps.boot(target, oldPid);
  if (booted === null) {
    // The new binary failed to come up — roll back to the pinned baseline.
    await fx.step('boot-fail'); // → rollback
    fx.log(`boot verification failed — rolling back to ${baseline}`);
    const rb = await deps.rollback(baseline, oldPid);
    if (rb.ok) {
      const err = `Update failed to boot — rolled back to ${baseline}`;
      await fx.step('rollback-ok'); // → failed (update did not succeed)
      fx.setState({ applyState: 'failed', rolledBack: true, error: err });
      fx.log(`rolled back to ${baseline}`);
      // `ok` below reflects the ROLLBACK outcome — the update's own failure
      // is carried by the -failed audit, exactly like the update surface.
      fx.audit('opencode-update-rollback', true);
      fx.audit('opencode-update-failed', false);
      return { ok: false, error: err };
    }
    const err = `Update failed to boot and the rollback to ${baseline} also failed${rb.error ? ` (${rb.error})` : ''}`;
    await fx.step('rollback-fail'); // → failed
    fx.setState({ applyState: 'failed', rolledBack: false, error: err });
    fx.log(`failed: ${err}`);
    fx.audit('opencode-update-rollback', false);
    fx.audit('opencode-update-failed', false);
    return { ok: false, error: err };
  }

  await fx.step('boot-ok'); // → ok
  fx.setState({ applyState: 'ok', currentVersion: booted, targetVersion: booted, rolledBack: false, error: undefined });
  fx.log(`updated ${baseline} → ${booted}`);
  fx.audit('opencode-update', true);
  return { ok: true, error: '' };
}