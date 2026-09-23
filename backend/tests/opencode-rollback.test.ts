/**
 * opencode-rollback.test.ts
 * Offline unit coverage for the opencode apply boot-fail → rollback wiring
 * (review #10) plus the no-baseline refusal (review #6). Drives the
 * import-free decision core (opencode-apply-core.ts) with injected fakes —
 * the same module component-updates.applyOpencode binds the REAL opencode-api
 * functions + state-machine/audit sinks to (the wrapper is 20 lines of pure
 * plumbing). Mirrors alerts-core / janitor-core / serve-core style.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  runOpencodeApply,
  BASELINE_UNKNOWN_ERROR,
  type OpencodeApplyDeps,
  type OpencodeApplyEffects,
} from '../src/services/opencode-apply-core.ts';

interface CallRecorder {
  steps: string[];
  audits: Array<{ event: string; ok: boolean }>;
  patches: Array<Record<string, unknown>>;
  logLines: string[];
}

function makeFx(): { fx: OpencodeApplyEffects; rec: CallRecorder } {
  const rec: CallRecorder = { steps: [], audits: [], patches: [], logLines: [] };
  const fx: OpencodeApplyEffects = {
    log: (line) => rec.logLines.push(line),
    setState: (patch) => rec.patches.push({ ...patch }),
    step: async (event) => rec.steps.push(event),
    audit: (event, ok) => rec.audits.push({ event, ok }),
  };
  return { fx, rec };
}

/** Default happy-path deps; per-test overrides win. */
function makeDeps(overrides: Partial<OpencodeApplyDeps> = {}): OpencodeApplyDeps {
  return {
    probeBaseline: async () => '1.18.22',
    fetchTarget: async () => '1.19.0',
    isDowngrade: () => false,
    currentPid: () => 1234,
    performUpdate: async () => ({ ok: true }),
    boot: async () => '1.19.0',
    rollback: async () => ({ ok: true }),
    ...overrides,
  };
}

function lastPatch(rec: CallRecorder): Record<string, unknown> {
  return rec.patches[rec.patches.length - 1];
}

describe('runOpencodeApply boot-fail → rollback wiring', () => {
  test('boot-fail + clean rollback → error names the rollback, rolledBack:true, both audits, pid passed forward', async () => {
    const rollbackCalls: Array<{ version: string; oldPid?: number }> = [];
    const deps = makeDeps({
      currentPid: () => 987,
      boot: async () => null, // new version never boots
      rollback: async (version, oldPid) => {
        rollbackCalls.push({ version, oldPid });
        return { ok: true };
      },
    });
    const { fx, rec } = makeFx();

    const res = await runOpencodeApply(deps, fx);

    assert.strictEqual(res.ok, false);
    assert.match(res.error, /rolled back to 1\.18\.22/);
    assert.strictEqual(rollbackCalls.length, 1, 'boot failure must trigger exactly one rollback');
    assert.strictEqual(rollbackCalls[0].version, '1.18.22', 'rollback pins the baseline');
    assert.strictEqual(rollbackCalls[0].oldPid, 987, 'rollback boot-checks against the PRE-update pid');

    // State has the honest rollback facts.
    assert.strictEqual(lastPatch(rec).rolledBack, true);
    assert.strictEqual(lastPatch(rec).applyState, 'failed');
    // Correct step sequence through the machine contract.
    assert.deepStrictEqual(rec.steps, [
      'start', 'downloaded', 'verified', 'installed', 'restarted',
      'boot-fail', 'rollback-ok',
    ]);
    // Both audit rows: rollback ok:true, update failed:false.
    assert.deepStrictEqual(rec.audits, [
      { event: 'opencode-update-rollback', ok: true },
      { event: 'opencode-update-failed', ok: false },
    ]);
  });

  test('boot-fail + FAILED rollback → rolledBack EXPLICITLY false and rollback audit ok:false', async () => {
    const deps = makeDeps({
      boot: async () => null,
      rollback: async () => ({ ok: false, error: 'npm install failed: ECONNREFUSED' }),
    });
    const { fx, rec } = makeFx();

    const res = await runOpencodeApply(deps, fx);

    assert.strictEqual(res.ok, false);
    assert.match(res.error, /rollback to 1\.18\.22 also failed/);
    assert.match(res.error, /npm install failed: ECONNREFUSED/); // rollback detail surfaced
    assert.strictEqual(lastPatch(rec).rolledBack, false, 'rolledBack must be EXPLICITLY false — never left stale');
    assert.strictEqual(lastPatch(rec).applyState, 'failed');
    assert.deepStrictEqual(rec.audits, [
      { event: 'opencode-update-rollback', ok: false },
      { event: 'opencode-update-failed', ok: false },
    ]);
  });

  test('happy path (boot succeeds) → ok, no rollback ever called', async () => {
    let rollbackCalled = false;
    const deps = makeDeps({
      rollback: async () => {
        rollbackCalled = true;
        return { ok: true };
      },
    });
    const { fx, rec } = makeFx();

    const res = await runOpencodeApply(deps, fx);

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.error, '');
    assert.strictEqual(rollbackCalled, false, 'a booted update must never trigger a rollback');
    assert.deepStrictEqual(rec.steps, [
      'start', 'downloaded', 'verified', 'installed', 'restarted', 'boot-ok',
    ]);
    assert.deepStrictEqual(rec.audits, [{ event: 'opencode-update', ok: true }]);
    assert.strictEqual(lastPatch(rec).applyState, 'ok');
    assert.strictEqual(lastPatch(rec).targetVersion, '1.19.0');
    assert.strictEqual(lastPatch(rec).rolledBack, false);
  });

  test('unknown baseline → refuses EARLY: nothing past the probe runs, failed state + audit', async () => {
    const touched: string[] = [];
    const deps = makeDeps({
      probeBaseline: async () => 'unknown',
      currentPid: () => { touched.push('currentPid'); return 1; },
      performUpdate: async () => { touched.push('performUpdate'); return { ok: true }; },
      boot: async () => { touched.push('boot'); return '1.19.0'; },
      rollback: async () => { touched.push('rollback'); return { ok: true }; },
    });
    const { fx, rec } = makeFx();

    const res = await runOpencodeApply(deps, fx);

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, BASELINE_UNKNOWN_ERROR);
    assert.match(res.error, /refusing to update without a rollback baseline/);
    assert.deepStrictEqual(touched, [], 'no update machinery may run without a baseline');
    assert.deepStrictEqual(rec.steps, [], 'state machine never entered');
    assert.strictEqual(lastPatch(rec).applyState, 'failed');
    assert.deepStrictEqual(rec.audits, [{ event: 'opencode-update-failed', ok: false }]);
  });

  test('downgrade gate inside the apply → refuses with no downgrades message, update never starts', async () => {
    let performed = false;
    const deps = makeDeps({
      fetchTarget: async () => '1.18.0', // registry moved DOWN since the route gate
      isDowngrade: (target, baseline) => target !== null && target <= baseline,
      performUpdate: async () => { performed = true; return { ok: true }; },
    });
    const { fx, rec } = makeFx();

    const res = await runOpencodeApply(deps, fx);

    assert.strictEqual(res.ok, false);
    assert.match(res.error, /no downgrades/);
    assert.strictEqual(performed, false, 'downgrade must never reach npm');
    assert.deepStrictEqual(rec.audits, [{ event: 'opencode-update-failed', ok: false }]);
  });

  test('perform failure → failed state + failed audit, no boot/rollback', async () => {
    const deps = makeDeps({
      performUpdate: async () => ({ ok: false, error: 'npm install failed: EACCES' }),
    });
    const { fx, rec } = makeFx();

    const res = await runOpencodeApply(deps, fx);

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'npm install failed: EACCES');
    assert.strictEqual(lastPatch(rec).applyState, 'failed');
    assert.deepStrictEqual(rec.audits, [{ event: 'opencode-update-failed', ok: false }]);
  });

  test('perform {ok:false, bootFailed:true} → the install DID happen, so the boot-fail rollback branch drives rollback with baseline + oldPid', async () => {
    const rollbackCalls: Array<{ version: string; oldPid?: number }> = [];
    const deps = makeDeps({
      currentPid: () => 987,
      performUpdate: async () => ({
        ok: false,
        bootFailed: true,
        error: 'Updated opencode 1.19.0 did not boot within 90s — the supervisor keeps reviving it; check the update log',
      }),
      boot: async () => null, // re-probe agrees the new binary is dead
      rollback: async (version, oldPid) => {
        rollbackCalls.push({ version, oldPid });
        return { ok: true };
      },
    });
    const { fx, rec } = makeFx();

    const res = await runOpencodeApply(deps, fx);

    // A bootFailed perform must NOT be treated as a plain install failure —
    // the pre-refactor contract (perform returned ok:true and the core's own
    // boot probe detected the dead binary) is restored: roll back to baseline.
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /rolled back to 1\.18\.22/);
    assert.strictEqual(rollbackCalls.length, 1, 'bootFailed must trigger exactly one rollback');
    assert.strictEqual(rollbackCalls[0].version, '1.18.22', 'rollback pins the baseline');
    assert.strictEqual(rollbackCalls[0].oldPid, 987, 'rollback boot-checks against the PRE-update pid');
    assert.strictEqual(lastPatch(rec).rolledBack, true);
    assert.strictEqual(lastPatch(rec).applyState, 'failed');
    assert.deepStrictEqual(rec.steps, [
      'start', 'downloaded', 'verified', 'installed', 'restarted',
      'boot-fail', 'rollback-ok',
    ]);
    assert.deepStrictEqual(rec.audits, [
      { event: 'opencode-update-rollback', ok: true },
      { event: 'opencode-update-failed', ok: false },
    ]);
  });

  test('perform {ok:false, bootFailed:true} with a boot that then SUCCEEDS (slow-boot safety net) → ok, no rollback', async () => {
    let rollbackCalled = false;
    const deps = makeDeps({
      performUpdate: async () => ({
        ok: false,
        bootFailed: true,
        error: 'Updated opencode 1.19.0 did not boot within 90s — the supervisor keeps reviving it; check the update log',
      }),
      boot: async () => '1.19.0', // the binary came up just after the internal timeout
      rollback: async () => { rollbackCalled = true; return { ok: true }; },
    });
    const { fx, rec } = makeFx();

    const res = await runOpencodeApply(deps, fx);

    assert.strictEqual(res.ok, true);
    assert.strictEqual(rollbackCalled, false, 'a live binary must never roll back — the re-probe is the safety net');
    assert.deepStrictEqual(rec.steps, [
      'start', 'downloaded', 'verified', 'installed', 'restarted', 'boot-ok',
    ]);
    assert.strictEqual(lastPatch(rec).applyState, 'ok');
  });

  test('perform plain {ok:false} (no bootFailed) NEVER rolls back — npm never ran install/restart', async () => {
    const touched: string[] = [];
    const deps = makeDeps({
      performUpdate: async () => ({ ok: false, error: 'npm install failed: EACCES' }),
      boot: async () => { touched.push('boot'); return '1.19.0'; },
      rollback: async () => { touched.push('rollback'); return { ok: true }; },
    });
    const { fx, rec } = makeFx();

    const res = await runOpencodeApply(deps, fx);

    assert.strictEqual(res.ok, false);
    assert.deepStrictEqual(touched, [], 'a plain install failure never probes boot nor rolls back');
    assert.strictEqual(lastPatch(rec).applyState, 'failed');
    assert.deepStrictEqual(rec.audits, [{ event: 'opencode-update-failed', ok: false }]);
  });

  test('baseline is persisted into the state as currentVersion once known', async () => {
    const { fx, rec } = makeFx();
    const res = await runOpencodeApply(makeDeps(), fx);
    assert.strictEqual(res.ok, true);
    const current = rec.patches.find((p) => 'currentVersion' in p);
    assert.deepStrictEqual(current, { currentVersion: '1.18.22' });
  });
});