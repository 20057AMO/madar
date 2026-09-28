import { render } from 'preact';
import { App } from './app';
import './index.css';
import { initPerfMetrics } from './lib/perf-metrics';

/**
 * Boot shim for the hash router: the server hands out the SPA shell for every
 * unmatched path, so a bare /ide or /opencode boots with an empty hash and
 * silently lands on the Dashboard. Fold such a path into the hash before the
 * first render so documented links behave like in-app navigation, keeping the
 * query after the hash (both embedded views read ?folder= / ?project= there).
 * Real server namespaces, file-looking paths and already-hashed URLs are left
 * alone, and a failure here must never block the boot.
 */
function normalizeBootPath() {
  try {
    const { pathname, search, hash } = window.location;
    if (pathname === '/' || hash) return;
    if (pathname.startsWith('/api/') || pathname.startsWith('/assets/')) return;
    if (pathname.slice(pathname.lastIndexOf('/') + 1).includes('.')) return;
    window.history.replaceState(null, '', `/#${pathname}${search}`);
  } catch {
    /* keep booting */
  }
}

normalizeBootPath();

// Real timing capture for Settings → Performance: shell Navigation Timing +
// FCP. Must never delay or break boot (initPerfMetrics is fully guarded).
initPerfMetrics();

render(<App />, document.getElementById('app')!);
