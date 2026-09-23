/**
 * opencode-restart-core.test.ts
 * Pure unit coverage for the supervised opencode web-child restart sequence
 * (runRestartSequence) — the offline heart of the boot-reapply restart fix.
 * Drives the import-free core with injected fakes (mirrors alerts-core /
 * serve-core style); opencode-api.ts binds the REAL primitives (pid file, ps
 * probe, process.kill) to the same interface.
 *
 * Contract:
 *  - No pid on record (after re-sampling the truncate-window-prone read) →
 *    {ok:false, reason:'missing', detail} before any probe/kill.
 *  - The ps probe is retried; all attempts failing → {ok:false, reason:'refused'}.
 *  - SIGTERM alone can be ABSORBED by a young child — death is verified by
 *    polling for a REVIVED pid, and a survivor escalates to SIGKILL only
 *    while the pid is still alive AND still a confirmed opencode child
 *    (pid gone → fall through to the revival poll; identity changed →
 *    {ok:false, reason:'refused', detail:'pid identity changed before SIGKILL'}).
 *  - A never-dying child → {ok:false, reason:'survived'} within the signal
 *    budgets; a dead-but-unrevived child → {ok:false, reason:'no-revival'}.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { runRestartSequence, type RestartPrimitives, type RestartVerdict } from '../src/services/opencode-restart-core.ts';

interface FakeIo {
  pid: number | undefined;
  /** first N pid-file reads report undefined (truncate-window race). */
  pidReadsToFail: number;
  pidReadCalls: number;
  /** first N probe calls report "not ours" (transient ps failure). */
  probesToFail: number;
  probeCalls: number;
  isOurs: boolean;
  /** identity verdict for probe calls after the first (the SIGKILL re-probe). */
  reprobeOurs: boolean;
  signalOrder: Array<'SIGTERM' | 'SIGKILL'>;
  /** which signal flips the pid file to a NEW pid (null = never). */
  reviveOn: 'SIGTERM' | 'SIGKILL' | null;
  nextPid: number;
  /** true → pidGone reports gone BEFORE any SIGKILL (died on SIGTERM). */
  goneBeforeKill: boolean;
  /** false → the original pid is gone after the signals (kill-0 fails). */
  aliveAfterKill: boolean;
  logLines: string[];
}

function makeIo(over: Partial<FakeIo> = {}): { deps: RestartPrimitives; io: FakeIo } {
  const io: FakeIo = {
    pid: 1234,
    pidReadsToFail: 0,
    pidReadCalls: 0,
    probesToFail: 0,
    probeCalls: 0,
    isOurs: true,
    reprobeOurs: true,
    signalOrder: [],
    reviveOn: 'SIGTERM',
    nextPid: 4321,
    goneBeforeKill: false,
    aliveAfterKill: true,
    logLines: [],
    ...over,
  };
  const deps: RestartPrimitives = {
    readPid: () => {
      io.pidReadCalls += 1;
      return io.pidReadCalls <= io.pidReadsToFail ? undefined : io.pid;
    },
    probeIsOurs: async () => {
      io.probeCalls += 1;
      if (io.probeCalls <= io.probesToFail) return false;
      return io.probeCalls === 1 ? io.isOurs : io.reprobeOurs;
    },
    kill: (pid, signal) => {
      io.signalOrder.push(signal);
      if (signal === io.reviveOn) io.pid = io.nextPid;
    },
    pidGone: () => {
      const killSent = io.signalOrder.includes('SIGKILL');
      return killSent ? !io.aliveAfterKill : io.goneBeforeKill;
    },
    // Real tiny sleep keeps the deadline loops honest (no microtask spin) —
    // the "within budget" assertions measure wall time against the injected
    // probeRetryMs/sigtermWaitMs/sigkillWaitMs budgets below.
    sleep: async () => {
      await new Promise((r) => setTimeout(r, 1));
    },
    log: (line) => io.logLines.push(line),
    probeAttempts: 3,
    probeRetryMs: 10,
    sigtermWaitMs: 300,
    sigkillWaitMs: 300,
  };
  return { deps, io };
}

describe('runRestartSequence', () => {
  test('missing: all pid-file samples empty → {ok:false, reason:"missing"} with the honest detail, before any probe/kill', async () => {
    const { deps, io } = makeIo({ pid: undefined });
    const v = await runRestartSequence(deps);
    assert.deepStrictEqual(v, { ok: false, reason: 'missing', detail: 'no supervised opencode pid on record' });
    assert.strictEqual(io.pidReadCalls, 4, 'first sample + 3 re-samples (probeRetryMs cadence) before giving up');
    assert.strictEqual(io.probeCalls, 0, 'no ps probe without a pid');
    assert.deepStrictEqual(io.signalOrder, [], 'no signal without a pid');
    assert.ok(io.logLines.some((l) => l.includes('no supervised opencode pid')), 'log explains the missing pid');
  });

  test('missing retry: first pid-file read lands in the truncate window, second sample succeeds → proceeds to SIGTERM', async () => {
    const { deps, io } = makeIo({ pidReadsToFail: 1 });
    const v = await runRestartSequence(deps);
    assert.ok(io.pidReadCalls >= 2, 'first sample consumed, retry sample succeeded before the revival poll');
    assert.strictEqual(v.ok, true, 'the re-sampled pid proceeds through the probe + SIGTERM');
    assert.deepStrictEqual(io.signalOrder, ['SIGTERM']);
    if (v.ok) assert.strictEqual(v.newPid, io.nextPid, 'revived pid reported');
  });

  test('refused: all ps probes fail → {ok:false, reason:"refused"} with the exact detail, never signalled', async () => {
    const { deps, io } = makeIo({ probesToFail: 99 });
    const v = await runRestartSequence(deps);
    assert.strictEqual(v.ok, false);
    if (!v.ok) {
      assert.strictEqual(v.reason, 'refused');
      assert.strictEqual(v.detail, 'ps probe failed after 3 attempts');
    }
    assert.strictEqual(io.probeCalls, 3, 'all 3 probe attempts consumed');
    assert.deepStrictEqual(io.signalOrder, [], 'a non-opencode pid is never signalled');
  });

  test('transient probe failure: first 2 probes fail, 3rd succeeds → proceeds to SIGTERM', async () => {
    const { deps, io } = makeIo({ probesToFail: 2 });
    const v = await runRestartSequence(deps);
    assert.strictEqual(v.ok, true);
    assert.strictEqual(io.probeCalls, 3, 'three probe attempts before the success');
    assert.deepStrictEqual(io.signalOrder, ['SIGTERM']);
    if (v.ok) assert.strictEqual(v.newPid, io.nextPid, 'revived pid reported');
  });

  test('SIGTERM-dies: child exits on SIGTERM → {ok:true,newPid} with a single signal', async () => {
    const { deps, io } = makeIo({ reviveOn: 'SIGTERM' });
    const v = await runRestartSequence(deps);
    assert.deepStrictEqual(io.signalOrder, ['SIGTERM'], 'SIGTERM alone was enough');
    assert.deepStrictEqual(v, { ok: true, newPid: io.nextPid });
    assert.ok(io.logLines.some((l) => l.includes('exited on SIGTERM')), 'log records the SIGTERM exit');
  });

  test('SIGTERM-absorbed: young child survives → escalates to SIGKILL, order asserted, revived pid returned', async () => {
    const { deps, io } = makeIo({ reviveOn: 'SIGKILL' });
    const v = await runRestartSequence(deps);
    assert.deepStrictEqual(io.signalOrder, ['SIGTERM', 'SIGKILL'], 'SIGTERM first, SIGKILL escalation second');
    assert.deepStrictEqual(v, { ok: true, newPid: io.nextPid });
    assert.ok(io.logLines.some((l) => l.includes('survived SIGTERM')), 'log records the escalation decision');
    assert.ok(io.logLines.some((l) => l.includes('killed with SIGKILL')), 'log records the SIGKILL kill');
  });

  test('never-dies: both signals absorbed → {ok:false, reason:"survived"} within the signal budgets', async () => {
    const { deps, io } = makeIo({ reviveOn: null, aliveAfterKill: true });
    const t0 = Date.now();
    const v = await runRestartSequence(deps);
    const elapsed = Date.now() - t0;
    assert.strictEqual(v.ok, false);
    if (!v.ok) {
      assert.strictEqual(v.reason, 'survived');
      assert.match(v.detail ?? '', /still alive after SIGTERM and SIGKILL/);
    }
    assert.deepStrictEqual(io.signalOrder, ['SIGTERM', 'SIGKILL']);
    assert.ok(elapsed < 2500, `resolved within the injected budgets (${elapsed}ms, budget ~620ms)`);
    assert.ok(io.logLines.some((l) => l.includes('FAILED')), 'the failure is logged');
  });

  test('no-revival: pid died but the supervisor never rewrote the pid file → {ok:false, reason:"no-revival"}', async () => {
    const { deps, io } = makeIo({ reviveOn: null, aliveAfterKill: false });
    const v = await runRestartSequence(deps);
    assert.strictEqual(v.ok, false);
    if (!v.ok) {
      assert.strictEqual(v.reason, 'no-revival');
      assert.match(v.detail ?? '', /no revived child appeared/);
    }
    assert.deepStrictEqual(io.signalOrder, ['SIGTERM', 'SIGKILL']);
    assert.ok(io.logLines.some((l) => l.includes('FAILED')), 'the failure is logged');
  });

  test('refused detail reflects a non-default probeAttempts budget', async () => {
    const { deps, io } = makeIo({ probesToFail: 99 });
    deps.probeAttempts = 2;
    const v: RestartVerdict = await runRestartSequence(deps);
    assert.deepStrictEqual(v, { ok: false, reason: 'refused', detail: 'ps probe failed after 2 attempts' });
    assert.strictEqual(io.probeCalls, 2, 'only the configured attempts run');
  });

  test('SIGKILL gate: pid died on SIGTERM → never signal a gone pid, fall through to the revival poll → no-revival', async () => {
    const { deps, io } = makeIo({ reviveOn: null, goneBeforeKill: true, aliveAfterKill: false });
    const v = await runRestartSequence(deps);
    assert.strictEqual(v.ok, false);
    if (!v.ok) {
      assert.strictEqual(v.reason, 'no-revival');
      assert.match(v.detail ?? '', /no revived child appeared/);
    }
    assert.deepStrictEqual(io.signalOrder, ['SIGTERM'], 'SIGKILL never sent to a dead (possibly recycled) pid');
    assert.strictEqual(io.probeCalls, 1, 'the identity re-probe was skipped entirely (pidGone short-circuits)');
    assert.ok(io.logLines.some((l) => l.includes('survived SIGTERM')), 'log records the escalation decision');
  });

  test('SIGKILL gate: identity changed before SIGKILL → refused with the exact detail, never signalled', async () => {
    const { deps, io } = makeIo({ reviveOn: null, aliveAfterKill: true, reprobeOurs: false });
    const v = await runRestartSequence(deps);
    assert.strictEqual(v.ok, false);
    if (!v.ok) {
      assert.strictEqual(v.reason, 'refused');
      assert.strictEqual(v.detail, 'pid identity changed before SIGKILL');
    }
    assert.deepStrictEqual(io.signalOrder, ['SIGTERM'], 'SIGKILL never sent to an unconfirmed pid');
    assert.ok(io.logLines.some((l) => l.includes('refusing SIGKILL')), 'the refusal is logged');
  });
});