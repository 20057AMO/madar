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
  if (path.startsWith('/project/')) return t2('المشروع', 'Project');
  if (path.startsWith('/user/')) return t('common.profile');
  if (path.startsWith('/terminals')) return t2('الطرفيات', 'Terminals');
  return '';
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
 */
function resolveLandingTarget(): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>('main h1, h1, main[tabindex]');
  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];
    if (!el.isConnected || el.closest('[inert]')) continue;
    if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
    return el;
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
    const settle = () => {
      const target = resolveLandingTarget();
      if (target) {
        if (document.activeElement === document.body) {
          target.tabIndex = -1;
          target.focus();
        }
        return;
      }
      if (++frames < LANDING_MAX_FRAMES) raf = requestAnimationFrame(settle);
    };
    raf = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(raf);
  }, [landing]);
}
