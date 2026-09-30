/**
 * embedded-status-core.ts
 * Madar — PURE, import-free TTL-cache + singleflight factory behind the
 * embedded-IDE (code-server) and opencode-web status probes (like
 * projects-cache-core.ts / serve-core.ts / alerts-core.ts): no net/fs/service
 * imports, so `node --test` loads it offline and drives the exact factory the
 * server uses.
 *
 * Contracts:
 *  - TTL: a probe result is reused for `ttlMs`. Short enough that a process
 *    restart surfaces within seconds, long enough to kill the per-tab probe
 *    storm (every IDE page polls this status on its own timer).
 *  - `ttlMs <= 0` disables caching entirely — every get() probes again (the
 *    singleflight still holds, so concurrent callers never double-probe).
 *  - Singleflight: concurrent callers share ONE in-flight load; a second load
 *    is never queued while the first is still pending.
 *  - Generation guard: an `invalidate()` during an in-flight load must not let
 *    that stale result repopulate the cache.
 *  - A rejected load is never cached; the next get() retries.
 */

export const EMBEDDED_STATUS_DEFAULT_TTL_MS = 4_000;

export interface StatusCache<T> {
  /** Cached (or freshly probed) value; concurrent callers share one load. */
  get(opts?: { fresh?: boolean }): Promise<T>;
  /** Drop the cached snapshot (call after restarting code-server / opencode). */
  invalidate(): void;
  /** Introspection helper (tests + debugging). */
  debug(): { cacheAt: number | null; ttlMs: number };
}

export interface StatusCacheOptions<T> {
  ttlMs: number;
  load: () => Promise<T>;
  /** Injectable clock so TTL expiry is unit-testable without sleeping. */
  now?: () => number;
}

export function createStatusCache<T>(opts: StatusCacheOptions<T>): StatusCache<T> {
  const now = opts.now || Date.now;
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : 0;
  let cache: { at: number; data: T } | null = null;
  let inflight: Promise<T> | null = null;
  let generation = 0;

  return {
    get(freshOpts?: { fresh?: boolean }): Promise<T> {
      const fresh = ttlMs <= 0 || !!freshOpts?.fresh;
      if (!fresh && !inflight && cache && now() - cache.at < ttlMs) {
        return Promise.resolve(cache.data);
      }
      if (inflight) return inflight;
      const gen = generation;
      inflight = opts.load()
        .then((data) => {
          // An invalidate() that landed mid-flight bumps the generation — that
          // result is already stale, so it must NOT refill the cache.
          if (gen === generation && ttlMs > 0) cache = { at: now(), data };
          return data;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
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

/**
 * Effective port for an embedded service from its env knob. Junk — missing,
 * blank, non-digits, 0, negative, fractional or out of the 1-65535 range —
 * degrades to `fallback` instead of poisoning a URL/socket with NaN.
 */
export function resolveEmbeddedPort(raw: string | undefined, fallback: number): number {
  const trimmed = String(raw ?? '').trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const port = Number(trimmed);
  if (port < 1 || port > 65535) return fallback;
  return port;
}

/**
 * Host interface the AUTHENTICATED embedded-surface proxy is published on
 * (compose `WSD_EMBEDDED_PUBLISH_HOST`). The raw code-server / opencode
 * publishes are GONE: those upstreams are bound to 127.0.0.1 inside the app
 * container and reachable only through the proxy, which demands an editor+
 * Madar session. So this knob no longer widens an anonymous surface — it
 * decides whether the LAN (or only the host itself) may reach the IDE and
 * opencode, over a route that authenticates first. Unset/blank degrades to
 * loopback, the conservative answer.
 */
export function resolveEmbeddedPublishHost(raw: string | undefined): string {
  return String(raw ?? '').trim() || '127.0.0.1';
}

/** True when the proxy is published beyond this host's loopback. */
export function isLanReachableHost(raw: string | undefined): boolean {
  const host = resolveEmbeddedPublishHost(raw).toLowerCase();
  return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
}
