// Self-unregistering service worker.
// Browsers with a stale Workbox SW registration from a previous deployment
// will fetch this script during their background update check. It immediately
// unregisters the SW so the browser stops caching stale asset hashes.
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    self.clients.claim().then(() => self.registration.unregister()).catch(() => {})
  );
});
