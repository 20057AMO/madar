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
import { withFileLock, withFileLockAsync, chainKeyCount } from '../src/services/write-queue.ts';

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

/* ── settled-key cleanup (the unbounded-chain-map nit) ─────────────────── */

// The chain map is keyed by project slug / document key / …, so on a
// long-lived server it accumulated ONE settled promise per key forever and
// never shrank. The symptom is invisible on its own (a slow leak), which is
// why these rows assert on the map size rather than on timing.
describe('write-queue · chain map does not grow without bound', () => {
  test('a settled key is released instead of pinning a promise forever', async () => {
    const before = chainKeyCount();
    await withFileLockAsync('cleanup-settled', async () => {});
    // The delete runs in a `then` AFTER our await resolves, so let the
    // microtask queue drain before counting.
    await delay(5);
    assert.strictEqual(chainKeyCount(), before, 'a fully settled key must be removed from the chain map');
  });

  test('a REJECTED key is released too (a throw must not pin it forever)', async () => {
    const before = chainKeyCount();
    await withFileLockAsync('cleanup-rejected', async () => { throw new Error('boom'); }).catch(() => {});
    await delay(5);
    assert.strictEqual(chainKeyCount(), before, 'a rejected key must be removed once it is the tail again');
  });

  test('many distinct keys leave nothing behind', async () => {
    const before = chainKeyCount();
    for (let i = 0; i < 200; i++) {
      await withFileLockAsync(`cleanup-many-${i}`, async () => {});
    }
    await delay(5);
    assert.strictEqual(chainKeyCount(), before, '200 one-shot keys must not leave 200 entries');
  });

  test('a key with a LATER waiter is NOT deleted — removing it would strand the queue', async () => {
    // This is the row that pins the dangerous half of the fix. The cleanup is
    // guarded by `chains.get(key) === guard`, so when a second caller has
    // already chained onto the first, the entry must survive. Deleting it would
    // let a third caller start concurrently with the second — the lost update
    // the whole module exists to prevent.
    let order: string[] = [];
    const first = withFileLockAsync('cleanup-strand', async () => {
      order.push('first-start');
      await delay(20);
      order.push('first-end');
    });
    const second = withFileLockAsync('cleanup-strand', async () => {
      order.push('second');
    });
    await delay(1);
    // While the second caller is queued the key MUST be present.
    assert.ok(chainKeyCount() > 0, 'a queued key must stay in the map');
    await Promise.all([first, second]);
    await delay(5);
    assert.deepStrictEqual(order, ['first-start', 'first-end', 'second'], 'the two writers stayed serialized');
    assert.strictEqual(chainKeyCount(), 0, 'and the key is released once nobody is waiting');
  });
});
