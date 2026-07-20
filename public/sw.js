/* Yield service worker — makes the site installable as a desktop/mobile app (PWA)
   and gives the app shell an offline fallback. Deliberately conservative:
   - Only GET, same-origin, non-API requests are ever cached.
   - Network-FIRST so users always get fresh HTML/JS when online (no stale app).
   - The cache is only a fallback for when the network fails (offline).
   Anything under /api/ or /p/ (streaming + dynamic) is never intercepted. */

const CACHE = 'yield-shell-v1';
// The app shell + its assets — precached so the app opens offline.
const SHELL = [
  '/workspace',
  '/chat', '/code',
  '/styles.css', '/chat.js', '/code.js',
  '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never touch POST/SSE
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;         // only our own origin
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/p/')) return; // dynamic — leave alone

  // Network-first: fresh when online, cached shell when offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        // Cache a copy of successful basic responses for offline use.
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) =>
          hit || (req.mode === 'navigate' ? caches.match('/workspace') : undefined) ||
          new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } }),
        ),
      ),
  );
});
