// Service worker for the browser build. Serves the shell offline, and refreshes every
// same-origin subresource from the network first — a stale cache must never win over the
// server, because the whole point of the bake step is that levels change between deploys.
//
// Register in js/sw-register.js only: this file is never fetched under file://.
const VERSION = 'v1';
const CACHE = 'pentapack-' + VERSION;
const SHELL = [
  './',
  './index.html',
  './css/game.css',
  './manifest.webmanifest',
  './assets/textures/felt.png',
  './assets/sprites/dust.png',
  './assets/sprites/spark.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  // Best effort: an unreachable asset must not leave the install rejected.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async (href) => {
      try {
        const res = await fetch(new Request(href, { cache: 'reload' }));
        if (res && res.ok) await cache.put(href, res);
      } catch {
        /* offline on first boot: the fetch handler still works, just without a fallback */
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok && !req.url.endsWith('/sw.js')) {
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
