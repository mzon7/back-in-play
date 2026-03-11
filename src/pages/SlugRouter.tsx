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
    return <PlayerReturnDatePage />;
  }

  // Default: treat as league page (e.g., /nba-injuries)
  return <LeagueInjuryPage />;
}
