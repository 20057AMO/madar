/**
 * projects-cache-core.ts
 * Madar — PURE, import-free stale-while-revalidate cache + singleflight
 * factory behind the project-LIST cache (like storage-core / janitor-core /
 * serve-core): no service imports, so `node --test` can load it offline and
 * drive the exact factory the server uses.
 *
 * The Docker-wired singleton (real builder + lifecycle invalidation wiring)
 * lives in projects-cache.ts and re-exports this factory.
 *
 * Contracts:
 *  - TTL: default 3s, env `WSD_PROJECTS_LIST_TTL_MS`, floored at 500ms so
 *    production can never flip the endpoint into a sub-500ms Docker/file
 *    stampede. Inside the window the SAME reference is served. Once expired,
 *    the stale value is returned immediately while ONE background refresh
 *    runs; the refreshed value is observed by the next read.
 *  - Singleflight: concurrent callers share ONE in-flight build (a cold call
 *    waits for it; a stale call never does).
 *  - Atomic swap: the full value is built first and only then cached —
 *    partial data is never observable. A rejected refresh keeps the last-good
 *    snapshot; a rejected cold build is never cached and the next call retries.
 *  - Generation guard: a build started before invalidate() cannot repopulate
 *    the cache afterward; the next generation gets its own singleflight.
 */

export const PROJECTS_CACHE_DEFAULT_TTL_MS = 3_000;
export const PROJECTS_CACHE_MIN_TTL_MS = 500;

export interface ProjectsCache<T> {
  /** Cached (or freshly built) value; concurrent callers share one build. */
  get(): Promise<T>;
  /** Drop the cached snapshot — call after any project-list lifecycle change. */
  invalidate(): void;
  /** Introspection helper (tests + debugging). */
  debug(): { cacheAt: number | null; ttlMs: number; refreshing: boolean };
}

/**
 * Factory: stale-while-revalidate cache + singleflight around an async builder.
 * `ttlMs` may be passed explicitly; otherwise it falls back to the
 * `WSD_PROJECTS_LIST_TTL_MS` env knob, then the 3s default — both paths are
 * clamped to PROJECTS_CACHE_MIN_TTL_MS. `now` is only injected by tests.
 */
export function createProjectsCache<T>(
  builder: () => Promise<T>,
  opts?: { ttlMs?: number; now?: () => number }
): ProjectsCache<T> {
  const ttlMs = Math.max(
    PROJECTS_CACHE_MIN_TTL_MS,
    opts?.ttlMs ?? (Number(process.env.WSD_PROJECTS_LIST_TTL_MS) || PROJECTS_CACHE_DEFAULT_TTL_MS)
  );
  const now = opts?.now ?? Date.now;
  let cache: { at: number; data: T } | null = null;
  let generation = 0;
  let inflight: { generation: number; promise: Promise<T> } | null = null;

  const liveInflight = (): boolean => inflight !== null && inflight.generation === generation;

  function start(gen: number): Promise<T> {
    let p: Promise<T>;
    try {
      p = Promise.resolve(builder()).then((data) => {
        // Swap only after the FULL value resolved — never partial data.
        if (generation === gen) cache = { at: now(), data };
        return data;
      });
    } catch (err) {
      p = Promise.reject(err);
    }
    p = p.finally(() => {
      if (inflight?.promise === p) inflight = null;
    });
    // Consume the rejection for the background caller without swallowing it
    // from the cold caller awaiting this very promise.
    void p.catch(() => undefined);
    inflight = { generation: gen, promise: p };
    return p;
  }

  return {
    get(): Promise<T> {
      if (cache !== null && now() - cache.at < ttlMs) return Promise.resolve(cache.data);
      if (cache !== null) {
        const stale = cache.data;
        if (!liveInflight()) start(generation);
        return Promise.resolve(stale);
      }
      if (liveInflight()) return inflight!.promise;
      return start(generation);
    },
    invalidate(): void {
      generation += 1;
      cache = null;
    },
    debug(): { cacheAt: number | null; ttlMs: number; refreshing: boolean } {
      return { cacheAt: cache?.at ?? null, ttlMs, refreshing: liveInflight() };
    },
  };
}
