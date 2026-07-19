/* Minimal service worker: makes the portfolio installable (a PWA install grants audible
   autoplay, so the hero transition plays with sound on reload) and gives a light offline
   shell. Network-first so edits always show; cache is only a fallback. Bump CACHE to invalidate.

   PERF RULES (learned the hard way — the SW must never compete with the hero reveal):
   1. CORE is TINY and must only list what the page ACTUALLY uses. It once listed the 1.9MB
      portrait-cut.png (superseded by the 140KB webp), so every first visit downloaded 1.9MB
      of pure waste in parallel with the reveal — re-creating the very contention the preload
      work removed.
   2. Precaching is deferred: the page posts 'precache' once the hero reveal has settled, so
      install-time fetches never steal bandwidth from it.
   3. The fetch handler never caches heavy media (mp4/wav) — they are big, rarely re-fetched,
      and the response.clone() + cache write costs main-thread time mid-animation. */
const CACHE = 'ryan-portfolio-v4';
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './portrait-cut.webp',
  './assets/vendor/gsap.min.js',
  './assets/icons/icon-192.png'
];
const SKIP_CACHE = /\.(mp4|wav)$/i;

self.addEventListener('install', (e) => {
  // Do NOT precache here — that races the reveal. Just take over; the page asks later.
  e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The page posts this once the hero reveal has settled (see the SW registration in index.html).
self.addEventListener('message', (e) => {
  if (e.data === 'precache') {
    e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => {}));
  }
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // let the browser handle cross-origin (fonts) directly
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && !SKIP_CACHE.test(url.pathname)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((m) => m || caches.match('./index.html')))
  );
});
