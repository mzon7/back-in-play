import { useState, useMemo } from "react";
import { Link, useSearchParams, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { SiteHeader } from "../components/SiteHeader";
import { SEO } from "../components/seo/SEO";
import { breadcrumbJsonLd, jsonLdGraph } from "../components/seo/seoHelpers";
import { supabase, dbTable } from "../lib/supabase";
import { StatusBadge } from "../components/StatusBadge";
import { PlayerAvatar } from "../components/PlayerAvatar";
import { leagueColor } from "../lib/leagueColors";
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
  curve?: PerformanceCurve | null;
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function useReturningThisWeek(leagueSlug?: string) {
  return useQuery<ReturningPlayer[]>({
    queryKey: ["returning-this-week", leagueSlug ?? "all"],
    queryFn: async () => {
      // 1. Get leagues, teams
      const { data: leagues } = await supabase.from(dbTable("leagues")).select("league_id,league_name,slug");
      const leagueMap = new Map<string, { name: string; slug: string }>();
      (leagues ?? []).forEach((l) => leagueMap.set(l.league_id, { name: l.league_name, slug: l.slug }));

      const { data: teams } = await supabase.from(dbTable("teams")).select("team_id,team_name,league_id").neq("team_name", "Unknown");
      const teamMap = new Map<string, { name: string; leagueId: string }>();
      (teams ?? []).forEach((t) => teamMap.set(t.team_id, { name: t.team_name, leagueId: t.league_id }));

      // 2. Find players expected to return within the next 7 days, or questionable/probable/day-to-day
      const today = new Date();
      const endOfWeek = new Date(today);
      endOfWeek.setDate(today.getDate() + 7);
      const todayStr = today.toISOString().slice(0, 10);
      const endStr = endOfWeek.toISOString().slice(0, 10);
      const cutoff90d = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);

      // Get injuries with expected_return within the week
      const { data: expectedThisWeek } = await supabase
        .from(dbTable("injuries"))
        .select("*")
        .gte("expected_return", todayStr)
        .lte("expected_return", endStr)
        .neq("status", "returned")
        .order("expected_return", { ascending: true })
        .limit(300);

      // Also get questionable/probable/day-to-day players (likely returning soon)
      const { data: nearingReturn } = await supabase
        .from(dbTable("injuries"))
        .select("*")
        .gte("date_injured", cutoff90d)
        .in("status", ["questionable", "day-to-day", "probable", "game_time_decision"])
        .order("date_injured", { ascending: false })
        .limit(200);

      // Also get players who returned this week (for "already back" section)
      const { data: returnedThisWeek } = await supabase
        .from(dbTable("injuries"))
        .select("*")
        .gte("return_date", todayStr)
        .lte("return_date", endStr)
        .eq("status", "returned")
        .order("return_date", { ascending: false })
        .limit(100);

      const allInjs = [...(expectedThisWeek ?? []), ...(nearingReturn ?? []), ...(returnedThisWeek ?? [])];
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

      // Sort: by expected_return date first, then stars, starters, recovery days
      result.sort((a, b) => {
        // Returned players go last
        if ((a.status === "returned") !== (b.status === "returned")) return a.status === "returned" ? 1 : -1;
        // Then by expected_return date
        const aDate = a.expected_return ?? "9999-12-31";
        const bDate = b.expected_return ?? "9999-12-31";
        if (aDate !== bDate) return aDate.localeCompare(bDate);
        if (a.is_star !== b.is_star) return a.is_star ? -1 : 1;
        if (a.is_starter !== b.is_starter) return a.is_starter ? -1 : 1;
        return (b.recovery_days ?? 0) - (a.recovery_days ?? 0);
      });

      return result;
    },
    staleTime: 5 * 60 * 1000,
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
            {median1 != null ? `${Math.round(median1 * 100)}%` : "\u2014"}
          </p>
        </div>
        <div className="text-center">
          <p className="text-[10px] text-white/30">Game 5 Back</p>
          <p className={`text-sm font-bold ${median5 != null && median5 >= 1.0 ? "text-green-400" : "text-amber-400"}`}>
            {median5 != null ? `${Math.round(median5 * 100)}%` : "\u2014"}
          </p>
        </div>
      </div>
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
  const lColor = leagueColor(player.league_slug);

  return (
    <div
      className="rounded-xl border border-white/10 bg-white/5 p-4 hover:bg-white/[0.06] transition-colors"
      style={multiLeague ? { borderTopWidth: 3, borderTopColor: lColor } : undefined}
    >
      <div className="flex items-start gap-3">
        <PlayerAvatar src={player.headshot_url} name={player.player_name} size={48} className="rounded-full" />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              to={`/player/${player.player_slug}`}
              className="text-sm font-semibold text-white hover:text-[#1C7CFF] transition-colors"
            >
              {player.player_name}
            </Link>
            <StatusBadge status={player.status} />
            {player.is_star && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400">Star</span>
            )}
          </div>

          <div className="flex items-center gap-2 mt-0.5 text-xs text-white/40">
            <span>{player.position}</span>
            <span>·</span>
            <span>{player.team_name}</span>
            <span className="inline-flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ backgroundColor: lColor }} />
              <span className="text-white/50">{LEAGUE_LABELS[player.league_slug]}</span>
            </span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
            <span className="text-white/50">
              <span className="text-white/30">Injury:</span> {player.injury_type}
            </span>
            <span className="text-white/50">
              <span className="text-white/30">Out:</span> {daysOut} days
            </span>
            {player.games_missed != null && player.games_missed > 0 && (
              <span className="text-white/50">
                <span className="text-white/30">Missed:</span> {player.games_missed} games
              </span>
            )}
            {player.expected_return && !isReturned && (
              <span className="text-white/50">
                <span className="text-white/30">Expected:</span>{" "}
                <span className="text-[#3DFF8F]">
                  {new Date(player.expected_return).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                </span>
              </span>
            )}
            {isReturned && (
              <span className="text-green-400/70 font-medium">Returned</span>
            )}
          </div>

          {player.curve && (
            <PerformancePreview curve={player.curve} leagueSlug={player.league_slug} />
          )}
        </div>
      </div>
    </div>
  );
}

function formatDayHeading(dateStr: string): string {
  const date = new Date(dateStr + "T12:00:00");
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  if (dateStr === todayStr) return "Today";
  if (dateStr === tomorrowStr) return "Tomorrow";
  return date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

export default function ReturningThisWeekPage() {
  const { leagueSlug: routeLeague } = useParams<{ leagueSlug?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlLeague = routeLeague ?? searchParams.get("league") ?? "all";
  const [league, setLeague] = useState(urlLeague);

  const { data: players = [], isLoading } = useReturningThisWeek(league === "all" ? undefined : league);

  const year = new Date().getFullYear();

  const returning = useMemo(() => players.filter((p) => p.status !== "returned"), [players]);
  const recentlyBack = useMemo(() => players.filter((p) => p.status === "returned"), [players]);

  // Group returning players by expected_return date
  const groupedByDay = useMemo(() => {
    const groups = new Map<string, ReturningPlayer[]>();
    for (const p of returning) {
      const day = p.expected_return ?? "unknown";
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day)!.push(p);
    }
    // Sort groups by date
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [returning]);

  const leagueLabel = league === "all" ? "" : ` ${LEAGUE_LABELS[league]}`;
  const basePath = "/players-returning-from-injury-this-week";
  const currentPath = league === "all" ? basePath : `/${league}${basePath}`;
  const title = `${leagueLabel ? LEAGUE_LABELS[league] : ""} Players Returning From Injury This Week (${year})`.trim();
  const description = `${returning.length}${leagueLabel} players are expected to return from injury this week. See day-by-day return schedule, expected performance impact, and fantasy/betting implications.`;

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
        path={currentPath}
        jsonLd={jsonLdGraph(
          breadcrumbJsonLd([
            { name: "Home", path: "/" },
            ...(league !== "all" ? [{ name: `${LEAGUE_LABELS[league]} Injuries`, path: `/${league}-injuries` }] : []),
            { name: "Returning This Week", path: currentPath },
          ])
        )}
      />
      <SiteHeader />

      {/* Hero */}
      <div className="relative overflow-hidden border-b border-white/10 bg-gradient-to-br from-[#0A0F1E] via-[#0d1529] to-[#0A0F1E]">
        <div className="pointer-events-none absolute -top-32 -left-32 w-96 h-96 rounded-full bg-[#1C7CFF] opacity-10 blur-3xl" />
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
            <span className="text-white/60">Returning This Week</span>
          </nav>

          <div className="flex items-center gap-3 mb-3">
            <span className="text-xs font-bold uppercase tracking-[0.2em] text-[#1C7CFF]">
              Weekly Injury Returns
            </span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-3">
            {league !== "all" ? (
              <>
                <span className="text-white">{LEAGUE_LABELS[league]} Players Returning </span>
                <span className="bg-gradient-to-r from-[#3DFF8F] to-[#1C7CFF] bg-clip-text text-transparent">
                  This Week
                </span>
              </>
            ) : (
              <>
                <span className="text-white">Players Returning </span>
                <span className="bg-gradient-to-r from-[#3DFF8F] to-[#1C7CFF] bg-clip-text text-transparent">
                  From Injury This Week
                </span>
              </>
            )}
          </h1>
          <p className="text-white/50 text-sm max-w-xl">
            {returning.length > 0
              ? `${returning.length} player${returning.length !== 1 ? "s" : ""} expected to return from injury over the next 7 days. Plan your fantasy lineups and bets with day-by-day return projections.`
              : "Track which injured players are expected to return this week across all major sports leagues."}
          </p>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        {/* League filter */}
        {!routeLeague && (
          <div className="flex gap-1.5 overflow-x-auto pb-4 mb-6">
            {(["all", "nba", "nfl", "mlb", "nhl", "premier-league"] as const).map((slug) => (
              <button
                key={slug}
                onClick={() => handleLeague(slug)}
                className={`shrink-0 px-4 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                  league === slug
                    ? "border-[#1C7CFF]/50 bg-[#1C7CFF]/15 text-[#1C7CFF]"
                    : "border-white/10 text-white/40 hover:text-white/60"
                }`}
              >
                {LEAGUE_LABELS[slug]}
              </button>
            ))}
          </div>
        )}

        {/* Fantasy/Betting insight box */}
        <div className="mb-6 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
          <p className="text-xs font-semibold text-amber-400 uppercase tracking-wider mb-1">Fantasy &amp; Betting Insight</p>
          <p className="text-sm text-white/60 leading-relaxed">
            Players returning from injury often face minutes restrictions and reduced performance in their first game back.
            Our data shows an average 12-18% dip in key stats during the first two games after return. Factor this into
            player props, DFS lineups, and season-long roster decisions.
          </p>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((i) => <div key={i} className="h-28 rounded-xl bg-white/10 animate-pulse" />)}
          </div>
        ) : (
          <>
            {/* Players grouped by expected return day */}
            {groupedByDay.length > 0 && (
              <section className="mb-8">
                {groupedByDay.map(([day, dayPlayers]) => (
                  <div key={day} className="mb-6">
                    <h2 className="text-base font-bold mb-3 flex items-center gap-2 sticky top-0 bg-[#0A0F1E] py-2 z-10">
                      <span className="w-2 h-2 rounded-full bg-[#1C7CFF]" />
                      {day === "unknown" ? "Date TBD" : formatDayHeading(day)}
                      <span className="text-white/30 text-sm font-normal">({dayPlayers.length})</span>
                    </h2>
                    <div className="space-y-3">
                      {dayPlayers.map((p) => <PlayerCard key={p.player_id} player={p} multiLeague={league === "all"} />)}
                    </div>
                  </div>
                ))}
              </section>
            )}

            {/* Recently returned this week */}
            {recentlyBack.length > 0 && (
              <section className="mb-8">
                <h2 className="text-lg font-bold mb-3 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-400" />
                  Already Back This Week ({recentlyBack.length})
                </h2>
                <p className="text-xs text-white/30 mb-3">
                  Players who returned from injury earlier this week. Monitor their first-game-back performance.
                </p>
                <div className="space-y-3">
                  {recentlyBack.map((p) => <PlayerCard key={p.player_id} player={p} multiLeague={league === "all"} />)}
                </div>
              </section>
            )}

            {returning.length === 0 && recentlyBack.length === 0 && (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-8 text-center">
                <p className="text-white/50">No players expected to return this week{league !== "all" ? ` in the ${LEAGUE_LABELS[league]}` : ""}.</p>
                <p className="text-xs text-white/30 mt-2">Check back during the season for weekly return schedules.</p>
              </div>
            )}
          </>
        )}

        {/* SEO content */}
        <section className="mt-10 border-t border-white/8 pt-8">
          <h2 className="text-lg font-bold mb-3">
            Why Tracking Weekly Injury Returns Matters
          </h2>
          <div className="text-sm text-white/50 leading-relaxed space-y-3">
            <p>
              For fantasy sports managers and sports bettors, knowing which players are returning from injury
              this week is essential for lineup planning and wagering decisions. Unlike daily updates that
              require constant monitoring, a weekly view lets you plan ahead for the entire slate of games
              and make proactive roster moves before your league-mates.
            </p>
            <p>
              Our database of over 50,000 historical injury returns shows that most athletes experience
              measurable performance drops in their first games back. The severity depends on injury type,
              time missed, and sport. Lower-body injuries tend to have a larger impact on performance than
              upper-body injuries, and players missing more than 3 weeks typically need 3-5 games to return
              to their pre-injury baseline. Use our performance curves to see exactly how players with
              similar injuries have performed historically, and adjust your fantasy lineups and prop bets
              accordingly.
            </p>
          </div>
        </section>

        {/* Related links */}
        <section className="mt-8 border-t border-white/8 pt-6">
          <h2 className="text-sm font-bold uppercase tracking-wide text-white/40 mb-3">
            Related Analysis
          </h2>
          <div className="grid gap-2 sm:grid-cols-2">
            <Link to="/returning-today" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              Players Returning Today
            </Link>
            <Link to="/performance-curves" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              Performance Curves — Recovery Analytics
            </Link>
            <Link to="/recovery-stats" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              Recovery Statistics — Time to Return
            </Link>
            <Link to="/minutes-restriction" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              Minutes Restrictions After Injury
            </Link>
            <Link to="/props" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              Player Props — Today's Lines
            </Link>
            {(["nba", "nfl", "mlb", "nhl", "premier-league"] as const).map((slug) => (
              <Link key={slug} to={`/${slug}-injuries`} className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
                {LEAGUE_LABELS[slug]} Injury Hub
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
