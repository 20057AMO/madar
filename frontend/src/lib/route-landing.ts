import { useEffect } from 'preact/hooks';

/**
 * The post-login route restore swaps the page without the user asking, leaving
 * a screen-reader user with no cue and the keyboard on <body>. This module owns
 * both halves of that one transition: name the destination once in a polite
 * live region, and hand focus to its heading — only if focus was already lost.
 * The focus rule mirrors useFrameFocusReturn in frame-load.ts (transition-scoped,
 * body-gated, cancellable) so it can never loop or steal focus from a live editor.
 */

/** Fired once, on the shell, the moment a restored route is committed. */
export const ROUTE_LANDING_EVENT = 'wsd:route-landing';

/** ~1s of frames: long enough for a lazy route chunk to resolve and mount. */
const LANDING_MAX_FRAMES = 60;

/** ~0.5s spent insisting on the destination's HEADING before its landmark is offered. */
const LANDING_HEADING_FRAMES = 30;

export function routePath(route: string): string {
  return (route || '').split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';
}

/** Reuses existing dictionary entries; a project page and the terminal hub carry inline copy. */
export function routeLabel(
  route: string,
  t: (key: string) => string,
  t2: (ar: string, en: string) => string,
): string {
  const path = routePath(route);
  const keys: Record<string, string> = {
    '/': 'nav.dashboard',
    '/projects': 'nav.projects',
    '/chat': 'nav.teamChat',
    '/planner': 'nav.planner',
    '/agents': 'nav.agents',
    '/ide': 'nav.vscode',
    '/opencode-studio': 'nav.ocStudio',
    '/providers': 'nav.providers',
    '/team': 'nav.team',
    '/settings': 'nav.settings',
    '/profile': 'common.profile',
  };
  if (keys[path]) return t(keys[path]);
  if (path === '/opencode') return 'opencode';
  // The cold directory deep link /opencode/<base64url> — without this branch
  // the destination had no label at all and the announcement read "now on ".
  if (path.startsWith('/opencode/')) return t2('جلسة opencode', 'opencode session');
  // A project page names itself as soon as its own heading has real text; until
  // then (chunk still loading) the generic label stands in.
  if (path.startsWith('/project/')) return landedProjectName(t) || t2('المشروع', 'Project');
  if (path.startsWith('/user/')) return t('common.profile');
  if (path.startsWith('/terminals')) return t2('الطرفيات', 'Terminals');
  return '';
}

/** The project page's own <h1> once it holds a name rather than the loading placeholder. */
function landedProjectName(t: (key: string) => string): string {
  const el = document.querySelector<HTMLElement>('main h1.detail-title');
  if (!el || el.closest('[inert]')) return '';
  const text = (el.textContent || '').trim();
  if (!text || text === t('common.loading')) return '';
  return text;
}

export function announceRouteLanding(route: string): void {
  if (!route) return;
  try {
    window.dispatchEvent(new CustomEvent<string>(ROUTE_LANDING_EVENT, { detail: route }));
  } catch {
    /* never break the restore over the announcement */
  }
}

/**
 * `inert` (a full-screen tool layer owns the screen) and display:none (a
 * parked keep-alive layer still holds its heading) are skipped — focusing
 * either is a silent no-op that strands the user just like doing nothing.
 *
 * Two passes, headings first: `<main tabindex="-1">` is the document-order
 * ANCESTOR of every page heading, so a single querySelectorAll handed the
 * landmark back first and the heading branch was unreachable. The landmark is
 * only offered once the heading grace is spent — the lazy route chunk has
 * usually not mounted on the first frame, and a landmark resolved from the
 * Suspense fallback beat the real heading to it.
 */
function resolveLandingTarget(allowLandmark: boolean): HTMLElement | null {
  for (const selector of allowLandmark ? ['main h1, h1', 'main[tabindex]'] : ['main h1, h1']) {
    const candidates = document.querySelectorAll<HTMLElement>(selector);
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (!el.isConnected || el.closest('[inert]')) continue;
      if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
      return el;
    }
  }
  return null;
}

/** `seq` keeps two restores of the SAME route distinct events, while the object staying put across the destination's re-renders keeps the focus effect from restarting its wait. */
export interface RouteLanding {
  route: string;
  seq: number;
}

/** One handoff per object identity, bounded by LANDING_MAX_FRAMES so a page that never mounts cannot leave a rAF loop running. */
export function useRouteFocusReturn(landing: RouteLanding | null): void {
  useEffect(() => {
    if (!landing) return;
    let raf = 0;
    let frames = 0;
    let touched: HTMLElement | null = null;
    let addedTabIndex = false;
    const settle = () => {
      const target = resolveLandingTarget(frames >= LANDING_HEADING_FRAMES);
      if (target) {
        if (document.activeElement === document.body) {
          // Only remembered when we ADDED it: `el.tabIndex` reads -1 both for an
          // ABSENT attribute and for an explicit one, so hasAttribute is the only
          // way to tell "mine to undo" from "the page's own". The cleanup then
          // restores absence instead of stranding the heading with an invented -1
          // (or stripping one the page had chosen).
          if (!touched && !target.hasAttribute('tabindex')) {
            target.tabIndex = -1;
            addedTabIndex = true;
          }
          touched = target;
          target.focus();
        }
        return;
      }
      if (++frames < LANDING_MAX_FRAMES) raf = requestAnimationFrame(settle);
    };
    raf = requestAnimationFrame(settle);
    return () => {
      cancelAnimationFrame(raf);
      if (addedTabIndex && touched && touched.isConnected) touched.removeAttribute('tabindex');
    };
  }, [landing]);
}
