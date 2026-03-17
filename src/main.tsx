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
