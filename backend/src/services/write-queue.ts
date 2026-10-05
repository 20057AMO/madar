/**
 * write-queue.ts
 * Madar — Per-key write serialization for JSON stores.
 *
 * Prevents lost concurrent updates: two async handlers that both
 * read→modify→write the same file will be serialized through the
 * promise chain so the second read always sees the first write.
 *
 * Design:
 *   Module-level Map<string, Promise> tail-chaining — each call appends
 *   to the previous promise for that key and returns the chained result.
 *   Different keys run independently (no global bottleneck).
 *
 * Error handling:
 *   If fn throws, the error propagates to the caller but the chain is
 *   NOT poisoned — the next caller still runs.
 *
 * Non-reentrant:
 *   Never call withFileLockAsync from inside an active lock on the
 *   same key (would deadlock on the promise chain). The internal
 *   helpers use the raw/unlocked write functions to avoid this.
 *
 * Sync/async share one key namespace, so the two variants must agree on one
 * invariant: **an async holder must never keep the lock across an `await`.**
 * A synchronous `fn` cannot wait for a pending promise (there is no blocking
 * `await` in JS), so if withFileLockAsync suspended mid-mutator, an interleaved
 * withFileLock call would run immediately and the resumed async write would
 * then persist its pre-await document — the lost-update class.
 *
 * That invariant is now ENFORCED, not merely documented: updateMetaAsync runs
 * its whole load→mutate→save window without an await and throws when handed a
 * thenable mutator (it used to `await` unconditionally, which opened the
 * window for a synchronous mutator too). Async work is resolved BEFORE the
 * lock is taken — updateProjectLimits calls getHostInfo first and validates
 * with checkCeilingsSync inside it.
 */

const chains = new Map<string, Promise<unknown>>();

/**
 * Synchronous variant — for purely synchronous fn. In single-threaded
 * Node.js, truly sync code between two calls cannot interleave, so this runs
 * fn directly; the "async-holder never awaits" invariant above is what makes
 * the fast path safe, and updateMetaAsync now enforces it by refusing a
 * thenable mutator. Deliberately NOT a deferred enqueue: running fn inside
 * `prev.then(...)` would always resolve on a later microtask, so a caller
 * could not get fn's return value synchronously (and a naive fallback would
 * execute fn twice). The real protection against interleaved async handlers
 * is withFileLockAsync plus that enforced invariant.
 */
export function withFileLock<T>(key: string, fn: () => T): T {
  return fn();
}

/**
 * Asynchronous variant — the real serialization primitive.
 * Tail-chains async operations per key. Each call awaits the previous
 * operation on the same key before running fn.
 *
 * ```ts
 * await withFileLockAsync('meta:my-slug', async () => {
 *   const meta = loadMeta('my-slug');
 *   await doSomethingAsync();
 *   meta.field = 'value';
 *   saveMeta('my-slug', meta);
 * });
 * ```
 */
export async function withFileLockAsync<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  let result!: T;
  // A flag, not a sentinel: `undefined` is a legal rejection reason, and
  // testing the caught value against it would resolve that failure as a
  // success — a silently dropped write in the only serialization primitive.
  let threw = false;
  let thrownError: unknown;

  const next = prev.then(async () => {
    try {
      result = await fn();
    } catch (e) {
      threw = true;
      thrownError = e;
    }
  });

  // Swallow rejections to keep the chain alive for subsequent callers.
  chains.set(key, next.catch(() => {}));

  await next;
  if (threw) throw thrownError;
  return result;
}
