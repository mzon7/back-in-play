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

// The main bundle loaded successfully.  Only clear the stale-deploy reload
// throttle if sufficient time has passed (> 30 s), so a cache-busting reload
// that re-serves the same stale HTML cannot spin in an infinite reload loop.
try {
  const _ck = "bip_chunk_reload";
  const _last = sessionStorage.getItem(_ck);
  if (_last && Date.now() - parseInt(_last, 10) > 30000) {
    sessionStorage.removeItem(_ck);
  }
} catch (_) {}

// Unregister any stale service worker registrations left over from the previous
// VitePWA-based deployment. Call update() first with a catch so the browser's
// internal update-check promise is always handled before we unregister.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const reg of registrations) {
      try { if (reg.update) reg.update().catch(() => {}); } catch (_) {}
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
