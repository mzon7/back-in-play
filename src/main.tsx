import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HelmetProvider } from "react-helmet-async";
import { AuthProvider } from "@mzon7/zon-incubator-sdk/auth";
import { supabase } from "./lib/supabase";
import { PremiumUnlocksProvider } from "./lib/premiumUnlocks";
import { installFrontendErrorCapture } from "./lib/errorReporting";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/react";
import App from "./App";
import "./index.css";

// Install global error capture for the self-heal monitoring system.
// Returns a cleanup function — called once at module load (not in a component).
installFrontendErrorCapture(supabase, "back_in_play_");

// Unregister any stale service worker registrations left over from the previous
// VitePWA-based deployment. The app no longer uses a service worker; stale
// registrations cause "sw.js load failed" errors when the browser tries to
// update them against the new self-unregistering public/sw.js.
//
// IMPORTANT: call reg.update().catch() BEFORE unregistering so we attach a
// rejection handler to any in-flight update promise. Without this, cancelling
// a pending update fetch via unregister() can produce an unhandled rejection
// with message "Script https://backinplay.ai/sw.js load failed".
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const reg of registrations) {
      try { reg.update().catch(() => {}); } catch (_e) {}
      reg.unregister().catch(() => {});
    }
  }).catch(() => {/* ignore */});
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 1,
    },
  },
});

// Hydrate preloaded data from prerendered HTML (instant render, then background refetch)
const preloaded = (window as any).__PRELOADED_QUERIES__;
if (Array.isArray(preloaded)) {
  for (const [queryKey, data] of preloaded) {
    queryClient.setQueryData(queryKey, data);
  }
  delete (window as any).__PRELOADED_QUERIES__;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HelmetProvider>
      <BrowserRouter>
        <QueryClientProvider client={queryClient}>
          <AuthProvider supabase={supabase}>
            <PremiumUnlocksProvider>
              <App />
              <Analytics />
              <SpeedInsights />
            </PremiumUnlocksProvider>
          </AuthProvider>
        </QueryClientProvider>
      </BrowserRouter>
    </HelmetProvider>
  </StrictMode>,
);
