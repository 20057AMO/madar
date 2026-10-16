/**
 * Pure helpers shared by the two embedded tool pages (/#/ide, /#/opencode).
 *
 * Both pages encode their selection in the URL hash and both have to answer the
 * same two questions honestly: "which project does this folder string actually
 * name?" and "does the address bar still describe what is open?". Kept free of
 * imports so a Playwright spec can exercise them directly.
 */

/**
 * The slug a `/workspaces/…` folder names, but ONLY when the picker really
 * renders that option.
 *
 * The first path segment is compared WHOLE, never as a prefix — `my-app` is not
 * reported for `/workspaces/my-app-2`, which a bare `startsWith` match would
 * silently do (the picker would then claim a project the folder does not name).
 * Returns `null` for anything else: a non-workspace path, a bare `/workspaces`,
 * or a slug the roster does not contain — the caller shows "All projects"
 * instead of a selection that is not in the list.
 */
export function pickedFolderSlug(folder: string, knownSlugs: readonly string[]): string | null {
  const prefix = '/workspaces/';
  if (!folder.startsWith(prefix)) return null;
  const slug = folder.slice(prefix.length).split('/')[0];
  if (!slug) return null;
  return knownSlugs.includes(slug) ? slug : null;
}

/**
 * Rewrite ONE query parameter of the current hash, in place.
 *
 * `history.replaceState` on purpose: it adds no history entry to back into and —
 * the important part — fires no `hashchange`, so the pages' reactive deep-link
 * effects cannot re-fire against a URL they have just normalised into a loop.
 *
 * A no-op unless the hash currently targets `route`: both pages stay mounted
 * behind the keep-alive layer, so a background layer must never rewrite the URL
 * of the route the user is actually looking at.
 */
export function replaceToolHashParam(
  route: '/ide' | '/opencode',
  param: string,
  value: string | null,
): void {
  const hash = window.location.hash || '';
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const qIdx = raw.indexOf('?');
  const path = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
  if (path !== route) return;
  const params = new URLSearchParams(qIdx >= 0 ? raw.slice(qIdx) : '');
  if (value) params.set(param, value);
  else params.delete(param);
  const qs = params.toString();
  const next = `#${route}${qs ? `?${qs}` : ''}`;
  if (next === hash) return;
  try {
    history.replaceState(null, '', next);
  } catch {
    /* history unavailable (rare sandboxed contexts) — the URL is cosmetic */
  }
}
