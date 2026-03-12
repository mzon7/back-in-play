import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { AuthCallback } from "@mzon7/zon-incubator-sdk/auth";
import { supabase } from "./lib/supabase";
import LoginPage from "./pages/LoginPage";
import SignupPage from "./pages/SignupPage";
import HomePage from "./features/home-page-injury-snapshots/components/HomePage";
import { RecoveryStatsPage } from "./features/historical-injury-data-system/components/RecoveryStatsPage";
import { HooksErrorBoundary } from "./components/HooksErrorBoundary";

const PlayerInjuryPage = lazy(() => import("./pages/player/PlayerInjuryPage"));
const TeamInjuryPage = lazy(() => import("./pages/team/TeamInjuryPage"));
const SlugRouter = lazy(() => import("./pages/SlugRouter"));

function Loading() {
  return (
    <div className="min-h-screen bg-[#0a0f1a] flex items-center justify-center">
      <div className="animate-pulse text-white/40 text-sm">Loading...</div>
    </div>
  );
}

export default function App() {
  return (
    <HooksErrorBoundary>
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

        {/* SEO: Team injury pages (must be before /:slug to match 2-segment paths) */}
        <Route path="/:leagueSlug/:teamSlug" element={<TeamInjuryPage />} />

        {/* SEO: Top-level slug — dispatches to league hub or player return date */}
        <Route path="/:slug" element={<SlugRouter />} />

        {/* Default redirect */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
    </HooksErrorBoundary>
  );
}
