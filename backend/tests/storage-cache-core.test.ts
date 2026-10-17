/**
 * storage-cache-core.test.ts
 * Madar — offline unit coverage for the pure TTL-cache + dual-slot
 * singleflight rules (createStorageCache) that back GET /api/storage. No
 * server, no Docker, no filesystem — the clock is injected and every load is
 * resolved by hand, so TTL and in-flight behaviour are asserted without
 * sleeping. Mirrors embedded-status-core.test.ts.
 *
 * Contract:
 *  - Concurrent non-fresh get() calls share ONE in-flight load (singleflight);
 *    concurrent get({fresh:true}) calls share ONE FRESH load — the fresh slot
 *    exists so N simultaneous ?fresh=1 requests cost exactly one scan.
 *  - Fresh never joins a non-fresh load and non-fresh never joins a fresh
 *    load; each side has its own slot.
 *  - Both slots are tagged with the generation captured when their load
 *    STARTED; a caller only joins a slot of the CURRENT generation, so
 *    invalidate() during an in-flight load orphans it — later callers start a
 *    new load and never receive the pre-invalidate value.
 *  - A result is reused while `now() - cachedAt < ttlMs`; at the boundary and
 *    beyond, the next get() reloads. A fresh scan populates the cache too, so
 *    non-fresh callers reuse it inside the TTL.
 *  - invalidate() drops the cache; an invalidate() landing during an in-flight
 *    load must not let that stale result repopulate (generation guard).
 *  - A rejected load propagates to every sharer of its slot and is never
 *    cached; the next get() retries.
 *  - ttlMs <= 0 disables caching (every idle get() reloads) but keeps both
 *    singleflights.
 *  - debug() reports hasCache / cachedAt / inflight honestly.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createStorageCache } from '../src/services/storage-cache-core.ts';

/** Injectable clock + a load whose resolution the test drives by hand. */
function harness(ttlMs: number) {
  let clock = 1_000;
  let calls = 0;
  const pending: Array<() => void> = [];
  const cache = createStorageCache<string>({
    ttlMs,
    now: () => clock,
    load: () => {
      calls += 1;
      const value = `v${calls}`;
      return new Promise<string>((resolve) => pending.push(() => resolve(value)));
    },
  });
  return {
    cache,
    get calls() {
      return calls;
    },
    advance(ms: number) {
      clock += ms;
    },
    /** Resolve every load still in flight, then let the microtasks drain. */
    async settle() {
      while (pending.length > 0) pending.shift()!();
      await new Promise((r) => setImmediate(r));
    },
    /** Resolve one specific in-flight load (FIFO index), then drain. */
    async settleAt(index: number) {
      const [resolve] = pending.splice(index, 1);
      resolve();
      await new Promise((r) => setImmediate(r));
    },
  };
}

describe('createStorageCache — singleflight', () => {
  test('N concurrent get() calls trigger exactly ONE load and share its value', async () => {
    const h = harness(45_000);
    const all = [h.cache.get(), h.cache.get(), h.cache.get(), h.cache.get(), h.cache.get()];
    assert.strictEqual(h.calls, 1, 'concurrent callers must share the in-flight load');
    await h.settle();
    assert.deepStrictEqual(await Promise.all(all), ['v1', 'v1', 'v1', 'v1', 'v1']);
    assert.strictEqual(h.calls, 1);
  });

  test('N concurrent get({fresh:true}) calls share ONE fresh scan — cold and warm cache', async () => {
    const h = harness(45_000);

    // Cold: no cache at all — five fresh callers must still cost ONE scan
    // (the security regression guard for the ?fresh=1 fan-out).
    const cold = [
      h.cache.get({ fresh: true }),
      h.cache.get({ fresh: true }),
      h.cache.get({ fresh: true }),
      h.cache.get({ fresh: true }),
      h.cache.get({ fresh: true }),
    ];
    assert.strictEqual(h.calls, 1, 'concurrent fresh callers must share ONE fresh scan');
    await h.settle();
    assert.deepStrictEqual(await Promise.all(cold), ['v1', 'v1', 'v1', 'v1', 'v1']);

    // Warm: the fresh scan above populated the cache, yet a fresh burst still
    // costs exactly ONE new scan — not five.
    const warm = [
      h.cache.get({ fresh: true }),
      h.cache.get({ fresh: true }),
      h.cache.get({ fresh: true }),
      h.cache.get({ fresh: true }),
      h.cache.get({ fresh: true }),
    ];
    assert.strictEqual(h.calls, 2, 'a fresh burst on a warm cache adds exactly ONE scan');
    await h.settle();
    assert.deepStrictEqual(await Promise.all(warm), ['v2', 'v2', 'v2', 'v2', 'v2']);
    assert.strictEqual(h.calls, 2);
  });

  test('a non-fresh get() during an in-flight fresh load starts its OWN load — the slots never cross-join', async () => {
    const h = harness(10_000);
    const fresh = h.cache.get({ fresh: true });
    const inflight = h.cache.get();
    assert.strictEqual(h.calls, 2, 'a non-fresh caller must not ride the fresh slot (nor the reverse)');
    assert.strictEqual(h.cache.debug().inflight, true);

    // Settle the FRESH load first — the non-fresh caller must keep waiting.
    await h.settleAt(0);
    assert.strictEqual(await fresh, 'v1');
    assert.strictEqual(h.cache.debug().inflight, true, 'the non-fresh load is still in flight');

    await h.settle();
    assert.strictEqual(await inflight, 'v2', 'the non-fresh caller gets its own scan result');
    assert.strictEqual(h.calls, 2);
    assert.strictEqual(h.cache.debug().inflight, false);
  });
});

describe('createStorageCache — TTL', () => {
  test('a second get() inside the window is served from the cache without a new load', async () => {
    const h = harness(4_000);
    const first = h.cache.get();
    await h.settle();
    assert.strictEqual(await first, 'v1');

    const second = h.cache.get();
    assert.strictEqual(h.calls, 1, 'inside the TTL the scan is not repeated');
    assert.strictEqual(await second, 'v1');
  });

  test('the cached value is reused until the deadline, then the next get() reloads', async () => {
    const h = harness(1_000);
    const first = h.cache.get();
    await h.settle();
    assert.strictEqual(await first, 'v1');

    h.advance(999);
    const almost = h.cache.get();
    assert.strictEqual(h.calls, 1, 'one millisecond before the deadline the cache still holds');
    assert.strictEqual(await almost, 'v1');

    h.advance(1); // exactly at ttlMs — now() - cachedAt >= ttlMs
    const expired = h.cache.get();
    assert.strictEqual(h.calls, 2, 'at the boundary the cached value is expired');
    await h.settle();
    assert.strictEqual(await expired, 'v2');
  });

  test('get({fresh:true}) while idle forces a reload past a warm cache', async () => {
    const h = harness(10_000);
    const first = h.cache.get();
    await h.settle();
    assert.strictEqual(await first, 'v1');

    const warm = h.cache.get();
    await h.settle();
    assert.strictEqual(await warm, 'v1');
    assert.strictEqual(h.calls, 1, 'the warm window must not re-scan');

    const fresh = h.cache.get({ fresh: true });
    assert.strictEqual(h.calls, 2, 'fresh while idle starts its own load even though the cache is warm');
    await h.settle();
    assert.strictEqual(await fresh, 'v2');
    assert.strictEqual(h.cache.debug().hasCache, true);
  });

  test('fresh during an in-flight load starts its OWN load; both settle independently', async () => {
    const h = harness(10_000);
    const inflight = h.cache.get();
    const fresh = h.cache.get({ fresh: true });
    assert.strictEqual(h.calls, 2, 'fresh must not join the in-flight load');
    assert.strictEqual(h.cache.debug().inflight, true);

    // Settle the FRESH load first — the original must keep waiting on its own.
    await h.settleAt(1);
    // Value separation: the fresh caller receives its OWN scan's value and
    // never the non-fresh load's (nor vice versa below).
    assert.strictEqual(await fresh, 'v2');
    assert.strictEqual(h.cache.debug().inflight, true, 'the original load is still in flight');

    await h.settle();
    assert.strictEqual(await inflight, 'v1', 'the original caller still gets its own load result');
    assert.strictEqual(h.calls, 2);
    assert.strictEqual(h.cache.debug().inflight, false);
  });

  test('a fresh load warms the cache — a non-fresh get() inside the TTL reuses it without a new scan', async () => {
    const h = harness(10_000);
    const fresh = h.cache.get({ fresh: true });
    assert.strictEqual(h.calls, 1);
    await h.settle();
    assert.strictEqual(await fresh, 'v1');
    assert.strictEqual(h.cache.debug().hasCache, true, 'a fresh scan populates the cache');

    const warm = h.cache.get();
    assert.strictEqual(h.calls, 1, 'inside the TTL the fresh scan is reused, not repeated');
    assert.strictEqual(await warm, 'v1');
  });

  test('ttlMs <= 0 disables caching but keeps the singleflight', async () => {
    for (const ttl of [0, -5]) {
      const h = harness(ttl);
      const a = h.cache.get();
      const b = h.cache.get();
      assert.strictEqual(h.calls, 1, `ttlMs ${ttl}: concurrent getters must still share one load`);
      await h.settle();
      assert.deepStrictEqual(await Promise.all([a, b]), ['v1', 'v1']);
      assert.strictEqual(h.cache.debug().hasCache, false, `ttlMs ${ttl}: nothing is ever cached`);

      const c = h.cache.get();
      assert.strictEqual(h.calls, 2, `ttlMs ${ttl}: every idle get() reloads`);
      await h.settle();
      assert.strictEqual(await c, 'v2');
      assert.strictEqual(h.cache.debug().hasCache, false);
    }
  });
});

describe('createStorageCache — invalidate', () => {
  test('invalidate() drops the warm snapshot; the next get() reloads', async () => {
    const h = harness(10_000);
    const first = h.cache.get();
    await h.settle();
    assert.strictEqual(await first, 'v1');
    assert.strictEqual(h.cache.debug().hasCache, true);

    h.cache.invalidate();
    assert.strictEqual(h.cache.debug().hasCache, false);
    assert.strictEqual(h.cache.debug().cachedAt, null);

    const second = h.cache.get();
    assert.strictEqual(h.calls, 2, 'the next get() reloads after invalidate');
    await h.settle();
    assert.strictEqual(await second, 'v2');
  });

  test('invalidate() mid-flight discards that result — it can never repopulate the cache', async () => {
    const h = harness(10_000);
    const inflight = h.cache.get();
    h.cache.invalidate();
    await h.settle();
    assert.strictEqual(await inflight, 'v1', 'the in-flight caller still gets its value');
    assert.strictEqual(h.cache.debug().hasCache, false, 'a post-invalidate result must not refill the cache');

    const next = h.cache.get();
    assert.strictEqual(h.calls, 2, 'the next get() reloads instead of trusting the stale fill');
    await h.settle();
    assert.strictEqual(await next, 'v2');
    assert.strictEqual(h.cache.debug().hasCache, true);
  });

  test('a non-fresh get() after invalidate() does NOT join the pre-invalidate in-flight load', async () => {
    const h = harness(10_000);
    const first = h.cache.get(); // load 1, generation 0
    h.cache.invalidate(); // generation 1 — load 1 is now orphaned

    let secondValue: string | null = null;
    const second = h.cache.get().then((v) => {
      secondValue = v;
      return v;
    });
    assert.strictEqual(h.calls, 2, 'the post-invalidate caller must start a NEW load, not join the orphaned one');

    // Settle the OLD (generation-0) load first — the new caller must not see it.
    await h.settleAt(0);
    assert.strictEqual(await first, 'v1', 'the original caller still gets its own result');
    assert.strictEqual(secondValue, null, 'the new caller must never receive the stale pre-invalidate value');

    await h.settle();
    assert.strictEqual(await second, 'v2', 'the new caller receives the new load result');
    assert.strictEqual(h.calls, 2);
  });

  test('a get({fresh:true}) after invalidate() does NOT join the pre-invalidate fresh load', async () => {
    const h = harness(10_000);
    const first = h.cache.get({ fresh: true }); // fresh load 1, generation 0
    h.cache.invalidate(); // generation 1 — the fresh load 1 is now orphaned

    let secondValue: string | null = null;
    const second = h.cache.get({ fresh: true }).then((v) => {
      secondValue = v;
      return v;
    });
    assert.strictEqual(h.calls, 2, 'the post-invalidate fresh caller starts its own fresh load');

    await h.settleAt(0);
    assert.strictEqual(await first, 'v1', 'the original fresh caller still gets its own result');
    assert.strictEqual(secondValue, null, 'the new fresh caller must never receive the stale value');

    await h.settle();
    assert.strictEqual(await second, 'v2', 'the new fresh caller receives the new load result');
    assert.strictEqual(h.calls, 2);
  });
});

describe('createStorageCache — failures', () => {
  test('a rejected load propagates to every sharer and is never cached; the next get() retries', async () => {
    let calls = 0;
    const cache = createStorageCache<boolean>({
      ttlMs: 10_000,
      load: async () => {
        calls += 1;
        if (calls === 1) throw new Error('scan exploded');
        return true;
      },
    });

    const a = cache.get();
    const b = cache.get();
    await assert.rejects(() => a, /scan exploded/);
    await assert.rejects(() => b, /scan exploded/);
    assert.strictEqual(calls, 1, 'both sharers share ONE failing load');
    assert.strictEqual(cache.debug().hasCache, false, 'a failed load must not be cached');
    assert.strictEqual(cache.debug().inflight, false);

    assert.strictEqual(await cache.get(), true, 'the next get() retries and can succeed');
    assert.strictEqual(calls, 2);
    assert.strictEqual(cache.debug().hasCache, true);
  });
});

describe('createStorageCache — debug', () => {
  test('debug() reports hasCache / cachedAt / inflight honestly across transitions', async () => {
    const h = harness(1_000);
    assert.deepStrictEqual(h.cache.debug(), { hasCache: false, cachedAt: null, inflight: false });

    const p = h.cache.get();
    assert.deepStrictEqual(h.cache.debug(), { hasCache: false, cachedAt: null, inflight: true });
    await h.settle();
    await p;
    assert.deepStrictEqual(h.cache.debug(), { hasCache: true, cachedAt: 1_000, inflight: false });

    const warm = h.cache.get();
    assert.deepStrictEqual(h.cache.debug(), { hasCache: true, cachedAt: 1_000, inflight: false });
    await warm;

    h.cache.invalidate();
    assert.deepStrictEqual(h.cache.debug(), { hasCache: false, cachedAt: null, inflight: false });
  });
});
