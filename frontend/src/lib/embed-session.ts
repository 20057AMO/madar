import { useEffect, useState } from 'preact/hooks';
import { ensureEmbedSession } from '../api';

/**
 * Gate the two embedded tool pages on the proxy credential.
 *
 * The IDE and opencode now live behind the authenticated Madar proxy, which
 * reads an HttpOnly cookie. An iframe `src` cannot carry the session's
 * Authorization header, so the cookie has to be in place BEFORE the frame
 * mounts — otherwise the very first load races the exchange and comes back
 * 401, which the frame contract would report as an "error" overlay.
 *
 * `ready` therefore joins the pages' existing "has the status endpoint answered
 * yet" condition: both still show their honest "checking…" state instead of a
 * spinner or a fake failure. A 403 (a viewer) resolves `ready` as false with
 * `forbidden`, which is the state the pages already render for "this tool is
 * not available to you".
 */
export function useEmbedSession(active: boolean): { ready: boolean; forbidden: boolean } {
  const [ready, setReady] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    ensureEmbedSession()
      .then(() => {
        if (cancelled) return;
        setReady(true);
        setForbidden(false);
      })
      .catch((err: any) => {
        if (cancelled) return;
        // 403 is a decision, not a failure: the viewer state is final.
        if (err?.status === 403 || /Editor access required/i.test(err?.message || '')) {
          setForbidden(true);
          return;
        }
        // A transport failure is retried by the caller's status poll, so the
        // cookie can still land on the next tick — leave `ready` false.
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  return { ready, forbidden };
}
