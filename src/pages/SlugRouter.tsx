// @refresh reset
import { useParams } from "react-router-dom";
import PlayerReturnDatePage from "./player/PlayerReturnDatePage";
import LeagueInjuryPage from "./league/LeagueInjuryPage";

/**
 * Handles top-level /:slug routes, dispatching to the right page:
 * - /nick-chubb-return-date → PlayerReturnDatePage
 * - /nba-injuries → LeagueInjuryPage
 */
export default function SlugRouter() {
  const { slug } = useParams<{ slug: string }>();

  if (slug?.endsWith("-return-date")) {
    return <PlayerReturnDatePage key="return-date-page" />;
  }

  return <LeagueInjuryPage key="league-injury-page" />;
}
