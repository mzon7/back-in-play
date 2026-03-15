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
  return_date: string | null;
  games_missed: number | null;
  recovery_days: number | null;
  status: string;
  expected_return: string | null;
  is_star: boolean;
  is_starter: boolean;
  games_back: number;
  // Matched curve data
  curve?: PerformanceCurve | null;
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Only show leagues where the regular season is actually underway (no pre-season buffer). */
function isCurrentlyInSeason(slug: string): boolean {
  const now = new Date();
  // Season boundaries: [startMonth, startDay, endMonth, endDay]
  const seasons: Record<string, [number, number, number, number]> = {
    nba:              [10, 15,  6, 20],
    nfl:              [ 9,  5,  2, 10],
    nhl:              [10, 10,  6, 25],
    mlb:              [ 3, 27, 10, 31],
    "premier-league": [ 8, 10,  5, 25],
  };
  const range = seasons[slug];
  if (!range) return true;

  const [sm, sd, em, ed] = range;
  const year = now.getFullYear();

  const seasonStart = new Date(year, sm - 1, sd);
  const seasonEnd = new Date(year, em - 1, ed);

  // Non-wrapping season (e.g. MLB Mar-Oct)
  if (seasonStart <= seasonEnd) {
    return now >= seasonStart && now <= seasonEnd;
  }

  // Wrapping season (e.g. NFL Sep-Feb, NBA Oct-Jun)
  // Either we're in the start→Dec part, or the Jan→end part
  return now >= seasonStart || now <= seasonEnd;
}

function useReturningPlayers(leagueSlug?: string) {
  return useQuery<ReturningPlayer[]>({
    queryKey: ["returning-today-page", leagueSlug ?? "all"],
    queryFn: async () => {
      // 1. Get leagues, teams, players
      const { data: leagues } = await supabase.from(dbTable("leagues")).select("league_id,league_name,slug");
      const leagueMap = new Map<string, { name: string; slug: string }>();
      (leagues ?? []).forEach((l) => leagueMap.set(l.league_id, { name: l.league_name, slug: l.slug }));

      const { data: teams } = await supabase.from(dbTable("teams")).select("team_id,team_name,league_id").neq("team_name", "Unknown");
      const teamMap = new Map<string, { name: string; leagueId: string }>();
      (teams ?? []).forEach((t) => teamMap.set(t.team_id, { name: t.team_name, leagueId: t.league_id }));

      // 2. Pre-filter: get player IDs for in-season leagues only
      // This prevents off-season leagues (NFL in spring etc.) from filling up query limits
      const inSeasonLeagueIds: string[] = [];
      for (const [lid, lg] of leagueMap) {
        if (leagueSlug && leagueSlug !== "all" && lg.slug !== leagueSlug) continue;
        if (isCurrentlyInSeason(lg.slug)) inSeasonLeagueIds.push(lid);
      }
      const inSeasonTeamIds: string[] = [];
      for (const [tid, tm] of teamMap) {
        if (inSeasonLeagueIds.includes(tm.leagueId)) inSeasonTeamIds.push(tid);
      }
      // Fetch player IDs for in-season teams
      const inSeasonPlayerIds = new Set<string>();
      for (let i = 0; i < inSeasonTeamIds.length; i += 100) {
        const chunk = inSeasonTeamIds.slice(i, i + 100);
        const { data } = await supabase
          .from(dbTable("players"))
          .select("player_id")
          .in("team_id", chunk);
        (data ?? []).forEach((p) => inSeasonPlayerIds.add(p.player_id));
      }

      if (inSeasonPlayerIds.size === 0) return [];
      const seasonPids = Array.from(inSeasonPlayerIds);

      // 3. Find players nearing return OR recently returned (only in-season players)
      const cutoff21d = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
      const cutoff90d = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);

      // Query in chunks since we filter by player_id
      const allInjs: any[] = [];
      for (let i = 0; i < seasonPids.length; i += 200) {
        const chunk = seasonPids.slice(i, i + 200);
        const [r1, r2] = await Promise.all([
          supabase
            .from(dbTable("injuries"))
            .select("*")
            .in("player_id", chunk)
            .gte("date_injured", cutoff90d)
            .in("status", ["questionable", "day-to-day", "probable", "doubtful"])
            .order("date_injured", { ascending: false }),
          supabase
            .from(dbTable("injuries"))
            .select("*")
            .in("player_id", chunk)
            .gte("return_date", cutoff21d)
            .in("status", ["returned", "active", "active_today", "back_in_play", "reduced_load"])
            .order("return_date", { ascending: false }),
        ]);
        allInjs.push(...(r1.data ?? []), ...(r2.data ?? []));
      }

      // Dedupe by player_id (keep most recent)
      const byPlayer = new Map<string, (typeof allInjs)[0]>();
      for (const inj of allInjs) {
        if (!byPlayer.has(inj.player_id)) byPlayer.set(inj.player_id, inj);
      }

      // 4. Fetch player details
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

      // 5. Count actual games played since return_date for returned players
      const returnedPids: { pid: string; returnDate: string }[] = [];
      for (const [pid, inj] of byPlayer) {
        if (inj.return_date && ["returned", "active", "active_today", "back_in_play", "reduced_load"].includes(inj.status)) {
          returnedPids.push({ pid, returnDate: inj.return_date });
        }
      }
      const gamesBackMap = new Map<string, number>();
      if (returnedPids.length > 0) {
        // Batch query game logs for returned players
        const rpIds = returnedPids.map((r) => r.pid);
        const earliestReturn = returnedPids.reduce((min, r) => r.returnDate < min ? r.returnDate : min, returnedPids[0].returnDate);
        for (let i = 0; i < rpIds.length; i += 100) {
          const chunk = rpIds.slice(i, i + 100);
          const { data: logs } = await supabase
            .from("back_in_play_player_game_logs")
            .select("player_id, game_date")
            .in("player_id", chunk)
            .gte("game_date", earliestReturn)
            .order("game_date", { ascending: false });
          if (logs) {
            // Build per-player return date lookup
            const returnDateLookup = new Map<string, string>();
            for (const r of returnedPids) returnDateLookup.set(r.pid, r.returnDate);
            for (const log of logs) {
              const rd = returnDateLookup.get(log.player_id);
              if (rd && log.game_date >= rd) {
                gamesBackMap.set(log.player_id, (gamesBackMap.get(log.player_id) ?? 0) + 1);
              }
            }
          }
        }
      }

      // 6. Build result
      const result: ReturningPlayer[] = [];
      for (const [pid, inj] of byPlayer) {
        const p = players.get(pid);
        if (!p) continue;
        const team = teamMap.get(p.team_id);
        if (!team) continue;
        const league = leagueMap.get(team.leagueId);
        if (!league) continue;
        if (leagueSlug && leagueSlug !== "all" && league.slug !== leagueSlug) continue;
        if (!isCurrentlyInSeason(league.slug)) continue;

        // Skip same-day injured/returned entries (likely day-to-day noise)
        if (inj.return_date && inj.date_injured === inj.return_date && (inj.games_missed == null || inj.games_missed === 0)) continue;

        const injSlug = slugify(inj.injury_type);
        const curveKey = `${league.slug}:${injSlug}`;

        // Compute actual recovery days
        let recoveryDays = inj.recovery_days;
        if (recoveryDays == null) {
          const endDate = inj.return_date ? new Date(inj.return_date) : new Date();
          recoveryDays = Math.max(0, Math.floor((endDate.getTime() - new Date(inj.date_injured).getTime()) / 86400000));
        }

        // Use real game count from game logs, not estimation
        const gamesBack = gamesBackMap.get(pid) ?? 0;

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
          return_date: inj.return_date ?? null,
          games_missed: inj.games_missed,
          recovery_days: recoveryDays,
          status: inj.status,
          expected_return: inj.expected_return,
          is_star: p.is_star ?? false,
          is_starter: p.is_starter ?? false,
          games_back: gamesBack,
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
  const isBack = ["returned", "active", "active_today", "back_in_play", "reduced_load"].includes(player.status);

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
          {player.games_missed != null && player.games_missed > 0 && (
            <span className="text-white/50">
              <span className="text-white/30">Missed:</span> {player.games_missed} game{player.games_missed !== 1 ? "s" : ""}
            </span>
          )}
          {isBack && player.games_back > 0 && (
            <span className="text-cyan-400/70 font-medium">
              ~{player.games_back} game{player.games_back !== 1 ? "s" : ""} back
            </span>
          )}
          {isBack && player.games_back === 0 && (
            <span className="text-green-400/70 font-medium">Just returned</span>
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

  const returning = useMemo(() => players.filter(
    (p) => !["returned", "active", "active_today", "back_in_play", "reduced_load"].includes(p.status)
  ), [players]);

  // Just Returned: players with return_date, 0-10 games back, sorted by fewest games
  const justReturned = useMemo(() => players.filter(
    (p) => ["returned", "active", "active_today", "back_in_play", "reduced_load"].includes(p.status)
      && p.return_date && (p.games_back ?? 0) >= 0 && (p.games_back ?? 0) <= 10
  ).sort((a, b) => (a.games_back ?? 0) - (b.games_back ?? 0)), [players]);

  // Other recently returned: more than 10 games back
  const recentlyBack = useMemo(() => players.filter(
    (p) => ["returned", "active", "active_today", "back_in_play", "reduced_load"].includes(p.status)
      && (!p.return_date || (p.games_back ?? 0) > 10)
  ), [players]);

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

            {/* Just Returned: 0-10 games back */}
            {justReturned.length > 0 && (
              <section className="mb-8">
                <h2 className="text-lg font-bold mb-3 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-cyan-400" />
                  Just Returned ({justReturned.length})
                </h2>
                <p className="text-xs text-white/30 mb-3">
                  Players within their first 10 games back from injury — the window where performance is most affected.
                </p>
                <div className="space-y-3">
                  {justReturned.map((p) => <PlayerCard key={p.player_id} player={p} multiLeague={league === "all"} />)}
                </div>
              </section>
            )}

            {/* Recently returned: 11+ games back */}
            {recentlyBack.length > 0 && (
              <section className="mb-8">
                <h2 className="text-lg font-bold mb-3 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-400" />
                  Recently Returned ({recentlyBack.length})
                </h2>
                <p className="text-xs text-white/30 mb-3">
                  Players who recently returned from injury and are past the initial recovery window.
                </p>
                <div className="space-y-3">
                  {recentlyBack.map((p) => <PlayerCard key={p.player_id} player={p} multiLeague={league === "all"} />)}
                </div>
              </section>
            )}

            {returning.length === 0 && justReturned.length === 0 && recentlyBack.length === 0 && (
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
