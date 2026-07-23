/* ============================================================
   Service Worker — يجعل التطبيق قابلاً للتثبيت ويعمل دون إنترنت،
   دون التسبّب في نُسخ قديمة عالقة:
   استراتيجية «الشبكة أولاً» — يجلب دائماً أحدث نسخة من الشبكة،
   ويستخدم النسخة المخزّنة فقط عند انقطاع الإنترنت.
   ============================================================ */
'use strict';
const CACHE = 'shiftapp-v3';
const SHELL = [
  './', './index.html', './styles.css',
  './seed.js', './config.js', './cloud.js', './qr.js', './app.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  // نطاق التطبيق فقط؛ نترك Supabase/الشبكات الأخرى تمرّ مباشرة
  if (url.origin !== self.location.origin) return;

  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);            // الشبكة أولاً — نسخة حديثة دائماً
      if (fresh && fresh.status === 200) {
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());           // خزّن نسخة احتياطية للعمل دون إنترنت
      }
      return fresh;
    } catch (err) {                              // لا إنترنت → النسخة المخزّنة
      const cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const idx = await caches.match('./index.html');
        if (idx) return idx;
      }
      throw err;
    }
  })());
});
