// Bump this on every deploy that changes the app shell — the `activate` handler deletes any cache
// whose name !== CACHE_NAME, so bumping it purges the previously-cached HTML and forces fresh fetches.
// (Was static at 'plainview-v2', which never self-purged → deployed UI changes could stay masked by
// the old cached shell until a manual hard refresh.)
const CACHE_NAME = 'plainview-v3';

// Never intercept these — always go to network
const BYPASS = [
  /^\/api\//,
  /supabase\.co/,
  /finance\.yahoo\.com/,
  /sec\.gov/,
  /googleapis\.com/,
];

self.addEventListener('install', evt => {
  self.skipWaiting();
  evt.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.add('/').catch(() => {}))
  );
});

self.addEventListener('activate', evt => {
  evt.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', evt => {
  const req = evt.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (BYPASS.some(p => p.test(url.href))) return;

  // Navigation: network-first so updates land immediately, fall back to cache offline
  if (req.mode === 'navigate') {
    evt.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Static assets (_next chunks, icons, fonts): cache-first
  if (url.origin === self.location.origin &&
      (url.pathname.startsWith('/_next/') ||
       /\.(svg|png|ico|woff2?|ttf)$/.test(url.pathname))) {
    evt.respondWith(
      caches.match(req).then(cached =>
        cached || fetch(req).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, clone));
          }
          return res;
        })
      )
    );
  }
});
