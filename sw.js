// Bump CACHE_VERSION whenever you ship updates so users get fresh files.
const CACHE_VERSION = 'jazzfest-v4';
const CORE = [
  './',
  './index.html',
  './schedule.js',
  './app.jsx',
  './ios-frame.jsx',
  './tweaks-panel.jsx',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './festival-map.jpg',
  './access-map.jpg',
  'https://unpkg.com/react@18.3.1/umd/react.development.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js',
  'https://unpkg.com/@babel/standalone@7.29.0/babel.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION).then((c) =>
      Promise.all(CORE.map((url) => c.add(url).catch(() => null)))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for HTML/JS so updates roll out fast; cache fallback offline.
// Cache-first for images and the YouTube iframe origin (those rarely change).
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Don't try to cache YouTube iframe content — let it go straight to network.
  if (url.hostname.endsWith('youtube.com') || url.hostname.endsWith('youtu.be') || url.hostname.endsWith('ytimg.com')) {
    return;
  }

  const isAsset = /\.(png|jpg|jpeg|svg|woff2?|ttf)$/i.test(url.pathname);
  if (isAsset) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        return res;
      }))
    );
    return;
  }

  // Network-first for everything else.
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req))
  );
});
