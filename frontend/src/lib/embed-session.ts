import { useEffect, useState } from 'preact/hooks';
import { clearEmbedSessionCookie, ensureEmbedSession } from '../api';

/**
 * Gate the two embedded tool pages on the proxy credential.
 *
 * The IDE and opencode now live behind the authenticated Madar proxy, which
 * reads an HttpOnly cookie. An iframe `src` cannot carry the session's
 * Authorization header, so the cookie has to be in place BEFORE the frame
 * mounts — otherwise the very first load races the exchange, comes back 401,
 * and the frame contract reports it as a "did not load" overlay for a tool
 * that is running perfectly well.
 *
 * The exchange is therefore a MODULE-level single flight, not a per-component
 * effect: the app-level warm-up, the hidden /ide layer (+3.5s) and the hidden
 * /opencode layer (+5.5s) all subscribe to one answer, so a page load mints the
 * cookie once instead of three times. That matters because every mint is an
 * audited `embed-session` entry against a 100-entry cap that has to keep the
 * real security events.
 *
 * A failure is a STATE, not a silent stall: `error` is exposed so both pages can
 * say what failed and offer a Retry, with bounded automatic backoff underneath.
 * A 403 (a viewer) is a decision, not a failure — `forbidden` is final and is
 * never retried automatically.
 */

export interface EmbedSessionState {
  /** The proxy credential exists — the frame may mount. */
  ready: boolean;
  /** This account may not use the embedded surfaces at all (a viewer). */
  forbidden: boolean;
  /** The exchange failed (429/500/transport). Retryable, never silent. */
  error: string | null;
  /** Re-run the exchange now (also clears a stale `forbidden`). */
  retry: () => void;
}

const RETRY_BASE_MS = 1500;
const RETRY_MAX_MS = 20_000;
/** Automatic retries before the honest error state + Retry button take over. */
const AUTO_RETRIES = 3;

let ready = false;
let forbidden = false;
let error: string | null = null;
let attempt = 0;
let inflight: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
// Bumped by clearEmbedSession(): an exchange that was still in flight when the
// user signed out must not resurrect `ready` afterwards.
let generation = 0;
const listeners = new Set<() => void>();

function publish(): void {
  for (const fn of listeners) fn();
}

function cancelRetry(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function isForbidden(err: any): boolean {
  return err?.status === 403 || /Editor access required/i.test(err?.message || '');
}

function reset(): void {
  cancelRetry();
  ready = false;
  forbidden = false;
  error = null;
  attempt = 0;
}

function scheduleRetry(): void {
  cancelRetry();
  if (attempt >= AUTO_RETRIES) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void exchange();
  }, Math.min(RETRY_BASE_MS * Math.pow(2, attempt), RETRY_MAX_MS));
}

function exchange(): Promise<void> {
  if (inflight) return inflight;
  if (ready || forbidden) return Promise.resolve();
  const gen = generation;
  inflight = ensureEmbedSession()
    .then(() => {
      if (gen !== generation) return;
      ready = true;
      forbidden = false;
      error = null;
      attempt = 0;
    })
    .catch((err: any) => {
      if (gen !== generation) return;
      ready = false;
      attempt += 1;
      if (isForbidden(err)) {
        // A decision, not a failure: the viewer state is final.
        forbidden = true;
        error = null;
        attempt = 0;
        return;
      }
      error = err?.message || 'The server did not answer';
      scheduleRetry();
    })
    .finally(() => {
      if (gen !== generation) return;
      inflight = null;
      publish();
    });
  return inflight;
}

/**
 * Re-run the exchange now. A credential that is already in place is left alone
 * (a frame retry must not re-mint the cookie and add audit noise); only a failed
 * or forbidden exchange is actually retried, and a stale `forbidden` is cleared
 * first so a promoted user gets a fresh answer.
 */
function retry(): void {
  cancelRetry();
  attempt = 0;
  const alreadyReady = ready;
  forbidden = false;
  error = null;
  publish();
  if (!alreadyReady) void exchange();
}

/**
 * Subscribe to the credential and kick the exchange off when `active`.
 *
 * `active` false means "this user has no business here" (a viewer at the app
 * level), so nothing is minted; the pages pass true because a viewer still needs
 * the 403 answer to render its honest "not available to you" state.
 */
export function useEmbedSession(active: boolean): EmbedSessionState {
  const [, bump] = useState(0);
  useEffect(() => {
    const notify = () => bump((n) => n + 1);
    listeners.add(notify);
    // The exchange can land between this component's render and this effect, and
    // that publish would have no listener — re-read once on subscribe so a
    // settled answer can never leave a page stuck on "checking…".
    notify();
    return () => {
      listeners.delete(notify);
    };
  }, []);
  useEffect(() => {
    if (active) void exchange();
  }, [active]);
  return { ready, forbidden, error, retry };
}

/**
 * Sign-out path: drop the 12-hour proxy cookie and reset the singleton, so a
 * browser left on a shared machine cannot reach /ide or /opencode on the proxy
 * after logout or an idle timeout, and the next sign-in runs a fresh exchange.
 *
 * The revoke request is fire-and-forget and tolerates a 404 (the route is
 * optional — an older backend simply has nothing to clear), because failing to
 * clear the cookie must never block signing out.
 */
export function clearEmbedSession(): void {
  generation += 1;
  inflight = null;
  reset();
  publish();
  clearEmbedSessionCookie().catch(() => {});
}
