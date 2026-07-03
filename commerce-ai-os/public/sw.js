// Minimal service worker — exists so the staff PWA meets the browser's
// installability criteria (Chrome requires a SW with a fetch handler before it
// will offer "Install"). Intentionally a pure network passthrough: it does NOT
// cache anything, so it can never serve a stale build.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // no respondWith → the browser handles the request normally (network)
});

// ---- Web Push -----------------------------------------------------------
// Payloads are JSON { title, body, url } sent by /api/cron/notify (see
// lib/push.ts). A malformed/empty payload still shows a generic alert —
// browsers require SOME notification for every push received.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* generic */ }
  const title = data.title || "ملاك";
  const body = data.body || "عندك تنبيهات جديدة — افتح التطبيق.";
  const url = data.url || "/dashboard";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      dir: "rtl",
      lang: "ar",
      icon: "/icon",           // app icon route (also used by the manifest)
      badge: "/icon",
      data: { url },
      tag: "malak-alerts",     // newer morning alert replaces the older one
    })
  );
});

// Tap → focus an open app tab if there is one, else open the target URL.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/dashboard";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) { c.navigate(url); return c.focus(); }
      }
      return self.clients.openWindow(url);
    })
  );
});
