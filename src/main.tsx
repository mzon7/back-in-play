import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "@mzon7/zon-incubator-sdk/auth";
import { installFrontendErrorCapture } from "@mzon7/zon-incubator-sdk";
import { supabase, PROJECT_PREFIX } from "./lib/supabase";
import App from "./App";
import "./index.css";

// Auto-capture frontend errors for self-heal monitoring
installFrontendErrorCapture(supabase, PROJECT_PREFIX);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider supabase={supabase} projectPrefix={PROJECT_PREFIX}>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
