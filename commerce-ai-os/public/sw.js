// Minimal service worker — exists so the staff PWA meets the browser's
// installability criteria (Chrome requires a SW with a fetch handler before it
// will offer "Install"). Intentionally a pure network passthrough: it does NOT
// cache anything, so it can never serve a stale build.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // no respondWith → the browser handles the request normally (network)
});
