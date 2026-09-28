/**
 * Madar service worker — app-shell caching for fast repeat first-loads.
 *
 * Scope of responsibility (deliberately narrow):
 *   1. The SPA shell (index.html, served at `/` and via the SPA fallback) —
 *      stale-while-revalidate: the cached copy answers instantly, the network
 *      copy refreshes it in the background. The shell is `no-cache` on the
 *      wire, so a plain navigation would ALWAYS round-trip; this turns repeat
 *      boots (and the `/#/ide` / `/#/opencode` deep links, which boot the same
 *      shell) into a cache hit while never pinning a stale deploy: the hashed
 *      asset names inside the refreshed shell change exactly when the assets
 *      change, and the next navigation uses the new shell.
 *   2. The built `assets/*` chunks — cache-first. Vite emits content-hashed
 *      file names: a hit is byte-identical forever, a miss never collides.
 *   3. `logo.png` + font CSS — cache-first (immutable brand assets).
 *
 * NEVER touched: /api/*, /ws* (WebSocket), cross-origin URLs (the Google
 * Fonts CDN), and anything with a query string (cache-busting inputs). The
 * authenticated API must never be answered from a shared cache, and the
 * WebSocket upgrade handshake must reach the server fresh every time.
 *
 * Versioning: bump CACHE_VERSION whenever the strategy itself changes (not
 * on deploys — hashed names already isolate those). Old caches are deleted
 * on activate, and clients are claimed so the second load is already fast.
 */
const CACHE_VERSION = 'madar-shell-v1';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const ASSET_CACHE = `${CACHE_VERSION}-assets`;

self.addEventListener('install', (event) => {
  // No precaching at install: the very first visit has nothing to gain (the
  // browser is already downloading everything in parallel), and skipping it
  // keeps the SW from ever being the reason a first load is slower.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith('madar-') && !n.startsWith(CACHE_VERSION))
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith('/assets/') ||
    url.pathname === '/logo.png' ||
    url.pathname === '/favicon-32.png' ||
    url.pathname === '/apple-touch-icon.png'
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // fonts CDN + everything else
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;
  if (url.search) return; // cache-busting inputs are never shared

  // SPA shell navigations (`/`, `/ide`, `/opencode`, any deep link): serve the
  // cached shell immediately, refresh it in the background.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        const cached = await cache.match('/', { ignoreSearch: true });
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put('/', res.clone());
            return res;
          })
          .catch(() => null);
        return cached || (await network) || Response.error();
      })(),
    );
    return;
  }

  // Content-hashed build output + immutable brand images: cache-first.
  if (isStaticAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
        return res;
      })(),
    );
  }
});
