// @refresh reset
import { useState, useEffect } from "react";
import { SiteHeader } from "../../components/SiteHeader";
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
  const { slug: rawSlug } = useParams<{ slug: string }>();
  // URL is like "/nba-injuries" — strip "-injuries"
  const leagueSlug = (rawSlug ?? "").replace(/-injuries$/, "");
  const { data: injuries, isLoading } = useCurrentInjuries(leagueSlug);
  const { data: teams } = useLeagueTeams(leagueSlug);
  const [teamFilter, setTeamFilter] = useState<string | null>(null);

  // Reset filter when league changes
  useEffect(() => { setTeamFilter(null); }, [leagueSlug]);

  const leagueLabel = LEAGUE_LABELS[leagueSlug] ?? leagueSlug.toUpperCase();
  const leagueFull = LEAGUE_FULL[leagueSlug] ?? leagueLabel;
  const year = new Date().getFullYear();

  const allActive = (injuries ?? []).filter((i) => i.status !== "returned" && i.status !== "active");
  const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const allReturning = (injuries ?? []).filter((i) =>
    (i.status === "returned" || i.status === "back_in_play") &&
    (i.return_date ?? i.updated_at ?? "") >= fourteenDaysAgo
  );

  const activeInjuries = teamFilter ? allActive.filter((i) => i.team_name === teamFilter) : allActive;
  const returning = teamFilter ? allReturning.filter((i) => i.team_name === teamFilter) : allReturning;

  // Unique team names for the filter bar
  const teamNames = Array.from(new Set((injuries ?? []).map((i) => i.team_name ?? "").filter((t) => t && t !== "Unknown"))).sort();

  // Count injuries per team (unfiltered for directory display)
  const teamCounts = new Map<string, number>();
  allActive.forEach((i) => {
    if (i.team_name) teamCounts.set(i.team_name, (teamCounts.get(i.team_name) ?? 0) + 1);
  });

  const pageTitle = `${leagueLabel} Injuries (${year}) - Injury Report & Updates`;
  const pageDesc = `${leagueFull} injury report — ${allActive.length} players currently injured. Latest ${leagueLabel} injury updates, return dates, and status changes.`;
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
      <SiteHeader />

      {/* Breadcrumb */}
      <nav className="px-4 py-3 text-sm text-white/45 max-w-3xl mx-auto">
        <Link to="/" className="hover:text-white/60">Home</Link>
        {" / "}
        <span className="text-white/60">{leagueLabel} Injuries</span>
      </nav>

      <div className="max-w-3xl mx-auto px-4 pb-12">
        <h1 className="text-2xl font-bold mb-1">{leagueLabel} Injury Report</h1>
        <p className="text-sm text-white/40 mb-4">{leagueFull} - {allActive.length} currently injured</p>

        {/* Team filter */}
        {teamNames.length > 1 && (
          <div className="flex gap-1.5 overflow-x-auto pb-3 -mx-1 px-1 mb-4">
            <button
              onClick={() => setTeamFilter(null)}
              className={`shrink-0 px-3 py-1 rounded-full text-[11px] font-semibold border transition-colors ${
                teamFilter === null
                  ? "border-white/30 bg-white/10 text-white"
                  : "border-white/10 text-white/40 hover:text-white/60"
              }`}
            >
              All Teams ({(injuries ?? []).length})
            </button>
            {teamNames.map((team) => {
              const count = (injuries ?? []).filter((i) => i.team_name === team).length;
              return (
                <button
                  key={team}
                  onClick={() => setTeamFilter(teamFilter === team ? null : team)}
                  className={`shrink-0 px-3 py-1 rounded-full text-[11px] font-semibold border transition-colors ${
                    teamFilter === team
                      ? "border-[#1C7CFF]/50 bg-[#1C7CFF]/15 text-[#1C7CFF]"
                      : "border-white/10 text-white/40 hover:text-white/60"
                  }`}
                >
                  {team} ({count})
                </button>
              );
            })}
          </div>
        )}

        {/* Jump navigation */}
        <nav className="flex flex-wrap gap-1.5 py-3 border-b border-white/8 mb-6">
          {teams && teams.length > 0 && (
            <button
              onClick={() => document.getElementById("league-teams")?.scrollIntoView({ behavior: "smooth", block: "start" })}
              className="px-3 py-1.5 rounded-full text-xs font-medium text-white/50 border border-white/10 hover:bg-white/10 hover:text-white/70 transition-colors"
            >
              Teams
            </button>
          )}
          {activeInjuries.length > 0 && (
            <button
              onClick={() => document.getElementById("league-injured")?.scrollIntoView({ behavior: "smooth", block: "start" })}
              className="px-3 py-1.5 rounded-full text-xs font-medium text-white/50 border border-white/10 hover:bg-white/10 hover:text-white/70 transition-colors"
            >
              Injured ({activeInjuries.length})
            </button>
          )}
          {returning.length > 0 && (
            <button
              onClick={() => document.getElementById("league-returning")?.scrollIntoView({ behavior: "smooth", block: "start" })}
              className="px-3 py-1.5 rounded-full text-xs font-medium text-white/50 border border-white/10 hover:bg-white/10 hover:text-white/70 transition-colors"
            >
              Back In Play ({returning.length})
            </button>
          )}
        </nav>

        {/* Team Directory */}
        {teams && teams.length > 0 && (
          <div id="league-teams" className="scroll-mt-32 mb-10">
            <h2 className="text-base font-bold uppercase tracking-wide text-white/80 mb-3">Team Injury Reports</h2>
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

        {/* Currently Injured — collapsible with show-more */}
        <LeagueSection
          id="league-injured"
          title="Currently Injured"
          emoji={"\u26A0\uFE0F"}
          color="text-red-400"
          items={activeInjuries}
          defaultCollapsed={false}
        />

        {/* Back In Play — collapsible with show-more */}
        {returning.length > 0 && (
          <LeagueSection
            id="league-returning"
            title="Back In Play"
            emoji={"\u26A1"}
            color="text-cyan-400"
            items={returning}
            defaultCollapsed={false}
          />
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

const LEAGUE_SECTION_LIMIT = 12;

function LeagueSection({
  id,
  title,
  emoji,
  color,
  items,
  defaultCollapsed = false,
}: {
  id: string;
  title: string;
  emoji: string;
  color: string;
  items: InjuryRow[];
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [showAll, setShowAll] = useState(false);

  if (items.length === 0) return null;

  // Sort by importance: stars first, then starters, then by rank
  const sorted = [...items].sort((a, b) => {
    const scoreA = (a.is_star ? 100 : 0) + (a.is_starter ? 50 : 0) + (50 - Math.min(a.league_rank ?? 999, a.preseason_rank ?? 999, 50));
    const scoreB = (b.is_star ? 100 : 0) + (b.is_starter ? 50 : 0) + (50 - Math.min(b.league_rank ?? 999, b.preseason_rank ?? 999, 50));
    return scoreB - scoreA;
  });

  const visible = showAll ? sorted : sorted.slice(0, LEAGUE_SECTION_LIMIT);
  const hasMore = sorted.length > LEAGUE_SECTION_LIMIT;

  return (
    <div id={id} className="scroll-mt-32 rounded-2xl border border-white/8 bg-white/[0.02] mb-10">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2.5 px-5 py-4 text-left"
      >
        <span className="text-xl">{emoji}</span>
        <h2 className={`text-base font-bold uppercase tracking-wide ${color}`}>{title}</h2>
        <span className="text-sm text-white/40">({sorted.length})</span>
        <span className="ml-auto text-white/30 text-sm transition-transform" style={{ transform: collapsed ? "rotate(-90deg)" : "rotate(0)" }}>&#9660;</span>
      </button>

      {!collapsed && (
        <div className="px-5 pb-5 space-y-2">
          {visible.map((inj) => (
            <InjuryRowItem key={inj.injury_id} inj={inj} />
          ))}
          {hasMore && !showAll && (
            <button
              onClick={() => setShowAll(true)}
              className="w-full py-2.5 rounded-lg border border-white/10 text-sm text-white/50 hover:bg-white/5 hover:text-white/70 transition-colors"
            >
              Show all {sorted.length} players
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function InjuryRowItem({ inj }: { inj: InjuryRow }) {
  const slug = inj.player_slug || (inj.player_name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
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
