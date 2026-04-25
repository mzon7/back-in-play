// Self-unregistering service worker.
// Browsers with a stale Workbox SW registration from a previous deployment
// will fetch this script during their background update check. It immediately
// unregisters itself so the browser stops caching stale asset hashes.
// NOTE: keep this file minimal — any uncaught error here surfaces as
// "Script https://backinplay.ai/sw.js load failed" in the window context.
self.addEventListener("install", function(event) {
  // Skip waiting so this SW activates immediately without waiting for old SW to finish.
  // Use .then() wrapper so any synchronous exception is caught as a rejected promise
  // rather than escaping as an uncaught throw (which some browsers surface as
  // "Script <url> load failed" in the parent window).
  event.waitUntil(
    Promise.resolve()
      .then(function() { return self.skipWaiting(); })
      .catch(function() {})
  );
});
self.addEventListener("activate", function(event) {
  // Unregister without claiming clients — avoid the claim+unregister race
  // condition that can cause Chrome to surface an activate-phase error as a
  // "Script ... load failed" unhandledrejection on the window.
  // Guard self.registration access in case it is undefined in some browser contexts.
  event.waitUntil(
    Promise.resolve()
      .then(function() {
        return self.registration && self.registration.unregister
          ? self.registration.unregister()
          : undefined;
      })
      .catch(function() {})
  );
});
