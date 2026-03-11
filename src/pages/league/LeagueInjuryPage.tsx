import { useParams, Link } from "react-router-dom";
import { useCurrentInjuries, type InjuryRow } from "../../hooks/useInjuries";
import { SEO } from "../../components/seo/SEO";
import { StatusBadge } from "../../components/StatusBadge";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";

const LEAGUE_LABELS: Record<string, string> = {
  nba: "NBA", nfl: "NFL", mlb: "MLB", nhl: "NHL", "premier-league": "EPL",
};
const LEAGUE_FULL: Record<string, string> = {
  nba: "National Basketball Association",
  nfl: "National Football League",
  mlb: "Major League Baseball",
  nhl: "National Hockey League",
  "premier-league": "English Premier League",
};

function teamSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Get teams with injury counts for this league */
function useLeagueTeams(leagueSlug: string) {
  return useQuery<{ team_id: string; team_name: string; injuredCount: number }[]>({
    queryKey: ["league-teams-summary", leagueSlug],
    enabled: !!leagueSlug,
    queryFn: async () => {
      const { data: leagues } = await supabase
        .from("back_in_play_leagues")
        .select("league_id")
        .eq("slug", leagueSlug)
        .limit(1);
      if (!leagues?.length) return [];

      const { data: teams } = await supabase
        .from("back_in_play_teams")
        .select("team_id, team_name")
        .eq("league_id", leagues[0].league_id)
        .neq("team_name", "Unknown")
        .order("team_name");

      return (teams ?? []).map((t) => ({ ...t, injuredCount: 0 }));
    },
    staleTime: 5 * 60 * 1000,
  });
}

export default function LeagueInjuryPage() {
  const { leagueSlug: rawSlug } = useParams<{ leagueSlug: string }>();
  // URL is like "/nba-injuries" — strip "-injuries"
  const leagueSlug = (rawSlug ?? "").replace(/-injuries$/, "");
  const { data: injuries, isLoading } = useCurrentInjuries(leagueSlug);
  const { data: teams } = useLeagueTeams(leagueSlug);

  const leagueLabel = LEAGUE_LABELS[leagueSlug] ?? leagueSlug.toUpperCase();
  const leagueFull = LEAGUE_FULL[leagueSlug] ?? leagueLabel;
  const year = new Date().getFullYear();

  const activeInjuries = (injuries ?? []).filter((i) => i.status !== "returned" && i.status !== "active");
  const returning = (injuries ?? []).filter((i) => i.status === "returned" || i.status === "active" || i.status === "back_in_play");

  // Count injuries per team
  const teamCounts = new Map<string, number>();
  activeInjuries.forEach((i) => {
    if (i.team_name) teamCounts.set(i.team_name, (teamCounts.get(i.team_name) ?? 0) + 1);
  });

  const pageTitle = `${leagueLabel} Injuries (${year}) - Injury Report & Updates`;
  const pageDesc = `${leagueFull} injury report — ${activeInjuries.length} players currently injured. Latest ${leagueLabel} injury updates, return dates, and status changes.`;
  const now = new Date().toISOString();

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `${leagueLabel} Injury Report`,
    description: pageDesc,
    url: `https://backinplay.app/${leagueSlug}-injuries`,
    dateModified: now,
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#0a0f1a] flex items-center justify-center">
        <div className="animate-pulse text-white/40 text-sm">Loading {leagueLabel} injuries...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white">
      <SEO title={pageTitle} description={pageDesc} path={`/${leagueSlug}-injuries`} type="website" dateModified={now} jsonLd={jsonLd} />

      {/* Breadcrumb */}
      <nav className="px-4 py-3 text-xs text-white/40 max-w-3xl mx-auto">
        <Link to="/" className="hover:text-white/60">Home</Link>
        {" / "}
        <span className="text-white/60">{leagueLabel} Injuries</span>
      </nav>

      <div className="max-w-3xl mx-auto px-4 pb-12">
        <h1 className="text-2xl font-bold mb-1">{leagueLabel} Injury Report</h1>
        <p className="text-sm text-white/40 mb-6">{leagueFull} - {activeInjuries.length} currently injured</p>

        {/* Team Directory */}
        {teams && teams.length > 0 && (
          <div className="mb-8">
            <h2 className="text-lg font-semibold mb-3">Team Injury Reports</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {teams.map((t) => {
                const count = teamCounts.get(t.team_name) ?? 0;
                return (
                  <Link
                    key={t.team_id}
                    to={`/${leagueSlug}/${teamSlug(t.team_name)}-injuries`}
                    className="bg-white/5 border border-white/10 rounded-lg p-2.5 hover:bg-white/10 transition-colors text-sm"
                  >
                    <span className="font-medium">{t.team_name}</span>
                    {count > 0 && <span className="text-red-400/60 text-xs ml-1">({count})</span>}
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        {/* Currently Injured */}
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-3">Currently Injured ({activeInjuries.length})</h2>
          {activeInjuries.length > 0 ? (
            <div className="space-y-2">
              {activeInjuries.slice(0, 50).map((inj) => (
                <InjuryRow key={inj.injury_id} inj={inj} />
              ))}
              {activeInjuries.length > 50 && (
                <p className="text-white/30 text-xs text-center mt-2">+ {activeInjuries.length - 50} more</p>
              )}
            </div>
          ) : (
            <p className="text-white/40 text-sm">No currently injured players</p>
          )}
        </div>

        {/* Recently Returned */}
        {returning.length > 0 && (
          <div className="mb-8">
            <h2 className="text-lg font-semibold mb-3">Back In Play ({returning.length})</h2>
            <div className="space-y-2">
              {returning.slice(0, 20).map((inj) => (
                <InjuryRow key={inj.injury_id} inj={inj} />
              ))}
            </div>
          </div>
        )}

        {/* Internal Links */}
        <div className="border-t border-white/10 pt-6 space-y-2 text-sm">
          <h3 className="text-white/40 text-xs uppercase tracking-wide mb-2">Other Leagues</h3>
          {Object.entries(LEAGUE_LABELS)
            .filter(([k]) => k !== leagueSlug)
            .map(([slug, label]) => (
              <Link key={slug} to={`/${slug}-injuries`} className="block text-cyan-400 hover:underline">
                {label} Injury Report
              </Link>
            ))}
          <Link to="/" className="block text-cyan-400 hover:underline mt-2">
            All Injury Updates
          </Link>
        </div>

        <p className="mt-6 text-[10px] text-white/20">
          Last updated: {new Date().toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}
        </p>
      </div>
    </div>
  );
}

function InjuryRow({ inj }: { inj: InjuryRow }) {
  const slug = inj.player_name?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ?? "";
  return (
    <Link
      to={`/player/${slug}`}
      className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-lg p-3 hover:bg-white/10 transition-colors"
    >
      {inj.headshot_url ? (
        <img src={inj.headshot_url} alt={inj.player_name ?? ""} className="w-10 h-10 rounded-full object-cover bg-white/5" />
      ) : (
        <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center text-sm text-white/20">
          {(inj.player_name ?? "?")[0]}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm truncate">{inj.player_name}</span>
          {inj.is_star && <span className="text-yellow-400 text-[10px]">STAR</span>}
          <span className="text-white/30 text-xs">{inj.position}</span>
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-xs">
          <span className="text-white/50">{inj.team_name}</span>
          <span className="text-white/30">-</span>
          <span className="text-white/50">{inj.injury_type}</span>
          {inj.expected_return && <span className="text-cyan-400/60">Est: {inj.expected_return}</span>}
        </div>
      </div>
      <StatusBadge status={inj.status} />
    </Link>
  );
}
