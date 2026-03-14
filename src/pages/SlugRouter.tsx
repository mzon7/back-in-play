// @refresh reset
import { lazy } from "react";
import { useParams } from "react-router-dom";
import PlayerReturnDatePage from "./player/PlayerReturnDatePage";
import LeagueInjuryPage from "./league/LeagueInjuryPage";

const LeagueInjuryPerformancePage = lazy(() => import("./league/LeagueInjuryPerformancePage"));
const LeagueInjuryAnalysisPage = lazy(() => import("./league/LeagueInjuryAnalysisPage"));
const InjuryReportPage = lazy(() => import("./InjuryReportPage"));

/**
 * Handles top-level /:slug routes, dispatching to the right page:
 * - /nick-chubb-return-date → PlayerReturnDatePage
 * - /nba-injury-performance → LeagueInjuryPerformancePage
 * - /nba-injury-analysis → LeagueInjuryAnalysisPage
 * - /nba-injuries → LeagueInjuryPage
 */
export default function SlugRouter() {
  const { slug } = useParams<{ slug: string }>();

  if (slug?.endsWith("-return-date")) {
    return <PlayerReturnDatePage key="return-date-page" />;
  }

  if (slug?.endsWith("-injury-performance")) {
    return <LeagueInjuryPerformancePage key="league-perf-page" />;
  }

  if (slug?.endsWith("-injury-analysis")) {
    return <LeagueInjuryAnalysisPage key="league-analysis-page" />;
  }

  if (slug?.includes("-injury-report")) {
    return <InjuryReportPage key="injury-report-page" />;
  }

  return <LeagueInjuryPage key="league-injury-page" />;
}
