/**
 * projects-cache.test.ts
 * Offline unit coverage for the GET /api/projects TTL cache + singleflight
 * (services/projects-cache.ts). No server, no Docker — the factory is driven
 * with a fake builder that counts invocations, exactly like
 * project-limits-core.test.ts / storage-core.test.ts.
 *
 * Proves the three contracts the endpoint depends on:
 *  - TTL: a fresh call after the window expires rebuilds; within the window
 *    the SAME reference is served without re-running the builder.
 *  - Singleflight: concurrent callers share ONE in-flight build (asserted via
 *    a builder counter), even while a build is being held open.
 *  - Invalidation: invalidate() clears the cache so the next call rebuilds.
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

  test('TTL expiry triggers a rebuild on the next call', async () => {
    let calls = 0;
    const cache = createProjectsCache(async () => ({ version: ++calls }), { ttlMs: 500 });

    const a = await cache.get();
    assert.strictEqual(a.version, 1);
    await sleep(650); // outlive the 500ms TTL
    const b = await cache.get();
    assert.strictEqual(b.version, 2, 'fresh call after TTL rebuilds');
    assert.notStrictEqual(b, a, 'expired entry is replaced, not reused');
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
});