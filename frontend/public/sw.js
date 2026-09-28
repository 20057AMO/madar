/**
 * Madar service worker — app-shell caching for fast repeat first-loads.
 *
 * Scope of responsibility (deliberately narrow):
 *   1. The SPA shell (index.html, served at `/` and via the SPA fallback) —
 *      network-first, with the cached copy kept purely as the offline fallback.
 *      It was stale-while-revalidate, which was actively harmful across a
 *      deploy: the cached pre-rebuild shell answers the navigation instantly
 *      and the new one only lands on the *next* boot, so a tab reloaded right
 *      after a rebuild kept pointing at pruned chunks. The shell is `no-cache`
 *      on the wire, so the network answer is always a fresh, cheap 304/200.
 *   2. The built `assets/*` chunks — cache-first, but only ever stored when
 *      the response really is JavaScript/CSS/image/font. A chunk pruned by a
 *      rebuild is answered by the SPA fallback with 200 text/html, and
 *      caching that body parks HTML under a dead `.js` URL permanently; the
 *      module loader then rejects on the MIME type with no 404 anywhere in
 *      devtools. An unusable response is passed through and evicted instead.
 *   3. `logo.png` + font CSS — cache-first (immutable brand assets).
 *
 * NEVER touched: /api/*, /ws* (WebSocket), cross-origin URLs (the Google
 * Fonts CDN), and anything with a query string (cache-busting inputs). The
 * authenticated API must never be answered from a shared cache, and the
 * WebSocket upgrade handshake must reach the server fresh every time.
 *
 * Versioning: bump CACHE_VERSION whenever the strategy itself changes (not
 * on deploys — hashed names already isolate those; the stale-chunk guard in
 * index.html covers a chunk that a deploy did prune). Old caches are deleted
 * on activate, and clients are claimed so the second load is already fast.
 */
const CACHE_VERSION = 'madar-shell-v2';
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

/** A response the browser can actually USE as a static asset. Anything else
 *  (notably the SPA fallback's 200 text/html served for a pruned chunk) must
 *  never reach the cache under a hashed URL. */
function isCacheableAsset(res) {
  if (!res || !res.ok || res.type !== 'basic') return false;
  const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  return (
    mime === 'text/javascript' ||
    mime === 'application/javascript' ||
    mime === 'text/css' ||
    mime === 'application/wasm' ||
    mime.startsWith('image/') ||
    mime.startsWith('font/')
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // fonts CDN + everything else
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;
  if (url.search) return; // cache-busting inputs are never shared

  // SPA shell navigations (`/`, `/ide`, `/opencode`, any deep link): network
  // first so the hashed asset names in the answer always match what the server
  // currently ships; the cached shell is the offline fallback only.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        try {
          const res = await fetch(req);
          if (res && res.ok) cache.put('/', res.clone());
          return res;
        } catch {
          return (await cache.match('/', { ignoreSearch: true })) || Response.error();
        }
      })(),
    );
    return;
  }

  // Content-hashed build output + immutable brand images: cache-first, but
  // gated on the response really being an asset.
  if (isStaticAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (isCacheableAsset(res)) {
          cache.put(req, res.clone());
        } else {
          // Pass the unusable body through, but drop any earlier copy of this
          // URL: a poisoned entry must not outlive the request that revealed it.
          cache.delete(req);
        }
        return res;
      })(),
    );
  }
});
