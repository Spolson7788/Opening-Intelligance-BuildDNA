/* Opening Intelligence — service worker
 * v53 · 2026-09-06
 *
 * BUMP THIS ON EVERY DEPLOY. Changing the string is what discards the old
 * cache. Leaving it alone is why a deploy can appear not to take effect.
 */
const CACHE = 'oi-v58';

/* Precached so the app opens with no network at all. portal.html is included
 * now — it was missing from v51, which is why the dashboard always came from
 * the network and the field app did not. */
const ASSETS = [
  './',
  './index.html',
  './portal.html',
  './inspect.html',
  './accuracy.html',
  './manifest.json',
  './oi-local-backend.js',
  './oi-provider-mappings.js',
  './oi-bounded-workflow.js',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // addAll fails the whole install if any one file 404s. Individual puts
      // let the rest succeed, so a renamed page cannot break the worker.
      .then(c => Promise.all(ASSETS.map(u =>
        c.add(u).catch(err => console.warn('[sw] skipped', u, err && err.message))
      )))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Strategy, and why it differs by request type:
 *
 *   HTML  → network first, cache as fallback.
 *           A technician must never run yesterday's build without knowing.
 *           If the network is unavailable the cached copy is served, so the
 *           app still opens at a door with no signal.
 *
 *   other → cache first, refreshed in the background.
 *           Icons and the manifest rarely change and should be instant.
 */
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never touch Supabase or CDN calls

  const isHTML = req.mode === 'navigate' ||
                 (req.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req)
        .then(res => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

/* Lets a page ask the worker to activate immediately, so an update can be
 * applied without waiting for every tab to close. */
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
