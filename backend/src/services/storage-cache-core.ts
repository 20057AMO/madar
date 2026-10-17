/**
 * storage-cache-core.ts
 * Madar — PURE, import-free TTL-cache + singleflight factory behind the
 * on-demand storage-metrics scan (like embedded-status-core.ts /
 * projects-cache-core.ts / serve-core.ts): no fs/docker/service imports, so
 * `node --test` loads it offline and drives the exact factory the server uses.
 *
 * Contracts:
 *  - TTL: a scan result is reused while `now() - cachedAt < ttlMs`; at the
 *    boundary and beyond the next get() reloads.
 *  - TWO singleflight slots — one for non-fresh callers, one for fresh
 *    callers — each tagged with the generation captured when its load
 *    STARTED (the same generation-tagging projects-cache-core.ts uses for
 *    its single slot). Decision rules:
 *      · non-fresh get(): serve the warm cache (TTL) if valid; else join the
 *        non-fresh slot ONLY when its generation equals the current one;
 *        else start a new load tagged with the current generation.
 *      · get({fresh:true}): never joins a non-fresh load (the caller asked
 *        for a NEW scan — the in-flight one may predate the mutation that
 *        prompted the refresh); joins the fresh slot ONLY on a generation
 *        match; else starts its own load tagged with the current
 *        generation. So N concurrent fresh callers share ONE fresh scan and
 *        at most two loads run per generation (one non-fresh + one fresh) —
 *        the fresh slot is what keeps `GET /api/storage?fresh=1` from
 *        fanning N concurrent full-tree walks + Docker calls (each up to the
 *        60 s compute ceiling) as a CPU/IO exhaustion vector.
 *  - Generation guard: `invalidate()` bumps the generation, drops the cache
 *    and orphans BOTH slots — an in-flight load of the old generation still
 *    settles for its original callers, but newer callers never join it (the
 *    generation check above) and its result is DISCARDED — never written to
 *    the cache — so a stale scan cannot repopulate. A settled slot is
 *    cleared by its own `finally`, and its clear is identity-guarded so an
 *    orphaned load can never wipe a newer slot that replaced it.
 *  - A fresh load's result POPULATES the cache on settle exactly like a
 *    non-fresh one (unless the generation moved meanwhile).
 *  - A rejected load is never cached; the error propagates to every sharer
 *    of that slot's promise; the slot still clears on settle, so the next
 *    get() retries instead of inheriting the poisoned slot.
 *  - `ttlMs <= 0` disables caching entirely (every idle get() reloads) while
 *    keeping BOTH singleflights.
 *  - `debug()` reports `{hasCache, cachedAt, inflight}` honestly;
 *    `inflight` counts every started-but-unsettled load of any slot.
 */

/** One singleflight slot: the in-flight load promise + the generation it started under. */
interface LoadSlot<T> {
  generation: number;
  promise: Promise<T>;
}

export interface StorageCache<T> {
  /** Cached (or freshly scanned) value; concurrent callers of the same slot share one load. */
  get(opts?: { fresh?: boolean }): Promise<T>;
  /** Drop the cached snapshot (call after any workspace/archive lifecycle change). */
  invalidate(): void;
  /** Introspection helper (tests + debugging). */
  debug(): { hasCache: boolean; cachedAt: number | null; inflight: boolean };
}

export interface StorageCacheOptions<T> {
  ttlMs: number;
  load: () => Promise<T>;
  /** Injectable clock so TTL expiry is unit-testable without sleeping. */
  now?: () => number;
}

export function createStorageCache<T>(opts: StorageCacheOptions<T>): StorageCache<T> {
  const now = opts.now || Date.now;
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : 0;
  let cache: { at: number; data: T } | null = null;
  /** The shared load for NON-fresh callers; fresh callers never join it. */
  let shared: LoadSlot<T> | null = null;
  /** The shared load for FRESH callers; non-fresh callers never join it. */
  let freshSlot: LoadSlot<T> | null = null;
  /** Count of every started-but-unsettled load (both slots), for debug(). */
  let active = 0;
  let generation = 0;

  function beginLoad(): Promise<T> {
    const gen = generation;
    // load() runs FIRST: a synchronous throw escapes cleanly and must never
    // leave `active` permanently inflated (the decrement lives in `finally`,
    // which only exists once a promise does).
    const started = opts.load();
    active += 1;
    return started
      .then((data) => {
        // Generation guard: an invalidate() that landed mid-flight means this
        // result is already stale — it must NOT refill the cache.
        if (gen === generation && ttlMs > 0) cache = { at: now(), data };
        return data;
      })
      .finally(() => {
        active -= 1;
      });
  }

  /**
   * Start a load and publish it as `fresh`'s slot (or the non-fresh one),
   * tagged with the CURRENT generation. The slot is cleared by its own
   * `finally` — identity-guarded so an orphaned pre-invalidate load can
   * never wipe the newer slot that replaced it.
   */
  function startLoad(fresh: boolean): Promise<T> {
    const slotGeneration = generation;
    const started = beginLoad();
    let joined: Promise<T>;
    joined = started.finally(() => {
      const current = fresh ? freshSlot : shared;
      if (current && current.promise === joined) {
        if (fresh) freshSlot = null;
        else shared = null;
      }
    });
    const entry: LoadSlot<T> = { generation: slotGeneration, promise: joined };
    if (fresh) freshSlot = entry;
    else shared = entry;
    return joined;
  }

  return {
    get(getOpts?: { fresh?: boolean }): Promise<T> {
      const fresh = !!getOpts?.fresh;
      if (!fresh && cache && now() - cache.at < ttlMs) return Promise.resolve(cache.data);
      const slot = fresh ? freshSlot : shared;
      if (slot && slot.generation === generation) return slot.promise;
      return startLoad(fresh);
    },
    invalidate(): void {
      generation += 1;
      cache = null;
      // Both slots are orphaned by the generation bump alone: their loads
      // keep running for their original callers, but the generation check in
      // get() stops anyone from joining them, and their results can no
      // longer reach the cache.
    },
    debug(): { hasCache: boolean; cachedAt: number | null; inflight: boolean } {
      return { hasCache: cache !== null, cachedAt: cache?.at ?? null, inflight: active > 0 };
    },
  };
}
