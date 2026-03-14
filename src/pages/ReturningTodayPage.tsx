import { useState, useMemo } from "react";
import { Link, useSearchParams, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { SiteHeader } from "../components/SiteHeader";
import { SEO } from "../components/seo/SEO";
import { breadcrumbJsonLd, jsonLdGraph } from "../components/seo/seoHelpers";
import { supabase, dbTable } from "../lib/supabase";
import { InjuryPlayerCard } from "../components/InjuryPlayerCard";
import type { PerformanceCurve } from "../features/performance-curves/lib/types";
import { STAT_LABELS, LEAGUE_STATS } from "../features/performance-curves/lib/types";

const LEAGUE_LABELS: Record<string, string> = {
  all: "All Leagues",
  nba: "NBA",
  nfl: "NFL",
  mlb: "MLB",
  nhl: "NHL",
  "premier-league": "EPL",
};

interface ReturningPlayer {
  player_id: string;
  player_name: string;
  player_slug: string;
  position: string;
  team_name: string;
  league_slug: string;
  headshot_url: string | null;
  injury_type: string;
  injury_type_slug: string;
  date_injured: string;
  games_missed: number | null;
  recovery_days: number | null;
  status: string;
  expected_return: string | null;
  is_star: boolean;
  is_starter: boolean;
  // Matched curve data
  curve?: PerformanceCurve | null;
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function useReturningPlayers(leagueSlug?: string) {
  return useQuery<ReturningPlayer[]>({
    queryKey: ["returning-today", leagueSlug ?? "all"],
    queryFn: async () => {
      // 1. Get leagues, teams, players
      const { data: leagues } = await supabase.from(dbTable("leagues")).select("league_id,league_name,slug");
      const leagueMap = new Map<string, { name: string; slug: string }>();
      (leagues ?? []).forEach((l) => leagueMap.set(l.league_id, { name: l.league_name, slug: l.slug }));

      const { data: teams } = await supabase.from(dbTable("teams")).select("team_id,team_name,league_id").neq("team_name", "Unknown");
      const teamMap = new Map<string, { name: string; leagueId: string }>();
      (teams ?? []).forEach((t) => teamMap.set(t.team_id, { name: t.team_name, leagueId: t.league_id }));

      // 2. Find players who are questionable, day-to-day, probable, or recently returned (last 7 days)
      const cutoff7d = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const cutoff90d = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);

      // Get injuries: either returning-status or recently returned
      const { data: returningInjuries } = await supabase
        .from(dbTable("injuries"))
        .select("*")
        .gte("date_injured", cutoff90d)
        .in("status", ["questionable", "day-to-day", "probable", "game_time_decision"])
        .order("date_injured", { ascending: false })
        .limit(200);

      const { data: recentlyReturned } = await supabase
        .from(dbTable("injuries"))
        .select("*")
        .gte("return_date", cutoff7d)
        .eq("status", "returned")
        .order("return_date", { ascending: false })
        .limit(100);

      const allInjs = [...(returningInjuries ?? []), ...(recentlyReturned ?? [])];
      // Dedupe by player_id (keep most recent)
      const byPlayer = new Map<string, (typeof allInjs)[0]>();
      for (const inj of allInjs) {
        if (!byPlayer.has(inj.player_id)) byPlayer.set(inj.player_id, inj);
      }

      // 3. Fetch player details
      const playerIds = Array.from(byPlayer.keys());
      if (playerIds.length === 0) return [];

      const players = new Map<string, any>();
      for (let i = 0; i < playerIds.length; i += 100) {
        const chunk = playerIds.slice(i, i + 100);
        const { data } = await supabase
          .from(dbTable("players"))
          .select("player_id,player_name,slug,position,team_id,headshot_url,espn_id,is_star,is_starter,league_rank")
          .in("player_id", chunk);
        (data ?? []).forEach((p) => players.set(p.player_id, p));
      }

      // 4. Fetch performance curves for matching injury types
      const injurySlugs = [...new Set(allInjs.map((i) => slugify(i.injury_type)).filter(Boolean))];
      const curves = new Map<string, PerformanceCurve>();
      if (injurySlugs.length > 0) {
        const { data: curveData } = await supabase
          .from(dbTable("performance_curves"))
          .select("*")
          .in("injury_type_slug", injurySlugs)
          .eq("position", "")
          .gte("sample_size", 3);
        (curveData ?? []).forEach((c: any) => {
          const key = `${c.league_slug}:${c.injury_type_slug}`;
          curves.set(key, c as PerformanceCurve);
        });
      }

      // 5. Build result
      const result: ReturningPlayer[] = [];
      for (const [pid, inj] of byPlayer) {
        const p = players.get(pid);
        if (!p) continue;
        const team = teamMap.get(p.team_id);
        if (!team) continue;
        const league = leagueMap.get(team.leagueId);
        if (!league) continue;
        if (leagueSlug && leagueSlug !== "all" && league.slug !== leagueSlug) continue;

        const injSlug = slugify(inj.injury_type);
        const curveKey = `${league.slug}:${injSlug}`;

        result.push({
          player_id: pid,
          player_name: p.player_name,
          player_slug: p.slug ?? slugify(p.player_name),
          position: p.position ?? "",
          team_name: team.name,
          league_slug: league.slug,
          headshot_url: p.headshot_url ?? (p.espn_id ? `https://a.espncdn.com/i/headshots/nba/players/full/${p.espn_id}.png` : null),
          injury_type: inj.injury_type,
          injury_type_slug: injSlug,
          date_injured: inj.date_injured,
          games_missed: inj.games_missed,
          recovery_days: inj.recovery_days ?? Math.floor((Date.now() - new Date(inj.date_injured).getTime()) / 86400000),
          status: inj.status,
          expected_return: inj.expected_return,
          is_star: p.is_star ?? false,
          is_starter: p.is_starter ?? false,
          curve: curves.get(curveKey) ?? null,
        });
      }

      // Sort: stars first, then starters, then by recovery days
      result.sort((a, b) => {
        if (a.is_star !== b.is_star) return a.is_star ? -1 : 1;
        if (a.is_starter !== b.is_starter) return a.is_starter ? -1 : 1;
        return (b.recovery_days ?? 0) - (a.recovery_days ?? 0);
      });

      return result;
    },
    staleTime: 2 * 60 * 1000,
  });
}

function parseJsonArray(val: unknown): (number | null)[] {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") { try { return JSON.parse(val); } catch { return []; } }
  return [];
}

function PerformancePreview({ curve, leagueSlug }: { curve: PerformanceCurve; leagueSlug: string }) {
  const stats = LEAGUE_STATS[leagueSlug] ?? [];
  const median1 = parseJsonArray(curve.median_pct_recent)[0];
  const median5 = parseJsonArray(curve.median_pct_recent)[4];

  // Parse stat data
  let statAvg: Record<string, (number | null)[]> | null = null;
  if (curve.stat_avg_pct) {
    statAvg = typeof curve.stat_avg_pct === "string" ? JSON.parse(curve.stat_avg_pct) : curve.stat_avg_pct;
  }

  return (
    <div className="mt-3 bg-white/[0.03] rounded-lg p-3 border border-white/5">
      <p className="text-[10px] text-white/30 uppercase tracking-wider font-medium mb-2">
        Historical Performance After {curve.injury_type} ({curve.sample_size} cases)
      </p>
      <div className="grid grid-cols-2 gap-2 mb-2">
        <div className="text-center">
          <p className="text-[10px] text-white/30">Game 1 Back</p>
          <p className={`text-sm font-bold ${median1 != null && median1 >= 1.0 ? "text-green-400" : "text-amber-400"}`}>
            {median1 != null ? `${Math.round(median1 * 100)}%` : "—"}
          </p>
        </div>
        <div className="text-center">
          <p className="text-[10px] text-white/30">Game 5 Back</p>
          <p className={`text-sm font-bold ${median5 != null && median5 >= 1.0 ? "text-green-400" : "text-amber-400"}`}>
            {median5 != null ? `${Math.round(median5 * 100)}%` : "—"}
          </p>
        </div>
      </div>
      {/* Per-stat breakdown for game 1 */}
      {statAvg && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1">
          {stats.map((stat) => {
            const g1 = statAvg![stat]?.[0];
            if (g1 == null) return null;
            const pct = Math.round(g1 * 100);
            const diff = pct - 100;
            return (
              <span key={stat} className="text-[11px]">
                <span className="text-white/30">{STAT_LABELS[stat] ?? stat}: </span>
                <span className={diff >= 0 ? "text-green-400" : "text-red-400"}>
                  {diff >= 0 ? "+" : ""}{diff}%
                </span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PlayerCard({ player, multiLeague }: { player: ReturningPlayer; multiLeague: boolean }) {
  const isReturned = player.status === "returned";
  const daysOut = player.recovery_days ?? 0;

  return (
    <InjuryPlayerCard
      player_name={player.player_name}
      player_slug={player.player_slug}
      position={player.position}
      team_name={player.team_name}
      league_slug={player.league_slug}
      headshot_url={player.headshot_url}
      status={player.status}
      injury_type={player.injury_type}
      date_injured={player.date_injured}
      expected_return={player.expected_return}
      is_star={player.is_star}
      is_starter={player.is_starter}
      games_missed={player.games_missed}
      showLeague={multiLeague}
      avatarSize={48}
    >
      {/* Extra returning-specific details */}
      <div className="px-4 pb-3">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="text-white/50">
            <span className="text-white/30">Out:</span> {daysOut} days
          </span>
          {isReturned && (
            <span className="text-green-400/70 font-medium">Returned</span>
          )}
        </div>
        {/* Performance preview from curve data */}
        {player.curve && (
          <PerformancePreview curve={player.curve} leagueSlug={player.league_slug} />
        )}
      </div>
    </InjuryPlayerCard>
  );
}

export default function ReturningTodayPage() {
  const { leagueSlug: routeLeague } = useParams<{ leagueSlug?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlLeague = routeLeague ?? searchParams.get("league") ?? "all";
  const [league, setLeague] = useState(urlLeague);

  const { data: players = [], isLoading } = useReturningPlayers(league === "all" ? undefined : league);

  const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  const returning = useMemo(() => players.filter((p) => p.status !== "returned"), [players]);
  const recentlyBack = useMemo(() => players.filter((p) => p.status === "returned"), [players]);

  const leagueLabel = league === "all" ? "" : ` ${LEAGUE_LABELS[league]}`;
  const title = `${leagueLabel ? LEAGUE_LABELS[league] : ""} Players Returning From Injury Today (${today})`;
  const description = `Which${leagueLabel} players are returning from injury today? See expected performance drops, stat changes, and prop implications for ${returning.length} players nearing return.`;

  function handleLeague(slug: string) {
    setLeague(slug);
    if (slug === "all") searchParams.delete("league");
    else searchParams.set("league", slug);
    setSearchParams(searchParams, { replace: true });
  }

  return (
    <div className="min-h-screen bg-[#0A0F1E] text-white">
      <SEO
        title={title}
        description={description}
        path={league === "all" ? "/returning-today" : `/${league}/returning-today`}
        jsonLd={jsonLdGraph(
          breadcrumbJsonLd([
            { name: "Home", path: "/" },
            ...(league !== "all" ? [{ name: `${LEAGUE_LABELS[league]} Injuries`, path: `/${league}-injuries` }] : []),
            { name: "Returning Today", path: league === "all" ? "/returning-today" : `/${league}/returning-today` },
          ])
        )}
      />
      <SiteHeader />

      {/* Hero */}
      <div className="relative overflow-hidden border-b border-white/10 bg-gradient-to-br from-[#0A0F1E] via-[#0d1529] to-[#0A0F1E]">
        <div className="pointer-events-none absolute -top-32 -left-32 w-96 h-96 rounded-full bg-[#3DFF8F] opacity-10 blur-3xl" />
        <div className="relative max-w-4xl mx-auto px-4 sm:px-6 py-10">
          <nav className="text-sm text-white/40 mb-4">
            <Link to="/" className="hover:text-white/60">Home</Link>
            {league !== "all" && (
              <>
                {" / "}
                <Link to={`/${league}-injuries`} className="hover:text-white/60">{LEAGUE_LABELS[league]} Injuries</Link>
              </>
            )}
            {" / "}
            <span className="text-white/60">Returning Today</span>
          </nav>

          <div className="flex items-center gap-3 mb-3">
            <span className="text-xs font-bold uppercase tracking-[0.2em] text-[#3DFF8F]">
              Daily Injury Returns
            </span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-3">
            <span className="text-white">Players Returning </span>
            <span className="bg-gradient-to-r from-[#3DFF8F] to-[#1C7CFF] bg-clip-text text-transparent">
              From Injury Today
            </span>
          </h1>
          <p className="text-white/50 text-sm max-w-xl">
            {today} — Players nearing return or recently back from injury.
            See historical performance trends for their injury type to gauge expected impact.
          </p>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        {/* League filter */}
        <div className="flex gap-1.5 overflow-x-auto pb-4 mb-6">
          {(["all", "nba", "nfl", "mlb", "nhl", "premier-league"] as const).map((slug) => (
            <button
              key={slug}
              onClick={() => handleLeague(slug)}
              className={`shrink-0 px-4 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                league === slug
                  ? "border-[#3DFF8F]/50 bg-[#3DFF8F]/15 text-[#3DFF8F]"
                  : "border-white/10 text-white/40 hover:text-white/60"
              }`}
            >
              {LEAGUE_LABELS[slug]}
            </button>
          ))}
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => <div key={i} className="h-28 rounded-xl bg-white/10 animate-pulse" />)}
          </div>
        ) : (
          <>
            {/* Players likely returning / questionable */}
            {returning.length > 0 && (
              <section className="mb-8">
                <h2 className="text-lg font-bold mb-3 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-amber-400" />
                  Nearing Return ({returning.length})
                </h2>
                <div className="space-y-3">
                  {returning.map((p) => <PlayerCard key={p.player_id} player={p} multiLeague={league === "all"} />)}
                </div>
              </section>
            )}

            {/* Recently returned */}
            {recentlyBack.length > 0 && (
              <section className="mb-8">
                <h2 className="text-lg font-bold mb-3 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-400" />
                  Recently Returned ({recentlyBack.length})
                </h2>
                <p className="text-xs text-white/30 mb-3">
                  Players who returned from injury in the last 7 days. Performance data shows how similar injuries typically affect play.
                </p>
                <div className="space-y-3">
                  {recentlyBack.map((p) => <PlayerCard key={p.player_id} player={p} multiLeague={league === "all"} />)}
                </div>
              </section>
            )}

            {returning.length === 0 && recentlyBack.length === 0 && (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-8 text-center">
                <p className="text-white/50">No players currently nearing return{league !== "all" ? ` in the ${LEAGUE_LABELS[league]}` : ""}.</p>
                <p className="text-xs text-white/30 mt-2">Check back during the season for daily return updates.</p>
              </div>
            )}
          </>
        )}

        {/* SEO content */}
        <section className="mt-10 border-t border-white/8 pt-8">
          <h2 className="text-lg font-bold mb-3">
            Why First-Game-Back Performance Matters
          </h2>
          <div className="text-sm text-white/50 leading-relaxed space-y-3">
            <p>
              When a player returns from injury, their first few games back are critical data points
              for fantasy managers and sports bettors. Historical data shows that most athletes
              experience a measurable performance dip in their first game back — typically 10-20%
              below their pre-injury baseline in key stats like points, yards, or goals.
            </p>
            <p>
              This page tracks which players are returning from injury today and matches them against
              our database of {">"}50,000 historical injury return cases to project expected performance.
              Minutes restrictions are common in first games back, particularly for players recovering
              from lower body injuries or returning from extended absences.
            </p>
          </div>
        </section>

        {/* Related links */}
        <section className="mt-8 border-t border-white/8 pt-6">
          <h2 className="text-sm font-bold uppercase tracking-wide text-white/40 mb-3">
            Related Analysis
          </h2>
          <div className="grid gap-2 sm:grid-cols-2">
            <Link to="/performance-curves" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              Performance Curves — Recovery Analytics
            </Link>
            <Link to="/recovery-stats" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              Recovery Statistics — Time to Return
            </Link>
            <Link to="/props" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              Player Props — Today's Lines
            </Link>
            {(["nba", "nfl", "mlb", "nhl", "premier-league"] as const).map((slug) => (
              <Link key={slug} to={`/${slug}-injury-performance`} className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
                {LEAGUE_LABELS[slug]} Injury Performance
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
