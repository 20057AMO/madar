/**
 * projects-cache.test.ts
 * Offline unit coverage for the GET /api/projects cache + singleflight
 * (services/projects-cache.ts). No server, no Docker — the factory is driven
 * with a fake builder that counts invocations, exactly like
 * project-limits-core.test.ts / storage-core.test.ts.
 *
 * Proves the contracts the endpoint depends on:
 *  - TTL / stale-while-revalidate: a fresh read reuses the SAME reference;
 *    once expired the stale value is served immediately and a single refresh
 *    runs in the background (injected clock, no real sleeps).
 *  - Singleflight: concurrent callers share ONE in-flight build (asserted via
 *    a builder counter), even while a build is being held open.
 *  - Invalidation: invalidate() clears the cache so the next call rebuilds,
 *    including while a background refresh is still in flight.
 *  - Never partial data: the cache is swapped only after the builder resolves;
 *    a rejected build is never cached and the next call retries.
 *  - Hygiene: the TTL is floored at 500ms and honors the env knob.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
// The import-free core (same pattern as storage-core/serve-core tests): the
// exact factory the server singleton in projects-cache.ts is wired to, loaded
// offline without dragging Docker in.
import { createProjectsCache } from '../src/services/projects-cache-core.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SENTINEL = Symbol('immediate');

/** Injected clock + a builder whose resolution/rejection the test drives. */
function harness<T>(ttlMs: number) {
  let clock = 1_000;
  let calls = 0;
  const pending: Array<{ resolve: (value: T) => void; reject: (error: Error) => void }> = [];
  const cache = createProjectsCache<T>(() => {
    calls += 1;
    return new Promise<T>((resolve, reject) => pending.push({ resolve, reject }));
  }, { ttlMs, now: () => clock });
  return {
    cache,
    get calls() {
      return calls;
    },
    advance(ms: number) {
      clock += ms;
    },
    immediate: () => new Promise<typeof SENTINEL>((r) => setImmediate(() => r(SENTINEL))),
    settle: () => new Promise<void>((r) => setImmediate(r)),
    release(value: T) {
      const build = pending.shift();
      assert.ok(build, 'a build is waiting');
      build.resolve(value);
    },
    fail(error: Error) {
      const build = pending.shift();
      assert.ok(build, 'a build is waiting');
      build.reject(error);
    },
  };
}

describe('createProjectsCache (TTL + singleflight)', () => {
  test('serves the SAME cached value within TTL without re-running the builder', async () => {
    let calls = 0;
    const cache = createProjectsCache(async () => {
      calls += 1;
      return [{ slug: 'a' }, { slug: 'b' }];
    }, { ttlMs: 500 });

    const first = await cache.get();
    const second = await cache.get();
    assert.deepStrictEqual(first, [{ slug: 'a' }, { slug: 'b' }]);
    assert.strictEqual(second, first, 'cached reference reused while fresh');
    assert.strictEqual(calls, 1, 'builder ran exactly once inside the TTL window');
  });

  test('singleflight: N concurrent callers share one in-flight build', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const cache = createProjectsCache(async () => {
      calls += 1;
      await gate; // hold the build open so every caller lands on the inflight branch
      return { slug: 'held', value: calls };
    }, { ttlMs: 500 });

    const p1 = cache.get();
    const p2 = cache.get();
    const p3 = cache.get();
    await sleep(15); // let all three reach the singleflight branch
    assert.strictEqual(calls, 1, 'one shared in-flight promise for N concurrent callers');
    release();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.deepStrictEqual(r1, { slug: 'held', value: 1 });
    assert.strictEqual(r2, r1, 'concurrent caller B resolved the same array');
    assert.strictEqual(r3, r1, 'concurrent caller C resolved the same array');
  });

  test('expired entry is served stale immediately and revalidated in the background', async () => {
    const h = harness<string>(500);
    const first = h.cache.get();
    h.release('A');
    await first;
    assert.strictEqual(h.cache.debug().cacheAt, 1_000);

    h.advance(501);
    const got = h.cache.get();
    assert.strictEqual(await Promise.race([got, h.immediate()]), 'A', 'stale value wins over the immediate sentinel');
    assert.strictEqual(h.calls, 2, 'the refresh started in the background');
    assert.strictEqual(h.cache.debug().refreshing, true, 'background refresh is visible');
    assert.strictEqual(h.cache.debug().cacheAt, 1_000, 'the stale stamp is kept until refresh resolves');

    h.release('B');
    await h.settle();
    assert.strictEqual(h.cache.debug().cacheAt, 1_501, 'cacheAt advances with the refresh');
    assert.strictEqual(h.cache.debug().refreshing, false, 'refresh slot is released');
    assert.strictEqual(await h.cache.get(), 'B', 'the next read observes the refreshed value');
    assert.strictEqual(h.calls, 2, 'no extra build for that read');
  });

  test('invalidation clears the cache so the next call rebuilds', async () => {
    let calls = 0;
    const cache = createProjectsCache(async () => ({ version: ++calls }), { ttlMs: 500 });

    const first = await cache.get();
    assert.strictEqual(first.version, 1);
    assert.strictEqual(cache.debug().cacheAt !== null, true);

    cache.invalidate();
    assert.strictEqual(cache.debug().cacheAt, null, 'invalidate drops the entry');

    const after = await cache.get();
    assert.strictEqual(after.version, 2);
    assert.strictEqual(calls, 2, 'invalidate forces a rebuild');
  });

  test('invalidation during a build prevents its stale result from repopulating the cache', async () => {
    let calls = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const cache = createProjectsCache(async () => {
      const version = ++calls;
      if (calls === 1) await firstGate;
      return { version };
    }, { ttlMs: 500 });

    const staleBuild = cache.get();
    cache.invalidate();
    const freshBuild = cache.get();
    assert.strictEqual(calls, 2, 'a new build starts for the invalidated generation');

    releaseFirst();
    assert.deepStrictEqual(await staleBuild, { version: 1 });
    assert.deepStrictEqual(await freshBuild, { version: 2 });
    assert.deepStrictEqual(await cache.get(), { version: 2 });
    assert.strictEqual(calls, 2, 'the invalidated build did not overwrite the fresh cache');
  });

  test('never serves partial data: cache is empty while the build is in flight', async () => {
    let calls = 0;
    const cache = createProjectsCache(async () => {
      calls += 1;
      await sleep(30);
      return { slug: 'full', items: [1, 2, 3] };
    }, { ttlMs: 500 });

    const p = cache.get();
    assert.strictEqual(cache.debug().cacheAt, null, 'nothing cached mid-build');
    const r = await p;
    assert.deepStrictEqual(r, { slug: 'full', items: [1, 2, 3] });
    assert.strictEqual(typeof cache.debug().cacheAt, 'number', 'swap happens only after full resolution');
    assert.strictEqual(calls, 1);
  });

  test('a failed build is never cached and the next call retries', async () => {
    let calls = 0;
    const cache = createProjectsCache(async () => {
      calls += 1;
      if (calls === 1) throw new Error('docker down');
      return { ok: true };
    }, { ttlMs: 500 });

    await assert.rejects(() => cache.get(), /docker down/);
    assert.strictEqual(cache.debug().cacheAt, null, 'rejected build never pollutes the cache');
    const r = await cache.get();
    assert.deepStrictEqual(r, { ok: true });
    assert.strictEqual(calls, 2, 'next call retries cleanly');
  });

  test('ttlMs clamps to the 500ms floor and the env knob drives the default', async () => {
    const clamped = createProjectsCache(async () => ({}), { ttlMs: 1 });
    assert.strictEqual(clamped.debug().ttlMs, 500, 'below-floor TTL is clamped');

    const prev = process.env.WSD_PROJECTS_LIST_TTL_MS;
    process.env.WSD_PROJECTS_LIST_TTL_MS = '1200';
    try {
      const envTtl = createProjectsCache(async () => ({}));
      assert.strictEqual(envTtl.debug().ttlMs, 1200, 'env knob honored when no explicit ttl');

      process.env.WSD_PROJECTS_LIST_TTL_MS = 'junk';
      const junkTtl = createProjectsCache(async () => ({}));
      assert.strictEqual(junkTtl.debug().ttlMs, 3000, 'junk env falls back to the default');
    } finally {
      if (prev === undefined) delete process.env.WSD_PROJECTS_LIST_TTL_MS;
      else process.env.WSD_PROJECTS_LIST_TTL_MS = prev;
    }
  });

  test('concurrent stale reads join one refresh and get the same stale reference', async () => {
    const h = harness<{ version: number }>(500);
    const first = h.cache.get();
    h.release({ version: 1 });
    const good = await first;

    h.advance(501);
    const p1 = h.cache.get();
    const p2 = h.cache.get();
    const p3 = h.cache.get();
    assert.strictEqual(await Promise.race([p1, h.immediate()]), good, 'caller A is not blocked');
    assert.strictEqual(await Promise.race([p2, h.immediate()]), good, 'caller B is not blocked');
    assert.strictEqual(await Promise.race([p3, h.immediate()]), good, 'caller C is not blocked');
    assert.strictEqual(h.calls, 2, 'all stale callers share one refresh');

    h.release({ version: 2 });
    await h.settle();
    assert.strictEqual((await h.cache.get()).version, 2, 'the next read sees the refreshed list');
    assert.strictEqual(h.calls, 2, 'no extra build was started');
  });

  test('invalidate during a background refresh makes the next read cold and never repopulates stale', async () => {
    const h = harness<{ version: number }>(500);
    const first = h.cache.get();
    h.release({ version: 1 });
    await first;

    h.advance(501);
    const stale = h.cache.get();
    assert.strictEqual(await Promise.race([stale, h.immediate()]).then((v) => v.version), 1);

    h.cache.invalidate();
    assert.strictEqual(h.cache.debug().cacheAt, null, 'invalidate drops the stale entry');
    assert.strictEqual(h.cache.debug().refreshing, false, 'old generation is no longer a live refresh');
    const cold = h.cache.get();
    assert.strictEqual(h.calls, 3, 'the next read is a cold build, not a join on the old refresh');

    h.release({ version: 99 });
    await h.settle();
    assert.strictEqual(h.cache.debug().cacheAt, null, 'the invalidated refresh cannot repopulate the cache');
    h.release({ version: 2 });
    assert.strictEqual((await cold).version, 2);
    assert.strictEqual(h.cache.debug().cacheAt, 1_501);
    assert.strictEqual((await h.cache.get()).version, 2);
  });

  test('a failed background refresh keeps the last-good value and retries on a later stale read', async () => {
    const h = harness<{ version: number }>(500);
    const first = h.cache.get();
    h.release({ version: 1 });
    const good = await first;

    h.advance(501);
    const stale = h.cache.get();
    assert.strictEqual(await Promise.race([stale, h.immediate()]), good);
    h.fail(new Error('docker down'));
    await h.settle();
    assert.strictEqual(h.cache.debug().cacheAt, 1_000, 'failed refresh keeps the old stamp');
    assert.strictEqual(h.cache.debug().refreshing, false, 'the rejected refresh frees its slot');

    const retry = h.cache.get();
    assert.strictEqual(await Promise.race([retry, h.immediate()]), good, 'last-good value still served');
    assert.strictEqual(h.calls, 3, 'a stale read after the failure retries the refresh');
    h.release({ version: 2 });
    await h.settle();
    assert.strictEqual(h.cache.debug().cacheAt, 1_501);
    assert.strictEqual((await h.cache.get()).version, 2);
  });

  test('debug().refreshing reflects the active build and clears when it settles', async () => {
    const h = harness<number>(500);
    const cold = h.cache.get();
    assert.strictEqual(typeof h.cache.debug().refreshing, 'boolean');
    assert.strictEqual(h.cache.debug().refreshing, true, 'cold build is reported');
    h.release(1);
    await cold;
    assert.strictEqual(h.cache.debug().refreshing, false, 'cold build settled');

    h.advance(501);
    const stale = h.cache.get();
    assert.strictEqual(await Promise.race([stale, h.immediate()]), 1);
    assert.strictEqual(h.cache.debug().refreshing, true, 'background refresh is reported');
    h.release(2);
    await h.settle();
    assert.strictEqual(h.cache.debug().refreshing, false, 'background refresh settled');
  });
});
