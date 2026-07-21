/*
  BokehBokeh service worker — offline field mode.

  Strategy:
  - Navigations: network first (deploys land immediately), cached shell
    as the offline fallback.
  - Forecast / geocoding APIs: network first, falling back to the last
    cached response for the same URL (same place → same URL, so the
    field fallback is "the last forecast you saw").
  - Everything else (shell assets, the Spektrum CDN module, light
    pollution tiles): cache first with a background refresh, so repeat
    visits are instant and updates still flow while online.
*/

const VERSION = 'bokehbokeh-v3';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './lib.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://unpkg.com/spektrum@0/spektrum.min.js',
];

const CACHEABLE_HOSTS = ['unpkg.com', 'djlorenz.github.io'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      // Settled, not all(): an unreachable CDN must not block install —
      // runtime caching fills any gap on the first online use.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);

      if (event.request.mode === 'navigate') {
        try {
          const res = await fetch(event.request);
          cache.put(event.request, res.clone());
          return res;
        } catch {
          return (
            (await cache.match(event.request, { ignoreVary: true })) ??
            (await cache.match('./index.html', { ignoreVary: true })) ??
            Response.error()
          );
        }
      }

      const isApi =
        url.hostname.endsWith('open-meteo.com') || url.hostname.endsWith('bigdatacloud.net');
      if (isApi) {
        try {
          const res = await fetch(event.request);
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        } catch {
          return (await cache.match(event.request, { ignoreVary: true })) ?? Response.error();
        }
      }

      // Static: cache first, refresh in the background.
      const cached = await cache.match(event.request, { ignoreVary: true });
      const cacheable =
        url.origin === self.location.origin || CACHEABLE_HOSTS.includes(url.hostname);
      const refresh = fetch(event.request)
        .then((res) => {
          if (res.ok && cacheable) cache.put(event.request, res.clone());
          return res;
        })
        .catch(() => null);
      return cached ?? (await refresh) ?? Response.error();
    })(),
  );
});
