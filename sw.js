/* Lemba service worker
   - the page itself is always fetched fresh from the network first (so updates and new work show up on their own)
   - the saved copy is used when the phone is offline or the connection is too slow (4 seconds)
   - bump V when you want to force every phone to refresh its saved files */
const V = 'lm-2026-11-19a';
const PUSH = true; // set to true after you create a OneSignal app (phone push alerts)
const CORE = ['./', 'index.html', 'manifest.webmanifest'];

if (PUSH) { try { importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js'); } catch (e) {} }

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(V).then(c => Promise.all(CORE.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== location.origin) return;              // Firebase, fonts etc. go straight to the network
  if (u.pathname.indexOf('/audio/') > -1) return;        // music files: let the browser stream and cache them
  if (u.pathname.indexOf('/downloads/') > -1) return;    // the app file: never saved by the service worker
  const isPage = r.mode === 'navigate' || (r.headers.get('accept') || '').includes('text/html');
  if (isPage) {                                          // network first, but never wait more than 4 seconds
    e.respondWith((async () => {
      const cache = await caches.open(V);
      const net = fetch(r, { cache: 'no-cache' }).then(res => {
        if (res.ok && /(\/|index\.html)$/.test(u.pathname)) cache.put('index.html', res.clone());
        return res;
      });
      e.waitUntil(net.catch(() => {}));                  // keep refreshing the saved copy quietly
      try {
        const first = await Promise.race([net, new Promise(ok => setTimeout(() => ok(null), 4000))]);
        if (first) return first;
        const saved = (await cache.match('index.html')) || (await caches.match('./'));
        return saved || await net;                       // slow phone: show the saved copy straight away
      } catch (err) {
        return (await cache.match('index.html')) || (await caches.match('./')) || Response.error();
      }
    })());
    return;
  }
  e.respondWith(                                         // icons, manifest: instant from the saved copy, refreshed quietly
    caches.match(r).then(m => {
      const net = fetch(r, { cache: 'no-cache' }).then(res => { if (res.ok) { const cp = res.clone(); caches.open(V).then(c => c.put(r, cp)); } return res; }).catch(() => m);
      return m || net;
    })
  );
});
