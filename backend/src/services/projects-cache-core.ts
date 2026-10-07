/**
 * projects-cache-core.ts
 * Madar — PURE, import-free TTL-cache + singleflight factory behind the
 * project-LIST cache (like storage-core / janitor-core / serve-core): no
 * service imports, so `node --test` can load it offline and drive the exact
 * factory the server uses.
 *
 * The Docker-wired singleton (real builder + lifecycle invalidation wiring)
 * lives in projects-cache.ts and re-exports this factory.
 *
 * Contracts:
 *  - TTL: default 3s, env `WSD_PROJECTS_LIST_TTL_MS`, floored at 500ms so
 *    production can never flip the endpoint into a sub-500ms Docker/file
 *    stampede. Within the window the SAME reference is served; after expiry
 *    the next call rebuilds.
 *  - Singleflight: concurrent callers share ONE in-flight build.
 *  - Atomic swap: the full value is built first and only then cached —
 *    partial data is never observable. A rejected build is never cached and
 *    the next call retries.
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
  debug(): { cacheAt: number | null; ttlMs: number };
}

/**
 * Factory: TTL cache + singleflight around an async builder.
 * `ttlMs` may be passed explicitly; otherwise it falls back to the
 * `WSD_PROJECTS_LIST_TTL_MS` env knob, then the 3s default — both paths are
 * clamped to PROJECTS_CACHE_MIN_TTL_MS.
 */
export function createProjectsCache<T>(
  builder: () => Promise<T>,
  opts?: { ttlMs?: number }
): ProjectsCache<T> {
  const ttlMs = Math.max(
    PROJECTS_CACHE_MIN_TTL_MS,
    opts?.ttlMs ?? (Number(process.env.WSD_PROJECTS_LIST_TTL_MS) || PROJECTS_CACHE_DEFAULT_TTL_MS)
  );
  let cache: { at: number; data: T } | null = null;
  let generation = 0;
  let inflight: { generation: number; promise: Promise<T> } | null = null;

  return {
    get(): Promise<T> {
      if (!inflight && cache && Date.now() - cache.at < ttlMs) return Promise.resolve(cache.data);
      if (inflight?.generation === generation) return inflight.promise;
      const buildGeneration = generation;
      const promise = builder()
        .then((data) => {
          // Swap only after the FULL value resolved — never partial data.
          if (generation === buildGeneration) cache = { at: Date.now(), data };
          return data;
        })
        .finally(() => {
          if (inflight?.promise === promise) inflight = null;
        });
      inflight = { generation: buildGeneration, promise };
      return promise;
    },
    invalidate(): void {
      generation += 1;
      cache = null;
    },
    debug(): { cacheAt: number | null; ttlMs: number } {
      return { cacheAt: cache?.at ?? null, ttlMs };
    },
  };
}