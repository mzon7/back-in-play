// @refresh reset
import React, { Fragment, lazy, Suspense } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { AuthCallback } from "@mzon7/zon-incubator-sdk/auth";
import { supabase } from "./lib/supabase";
import LoginPage from "./pages/LoginPage";
import SignupPage from "./pages/SignupPage";
import HomePage from "./features/home-page-injury-snapshots/components/HomePage";
import { RecoveryStatsPage } from "./features/historical-injury-data-system/components/RecoveryStatsPage";
import { HooksErrorBoundary } from "./components/HooksErrorBoundary";
import { MobileTabBar } from "./components/MobileTabBar";
import { usePageTracking, useVisitorTracking } from "./lib/analytics";

// Wraps lazy() so that chunk-load failures (stale deploy hashes) trigger a
// hard reload instead of leaving the user on a broken blank screen.
function lazyWithReload<T extends React.ComponentType<unknown>>(
  factory: () => Promise<{ default: T }>,
) {
  return lazy(() =>
    factory().catch(() => {
      window.location.reload();
      // Never resolves — reload fires before React needs the module.
      return new Promise<{ default: T }>(() => {});
    }),
  );
}

const PlayerInjuryPage = lazyWithReload(() => import("./pages/player/PlayerInjuryPage"));
const PlayerReturnPage = lazyWithReload(() => import("./pages/player/PlayerReturnAliasPage"));
const TeamInjuryPage = lazyWithReload(() => import("./pages/team/TeamInjuryPage"));
const SlugRouter = lazyWithReload(() => import("./pages/SlugRouter"));
const PerformanceCurvesPage = lazyWithReload(() => import("./features/performance-curves/components/PerformanceCurvesPage"));
const PropsPage = lazyWithReload(() => import("./pages/PropsPage"));
const ReturningTodayPage = lazyWithReload(() => import("./pages/ReturningTodayPage"));
const ReturningThisWeekPage = lazyWithReload(() => import("./pages/ReturningThisWeekPage"));
const MinutesRestrictionPage = lazyWithReload(() => import("./pages/MinutesRestrictionPage"));
const TrackedPlayersPage = lazyWithReload(() => import("./pages/TrackedPlayersPage"));
const LeagueInjuryTypePerformancePage = lazyWithReload(() => import("./pages/league/LeagueInjuryTypePerformancePage"));
const CrossLeagueComparePage = lazyWithReload(() => import("./pages/injury/CrossLeagueComparePage"));
const ModelAnalysisPage = lazyWithReload(() => import("./pages/ModelAnalysisPage"));

function Loading() {
  return (
    <div className="min-h-screen bg-[#0a0f1a] flex items-center justify-center">
      <div className="animate-pulse text-white/40 text-sm">Loading...</div>
    </div>
  );
}

// Derives a stable key from the pathname that changes when the route *type* changes,
// forcing React to fully unmount and remount the subtree instead of reconciling
// fibers with mismatched hook counts across different page components.
function routeKey(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "home";
  if (segments[0] === "player" || segments[0] === "injury") return `player-${segments[1] ?? ""}`;
  if (segments[0] === "league") return `league-${segments[1] ?? ""}`;
  if (segments[0] === "login") return "login";
  if (segments[0] === "signup") return "signup";
  if (segments[0] === "auth") return "auth";
  if (segments[0] === "recovery-stats") return "recovery-stats";
  if (segments[0] === "injuries" && segments[2] === "compare") return `injuries-compare-${segments[1] ?? ""}`;
  if (segments[0] === "injuries") return `injuries-${segments[1] ?? ""}`;
  if (segments[0] === "performance-curves") return "performance-curves";
  if (segments[0] === "props") return "props";
  if (segments[0] === "tracked-players") return "tracked-players";
  if (segments[0] === "returning-today") return "returning-today";
  if (segments[0] === "players-returning-from-injury-this-week") return "returning-week";
  if (segments[0] === "minutes-restriction-after-injury") return "minutes-restriction";
  if (segments.length === 2 && segments[1] === "returning-today") return `returning-today-${segments[0]}`;
  if (segments.length === 2 && segments[1] === "players-returning-from-injury-this-week") return `returning-week-${segments[0]}`;
  if (segments.length === 2 && segments[1] === "minutes-restriction-after-injury") return `minutes-restriction-${segments[0]}`;
  if (segments.length === 3 && segments[2].endsWith("-recovery")) return `pos-recovery-${segments[0]}-${segments[1]}-${segments[2]}`;
  if (segments.length >= 2 && segments[1].endsWith("-injury-performance")) return `injury-perf-${segments[0]}-${segments[1]}`;
  if (segments.length === 2 && /^\d{4}-season-injuries$/.test(segments[1])) return `seasonal-${segments[0]}-${segments[1]}`;
  if (segments.length === 2) return `team-${segments[0]}-${segments[1]}`;
  // top-level slug (league hub, injury performance, or player return date)
  if (segments[0].endsWith("-injury-performance")) return `perf-${segments[0]}`;
  if (segments[0].endsWith("-injury-analysis")) return `analysis-${segments[0]}`;
  if (segments[0].includes("-injury-report")) return `report-${segments[0]}`;
  return `slug-${segments[0]}`;
}



function AppRoutes() {
  const location = useLocation();
  usePageTracking();
  useVisitorTracking();
  return (
    <Fragment key={routeKey(location.pathname)}>
      <Suspense fallback={<Loading />}>
        <Routes>
          {/* Public routes */}
          <Route path="/" element={<HomePage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/auth/callback" element={<AuthCallback supabase={supabase} redirectTo="/" />} />

          <Route path="/recovery-stats" element={<RecoveryStatsPage />} />
          <Route path="/performance-curves" element={<PerformanceCurvesPage />} />
          <Route path="/props" element={<PropsPage />} />
          <Route path="/returning-today" element={<ReturningTodayPage />} />
          <Route path="/players-returning-from-injury-this-week" element={<ReturningThisWeekPage />} />
          <Route path="/minutes-restriction-after-injury" element={<MinutesRestrictionPage />} />
          <Route path="/tracked-players" element={<TrackedPlayersPage />} />
          {window.location.hostname === "localhost" && (
            <Route path="/model-analysis" element={<ModelAnalysisPage />} />
          )}

          {/* League-specific view (pre-selects the league tab on home) */}
          <Route path="/league/:leagueSlug" element={<HomePage />} />

          {/* SEO: Player injury pages */}
          <Route path="/player/:playerSlug" element={<PlayerInjuryPage />} />
          <Route path="/injury/:playerSlug" element={<PlayerInjuryPage />} />
          <Route path="/player/:playerSlug/return" element={<PlayerReturnPage />} />

          {/* SEO: Injury type pages */}
          <Route path="/injuries/:injurySlug/compare" element={<CrossLeagueComparePage />} />
          <Route path="/injuries/:injurySlug" element={<RecoveryStatsPage />} />

          {/* SEO: League-specific returning today/this week */}
          <Route path="/:leagueSlug/returning-today" element={<ReturningTodayPage />} />
          <Route path="/:leagueSlug/players-returning-from-injury-this-week" element={<ReturningThisWeekPage />} />

          {/* SEO: League-specific recovery stats */}
          <Route path="/:leagueSlug/recovery-stats" element={<RecoveryStatsPage />} />
          <Route path="/:leagueSlug/minutes-restriction-after-injury" element={<MinutesRestrictionPage />} />

          {/* SEO: League + injury type performance with position (e.g., /nba/hamstring-injury-performance/guards) */}
          <Route path="/:leagueSlug/:injuryPerf/:position" element={<LeagueInjuryTypePerformancePage />} />

          {/* SEO: Team injury pages + league/injury-type performance (2-segment paths) */}
          <Route path="/:leagueSlug/:teamSlug" element={<TeamInjuryPage />} />

          {/* SEO: Top-level slug — dispatches to league hub or player return date */}
          <Route path="/:slug" element={<SlugRouter />} />

          {/* Default redirect */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Fragment>
  );
}

export default function App() {
  return (
    <HooksErrorBoundary>
      <AppRoutes />
      <MobileTabBar />
    </HooksErrorBoundary>
  );
}
