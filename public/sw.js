// App-shell cache. Bump VERSION on every release so clients pick up new files.
const VERSION = 'v1.0.0';
const CACHE = `mycelium-${VERSION}`;
const SHELL = ['./', './index.html', './app.css', './main.js', './sim.wasm', './manifest.webmanifest',
  './fonts/fraunces-600.woff2', './fonts/fraunces-italic-400.woff2', './fonts/inter-400.woff2', './fonts/inter-600.woff2',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request).then((hit) => {
    const net = fetch(e.request).then((res) => { if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone())); return res; }).catch(() => hit);
    return hit || net;
  }));
});
