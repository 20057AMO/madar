/**
 * One-shot guard for the stale-chunk failure. A tab left open across a
 * rebuild keeps the pre-deploy module graph, so a lazy route resolves to a
 * chunk URL the new build never had and the whole app dies on the rejection.
 * Reloading once is the only cure (the document re-reads the shell and learns
 * the new hashed names) — but the guard has to make a SECOND reload
 * impossible, or a genuinely broken build would reload forever.
 *
 * The key holds `<shell>|<failure>`, and a guard that is PRESENT at all blocks
 * the next automatic reload — that is what bounds the loop. The shell is the
 * entry chunk of THIS document (read from the DOM, so it is available in a
 * stale document too and a rebuild always changes it, since the name is
 * content-hashed):
 *
 *   - Same shell → this document already spent its attempt, so a repeat of the
 *     failure (or any further one) is refused and the caller renders honest
 *     copy. A broken build therefore terminates instead of spinning.
 *   - New shell → a newer build is on disk → the boot hook drops the guard, so a
 *     later failure in the same browser session gets its own attempt (this is
 *     the "clear it on a successful boot" rule: booting a shell the failing
 *     document never had IS the proof that the reload worked).
 *
 * Refusing on presence rather than on an exact match is deliberate: any guard
 * already in sessionStorage means some reload has been spent, and the shell
 * check above — not the failure text — is what decides whether a new attempt is
 * warranted.
 *
 * Without a persistable sessionStorage (private mode) nothing is claimed and
 * nothing reloads: a guard we cannot enforce is a loop we cannot bound.
 */
export const CHUNK_RELOAD_KEY = 'wsd.chunkReload';

/** The one automatic reload was CLAIMED but withheld because this document holds typed input; the app reads it to ask instead of reloading. Written by the inline shell script in index.html (it must catch `vite:preloadError` before any module loads), so this module only reads and clears it — there is deliberately no setter here. Cleared with the guard by the boot hook. */
export const CHUNK_RELOAD_DEFERRED_KEY = 'wsd.chunkReloadDeferred';

export function isChunkReloadDeferred(): boolean {
  try {
    return sessionStorage.getItem(CHUNK_RELOAD_DEFERRED_KEY) === '1';
  } catch {
    return false;
  }
}

export function clearChunkReloadDeferred(): void {
  try {
    sessionStorage.removeItem(CHUNK_RELOAD_DEFERRED_KEY);
  } catch {
    /* nothing persisted */
  }
}

/** The entry script of the running document — the build identity of this boot. */
export function currentShellId(): string {
  try {
    const el = document.querySelector('script[type="module"][src]');
    return (el && el.getAttribute('src')) || window.location.pathname;
  } catch {
    return window.location.pathname;
  }
}

const STALE_CHUNK_RE = /Failed to fetch dynamically imported module|Importing a module script failed/;

/** The loader signature of a chunk that is gone (or is no longer JavaScript). */
export function isStaleChunkError(error: unknown): boolean {
  const e = error as { name?: string; message?: string } | null;
  if (!e || typeof e.message !== 'string') return false;
  const isTypeError = e instanceof TypeError || e.name === 'TypeError';
  return isTypeError && STALE_CHUNK_RE.test(e.message);
}

/**
 * Claim the one automatic reload for this document. False whenever a guard is
 * already spent (the caller must then show honest copy) and false when the
 * guard cannot be persisted at all.
 */
export function claimChunkReload(failure: string): boolean {
  try {
    if (sessionStorage.getItem(CHUNK_RELOAD_KEY)) return false;
    sessionStorage.setItem(CHUNK_RELOAD_KEY, `${currentShellId()}|${failure}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Boot hook: forget a guard left by a shell this document is not. A guard that
 * matches the running shell is deliberately KEPT — that shell already failed
 * once, so the one-shot stays spent. A deferred flag never survives a boot:
 * the document that owed the user a decision is gone.
 */
export function clearChunkReloadGuard(): void {
  try {
    const prev = sessionStorage.getItem(CHUNK_RELOAD_KEY);
    if (!prev || prev.split('|')[0] !== currentShellId()) sessionStorage.removeItem(CHUNK_RELOAD_KEY);
  } catch {
    /* nothing persisted, nothing to clear */
  }
  clearChunkReloadDeferred();
}
