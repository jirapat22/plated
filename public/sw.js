const CACHE_NAME = 'plated-v252';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/js/api.js',
  '/js/views/today.js',
  '/js/views/history.js',
  '/js/views/trends.js',
  '/js/views/foods.js',
  '/js/views/batches.js',
  '/js/views/presets.js',
  '/js/views/settings.js',
  '/js/views/log.js',
  '/js/components/barcode.js',
  '/js/components/onboarding.js',
  '/js/components/foodSearch.js',
  '/js/components/macroBar.js',
  '/js/utils/energy.js',
  '/js/utils/date.js',
  '/js/utils/foodIcon.js',
  '/js/utils/logCheck.js',
  '/js/utils/bugReport.js',
  '/js/utils/phase.js',
  '/js/utils/stats.js',
  '/js/utils/ironlogState.js',
  '/js/utils/offlineStore.js',
  '/js/utils/writeQueue.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/manifest.json',
];

self.addEventListener('install', event => {
  // Precache the new shell but DON'T skipWaiting — the new worker stays in
  // "waiting" so the page can show a "new version" prompt and only activate
  // when the user taps Refresh (or on the next cold launch). Swapping silently
  // meant users never knew an update landed.
  // Fetched one at a time and content-type checked, NOT cache.addAll.
  //
  // addAll sets each request's service-workers mode to "none", so the fetch
  // handler below — and the isHtml === wantsHtml guard it carries — never runs
  // for the precache. And server.js answers any unmatched non-/api path with
  // index.html and a 200, so a STATIC_ASSETS entry naming a file that a deploy
  // renamed or removed would be stored as HTML under its .js URL, unguarded,
  // BY the very CACHE_NAME bump that the guard's comment says is the cure. The
  // module then fails to parse on every offline load.
  //
  // Rejecting here fails the install, which is the right outcome: the phone
  // keeps serving the previous version instead of adopting a poisoned one.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(STATIC_ASSETS.map(async path => {
      const resp = await fetch(path, { cache: 'reload' });
      if (!resp.ok) throw new Error(`precache ${path}: HTTP ${resp.status}`);
      const isHtml = (resp.headers.get('content-type') || '').includes('text/html');
      const wantsHtml = path === '/' || path === '/index.html';
      if (isHtml !== wantsHtml) throw new Error(`precache ${path}: got ${isHtml ? 'HTML' : 'non-HTML'}`);
      await cache.put(path, resp);
    }));
  })());
});

// The page posts this when the user accepts the update prompt.
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // API routes: network-first with offline fallback
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then(resp => resp)
        .catch(() =>
          new Response(
            JSON.stringify({ error: 'offline', offline: true }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          )
        )
    );
    return;
  }

  // CDN resources: network-first (don't cache externally).
  // Compared with !== rather than .includes(): an origin merely CONTAINING ours
  // is not ours. "https://plated.up.railway.app.evil.com" contains
  // "https://plated.up.railway.app", so the substring test called it same-origin
  // and fell through to the app-shell branch below, which caches what it gets.
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // App shell (HTML/JS/CSS): network-first so a new deploy is picked up on the
  // next online load. Falls back to cache when offline. This prevents the app
  // from getting stuck on a stale cached version (e.g. an old login screen).
  event.respondWith(
    fetch(request)
      .then(resp => {
        // Only cache a response whose KIND matches what was asked for. The
        // server answers any unmatched non-/api path with index.html and a 200
        // (server.js's SPA fallback), so a request for a module that a deploy
        // renamed or removed comes back as HTML — and this used to store that
        // HTML under the .js URL. The module then failed to parse on every
        // subsequent load, and the poisoned entry outlived the deploy that
        // caused it, because only a CACHE_NAME bump clears it.
        const isHtml   = (resp.headers.get('content-type') || '').includes('text/html');
        const wantsHtml = request.destination === 'document' || request.mode === 'navigate';
        if (resp.ok && request.method === 'GET' && isHtml === wantsHtml) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return resp;
      })
      .catch(() => caches.match(request)
        .then(cached => cached || caches.match('/index.html'))
        // A third rung, because the second can also miss: if Cache Storage was
        // evicted while the registration survived, both lookups resolve to
        // undefined and respondWith(undefined) THROWS — an installed PWA then
        // opens on a bare browser error page. Better a sentence than that.
        .then(r => r || new Response(
          '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">'
          + '<body style="font:16px system-ui;padding:32px;text-align:center">'
          + '<p>Plated is offline and its saved copy is gone.</p>'
          + '<p>Reconnect and open it again.</p>',
          { status: 200, headers: { 'Content-Type': 'text/html' } })))
  );
});
