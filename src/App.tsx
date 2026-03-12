import { Fragment } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { AuthCallback } from "@mzon7/zon-incubator-sdk/auth";
import { supabase } from "./lib/supabase";
import LoginPage from "./pages/LoginPage";
import SignupPage from "./pages/SignupPage";
import HomePage from "./features/home-page-injury-snapshots/components/HomePage";
import { RecoveryStatsPage } from "./features/historical-injury-data-system/components/RecoveryStatsPage";
import { HooksErrorBoundary } from "./components/HooksErrorBoundary";
import PlayerInjuryPage from "./pages/player/PlayerInjuryPage";
import TeamInjuryPage from "./pages/team/TeamInjuryPage";
import SlugRouter from "./pages/SlugRouter";

// Derives a stable key from the pathname that changes when the route *type* changes,
// forcing React to fully unmount and remount the subtree instead of reconciling
// fibers with mismatched hook counts across different page components.
function routeKey(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "home";
  if (segments[0] === "player") return `player-${segments[1] ?? ""}`;
  if (segments[0] === "league") return `league-${segments[1] ?? ""}`;
  if (segments[0] === "login") return "login";
  if (segments[0] === "signup") return "signup";
  if (segments[0] === "auth") return "auth";
  if (segments[0] === "recovery-stats") return "recovery-stats";
  if (segments.length === 2) return `team-${segments[0]}-${segments[1]}`;
  // top-level slug (league hub or player return date)
  return `slug-${segments[0]}`;
}

function AppRoutes() {
  const location = useLocation();
  return (
    <Fragment key={routeKey(location.pathname)}>
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
    </Fragment>
  );
}

export default function App() {
  return (
    <HooksErrorBoundary>
      <AppRoutes />
    </HooksErrorBoundary>
  );
}
