// Service worker ذاتي الإزالة:
// يُلغي نفسه ويمسح كل الكاش القديم ثم يعيد تحميل التبويبات،
// فتزول طبقة التخزين العنيدة وتظهر التحديثات دائماً دون مسح يدوي.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    try { await self.registration.unregister(); } catch (err) {}
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (err) {}
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((c) => { try { c.navigate(c.url); } catch (err) {} });
  })());
});
