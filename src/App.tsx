import { useEffect, lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { AuthCallback } from "@mzon7/zon-incubator-sdk/auth";
import { supabase } from "./lib/supabase";
import { installFrontendErrorCapture } from "./lib/errorReporting";
import LoginPage from "./pages/LoginPage";
import SignupPage from "./pages/SignupPage";
import HomePage from "./features/home-page-injury-snapshots/components/HomePage";
import { RecoveryStatsPage } from "./features/historical-injury-data-system/components/RecoveryStatsPage";

const PlayerInjuryPage = lazy(() => import("./pages/player/PlayerInjuryPage"));
const TeamInjuryPage = lazy(() => import("./pages/team/TeamInjuryPage"));
const LeagueInjuryPage = lazy(() => import("./pages/league/LeagueInjuryPage"));

function Loading() {
  return (
    <div className="min-h-screen bg-[#0a0f1a] flex items-center justify-center">
      <div className="animate-pulse text-white/40 text-sm">Loading...</div>
    </div>
  );
}

export default function App() {
  useEffect(() => {
    const cleanup = installFrontendErrorCapture(supabase, "back_in_play_");
    return cleanup;
  }, []);

  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        {/* Public routes */}
        <Route path="/" element={<HomePage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/auth/callback" element={<AuthCallback supabase={supabase} redirectTo="/" />} />

        <Route path="/recovery-stats" element={<RecoveryStatsPage />} />

        {/* League-specific view (pre-selects the league tab on home) */}
        <Route path="/league/:leagueSlug" element={<HomePage />} />

        {/* SEO: Player injury pages */}
        <Route path="/player/:playerSlug" element={<PlayerInjuryPage />} />

        {/* SEO: League injury hub pages */}
        <Route path="/:leagueSlug" element={<LeagueInjuryPage />} />

        {/* SEO: Team injury pages */}
        <Route path="/:leagueSlug/:teamSlug" element={<TeamInjuryPage />} />

        {/* Default redirect */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
