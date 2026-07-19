// Service worker — offline support for the shift-management PWA.
// شبكة أولاً لملفات التطبيق (HTML/CSS/JS) حتى تظهر أحدث نسخة دائماً عند وجود إنترنت،
// والكاش احتياطي للعمل دون إنترنت. الأيقونات والمكتبة الخارجية: كاش أولاً.
const CACHE = 'shift-app-v3';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './seed.js',
  './config.js',
  './cloud.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(ASSETS.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const isShell = e.request.mode === 'navigate' || /\.(css|js|webmanifest)$/.test(url.pathname);

  if (isShell) {
    // شبكة أولاً: أحدث نسخة، مع تحديث الكاش، والرجوع للكاش دون إنترنت
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
    );
  } else {
    // كاش أولاً للأصول الثابتة (أيقونات/مكتبة)
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }))
    );
  }
});
