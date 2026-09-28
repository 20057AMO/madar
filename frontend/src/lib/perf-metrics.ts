/**
 * perf-metrics.ts
 * Madar — real timing instrumentation for the surfaces the load-performance
 * work targets: the SPA shell (boot → interactive) and the two embedded tool
 * frames (VS Code + opencode — mount → iframe `load`).
 *
 * Design constraints (in priority order):
 *  1. Never break a page: every entry point is wrapped, no observer throws
 *     out of `main.tsx`, and the module is inert on unsupported browsers.
 *  2. Nothing is sent anywhere — measurements live in localStorage
 *     (`wsd.perf`) and are rendered by Settings → Performance.
 *  3. Cheap: one PerformanceObserver instance for the whole session, buffers
 *     capped, entries coalesced via a module-scoped store.
 *
 * Measurements taken:
 *  - Shell: `responseEnd - startTime` (shell fetch — 0 for a service-worker
 *    hit), FCP when available, `domContentLoadedEventEnd`, and the full
 *    `loadEventEnd`. Recorded ONCE per page load.
 *  - Tool frames: `performance.now()` at the iframe `src` assignment → the
 *  frame's `load` event. That includes the status-probe round-trip, the DNS
 *  + TCP + TLS to the tool origin and the tool's own first render — exactly
 *  the path the Early Hints / service-worker / prefetch work optimizes.
 */

const PERF_KEY = 'wsd.perf';
const MAX_HISTORY = 20;
const MAX_SHELL = 30;

export interface ShellPerf {
  at: number;
  /** Total document fetch, 0 when served from the service worker cache. */
  shellTransferMs: number;
  /** First Contentful Paint, null when the browser doesn't report it. */
  fcpMs: number | null;
  /** DOMContentLoaded — the app shell is parsed and Preact mounts. */
  domContentLoadedMs: number;
  /** Full load (fonts, late assets) — null while the page is still loading. */
  loadMs: number | null;
  /** True when the shell document came from the service-worker cache. */
  fromCache: boolean;
}

export interface FramePerf {
  at: number;
  /** status-probe → iframe `load`. The user-facing "tool is usable" number. */
  totalMs: number;
  /** Status probe duration — the status API fetch before mounting. */
  probeMs: number;
  /** tool origin connect + first response (total − probe − paint budget). */
  frameMs: number;
  /** True when the frame errored instead of loading (timeout path). */
  errored: boolean;
}

export interface PerfStore {
  shell: ShellPerf[];
  ide: FramePerf[];
  opencode: FramePerf[];
}

function emptyStore(): PerfStore {
  return { shell: [], ide: [], opencode: [] };
}

function readStore(): PerfStore {
  try {
    const raw = localStorage.getItem(PERF_KEY);
    if (!raw) return emptyStore();
    const parsed = JSON.parse(raw) as Partial<PerfStore>;
    return {
      shell: Array.isArray(parsed.shell) ? parsed.shell.slice(-MAX_SHELL) : [],
      ide: Array.isArray(parsed.ide) ? parsed.ide.slice(-MAX_HISTORY) : [],
      opencode: Array.isArray(parsed.opencode) ? parsed.opencode.slice(-MAX_HISTORY) : [],
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(store: PerfStore): void {
  try {
    localStorage.setItem(PERF_KEY, JSON.stringify(store));
  } catch {
    /* private mode / full — metrics are never worth an error */
  }
}

/** All recorded samples, oldest → newest. Read-only copy for the UI. */
export function readPerfMetrics(): PerfStore {
  const s = readStore();
  return { shell: [...s.shell], ide: [...s.ide], opencode: [...s.opencode] };
}

/** Drop every recorded sample (Settings → "Clear measurements"). */
export function clearPerfMetrics(): void {
  writeStore(emptyStore());
}

function pushShell(sample: ShellPerf): void {
  const store = readStore();
  store.shell = [...store.shell, sample].slice(-MAX_SHELL);
  writeStore(store);
}

function pushFrame(kind: 'ide' | 'opencode', sample: FramePerf): void {
  const store = readStore();
  store[kind] = [...store[kind], sample].slice(-MAX_HISTORY);
  writeStore(store);
}

// ── Shell capture (one-shot per page load) ───────────────────────────────

let shellCaptured = false;

function captureShell(): void {
  if (shellCaptured) return;
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  if (!nav) return;
  shellCaptured = true;

  const sample: ShellPerf = {
    at: Date.now(),
    shellTransferMs: Math.max(0, nav.responseEnd - nav.startTime),
    fcpMs: null,
    // A shell served from the service-worker cache can report a 0 DCL (the
    // document completes before the entry is stamped) — keep 0; the UI treats
    // 0 as 'not available' rather than 'instant' for this field.
    domContentLoadedMs: Math.max(0, nav.domContentLoadedEventEnd),
    loadMs: nav.loadEventEnd > 0 ? Math.max(0, nav.loadEventEnd) : null,
    // paintTiming entries are absent on the very first capture tick; patched
    // by the FCP observer below when it fires later in this load.
    fromCache: nav.transferSize === 0 && nav.decodedBodySize > 0,
  };
  pushShell(sample);

  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === 'first-contentful-paint') {
            sample.fcpMs = Math.max(0, entry.startTime);
            // Rewrite the just-pushed sample once FCP lands (same object
            // reference is in the array — cheap in-place patch, no re-sort).
            try {
              const store = readStore();
              const last = store.shell[store.shell.length - 1];
              if (last && Math.abs(last.at - sample.at) < 2000) {
                last.fcpMs = sample.fcpMs;
                writeStore(store);
              }
            } catch {
              /* metrics only */
            }
          }
        }
      });
      po.observe({ type: 'paint', buffered: true });
    } catch {
      /* paint timing unsupported — FCP stays null */
    }
  }
}

/**
 * Install the shell capture. Called from main.tsx after mount; captures at
 * idle (or a 3s fallback so `loadEventEnd` has usually landed) and re-runs
 * `loadMs` capture on the `load` event when the page is still loading.
 */
export function initPerfMetrics(): void {
  if (shellCaptured) return;
  if (typeof performance === 'undefined' || !performance.getEntriesByType) return;
  try {
    captureShell();
    // Patch loadMs once the load event completes (captureShell may run before it).
    if (document.readyState !== 'complete') {
      window.addEventListener('load', () => {
        setTimeout(() => {
          try {
            const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
            if (!nav || nav.loadEventEnd <= 0) return;
            const store = readStore();
            const last = store.shell[store.shell.length - 1];
            if (last && !last.loadMs) {
              last.loadMs = Math.max(0, nav.loadEventEnd);
              writeStore(store);
            }
          } catch {
            /* metrics only */
          }
        }, 0);
      }, { once: true });
    }
  } catch {
    /* never let metrics break boot */
  }
}

// ── Frame capture (VS Code / opencode iframes) ──────────────────────────

export interface FrameTimer {
  /** Call when the iframe `load` event fires (or the load times out). */
  done: (opts?: { errored?: boolean }) => void;
}

/**
 * Start a frame-load measurement. Call this in the same tick the frame's
 * destination URL is chosen (before the iframe mounts) — that is when the
 * user-facing wait actually begins.
 */
export function startFrameTimer(kind: 'ide' | 'opencode', probeMs: number): FrameTimer {
  const t0 = performance.now();
  let finished = false;
  return {
    done({ errored = false } = {}): void {
      if (finished) return;
      finished = true;
      const totalMs = Math.round(performance.now() - t0);
      try {
        pushFrame(kind, {
          at: Date.now(),
          totalMs,
          probeMs: Math.max(0, Math.round(probeMs)),
          frameMs: Math.max(0, totalMs - Math.max(0, Math.round(probeMs))),
          errored,
        });
      } catch {
        /* metrics only */
      }
    },
  };
}

/** Median of an array (rounded) — null on empty. Used by the Settings panel. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const m = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(m);
}
