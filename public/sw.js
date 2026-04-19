// Self-unregistering service worker.
// Browsers with a stale Workbox SW registration from a previous deployment
// will fetch this script during their background update check. It immediately
// unregisters itself so the browser stops caching stale asset hashes.
// NOTE: keep this file minimal — any uncaught error here surfaces as
// "Script https://backinplay.ai/sw.js load failed" in the window context.
self.addEventListener("install", function(event) {
  // Skip waiting so this SW activates immediately without waiting for old SW to finish.
  event.waitUntil(Promise.resolve(self.skipWaiting()).catch(function() {}));
});
self.addEventListener("activate", function(event) {
  // Unregister without claiming clients — avoid the claim+unregister race
  // condition that can cause Chrome to surface an activate-phase error as a
  // "Script ... load failed" unhandledrejection on the window.
  event.waitUntil(Promise.resolve(self.registration.unregister()).catch(function() {}));
});
