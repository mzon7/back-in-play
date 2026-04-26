// Self-unregistering service worker.
// Browsers with a stale registration from a prior deployment fetch this script
// during background update checks. It immediately unregisters so the browser
// stops expecting a service worker at this origin.
self.addEventListener("install", function () {
  self.skipWaiting();
});
self.addEventListener("activate", function () {
  if (self.registration && self.registration.unregister) {
    self.registration.unregister();
  }
});
