/**
 * write-queue.test.ts
 * Pure unit coverage for the per-key write-serialization primitives
 * (withFileLock / withFileLockAsync). Fully offline — no server, no Docker.
 *
 * Verifies:
 *   - withFileLock (sync) runs fn and returns its result
 *   - withFileLockAsync chains N concurrent ops on the same key → exactly N
 *     increments (no lost updates)
 *   - concurrent async saves from two "users" preserve both fields
 *   - different keys run independently (no cross-blocking)
 *   - an error in one call does not poison the chain for the next caller
 *   - a rejection whose reason is falsy (undefined / 0 / '' / null / false /
 *     NaN) still propagates as a failure instead of resolving as a success
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { withFileLock, withFileLockAsync } from '../src/services/write-queue.ts';

/* ── Helpers ─────────────────────────────────────────────────────────── */

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ── withFileLock (sync) ─────────────────────────────────────────────── */

describe('withFileLock (sync)', () => {
  test('runs fn and returns the result', () => {
    const result = withFileLock('sync-basic', () => 42);
    assert.strictEqual(result, 42);
  });

  test('different keys run independently', () => {
    const log: string[] = [];
    withFileLock('sa', () => log.push('a'));
    withFileLock('sb', () => log.push('b'));
    assert.deepStrictEqual(log, ['a', 'b']);
  });

  test('propagates thrown errors', () => {
    assert.throws(
      () => withFileLock('sync-throw', () => { throw new Error('boom'); }),
      { message: 'boom' },
    );
  });
});

/* ── withFileLockAsync ───────────────────────────────────────────────── */

describe('withFileLockAsync', () => {
  test('N concurrent increments over same key produce exactly N (no lost updates)', async () => {
    let counter = 0;
    const N = 50;

    const promises: Promise<void>[] = [];
    for (let i = 0; i < N; i++) {
      promises.push(
        withFileLockAsync('counter', async () => {
          // Read-modify-write — if serialization is broken, increments are lost.
          const snapshot = counter;
          // Yield to the event loop to increase interleaving surface.
          await delay(0);
          counter = snapshot + 1;
        }),
      );
    }

    await Promise.all(promises);
    assert.strictEqual(counter, N, `expected ${N} increments, got ${counter}`);
  });

  test('concurrent saves from two "users" preserve both fields', async () => {
    const doc: Record<string, string> = {};

    await Promise.all([
      withFileLockAsync('doc', async () => {
        await delay(0);
        doc.userA = 'alice';
      }),
      withFileLockAsync('doc', async () => {
        await delay(0);
        doc.userB = 'bob';
      }),
    ]);

    assert.strictEqual(doc.userA, 'alice', 'userA field missing');
    assert.strictEqual(doc.userB, 'bob', 'userB field missing');
  });

  test('different keys do not block each other', async () => {
    const events: string[] = [];

    // Key X: start, 10ms delay, end
    const xDone = withFileLockAsync('dx', async () => {
      events.push('x-start');
      await delay(10);
      events.push('x-end');
    });

    // Key Y: runs immediately (independent chain)
    const yDone = withFileLockAsync('dy', async () => {
      events.push('y-start');
      events.push('y-end');
    });

    await Promise.all([xDone, yDone]);

    // Y must complete (both events) before X ends
    const yEnd = events.indexOf('y-end');
    const xEnd = events.indexOf('x-end');
    assert.ok(yEnd < xEnd, `y-end (idx ${yEnd}) should precede x-end (idx ${xEnd})`);
  });

  test('error in fn does not poison the chain for the next caller', async () => {
    let lastValue = 0;

    // First call throws
    const p1 = withFileLockAsync('poison', async () => {
      throw new Error('boom');
    }).catch(() => { /* swallow */ });

    // Second call on same key must still run
    const p2 = withFileLockAsync('poison', async () => {
      lastValue = 42;
    });

    await Promise.all([p1, p2]);
    assert.strictEqual(lastValue, 42, 'second call should execute despite first call throwing');
  });

  test('returns the value produced by fn', async () => {
    const result = await withFileLockAsync('ret', async () => 'hello');
    assert.strictEqual(result, 'hello');
  });

  test('propagates errors from fn to the caller', async () => {
    await assert.rejects(
      () => withFileLockAsync('rej', async () => { throw new Error('fail'); }),
      { message: 'fail' },
    );
  });

  test('a rejection whose reason is undefined still surfaces as a failure', async () => {
    let outcome = 'pending';
    await withFileLockAsync('undef-reason', async () => {
      throw undefined;
    }).then(
      () => { outcome = 'resolved'; },
      () => { outcome = 'rejected'; },
    );
    assert.strictEqual(
      outcome, 'rejected',
      'a rejection with an undefined reason must not resolve as a success',
    );
  });

  test('a falsy non-undefined reason (0 / "" / null / false) still propagates', async () => {
    for (const reason of [0, '', null, false, NaN]) {
      let outcome = 'pending';
      await withFileLockAsync(`falsy-${String(reason)}`, async () => {
        throw reason;
      }).then(
        () => { outcome = 'resolved'; },
        () => { outcome = 'rejected'; },
      );
      assert.strictEqual(outcome, 'rejected', `reason ${String(reason)} was swallowed`);
    }
  });

  test('an undefined-reason rejection does not poison the chain', async () => {
    let ran = false;
    const first = withFileLockAsync('undef-poison', async () => {
      throw undefined;
    }).catch(() => { /* swallow */ });
    const second = withFileLockAsync('undef-poison', async () => {
      ran = true;
    });
    await Promise.all([first, second]);
    assert.strictEqual(ran, true, 'next caller must still run after an undefined-reason rejection');
  });
});
