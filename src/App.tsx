import { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { AuthCallback } from "@mzon7/zon-incubator-sdk/auth";
import { supabase } from "./lib/supabase";
import { installFrontendErrorCapture } from "./lib/errorReporting";
import LoginPage from "./pages/LoginPage";
import SignupPage from "./pages/SignupPage";
import HomePage from "./features/home-page-injury-snapshots/components/HomePage";
import { RecoveryStatsPage } from "./features/historical-injury-data-system/components/RecoveryStatsPage";

export default function App() {
  useEffect(() => {
    const cleanup = installFrontendErrorCapture(supabase, "back_in_play_");
    return cleanup;
  }, []);

  return (
    <Routes>
      {/* Public routes */}
      <Route path="/" element={<HomePage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route
        path="/auth/callback"
        element={<AuthCallback supabase={supabase} redirectTo="/" />}
      />

      <Route path="/recovery-stats" element={<RecoveryStatsPage />} />

      {/* League-specific view (pre-selects the league tab) */}
      <Route path="/league/:leagueSlug" element={<HomePage />} />

      {/* Placeholder routes */}
      <Route path="/player/:playerSlug" element={<HomePage />} />
      <Route path="/injury-type/:injuryTypeSlug" element={<HomePage />} />

      {/* Default redirect */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
