import { useState, useMemo } from "react";
import { Link, useSearchParams, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { SiteHeader } from "../components/SiteHeader";
import { SEO } from "../components/seo/SEO";
import { breadcrumbJsonLd, jsonLdGraph } from "../components/seo/seoHelpers";
import { supabase, dbTable } from "../lib/supabase";
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
  return_date: string | null;
  games_missed: number | null;
  recovery_days: number | null;
  status: string;
  expected_return: string | null;
  is_star: boolean;
  is_starter: boolean;
  games_back: number;
  next_game_date: string | null;
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
      // 1. Get leagues + teams in parallel
      const [leagueRes, teamRes] = await Promise.all([
        supabase.from(dbTable("leagues")).select("league_id,league_name,slug").then(r => r),
        supabase.from(dbTable("teams")).select("team_id,team_name,league_id").neq("team_name", "Unknown").then(r => r),
      ]);
      const leagueMap = new Map<string, { name: string; slug: string }>();
      (leagueRes.data ?? []).forEach((l) => leagueMap.set(l.league_id, { name: l.league_name, slug: l.slug }));
      const teamMap = new Map<string, { name: string; leagueId: string }>();
      (teamRes.data ?? []).forEach((t) => teamMap.set(t.team_id, { name: t.team_name, leagueId: t.league_id }));

      // 2. Pre-filter: in-season leagues only
      const inSeasonLeagueIds: string[] = [];
      for (const [lid, lg] of leagueMap) {
        if (leagueSlug && leagueSlug !== "all" && lg.slug !== leagueSlug) continue;
        if (isCurrentlyInSeason(lg.slug)) inSeasonLeagueIds.push(lid);
      }
      const inSeasonTeamIds: string[] = [];
      for (const [tid, tm] of teamMap) {
        if (inSeasonLeagueIds.includes(tm.leagueId)) inSeasonTeamIds.push(tid);
      }
      // Fetch player IDs — all chunks in parallel
      const playerChunkPromises = [];
      for (let i = 0; i < inSeasonTeamIds.length; i += 100) {
        const chunk = inSeasonTeamIds.slice(i, i + 100);
        playerChunkPromises.push(
          supabase.from(dbTable("players")).select("player_id").in("team_id", chunk).then(r => r)
        );
      }
      const playerChunks = await Promise.all(playerChunkPromises);
      const inSeasonPlayerIds = new Set<string>();
      playerChunks.forEach(({ data }) => (data ?? []).forEach((p) => inSeasonPlayerIds.add(p.player_id)));

      if (inSeasonPlayerIds.size === 0) return [];
      const seasonPids = Array.from(inSeasonPlayerIds);

      // 3. Find players nearing return OR recently returned — all chunks in parallel
      const cutoff21d = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
      const cutoff90d = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);

      const injuryPromises = [];
      for (let i = 0; i < seasonPids.length; i += 200) {
        const chunk = seasonPids.slice(i, i + 200);
        injuryPromises.push(
          supabase
            .from(dbTable("injuries"))
            .select("*")
            .in("player_id", chunk)
            .gte("date_injured", cutoff90d)
            .in("status", ["questionable", "day-to-day", "probable", "doubtful"])
            .order("date_injured", { ascending: false })
            .then(r => r),
          supabase
            .from(dbTable("injuries"))
            .select("*")
            .in("player_id", chunk)
            .gte("return_date", cutoff21d)
            .in("status", ["returned", "active", "active_today", "back_in_play", "reduced_load"])
            .order("return_date", { ascending: false })
            .then(r => r),
        );
      }
      const injuryResults = await Promise.all(injuryPromises);
      const allInjs: any[] = [];
      injuryResults.forEach(({ data }) => allInjs.push(...(data ?? [])));

      // Dedupe by player_id (keep most recent)
      const byPlayer = new Map<string, (typeof allInjs)[0]>();
      for (const inj of allInjs) {
        if (!byPlayer.has(inj.player_id)) byPlayer.set(inj.player_id, inj);
      }

      // 4. Fetch player details + curves + game logs — all in parallel
      const playerIds = Array.from(byPlayer.keys());
      if (playerIds.length === 0) return [];

      const injurySlugs = [...new Set(allInjs.map((i) => slugify(i.injury_type)).filter(Boolean))];
      const returnedPids: { pid: string; returnDate: string }[] = [];
      for (const [pid, inj] of byPlayer) {
        if (inj.return_date && ["returned", "active", "active_today", "back_in_play", "reduced_load"].includes(inj.status)) {
          returnedPids.push({ pid, returnDate: inj.return_date });
        }
      }

      // Build all promises at once
      const playerPromises = [];
      for (let i = 0; i < playerIds.length; i += 100) {
        const chunk = playerIds.slice(i, i + 100);
        playerPromises.push(
          supabase.from(dbTable("players"))
            .select("player_id,player_name,slug,position,team_id,headshot_url,espn_id,is_star,is_starter,league_rank")
            .in("player_id", chunk)
            .then(r => r)
        );
      }

      const curvePromise = injurySlugs.length > 0
        ? supabase.from(dbTable("performance_curves")).select("*")
            .in("injury_type_slug", injurySlugs).eq("position", "").gte("sample_size", 3)
            .then(r => r)
        : Promise.resolve({ data: [] as any[] });

      const logPromises: PromiseLike<any>[] = [];
      if (returnedPids.length > 0) {
        const rpIds = returnedPids.map((r) => r.pid);
        const earliestReturn = returnedPids.reduce((min, r) => r.returnDate < min ? r.returnDate : min, returnedPids[0].returnDate);
        for (let i = 0; i < rpIds.length; i += 100) {
          const chunk = rpIds.slice(i, i + 100);
          logPromises.push(
            supabase.from("back_in_play_player_game_logs")
              .select("player_id, game_date")
              .in("player_id", chunk)
              .gte("game_date", earliestReturn)
              .order("game_date", { ascending: false })
              .then(r => r)
          );
        }
      }

      // Fetch next game dates from props
      const today = new Date().toISOString().slice(0, 10);
      const nextGamePromises: PromiseLike<any>[] = [];
      for (let i = 0; i < playerIds.length; i += 100) {
        const chunk = playerIds.slice(i, i + 100);
        nextGamePromises.push(
          supabase.from("back_in_play_player_props")
            .select("player_id, game_date")
            .in("player_id", chunk)
            .gte("game_date", today)
            .order("game_date", { ascending: true })
            .then(r => r)
        );
      }

      // Execute everything in parallel
      const [playerResults, curveResult, nextGameResults, ...logResults] = await Promise.all([
        Promise.all(playerPromises),
        curvePromise,
        Promise.all(nextGamePromises),
        ...logPromises,
      ]);

      const players = new Map<string, any>();
      playerResults.forEach(({ data }) => (data ?? []).forEach((p: any) => players.set(p.player_id, p)));

      const curves = new Map<string, PerformanceCurve>();
      (curveResult.data ?? []).forEach((c: any) => {
        const key = `${c.league_slug}:${c.injury_type_slug}`;
        curves.set(key, c as PerformanceCurve);
      });

      // Build next game date map (earliest upcoming game per player)
      const nextGameMap = new Map<string, string>();
      (nextGameResults as any[]).forEach((res: any) => {
        for (const row of res?.data ?? []) {
          if (!nextGameMap.has(row.player_id) || row.game_date < nextGameMap.get(row.player_id)!) {
            nextGameMap.set(row.player_id, row.game_date);
          }
        }
      });

      const gamesBackMap = new Map<string, number>();
      const returnDateLookup = new Map<string, string>();
      for (const r of returnedPids) returnDateLookup.set(r.pid, r.returnDate);
      logResults.forEach((res: any) => {
        const logs = res?.data ?? [];
        for (const log of logs) {
          const rd = returnDateLookup.get(log.player_id);
          if (rd && log.game_date >= rd) {
            gamesBackMap.set(log.player_id, (gamesBackMap.get(log.player_id) ?? 0) + 1);
          }
        }
      });

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
          next_game_date: nextGameMap.get(pid) ?? null,
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

/** Compact tag for player status */
function returnTag(p: ReturningPlayer): { text: string; color: string } | null {
  if (p.games_back <= 3 && p.curve) {
    const medians = p.curve.stat_median_pct ?? {};
    const vals = Object.values(medians).map((arr) => (Array.isArray(arr) ? arr[0] : null)).filter((v): v is number => v != null);
    const avg = vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
    if (avg != null && avg < 0.85) return { text: "Strong historical drop", color: "bg-red-500/15 text-red-400/80 border-red-500/25" };
  }
  if (p.status === "reduced_load") return { text: "Minutes restricted", color: "bg-amber-500/15 text-amber-400/80 border-amber-500/25" };
  if (p.is_star && p.games_back <= 3) return { text: "High impact return", color: "bg-blue-500/15 text-blue-400/80 border-blue-500/25" };
  return null;
}

/** Performance trend from curve data */
function perfTrend(p: ReturningPlayer): { text: string; color: string; detail: string | null } {
  if (!p.curve || p.games_back <= 0) return { text: "No data", color: "text-white/30", detail: null };
  const medians = p.curve.stat_median_pct ?? {};
  const gIdx = Math.min(p.games_back - 1, 9);
  const vals = Object.values(medians).map((arr) => (Array.isArray(arr) ? arr[gIdx] : null)).filter((v): v is number => v != null);
  if (vals.length === 0) return { text: "No data", color: "text-white/30", detail: null };
  const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
  const pct = Math.round((avg - 1) * 100);
  if (avg < 0.85) return { text: "Underperforming", color: "text-red-400", detail: `${pct}% vs baseline` };
  if (avg < 0.95) return { text: "Below baseline", color: "text-amber-400", detail: `${pct}% vs baseline` };
  if (avg <= 1.05) return { text: "Near baseline", color: "text-green-400", detail: `${pct >= 0 ? "+" : ""}${pct}% vs baseline` };
  return { text: "Overperforming", color: "text-cyan-400", detail: `+${pct}% vs baseline` };
}

function DashboardCard({ player, multiLeague }: { player: ReturningPlayer; multiLeague: boolean }) {
  const [showCurve, setShowCurve] = useState(false);
  const isBack = ["returned", "active", "active_today", "back_in_play", "reduced_load"].includes(player.status);
  const lc = leagueColor(player.league_slug);
  const tag = isBack ? returnTag(player) : null;
  const trend = isBack ? perfTrend(player) : null;
  const gbColor = player.games_back <= 3
    ? "bg-red-500/15 text-red-400/90 border-red-500/25"
    : player.games_back <= 6
    ? "bg-amber-500/15 text-amber-400/90 border-amber-500/25"
    : "bg-green-500/15 text-green-400/90 border-green-500/25";

  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.02] hover:bg-white/[0.04] transition-colors p-4">
      {/* Header row */}
      <div className="flex items-start gap-3 mb-3">
        <PlayerAvatar src={player.headshot_url} name={player.player_name} size={40} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Link to={`/player/${player.player_slug}`} className="text-sm font-semibold text-white hover:text-blue-400 transition-colors truncate">
              {player.player_name}
            </Link>
            {player.is_star && <span className="text-[9px] text-amber-400/70">★</span>}
            {tag && (
              <span className={`inline-flex items-center px-1.5 py-0.5 rounded-md border text-[8px] font-semibold ${tag.color}`}>
                {tag.text}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-white/35 mt-0.5">
            {multiLeague && <span style={{ color: `${lc}aa` }}>{LEAGUE_LABELS[player.league_slug]}</span>}
            {multiLeague && <span>·</span>}
            <span>{player.team_name}</span>
            <span>·</span>
            <span>{player.position}</span>
            <span>·</span>
            <span>{player.injury_type}</span>
          </div>
        </div>
      </div>

      {/* Key metrics row */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Games back badge */}
        {isBack && player.games_back >= 0 && (
          <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[9px] font-semibold ${gbColor}`}>
            {player.games_back === 0 ? "Just Returned" : `Game ${player.games_back} After Return`}
          </span>
        )}

        {/* Performance trend */}
        {isBack && trend && trend.text !== "No data" && (
          <div className="flex items-center gap-1.5">
            <span className={`text-[10px] font-semibold ${trend.color}`}>{trend.text}</span>
            {trend.detail && <span className="text-[9px] text-white/25 tabular-nums">{trend.detail}</span>}
          </div>
        )}

        {/* Next game date */}
        {player.next_game_date && (
          <span className="text-[10px] text-blue-400/60">
            Next: {new Date(player.next_game_date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </span>
        )}

        {/* Games missed */}
        {player.games_missed != null && player.games_missed > 0 && (
          <span className="text-[10px] text-white/30">Missed {player.games_missed} game{player.games_missed !== 1 ? "s" : ""}</span>
        )}

        {/* Nearing return status */}
        {!isBack && player.expected_return && (
          <span className="text-[10px] text-amber-400/60">Expected: {player.expected_return}</span>
        )}
      </div>

      {/* Compact performance preview — only 1-2 key stats */}
      {isBack && player.curve && (() => {
        const stats = LEAGUE_STATS[player.league_slug] ?? [];
        const statAvg = player.curve!.stat_avg_pct
          ? (typeof player.curve!.stat_avg_pct === "string" ? JSON.parse(player.curve!.stat_avg_pct) : player.curve!.stat_avg_pct)
          : null;
        if (!statAvg) return null;
        const gIdx = Math.min(player.games_back - 1, 9);
        const items = stats
          .map((stat) => {
            const val = statAvg[stat]?.[gIdx];
            if (val == null) return null;
            const pct = Math.round((val - 1) * 100);
            return { stat, pct };
          })
          .filter((v): v is { stat: string; pct: number } => v != null)
          .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
          .slice(0, 2);
        if (items.length === 0) return null;
        return (
          <div className="flex items-center gap-3 mt-2">
            {items.map(({ stat, pct }) => (
              <span key={stat} className="text-[10px]">
                <span className="text-white/30">{STAT_LABELS[stat] ?? stat}: </span>
                <span className={pct >= 0 ? "text-green-400/70" : "text-red-400/70"}>{pct >= 0 ? "+" : ""}{pct}%</span>
              </span>
            ))}
            <span className="text-[9px] text-white/15">({player.curve!.sample_size} cases)</span>
          </div>
        );
      })()}

      {/* Action links */}
      <div className="flex items-center gap-3 mt-3 pt-2 border-t border-white/5">
        {player.curve && (
          <button
            onClick={() => setShowCurve(!showCurve)}
            className="text-[10px] text-blue-400/50 hover:text-blue-400/80 transition-colors"
          >
            {showCurve ? "Hide recovery curve ▴" : "View recovery curve ▾"}
          </button>
        )}
        {player.next_game_date && (
          <Link
            to={`/props?player=${encodeURIComponent(player.player_name)}`}
            className="text-[10px] text-white/25 hover:text-white/50 transition-colors"
          >
            Props →
          </Link>
        )}
        <Link
          to={`/player/${player.player_slug}`}
          className="text-[10px] text-white/25 hover:text-white/50 transition-colors"
        >
          Profile →
        </Link>
      </div>

      {/* Inline recovery curve */}
      {showCurve && player.curve && (() => {
        const curve = player.curve!;
        const rawMedians = curve.stat_median_pct ?? {};
        const rawBaselines = curve.stat_baselines ?? {};
        const medians = typeof rawMedians === "string" ? JSON.parse(rawMedians) : rawMedians;
        const baselines = typeof rawBaselines === "string" ? JSON.parse(rawBaselines) : rawBaselines;
        const stats = LEAGUE_STATS[player.league_slug] ?? [];
        const gIdx = Math.min(Math.max(player.games_back - 1, 0), 9);

        // Build SVG curve for primary stat (fallback to composite if primary is all zeros)
        let pcts: number[] | undefined;
        for (const s of [...stats, "composite"]) {
          const arr = medians[s] as number[] | undefined;
          if (arr && arr.some((v) => v > 0)) { pcts = arr; break; }
        }
        const points = pcts?.slice(0, 10);

        return (
          <div className="mt-3 pt-3 border-t border-white/5">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] text-white/40">
                {curve.injury_type} recovery — {curve.sample_size} cases
              </span>
            </div>

            {/* SVG curve */}
            {points && points.length > 1 && (() => {
              const minPct = Math.min(...points, 0.7);
              const maxPct = Math.max(...points, 1.1);
              const range = maxPct - minPct || 0.1;
              const w = 280;
              const h = 60;
              const step = w / (points.length - 1 || 1);

              const pathPoints = points.map((p, i) => {
                const x = i * step;
                const y = h - ((p - minPct) / range) * h;
                return `${x},${y}`;
              });
              const path = `M${pathPoints.join(" L")}`;
              const baselineY = h - ((1.0 - minPct) / range) * h;
              const curIdx = Math.min(player.games_back - 1, points.length - 1);
              const curX = curIdx >= 0 ? curIdx * step : 0;
              const curY = curIdx >= 0 ? h - ((points[curIdx] - minPct) / range) * h : h / 2;

              return (
                <div className="mb-2">
                  <svg width={w} height={h + 16} className="overflow-visible">
                    {/* Baseline */}
                    <line x1={0} y1={baselineY} x2={w} y2={baselineY} stroke="rgba(255,255,255,0.1)" strokeDasharray="3,3" />
                    <text x={w + 4} y={baselineY + 3} fill="rgba(255,255,255,0.2)" fontSize={8}>100%</text>
                    {/* Curve */}
                    <path d={path} fill="none" stroke="rgba(59,130,246,0.6)" strokeWidth={2} />
                    {/* Game markers */}
                    {points.map((p, i) => (
                      <circle key={i} cx={i * step} cy={h - ((p - minPct) / range) * h} r={2} fill="rgba(59,130,246,0.3)" />
                    ))}
                    {/* Current position */}
                    {curIdx >= 0 && (
                      <circle cx={curX} cy={curY} r={4} fill="#3b82f6" stroke="#0a0f1a" strokeWidth={2} />
                    )}
                    {/* Game labels */}
                    {points.map((_, i) => (
                      <text key={i} x={i * step} y={h + 12} fill="rgba(255,255,255,0.15)" fontSize={7} textAnchor="middle">G{i + 1}</text>
                    ))}
                  </svg>
                </div>
              );
            })()}

            {/* Stat impacts per game */}
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {stats.slice(0, 3).map((stat) => {
                const pctArr = medians[stat] as number[] | undefined;
                const base = baselines[stat] as number | undefined;
                if (!pctArr || !base || base === 0) return null;
                const pct = pctArr[gIdx];
                if (pct == null) return null;
                const diff = Math.round((pct - 1) * 100);
                return (
                  <span key={stat} className="text-[10px]">
                    <span className="text-white/30">{STAT_LABELS[stat] ?? stat}: </span>
                    <span className={diff >= 0 ? "text-green-400/70" : "text-red-400/70"}>
                      {diff >= 0 ? "+" : ""}{diff}%
                    </span>
                    <span className="text-white/15"> ({(base * pct).toFixed(1)} vs {base.toFixed(1)})</span>
                  </span>
                );
              })}
            </div>
          </div>
        );
      })()}
    </div>
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

  // Group returned players by return window
  const allReturned = useMemo(() => players.filter(
    (p) => ["returned", "active", "active_today", "back_in_play", "reduced_load"].includes(p.status)
  ), [players]);

  const earlyReturn = useMemo(() => allReturned
    .filter((p) => p.games_back >= 0 && p.games_back <= 3)
    .sort((a, b) => a.games_back - b.games_back), [allReturned]);

  const recentReturn = useMemo(() => allReturned
    .filter((p) => p.games_back >= 4 && p.games_back <= 10)
    .sort((a, b) => a.games_back - b.games_back), [allReturned]);

  const allOther = useMemo(() => allReturned
    .filter((p) => p.games_back > 10 || !p.return_date)
    .sort((a, b) => (a.games_back ?? 0) - (b.games_back ?? 0)), [allReturned]);

  // Summary stats
  const reducedPerf = useMemo(() => allReturned.filter((p) => {
    if (!p.curve || p.games_back <= 0) return false;
    const medians = p.curve.stat_median_pct ?? {};
    const gIdx = Math.min(p.games_back - 1, 9);
    const vals = Object.values(medians).map((arr) => (Array.isArray(arr) ? arr[gIdx] : null)).filter((v): v is number => v != null);
    if (vals.length === 0) return false;
    return vals.reduce((s, v) => s + v, 0) / vals.length < 0.9;
  }).length, [allReturned]);

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
        <div className="relative max-w-4xl lg:max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-10 py-10">
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

      <div className="max-w-4xl lg:max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-10 py-8">
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

        {/* Summary bar */}
        {!isLoading && (allReturned.length > 0 || returning.length > 0) && (
          <div className="rounded-xl bg-gradient-to-r from-blue-500/[0.06] to-purple-500/[0.04] border border-blue-500/15 px-4 py-3 mb-6">
            <div className="flex items-center gap-5 text-[12px] text-white/45 flex-wrap">
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                <span className="font-medium text-white/60">{allReturned.length}</span> players returned recently
              </span>
              {earlyReturn.length > 0 && (
                <span className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-400/80" />
                  <span className="font-medium text-red-400/70">{earlyReturn.length}</span> in early return window (G1–G3)
                </span>
              )}
              {reducedPerf > 0 && (
                <span className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400/80" />
                  <span className="font-medium text-amber-400/70">{reducedPerf}</span> showing reduced performance
                </span>
              )}
              {returning.length > 0 && (
                <span>{returning.length} nearing return</span>
              )}
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => <div key={i} className="h-28 rounded-xl bg-white/10 animate-pulse" />)}
          </div>
        ) : (
          <>
            {/* Section 1: Early Return Window (G1–G3) — most important */}
            {earlyReturn.length > 0 && (
              <section className="mb-8">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-base">🔥</span>
                  <h2 className="text-sm font-bold text-red-400/80 uppercase tracking-wider">Early Return Window</h2>
                  <span className="text-[10px] text-white/30">({earlyReturn.length})</span>
                </div>
                <p className="text-[11px] text-white/30 mb-3">Games 1–3 after return — highest performance volatility and largest market gaps</p>
                <div className="space-y-2.5">
                  {earlyReturn.map((p) => <DashboardCard key={p.player_id} player={p} multiLeague={league === "all"} />)}
                </div>
              </section>
            )}

            {/* Section 2: Recently Returned (G4–G10) */}
            {recentReturn.length > 0 && (
              <section className="mb-8">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-base">⚡</span>
                  <h2 className="text-sm font-bold text-amber-400/80 uppercase tracking-wider">Recently Returned</h2>
                  <span className="text-[10px] text-white/30">({recentReturn.length})</span>
                </div>
                <p className="text-[11px] text-white/30 mb-3">Games 4–10 after return — still stabilizing toward baseline performance</p>
                <div className="space-y-2.5">
                  {recentReturn.map((p) => <DashboardCard key={p.player_id} player={p} multiLeague={league === "all"} />)}
                </div>
              </section>
            )}

            {/* Section 3: Nearing Return */}
            {returning.length > 0 && (
              <section className="mb-8">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-base">📋</span>
                  <h2 className="text-sm font-bold text-white/50 uppercase tracking-wider">Nearing Return</h2>
                  <span className="text-[10px] text-white/30">({returning.length})</span>
                </div>
                <p className="text-[11px] text-white/30 mb-3">Players likely to return soon — watch for status updates</p>
                <div className="space-y-2.5">
                  {returning.map((p) => <DashboardCard key={p.player_id} player={p} multiLeague={league === "all"} />)}
                </div>
              </section>
            )}

            {/* Section 4: All Other Returns */}
            {allOther.length > 0 && (
              <section className="mb-8">
                <div className="flex items-center gap-2 mb-1">
                  <h2 className="text-sm font-bold text-white/30 uppercase tracking-wider">Past Recovery Window</h2>
                  <span className="text-[10px] text-white/20">({allOther.length})</span>
                </div>
                <p className="text-[11px] text-white/20 mb-3">Players past the initial recovery window</p>
                <div className="space-y-2.5">
                  {allOther.map((p) => <DashboardCard key={p.player_id} player={p} multiLeague={league === "all"} />)}
                </div>
              </section>
            )}

            {allReturned.length === 0 && returning.length === 0 && (
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
