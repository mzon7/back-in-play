// @refresh reset
import { lazy } from "react";
import { useParams, Link, Navigate } from "react-router-dom";
import { SiteHeader } from "../../components/SiteHeader";
import { useTeamPage } from "../../hooks/useTeamPage";
import { isKnownPositionSlug } from "../position/PositionInjuryHubPage";
import { SEO } from "../../components/seo/SEO";
import { teamJsonLd } from "../../components/seo/seoHelpers";
import { StatusBadge } from "../../components/StatusBadge";
import { PlayerAvatar } from "../../components/PlayerAvatar";

const LeagueInjuryTypePerformancePage = lazy(() => import("../league/LeagueInjuryTypePerformancePage"));
const RecoveryStatsPage = lazy(() => import("../../features/historical-injury-data-system/components/RecoveryStatsPage").then(m => ({ default: m.RecoveryStatsPage })));
const PositionInjuryHubPage = lazy(() => import("../position/PositionInjuryHubPage"));
const SeasonalInjuryAnalysisPage = lazy(() => import("../league/SeasonalInjuryAnalysisPage"));

const LEAGUE_LABELS: Record<string, string> = {
  nba: "NBA", nfl: "NFL", mlb: "MLB", nhl: "NHL", "premier-league": "EPL",
};

function daysAgo(d: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000));
}

export default function TeamInjuryPage() {
  const { leagueSlug, teamSlug } = useParams<{ leagueSlug: string; teamSlug: string }>();

  // Delegate to seasonal injury analysis page (e.g., /nba/2025-season-injuries)
  if (teamSlug && /^\d{4}-season-injuries$/.test(teamSlug)) {
    return <SeasonalInjuryAnalysisPage />;
  }

  // Delegate to injury-type performance page if slug matches pattern
  if (teamSlug?.endsWith("-injury-performance")) {
    return <LeagueInjuryTypePerformancePage />;
  }

  // Delegate to league + injury type recovery page (e.g., /nba/acl-recovery)
  if (teamSlug?.endsWith("-recovery")) {
    return <RecoveryStatsPage />;
  }

  // Redirect /{league}-injury-performance/{injuryType} → /{league}/{injuryType}-injury-performance
  if (leagueSlug?.endsWith("-injury-performance") && teamSlug) {
    const actualLeague = leagueSlug.replace("-injury-performance", "");
    return <Navigate to={`/${actualLeague}/${teamSlug}-injury-performance`} replace />;
  }

  // Delegate to position injury hub (e.g., /nba/guard-injuries)
  if (teamSlug?.endsWith("-injuries") && leagueSlug) {
    const posSlug = teamSlug.replace(/-injuries$/, "");
    if (isKnownPositionSlug(leagueSlug, posSlug)) {
      return <PositionInjuryHubPage />;
    }
  }

  // teamSlug comes as "buffalo-bills-injuries" — strip the "-injuries" suffix
  const cleanTeamSlug = (teamSlug ?? "").replace(/-injuries$/, "");

  const { data: team, isLoading } = useTeamPage(leagueSlug ?? "", cleanTeamSlug);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#0a0f1a] flex items-center justify-center">
        <div className="animate-pulse text-white/40 text-sm">Loading team...</div>
      </div>
    );
  }

  if (!team) {
    return (
      <div className="min-h-screen bg-[#0a0f1a] flex flex-col items-center justify-center gap-4">
        <p className="text-white/60">Team not found</p>
        <Link to="/" className="text-cyan-400 hover:underline text-sm">Back to Home</Link>
      </div>
    );
  }

  const leagueLabel = LEAGUE_LABELS[team.league_slug] ?? team.league_name;
  const year = new Date().getFullYear();
  const activeInjuries = team.injuries.filter((i) => i.status !== "returned" && i.status !== "active");
  const returnedRecently = team.injuries.filter((i) => i.status === "returned" || i.status === "active");

  const pageTitle = `${team.team_name} Injury Report (${year})`;
  const pageDesc = `${team.team_name} injury report — ${activeInjuries.length} players currently injured. Latest ${leagueLabel} injury updates, expected return dates, and status changes.`;
  const now = new Date().toISOString();

  const jsonLd = teamJsonLd({
    name: team.team_name,
    league: leagueLabel,
    injuredCount: activeInjuries.length,
    dateModified: now,
    url: `https://backinplay.app/${team.league_slug}/${cleanTeamSlug}-injuries`,
  });

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white">
      <SEO title={pageTitle} description={pageDesc} path={`/${team.league_slug}/${cleanTeamSlug}-injuries`} type="article" dateModified={now} jsonLd={jsonLd} />
      <SiteHeader />

      {/* Breadcrumb */}
      <nav className="px-4 py-3 text-sm text-white/45 max-w-3xl mx-auto">
        <Link to="/" className="hover:text-white/60">Home</Link>
        {" / "}
        <Link to={`/${team.league_slug}-injuries`} className="hover:text-white/60">{leagueLabel} Injuries</Link>
        {" / "}
        <span className="text-white/60">{team.team_name}</span>
      </nav>

      <div className="max-w-3xl mx-auto px-4 pb-12">
        <h1 className="text-2xl font-bold mb-1">{team.team_name} Injury Report</h1>
        <p className="text-sm text-white/40 mb-6">{leagueLabel} - {activeInjuries.length} currently injured</p>

        {/* Currently Injured */}
        {activeInjuries.length > 0 ? (
          <div className="mb-8">
            <h2 className="text-lg font-semibold mb-3">Currently Injured</h2>
            <div className="space-y-2">
              {activeInjuries.map((inj) => (
                <Link
                  key={inj.injury_id}
                  to={`/player/${inj.player_slug}`}
                  className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-lg p-3 hover:bg-white/10 transition-colors"
                >
                  <PlayerAvatar src={inj.headshot_url} name={inj.player_name} size={40} className="rounded-full" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">{inj.player_name}</span>
                      {inj.is_star && <span className="text-yellow-400 text-[10px]">STAR</span>}
                      <span className="text-white/30 text-xs">{inj.position}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-white/50">{inj.injury_type}</span>
                      <span className="text-xs text-white/30">{daysAgo(inj.date_injured)}d ago</span>
                      {inj.expected_return && <span className="text-xs text-cyan-400/60">Est: {inj.expected_return}</span>}
                    </div>
                  </div>
                  <StatusBadge status={inj.status} />
                </Link>
              ))}
            </div>
          </div>
        ) : (
          <div className="bg-white/5 border border-white/10 rounded-xl p-6 text-center mb-8">
            <p className="text-white/40">No currently injured players</p>
          </div>
        )}

        {/* Recently Returned */}
        {returnedRecently.length > 0 && (
          <div className="mb-8">
            <h2 className="text-lg font-semibold mb-3">Recently Returned</h2>
            <div className="space-y-2">
              {returnedRecently.slice(0, 20).map((inj) => (
                <Link
                  key={inj.injury_id}
                  to={`/player/${inj.player_slug}`}
                  className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-lg p-3 hover:bg-white/10 transition-colors"
                >
                  <PlayerAvatar src={inj.headshot_url} name={inj.player_name} size={40} className="rounded-full" />
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-sm">{inj.player_name}</span>
                    <span className="text-white/30 text-xs ml-2">{inj.injury_type}</span>
                  </div>
                  <StatusBadge status={inj.status} />
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Related Links */}
        <div className="border-t border-white/10 pt-8 space-y-2 text-sm">
          <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wide mb-3">Related Links</h3>
          <Link to={`/${team.league_slug}-injuries`} className="block text-cyan-400 hover:underline">
            {leagueLabel} injury report
          </Link>
          <Link to="/" className="block text-cyan-400 hover:underline">
            All injury updates
          </Link>
        </div>

        <p className="mt-6 text-xs text-white/35">
          Last updated: {new Date().toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}
        </p>
      </div>
    </div>
  );
}
