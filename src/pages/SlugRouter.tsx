// @refresh reset
import { useParams } from "react-router-dom";
import { lazy } from "react";

const PlayerReturnDatePage = lazy(() => import("./player/PlayerReturnDatePage"));
const LeagueInjuryPage = lazy(() => import("./league/LeagueInjuryPage"));

/**
 * Handles top-level /:slug routes, dispatching to the right page:
 * - /nick-chubb-return-date → PlayerReturnDatePage
 * - /nba-injuries → LeagueInjuryPage
 */
export default function SlugRouter() {
  const { slug } = useParams<{ slug: string }>();

  if (slug?.endsWith("-return-date")) {
    // Use a stable key so React remounts cleanly when switching component types.
    // PlayerReturnDatePage has 2 hooks; LeagueInjuryPage has 3 — different types
    // MUST unmount/remount rather than reconcile in place.
    return <PlayerReturnDatePage key="return-date-page" />;
  }

  // Default: treat as league page (e.g., /nba-injuries)
  return <LeagueInjuryPage key="league-injury-page" />;
}
