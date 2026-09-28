/**
 * The route a forced bounce to /login interrupted. The app is hash-routed and
 * the ?folder= / ?project= query lives INSIDE the hash, so every raw
 * `location.hash = '/login'` replaced the destination and dropped the user on
 * the Dashboard after signing back in. Capture before such a write, consume
 * once when the session returns.
 */
const KEY = 'wsd.postLoginRoute';
const MAX_LEN = 300;
/** Route + query vocabulary: nothing here can break out of a hash. */
const SAFE_RE = /^\/[A-Za-z0-9\-._~/:?&=%+]*$/;
const ROUTES = [
  '/',
  '/projects',
  '/chat',
  '/planner',
  '/agents',
  '/ide',
  '/opencode',
  '/opencode-studio',
  '/providers',
  '/team',
  '/settings',
  '/profile',
  '/terminals',
];
/** Routes that carry a parameter segment (/project/<slug>, /user/<id>, …). */
const PARAM_PREFIXES = ['/project/', '/user/', '/terminals/', '/opencode/'];

function readHashRoute(): string {
  try {
    return (window.location.hash || '').replace(/^#/, '');
  } catch {
    return '';
  }
}

/** Only a real app route may be remembered — the value becomes a redirect
 *  target after login, so a junk or hostile hash is dropped, not stored. */
function isAppRoute(route: string): boolean {
  if (!route || route.length > MAX_LEN || !SAFE_RE.test(route)) return false;
  const path = route.split('?')[0].replace(/\/+$/, '') || '/';
  if (path === '/login') return false;
  if (ROUTES.includes(path)) return true;
  return PARAM_PREFIXES.some((p) => path.startsWith(p) && path.length > p.length);
}

/** Remember where the user was, before a bounce overwrites the hash. */
export function capturePostLoginRoute(): void {
  const route = readHashRoute();
  if (!isAppRoute(route)) return;
  try {
    sessionStorage.setItem(KEY, route);
  } catch {
    /* private mode — signing in simply lands on the Dashboard */
  }
}

/** One-shot: the value is removed on read, so a /login → /login render can
 *  never replay it into a redirect loop. */
export function consumePostLoginRoute(): string | null {
  try {
    const stored = sessionStorage.getItem(KEY);
    if (!stored) return null;
    sessionStorage.removeItem(KEY);
    return isAppRoute(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** A deliberate sign-out starts clean: never teleport to the last page. */
export function clearPostLoginRoute(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* nothing persisted */
  }
}
