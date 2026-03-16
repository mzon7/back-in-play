import { useState, useMemo, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { SiteHeader } from "../components/SiteHeader";
import { SEO } from "../components/seo/SEO";
import { PlayerAvatar } from "../components/PlayerAvatar";
import { InjuryPlayerCard } from "../components/InjuryPlayerCard";
import { trackLeagueFilter } from "../lib/analytics";
import { leagueColor } from "../lib/leagueColors";
import { usePerformanceCurves } from "../features/performance-curves/lib/queries";
import type { PerformanceCurve } from "../features/performance-curves/lib/types";
import { computeEV, formatEV, parseOdds, type EVResult } from "../lib/evModel";

const LEAGUE_ORDER = ["nba", "nfl", "mlb", "nhl", "premier-league"];
const LEAGUE_LABELS: Record<string, string> = {
  nba: "NBA", nfl: "NFL", mlb: "MLB", nhl: "NHL", "premier-league": "EPL",
};

const MARKET_LABELS: Record<string, string> = {
  player_points: "PTS", player_rebounds: "REB", player_assists: "AST",
  player_threes: "3PT", player_points_rebounds_assists: "PRA",
  player_pass_yds: "Pass Yds", player_rush_yds: "Rush Yds",
  player_reception_yds: "Rec Yds", player_receptions: "Rec",
  player_goals: "Goals", player_shots_on_goal: "SOG",
  player_shots: "Shots", player_shots_on_target: "SOT",
  batter_hits: "Hits", batter_total_bases: "TB", batter_rbis: "RBI",
};

// Map prop market keys to game log stat columns
const MARKET_TO_STAT: Record<string, string> = {
  player_points: "stat_pts", player_rebounds: "stat_reb", player_assists: "stat_ast",
  player_pass_yds: "stat_pass_yds", player_rush_yds: "stat_rush_yds",
  player_reception_yds: "stat_rec_yds", player_receptions: "stat_rec",
  player_goals: "stat_goals", player_shots_on_goal: "stat_sog",
  player_shots: "stat_sog", player_shots_on_target: "stat_sog",
  batter_hits: "stat_h", batter_total_bases: "stat_h", batter_rbis: "stat_rbi",
};

/** Normalize an injury_type string to a slug for curve matching */
function injuryToSlug(injuryType: string): string {
  return injuryType.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Primary stat per league for curve impact display */
const PRIMARY_STAT: Record<string, { key: string; label: string }> = {
  nba: { key: "stat_pts", label: "PTS" },
  nfl: { key: "stat_rush_yds", label: "Rush Yds" },
  mlb: { key: "stat_h", label: "Hits" },
  nhl: { key: "stat_goals", label: "Goals" },
  "premier-league": { key: "stat_goals", label: "Goals" },
};

/** Compute stat impact from a curve at game index */
function getCurveImpact(curve: PerformanceCurve, gIdx: number, leagueSlug: string): { label: string; diff: number } | null {
  const baselines = curve.stat_baselines ?? {};
  const medians = curve.stat_median_pct ?? {};
  const ps = PRIMARY_STAT[leagueSlug];
  if (ps) {
    const base = baselines[ps.key];
    const pct = (medians[ps.key] as number[] | undefined)?.[gIdx];
    if (base && base > 0 && pct != null) return { label: ps.label, diff: base * (pct - 1.0) };
  }
  // Fallback: largest % deviation
  let best: { label: string; diff: number; pctDev: number } | null = null;
  for (const [sk, base] of Object.entries(baselines)) {
    if (sk === "composite" || !base || base === 0) continue;
    const pct = (medians[sk] as number[] | undefined)?.[gIdx];
    if (pct == null) continue;
    const pctDev = Math.abs(pct - 1.0);
    if (!best || pctDev > best.pctDev) {
      best = { label: MARKET_LABELS_SHORT[sk] ?? sk.replace("stat_", ""), diff: base * (pct - 1.0), pctDev };
    }
  }
  return best ? { label: best.label, diff: best.diff } : null;
}

const MARKET_LABELS_SHORT: Record<string, string> = {
  stat_pts: "PTS", stat_reb: "REB", stat_ast: "AST",
  stat_rush_yds: "Rush Yds", stat_pass_yds: "Pass Yds", stat_rec_yds: "Rec Yds",
  stat_goals: "Goals", stat_sog: "SOG", stat_assists: "Assists",
  stat_h: "Hits", stat_hr: "HR", stat_rbi: "RBI",
};

const SORT_OPTIONS = [
  { value: "best", label: "Best Opportunities" },
  { value: "gap", label: "Largest Gap vs Expectation" },
  { value: "early", label: "Earliest Return" },
  { value: "drop", label: "Biggest Historical Drop" },
] as const;

type SortMode = typeof SORT_OPTIONS[number]["value"];

const SOURCE_LABELS: Record<string, string> = {
  draftkings: "DraftKings",
  fanduel: "FanDuel",
  betrivers: "BetRivers",
  bovada: "Bovada",
};

/** Format game status from commence_time */
function gameStatus(commenceTime: string | null | undefined, gameDate: string | undefined): { label: string; started: boolean; tomorrow: boolean } {
  const today = new Date().toISOString().slice(0, 10);
  const isTomorrow = gameDate != null && gameDate > today;

  if (!commenceTime) {
    return { label: isTomorrow ? "Tomorrow" : "Today", started: false, tomorrow: isTomorrow };
  }
  const ct = new Date(commenceTime);
  const now = new Date();
  if (now >= ct) {
    return { label: "Live", started: true, tomorrow: false };
  }
  // Format time in user's locale
  const timeStr = ct.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return { label: isTomorrow ? `Tomorrow ${timeStr}` : timeStr, started: false, tomorrow: isTomorrow };
}

function GameTimeBadge({ commenceTime, gameDate }: { commenceTime?: string | null; gameDate?: string }) {
  const { label, started, tomorrow } = gameStatus(commenceTime, gameDate);
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold ${
      started ? "bg-green-500/20 text-green-400" :
      tomorrow ? "bg-blue-500/10 text-blue-400/60" :
      "bg-white/5 text-white/40"
    }`}>
      {started && <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />}
      {label}
    </span>
  );
}

interface PropItem {
  id: string;
  market: string;
  line: number | null;
  over_price: string | null;
  under_price: string | null;
  source: string;
  game_date?: string;
  commence_time?: string | null;
  home_team?: string | null;
  away_team?: string | null;
}

interface PreInjuryAvg {
  minutes: number | null;
  [statKey: string]: number | null;
}

interface PropsPlayer {
  player_id: string;
  player_name: string;
  player_slug: string;
  position: string;
  team_name: string;
  league_slug: string;
  headshot_url: string | null;
  status: string;
  injury_type: string;
  expected_return: string | null;
  is_star: boolean;
  is_starter: boolean;
  injury_date: string | null;
  props: PropItem[];
  avg5: PreInjuryAvg | null;
  avg10: PreInjuryAvg | null;
  gamesBack: number;
  avgSinceReturn: PreInjuryAvg | null;
  game_date?: string;
  commence_time?: string | null;
  home_team?: string | null;
  away_team?: string | null;
}

/** Median of a numeric array */
function arrMedian(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Minutes-adjusted stat averages using median of per-minute rates.
 * 1. Filter out games below 25% of the player's median minutes (injury exits)
 * 2. Compute per-minute rate for each game
 * 3. Take median of rates (robust to outliers)
 * 4. Multiply by median minutes → per-game expected value
 */
function computeAvg(games: any[], n: number): PreInjuryAvg | null {
  // First pass: get all games with any minutes to compute typical minutes
  const withMinutes = games.filter((g: any) => g.minutes != null && g.minutes > 0);
  if (withMinutes.length === 0) return null;

  // Compute median minutes from ALL available games to determine threshold
  const allMinutes = withMinutes.map((g: any) => g.minutes as number);
  const typicalMinutes = arrMedian(allMinutes);
  const minThreshold = typicalMinutes * 0.25; // 25% of typical = injury exit cutoff

  // Filter to real games (above threshold), then take top n
  const realGames = withMinutes.filter((g: any) => g.minutes >= minThreshold);
  const slice = realGames.slice(0, n);
  if (slice.length === 0) return null;

  const statKeys = ["stat_pts", "stat_reb", "stat_ast", "stat_stl", "stat_blk",
    "stat_sog", "stat_rush_yds", "stat_pass_yds", "stat_rec", "stat_rec_yds",
    "stat_goals", "stat_h", "stat_rbi"];
  const result: PreInjuryAvg = { minutes: null };

  // Median minutes of real games
  const minuteVals = slice.map((g: any) => g.minutes as number);
  const medMinutes = arrMedian(minuteVals);
  result.minutes = Math.round(medMinutes * 10) / 10;

  for (const key of statKeys) {
    const rates: number[] = [];
    for (const g of slice) {
      const val = g[key];
      if (val != null) {
        rates.push(val / g.minutes);
      }
    }
    // Median per-minute rate × median minutes = expected per-game stat
    result[key] = rates.length > 0
      ? Math.round(arrMedian(rates) * medMinutes * 10) / 10
      : null;
  }
  return result;
}

function usePropsWithPlayers() {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  return useQuery<PropsPlayer[]>({
    queryKey: ["bip-props-page", today],
    queryFn: async () => {
      // 1. Get today's + tomorrow's props; fall back to most recent if none
      let { data: props, error: propsErr } = await supabase
        .from("back_in_play_player_props")
        .select("id, player_id, player_name, market, line, over_price, under_price, source, game_date, commence_time, home_team, away_team")
        .in("game_date", [today, tomorrow])
        .order("game_date", { ascending: true });
      if (propsErr) throw propsErr;

      // If no props for today/tomorrow, get the most recent day that has data
      if (!props || props.length === 0) {
        const { data: recent } = await supabase
          .from("back_in_play_player_props")
          .select("id, player_id, player_name, market, line, over_price, under_price, source, game_date, commence_time, home_team, away_team")
          .order("game_date", { ascending: false })
          .limit(1000);
        props = recent ?? [];
      }
      if (!props || props.length === 0) return [];

      // 2. Group props by player_id (skip nulls — unresolved players)
      const propsByPlayer = new Map<string, typeof props>();
      for (const p of props) {
        if (!p.player_id) continue;
        const existing = propsByPlayer.get(p.player_id) ?? [];
        existing.push(p);
        propsByPlayer.set(p.player_id, existing);
      }

      const playerIds = Array.from(propsByPlayer.keys());

      // 3. Parallel: players (with team+league joins), injuries, game logs
      const [playersRes, leaguesRes, ...injuryChunks] = await Promise.all([
        // Players with team+league join (1 call instead of 3 sequential)
        supabase
          .from("back_in_play_players")
          .select("player_id, player_name, slug, position, team_id, league_id, headshot_url, espn_id, is_star, is_starter, team:back_in_play_teams(team_name, league_id), league:back_in_play_leagues!back_in_play_players_league_id_fkey(slug)")
          .in("player_id", playerIds),
        // Leagues (small, fast)
        supabase.from("back_in_play_leagues").select("league_id, slug"),
        // Injuries — parallel chunks
        ...Array.from({ length: Math.ceil(playerIds.length / 200) }, (_, i) =>
          supabase
            .from("back_in_play_injuries")
            .select("player_id, status, injury_type, expected_return, date_injured")
            .in("player_id", playerIds.slice(i * 200, (i + 1) * 200))
            .neq("status", "cleared")
            .order("date_injured", { ascending: false })
        ),
      ]);

      const players = playersRes.data ?? [];
      const playerMap = new Map<string, any>();
      players.forEach((p: any) => playerMap.set(p.player_id, p));

      const leagueMap = new Map<string, string>();
      (leaguesRes.data ?? []).forEach((l: any) => leagueMap.set(l.league_id, l.slug));

      // Latest injury per player
      const injuryMap = new Map<string, any>();
      for (const chunk of injuryChunks) {
        for (const inj of chunk.data ?? []) {
          if (!injuryMap.has(inj.player_id)) injuryMap.set(inj.player_id, inj);
        }
      }

      // 4. Game logs — parallel chunks, 20 players per chunk to ensure enough rows per player
      const LOG_CHUNK_SIZE = 20;
      const logChunks = await Promise.all(
        Array.from({ length: Math.ceil(playerIds.length / LOG_CHUNK_SIZE) }, (_, i) =>
          supabase
            .from("back_in_play_player_game_logs")
            .select("player_id, game_date, minutes, stat_pts, stat_reb, stat_ast, stat_stl, stat_blk, stat_sog, stat_rush_yds, stat_pass_yds, stat_rec, stat_rec_yds, stat_goals, stat_h, stat_rbi")
            .in("player_id", playerIds.slice(i * LOG_CHUNK_SIZE, (i + 1) * LOG_CHUNK_SIZE))
            .order("game_date", { ascending: false })
            .limit(1000)
        )
      );
      const gameLogMap = new Map<string, any[]>();
      for (const chunk of logChunks) {
        for (const g of chunk.data ?? []) {
          const existing = gameLogMap.get(g.player_id) ?? [];
          existing.push(g);
          gameLogMap.set(g.player_id, existing);
        }
      }

      // 5. Build result
      const result: PropsPlayer[] = [];
      for (const [pid, playerProps] of propsByPlayer) {
        const player = playerMap.get(pid);
        if (!player) continue;
        const team = (player as any).team;
        const leagueSlug = (player as any).league?.slug ?? leagueMap.get(player.league_id) ?? "";
        const injury = injuryMap.get(pid);

        // Compute pre-injury averages from game logs
        const allGames = gameLogMap.get(pid) ?? [];
        let preInjuryGames = allGames;
        const injuryDate = injury?.date_injured;
        if (injuryDate) {
          // Only games before the injury date
          preInjuryGames = allGames.filter((g: any) => g.game_date < injuryDate);
        }
        // Sort descending (most recent first)
        preInjuryGames.sort((a: any, b: any) => b.game_date.localeCompare(a.game_date));

        const avg5 = computeAvg(preInjuryGames, 5);
        const avg10 = computeAvg(preInjuryGames, 10);

        // Post-return games (after injury date)
        let postReturnGames: any[] = [];
        if (injuryDate) {
          postReturnGames = allGames
            .filter((g: any) => g.game_date > injuryDate)
            .sort((a: any, b: any) => b.game_date.localeCompare(a.game_date));
        }
        const gamesBack = postReturnGames.length;
        const avgSinceReturn = gamesBack > 0 ? computeAvg(postReturnGames, gamesBack) : null;

        result.push({
          player_id: pid,
          player_name: player.player_name,
          player_slug: player.slug ?? "",
          position: player.position ?? "",
          team_name: team?.team_name ?? "",
          league_slug: leagueSlug,
          headshot_url: player.headshot_url ?? (player.espn_id ? `https://a.espncdn.com/i/headshots/nba/players/full/${player.espn_id}.png` : null),
          status: injury?.status ?? "active",
          injury_type: injury?.injury_type ?? "",
          expected_return: injury?.expected_return ?? null,
          is_star: player.is_star ?? false,
          is_starter: player.is_starter ?? false,
          injury_date: injuryDate ?? null,
          props: playerProps.map((p: any) => ({
            id: p.id,
            market: p.market,
            line: p.line,
            over_price: p.over_price,
            under_price: p.under_price,
            source: p.source,
            game_date: p.game_date,
            commence_time: p.commence_time,
            home_team: p.home_team,
            away_team: p.away_team,
          })),
          avg5,
          avg10,
          gamesBack,
          avgSinceReturn,
          game_date: playerProps[0]?.game_date ?? today,
          commence_time: playerProps[0]?.commence_time ?? null,
          home_team: playerProps[0]?.home_team ?? null,
          away_team: playerProps[0]?.away_team ?? null,
        });
      }

      // Sort: stars first, then starters, then by name
      result.sort((a, b) => {
        if (a.is_star !== b.is_star) return a.is_star ? -1 : 1;
        if (a.is_starter !== b.is_starter) return a.is_starter ? -1 : 1;
        return a.player_name.localeCompare(b.player_name);
      });

      return result;
    },
    staleTime: 5 * 60 * 1000,
  });
}

function PlayerPropCard({ player, sourceFilter, curve, highlighted }: { player: PropsPlayer; sourceFilter: string; curve?: PerformanceCurve | null; highlighted?: boolean }) {
  const priority = ["player_points", "player_goals", "batter_hits", "player_pass_yds", "player_rush_yds",
    "player_rebounds", "player_assists", "player_threes", "player_shots_on_goal", "batter_total_bases"];

  // Filter by source, then dedupe by market (prefer draftkings when showing all)
  const sourceProps = sourceFilter === "all"
    ? player.props
    : player.props.filter((p) => p.source === sourceFilter);

  const deduped = new Map<string, PropItem>();
  const SOURCE_PRIORITY = ["draftkings", "fanduel"];
  for (const p of sourceProps) {
    const existing = deduped.get(p.market);
    if (!existing) {
      deduped.set(p.market, p);
    } else if (sourceFilter === "all") {
      const curIdx = SOURCE_PRIORITY.indexOf(existing.source);
      const newIdx = SOURCE_PRIORITY.indexOf(p.source);
      if (newIdx !== -1 && (curIdx === -1 || newIdx < curIdx)) {
        deduped.set(p.market, p);
      }
    }
  }

  const sorted = [...deduped.values()].sort((a, b) => {
    const ai = priority.indexOf(a.market);
    const bi = priority.indexOf(b.market);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  if (sorted.length === 0) return null;

  const isEarlyReturn = player.gamesBack > 0 && player.gamesBack <= 10;
  const injurySlug = player.injury_type ? injuryToSlug(player.injury_type) : "";

  // Curve impacts at G1, G3, G5
  const impG1 = curve ? getCurveImpact(curve, 0, player.league_slug) : null;
  const impG3 = curve ? getCurveImpact(curve, 2, player.league_slug) : null;
  const impG5 = curve ? getCurveImpact(curve, 4, player.league_slug) : null;
  const fmtDiff = (d: number) => `${d >= 0 ? "+" : ""}${d.toFixed(1)}`;

  return (
    <div
      id={`prop-player-${player.player_id}`}
      className={`scroll-mt-24 rounded-xl transition-shadow duration-[2500ms] ${highlighted ? "ring-2 ring-[#1C7CFF]/50 shadow-[0_0_20px_rgba(28,124,255,0.15)]" : ""}`}
    >
    <InjuryPlayerCard
      player_name={player.player_name}
      player_slug={player.player_slug}
      position={player.position}
      team_name={player.team_name}
      league_slug={player.league_slug}
      headshot_url={player.headshot_url}
      status={player.status}
      injury_type={player.injury_type}
      is_star={player.is_star}
      is_starter={player.is_starter}
      expected_return={player.expected_return}
      date_injured={player.injury_date}
      showLeague
      avatarSize={48}
      linkToPlayer={false}
    >
      {/* Return context bar */}
      <div className="px-4 pb-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-[11px] text-white/30">
          {player.avg10?.minutes != null && (
            <span>Pre-injury: {player.avg10.minutes} min/g</span>
          )}
          {player.gamesBack > 0 && (
            <span>{player.gamesBack} game{player.gamesBack !== 1 ? "s" : ""} back{player.avgSinceReturn?.minutes != null ? ` · ${player.avgSinceReturn.minutes} min/g since return` : ""}</span>
          )}
          {isEarlyReturn && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400/80 font-medium">Early return window</span>
          )}
        </div>
      </div>

      {/* Prop market boxes */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 px-4 pb-2">
        {sorted.map((p) => {
          const statKey = MARKET_TO_STAT[p.market];
          const avg10Val = statKey && player.avg10 ? player.avg10[statKey] : null;
          const sinceReturnVal = statKey && player.avgSinceReturn ? player.avgSinceReturn[statKey] : null;

          // EV computation
          let ev: EVResult | null = null;
          if (curve && statKey && avg10Val != null && p.line != null && player.gamesBack > 0) {
            ev = computeEV({
              baseline: avg10Val,
              propLine: p.line,
              overOdds: parseOdds(p.over_price),
              underOdds: parseOdds(p.under_price),
              gamesSinceReturn: player.gamesBack,
              recentAvg: sinceReturnVal,
              curve,
              leagueSlug: player.league_slug,
              statKey,
              preInjuryMinutes: player.avg10?.minutes,
              currentMinutes: player.avgSinceReturn?.minutes,
            });
          }

          return (
            <div key={p.id} className="bg-white/5 rounded-lg px-2.5 py-2 text-center">
              <p className="text-[10px] text-emerald-400/70 font-medium mb-0.5">
                {MARKET_LABELS[p.market] ?? p.market}
              </p>
              <p className="text-base font-bold text-white">{p.line}</p>
              <div className="flex justify-center gap-2 mt-0.5 text-[11px]">
                {p.over_price && <span className="text-green-400/80">O {p.over_price}</span>}
                {p.under_price && <span className="text-red-400/80">U {p.under_price}</span>}
              </div>
              {sourceFilter === "all" && (
                <p className="text-[9px] text-white/20 mt-0.5">{SOURCE_LABELS[p.source] ?? p.source}</p>
              )}
              {(avg10Val != null || sinceReturnVal != null) && (
                <div className="mt-1.5 pt-1.5 border-t border-white/5 text-[10px] text-white/35 space-y-0.5">
                  {avg10Val != null && (
                    <p>Pre-injury avg: <span className={p.line != null && avg10Val > p.line ? "text-green-400/70" : p.line != null && avg10Val < p.line ? "text-red-400/70" : "text-white/50"}>{avg10Val}</span></p>
                  )}
                  {sinceReturnVal != null && player.gamesBack > 0 && (
                    <p>Return avg: <span className={p.line != null && sinceReturnVal > p.line ? "text-green-400/70" : p.line != null && sinceReturnVal < p.line ? "text-red-400/70" : "text-white/50"}>{sinceReturnVal}</span></p>
                  )}
                </div>
              )}
              {/* EV model output */}
              {ev && (
                <div className="mt-1.5 pt-1.5 border-t border-white/5 text-[10px] space-y-0.5">
                  <p className="text-white/30">Model: <span className="text-white/60 font-medium tabular-nums">{ev.expectedCombined.toFixed(1)}</span></p>
                  {ev.recommendation && ev.bestEv != null && (
                    <p className={`font-semibold tabular-nums ${ev.recommendation === "OVER" ? "text-green-400/90" : "text-red-400/90"}`}>
                      EV {formatEV(ev.bestEv)} · {ev.recommendation}
                    </p>
                  )}
                  {!ev.recommendation && (
                    <p className="text-white/20">No positive EV edge</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Historical injury trend + analytics links */}
      {(curve || injurySlug) && (
        <div className="px-4 pb-4">
          {/* Historical trend from curve data */}
          {curve && (impG1 || impG3 || impG5) && (
            <div className="rounded-lg bg-white/[0.03] border border-white/5 p-3 mb-2">
              <p className="text-[10px] text-white/35 mb-1.5">
                Historical {player.injury_type?.toLowerCase()} return trend
                <span className="text-white/20 ml-1">({LEAGUE_LABELS[player.league_slug]} · {curve.sample_size} cases)</span>
              </p>
              <div className="grid grid-cols-3 gap-2">
                {([["G1", impG1], ["G3", impG3], ["G5", impG5]] as [string, { label: string; diff: number } | null][]).map(([label, imp]) => (
                  <div key={label} className="text-center">
                    <p className="text-[9px] text-white/20">{label}</p>
                    <p className={`text-xs font-bold tabular-nums ${imp == null ? "text-white/20" : imp.diff >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {imp != null ? `${fmtDiff(imp.diff)} ${imp.label}` : "—"}
                    </p>
                  </div>
                ))}
              </div>
              {impG3 && impG3.diff < 0 && (
                <p className="text-[10px] text-white/25 mt-2 leading-snug">
                  Historical {impG3.label.toLowerCase()} has typically lagged pre-injury baseline in the first few games back.
                </p>
              )}
            </div>
          )}

          {/* Analytics links */}
          {injurySlug && (
            <div className="flex items-center gap-3 text-[10px]">
              <Link
                to={`/performance-curves?league=${player.league_slug}&injury=${injurySlug}`}
                className="text-white/25 hover:text-[#1C7CFF]/70 transition-colors"
              >
                View recovery curve &rarr;
              </Link>
              <Link
                to={`/injuries/${injurySlug}?league=${player.league_slug}`}
                className="text-white/25 hover:text-[#1C7CFF]/70 transition-colors"
              >
                View recovery stats &rarr;
              </Link>
            </div>
          )}
        </div>
      )}
    </InjuryPlayerCard>
    </div>
  );
}

function EVInfoModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        className="relative bg-[#111827] border border-white/10 rounded-2xl max-w-lg w-full max-h-[85vh] overflow-y-auto p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button onClick={onClose} className="absolute top-4 right-4 text-white/30 hover:text-white/60 transition-colors text-lg">✕</button>

        <h2 className="text-lg font-bold text-white mb-1">How EV Works</h2>
        <p className="text-xs text-white/40 mb-5">Injury-adjusted expected value</p>

        <div className="space-y-5 text-[13px] text-white/70 leading-relaxed">
          <div>
            <p>
              Expected value compares the model's estimated probability
              of a player going over or under the prop line to the
              sportsbook's implied probability based on the odds.
            </p>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-white/90 mb-2">Our model uses</h3>
            <ul className="space-y-2 text-white/60">
              <li className="flex items-start gap-2.5">
                <span className="shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full bg-[#1C7CFF]/60" />
                <span><span className="text-white/80">Historical injury recovery trends</span> — how players have performed after the same injury type, at each game since return</span>
              </li>
              <li className="flex items-start gap-2.5">
                <span className="shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full bg-[#3DFF8F]/60" />
                <span><span className="text-white/80">Player performance since returning</span> — actual stats in games played after the injury</span>
              </li>
              <li className="flex items-start gap-2.5">
                <span className="shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full bg-orange-400/60" />
                <span><span className="text-white/80">Minutes and usage changes</span> — load management and minutes restrictions</span>
              </li>
            </ul>
          </div>

          <div className="rounded-lg bg-[#1C7CFF]/5 border border-[#1C7CFF]/15 p-3.5">
            <p className="text-[13px] text-white/70 leading-relaxed">
              <span className="text-white/90 font-medium">Positive EV</span> indicates the model probability exceeds the
              sportsbook's breakeven probability — a potential long-term edge.
            </p>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-white/90 mb-2">Confidence levels</h3>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg bg-green-500/10 border border-green-500/15 p-2.5 text-center">
                <p className="text-xs font-bold text-green-400 mb-0.5">High</p>
                <p className="text-[10px] text-white/40">500+ historical cases</p>
              </div>
              <div className="rounded-lg bg-amber-500/10 border border-amber-500/15 p-2.5 text-center">
                <p className="text-xs font-bold text-amber-400 mb-0.5">Medium</p>
                <p className="text-[10px] text-white/40">100–500 cases</p>
              </div>
              <div className="rounded-lg bg-red-500/10 border border-red-500/15 p-2.5 text-center">
                <p className="text-xs font-bold text-red-400 mb-0.5">Low</p>
                <p className="text-[10px] text-white/40">Under 100 cases</p>
              </div>
            </div>
          </div>

          <div className="rounded-lg bg-white/5 border border-white/8 p-3 text-[11px] text-white/40 leading-relaxed">
            <p className="font-semibold text-white/60 mb-1">Important</p>
            <p>
              This model provides statistical estimates, not guarantees. Positive EV does not mean a bet will win —
              it means the odds may be in your favor over a large number of similar situations. Always bet responsibly.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function PropsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const qLeague = searchParams.get("league")?.toLowerCase();
  const qInjury = searchParams.get("injury")?.toLowerCase();
  const qPlayer = searchParams.get("player");
  const qSort = searchParams.get("sort");

  const { data: players = [], isLoading } = usePropsWithPlayers();
  const { data: curves = [], isLoading: curvesIsLoading } = usePerformanceCurves();

  const [leagueFilter, setLeagueFilter] = useState<string>(
    qLeague && LEAGUE_ORDER.includes(qLeague) ? qLeague : "all"
  );
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [sortMode, setSortMode] = useState<SortMode>(
    qSort && ["best", "gap", "early", "drop"].includes(qSort) ? qSort as SortMode : "best"
  );
  const [showEVInfo, setShowEVInfo] = useState(false);
  const [highlightedPlayerId, setHighlightedPlayerId] = useState<string | null>(null);

  // Build curve lookup: injury_type_slug|league_slug → PerformanceCurve
  const curveMap = useMemo(() => {
    const m = new Map<string, PerformanceCurve>();
    for (const c of curves) {
      if (c.position) continue; // only all-position curves
      const key = `${c.injury_type_slug}|${c.league_slug}`;
      const existing = m.get(key);
      if (!existing || c.sample_size > existing.sample_size) m.set(key, c);
    }
    return m;
  }, [curves]);

  /** Find matching curve for a player */
  const findCurve = (p: PropsPlayer): PerformanceCurve | null => {
    if (!p.injury_type) return null;
    const slug = injuryToSlug(p.injury_type);
    // Exact match first
    const exact = curveMap.get(`${slug}|${p.league_slug}`);
    if (exact) return exact;
    // Partial match: find curve whose slug contains the injury slug or vice versa
    for (const [key, curve] of curveMap) {
      const [cSlug, cLeague] = key.split("|");
      if (cLeague === p.league_slug && (cSlug.includes(slug) || slug.includes(cSlug))) return curve;
    }
    return null;
  };

  // Scroll to matched player and highlight — re-scroll if layout shifts
  useEffect(() => {
    if (!qPlayer || players.length === 0 || isLoading || curvesIsLoading) return;
    const q = qPlayer.toLowerCase();
    const match = players.find((p) => p.player_name.toLowerCase().includes(q));
    if (!match) return;

    setHighlightedPlayerId(match.player_id);

    // Scroll with retry: if the element moves due to late-rendering sections, scroll again
    let attempts = 0;
    let lastTop = -1;
    let rafId: number;

    function scrollToTarget() {
      const el = document.getElementById(`prop-player-${match!.player_id}`);
      if (!el) {
        if (attempts < 10) { attempts++; rafId = requestAnimationFrame(scrollToTarget); }
        return;
      }
      const rect = el.getBoundingClientRect();
      const currentTop = rect.top + window.scrollY;

      // Scroll if first attempt or if the element moved significantly
      if (lastTop < 0 || Math.abs(currentTop - lastTop) > 20) {
        lastTop = currentTop;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      // Keep checking for layout shifts for 2 seconds
      attempts++;
      if (attempts < 20) {
        setTimeout(() => { rafId = requestAnimationFrame(scrollToTarget); }, 150);
      }
    }

    // Start after a brief delay for initial render
    const timer = setTimeout(() => { rafId = requestAnimationFrame(scrollToTarget); }, 100);

    const fadeTimer = setTimeout(() => setHighlightedPlayerId(null), 4000);

    return () => { clearTimeout(timer); clearTimeout(fadeTimer); cancelAnimationFrame(rafId); };
  }, [qPlayer, players, isLoading, curvesIsLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear query params after initial use
  useEffect(() => {
    if (qLeague || qInjury || qPlayer) {
      const timer = setTimeout(() => {
        setSearchParams({}, { replace: true });
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    let list = leagueFilter === "all"
      ? players
      : players.filter((p) => p.league_slug === leagueFilter);
    // If injury query param, prioritize matching players
    if (qInjury) {
      list = [...list].sort((a, b) => {
        const aMatch = a.injury_type && injuryToSlug(a.injury_type).includes(qInjury) ? 1 : 0;
        const bMatch = b.injury_type && injuryToSlug(b.injury_type).includes(qInjury) ? 1 : 0;
        return bMatch - aMatch;
      });
    }
    // If player query param, prioritize matching players
    if (qPlayer) {
      const q = qPlayer.toLowerCase();
      list = [...list].sort((a, b) => {
        const aMatch = a.player_name.toLowerCase().includes(q) ? 1 : 0;
        const bMatch = b.player_name.toLowerCase().includes(q) ? 1 : 0;
        return bMatch - aMatch;
      });
    }
    return list;
  }, [players, leagueFilter, qInjury, qPlayer]);

  // Get unique leagues that have props today
  const activeLeagues = Array.from(new Set(players.map((p) => p.league_slug))).filter(Boolean);
  const orderedLeagues = LEAGUE_ORDER.filter((l) => activeLeagues.includes(l));

  // Get unique sources
  const activeSources = Array.from(new Set(players.flatMap((p) => p.props.map((pr) => pr.source)))).filter(Boolean);

  const injuredCount = filtered.filter((p) => p.status !== "active" && p.status !== "returned").length;

  // Split: recently returned (10 games or fewer since injury) vs rest
  const recentlyReturned = useMemo(() => {
    const list = filtered.filter(
      (p) => p.injury_date && p.gamesBack > 0 && p.gamesBack <= 10
    );
    // Sort by sortMode
    if (sortMode === "early") {
      list.sort((a, b) => a.gamesBack - b.gamesBack);
    } else if (sortMode === "gap") {
      list.sort((a, b) => {
        // Largest gap between return avg and line
        const gapA = getMaxGap(a);
        const gapB = getMaxGap(b);
        return gapB - gapA;
      });
    } else if (sortMode === "drop") {
      list.sort((a, b) => {
        const cA = findCurve(a);
        const cB = findCurve(b);
        const dropA = cA ? getCurveImpact(cA, 0, a.league_slug)?.diff ?? 0 : 0;
        const dropB = cB ? getCurveImpact(cB, 0, b.league_slug)?.diff ?? 0 : 0;
        return dropA - dropB; // most negative first
      });
    }
    return list;
  }, [filtered, sortMode, curveMap]);

  const otherPlayers = filtered.filter(
    (p) => !p.injury_date || p.gamesBack === 0 || p.gamesBack > 10
  );

  // Compute max gap between any prop line and return avg
  function getMaxGap(p: PropsPlayer): number {
    let maxGap = 0;
    for (const prop of p.props) {
      if (prop.line == null) continue;
      const statKey = MARKET_TO_STAT[prop.market];
      const returnVal = statKey && p.avgSinceReturn ? p.avgSinceReturn[statKey] : null;
      if (returnVal != null) maxGap = Math.max(maxGap, Math.abs(returnVal - prop.line));
    }
    return maxGap;
  }

  // Top 2 edges by EV for highlight cards, plus full list for edges section
  const returningEdges = useMemo(() => {
    return recentlyReturned
      .filter((p) => findCurve(p) != null)
      .slice(0, 6);
  }, [recentlyReturned, curveMap]);

  const topEdges = useMemo(() => {
    return returningEdges
      .map((p) => {
        const curve = findCurve(p)!;
        const topProp = p.props[0];
        const statKey = topProp ? MARKET_TO_STAT[topProp.market] : null;
        const baseline = statKey && p.avg10 ? p.avg10[statKey] : null;
        const recent = statKey && p.avgSinceReturn ? p.avgSinceReturn[statKey] : null;
        let ev: EVResult | null = null;
        if (curve && statKey && baseline != null && baseline > 0 && topProp?.line != null && p.gamesBack > 0) {
          ev = computeEV({
            baseline, propLine: topProp.line,
            overOdds: parseOdds(topProp.over_price), underOdds: parseOdds(topProp.under_price),
            gamesSinceReturn: p.gamesBack, recentAvg: recent, curve,
            leagueSlug: p.league_slug, statKey,
            preInjuryMinutes: p.avg10?.minutes, currentMinutes: p.avgSinceReturn?.minutes,
          });
        }
        return { player: p, ev, prop: topProp, evVal: ev?.bestEv != null && ev.bestEv > 0 ? ev.bestEv : 0 };
      })
      .filter((e) => e.ev?.recommendation && e.evVal > 0)
      .sort((a, b) => b.evVal - a.evVal)
      .slice(0, 4);
  }, [returningEdges, curveMap]);

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white">
      <SEO
        title="Player Props Today - Injury Return Analysis | Back In Play"
        description="Today's player prop lines analyzed through injury return data. Historical performance trends, return context, and market comparison for returning players."
        path="/props"
      />
      <SiteHeader />

      <EVInfoModal open={showEVInfo} onClose={() => setShowEVInfo(false)} />

      <div className="max-w-3xl mx-auto px-4 py-6">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-2xl font-bold">Player Props</h1>
          <button
            onClick={() => setShowEVInfo(true)}
            className="shrink-0 w-6 h-6 rounded-full border border-white/15 text-white/35 hover:text-white/70 hover:border-white/30 transition-colors text-xs font-semibold flex items-center justify-center"
            title="How the EV model works"
          >
            ?
          </button>
        </div>
        <p className="text-sm text-white/50 mb-5 leading-relaxed">
          Prop lines for players with injury history. Compare current lines against
          historical return trends and pre-injury baselines to identify where the market
          may still reflect injury uncertainty.
        </p>

        {/* Date context */}
        {players.length > 0 && (() => {
          const dates = [...new Set(players.flatMap((p) => p.props.map((pr) => pr.game_date).filter(Boolean)))].sort();
          const todayStr = new Date().toISOString().slice(0, 10);
          const hasTomorrow = dates.some((d) => d && d > todayStr);
          const mostRecent = dates[dates.length - 1];
          const isStale = mostRecent != null && mostRecent < todayStr;
          return (
            <div className={`rounded-lg px-3 py-2 mb-4 text-[11px] ${isStale ? "bg-amber-500/10 text-amber-400/70 border border-amber-500/20" : "bg-white/[0.03] text-white/40 border border-white/5"}`}>
              {isStale ? (
                <span>Showing props from {new Date(mostRecent + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} — today's lines aren't available yet</span>
              ) : (
                <span>
                  {dates.filter((d) => d === todayStr).length > 0 ? "Today's games" : ""}
                  {hasTomorrow ? (dates.filter((d) => d === todayStr).length > 0 ? " + tomorrow's games" : "Tomorrow's games") : ""}
                </span>
              )}
            </div>
          );
        })()}

        {/* Top 2 Edges — compact cards with large EV numbers */}
        {topEdges.length > 0 && (
          <section className="mb-6">
            <h2 className="text-xs font-bold text-[#1C7CFF]/80 uppercase tracking-widest mb-3">Top Edges</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {topEdges.map(({ player: p, ev: topEv, prop: topProp }) => {
                const lc = leagueColor(p.league_slug);
                const side = topEv!.recommendation!;
                const isOver = side === "OVER";
                return (
                  <Link
                    key={p.player_id}
                    to={`/props?player=${p.player_id}&sort=best`}
                    className={`relative rounded-xl border p-3.5 transition-all overflow-hidden ${
                      isOver
                        ? "bg-green-500/[0.06] border-green-500/20 hover:border-green-500/40"
                        : "bg-red-500/[0.06] border-red-500/20 hover:border-red-500/40"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <PlayerAvatar src={p.headshot_url} name={p.player_name} size={40} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold truncate">{p.player_name}</p>
                        <div className="flex items-center gap-1.5 text-[10px] text-white/35">
                          <span style={{ color: `${lc}aa` }}>{LEAGUE_LABELS[p.league_slug]}</span>
                          <span>·</span>
                          <span>{p.injury_type}</span>
                          <span>·</span>
                          <span>{p.gamesBack}G back</span>
                          <GameTimeBadge commenceTime={p.commence_time} gameDate={p.game_date} />
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <p className={`text-lg font-black tabular-nums ${isOver ? "text-green-400" : "text-red-400"}`}>
                          EV {formatEV(topEv!.bestEv!)}
                        </p>
                        <p className={`text-[11px] font-bold ${isOver ? "text-green-400/70" : "text-red-400/70"}`}>
                          {side}
                        </p>
                        <p className="text-[10px] text-white/40">
                          {MARKET_LABELS[topProp.market] ?? topProp.market} {topProp.line}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 mt-2 text-[10px] text-white/35">
                      <span>Model: <span className="text-white/60 font-medium tabular-nums">{topEv!.expectedCombined.toFixed(1)}</span></span>
                      <span>·</span>
                      <span>P({side.toLowerCase()}): <span className="text-white/60 font-medium tabular-nums">{Math.round((isOver ? topEv!.probOver : topEv!.probUnder) * 100)}%</span></span>
                      <span>·</span>
                      <span>{topEv!.confidence} confidence</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        {/* Returning Player Edges */}
        {returningEdges.length > 0 && (
          <section className="mb-8">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-bold text-white/40 uppercase tracking-widest">Returning Player Edges</h2>
              <span className="text-[10px] text-white/25">Based on historical injury return data</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mb-2">
              {returningEdges.map((p) => {
                const curve = findCurve(p);
                const impG3 = curve ? getCurveImpact(curve, 2, p.league_slug) : null;
                const topProp = p.props[0];
                const lc = leagueColor(p.league_slug);
                const fmtD = (d: number) => `${d >= 0 ? "+" : ""}${d.toFixed(1)}`;

                const topStatKey = topProp ? MARKET_TO_STAT[topProp.market] : null;
                const topBaseline = topStatKey && p.avg10 ? p.avg10[topStatKey] : null;
                const topRecent = topStatKey && p.avgSinceReturn ? p.avgSinceReturn[topStatKey] : null;
                let topEv: EVResult | null = null;
                if (curve && topStatKey && topBaseline != null && topBaseline > 0 && topProp?.line != null && p.gamesBack > 0) {
                  topEv = computeEV({
                    baseline: topBaseline, propLine: topProp.line,
                    overOdds: parseOdds(topProp.over_price), underOdds: parseOdds(topProp.under_price),
                    gamesSinceReturn: p.gamesBack, recentAvg: topRecent, curve,
                    leagueSlug: p.league_slug, statKey: topStatKey,
                    preInjuryMinutes: p.avg10?.minutes, currentMinutes: p.avgSinceReturn?.minutes,
                  });
                }

                return (
                  <div
                    key={p.player_id}
                    className="relative rounded-xl bg-white/[0.03] border border-white/8 p-4 hover:bg-white/[0.06] hover:border-white/15 transition-all overflow-hidden"
                  >
                    <div className="absolute left-0 top-0 bottom-0 w-[2px]" style={{ backgroundColor: `${lc}55` }} />

                    <div className="flex items-center gap-3 mb-2.5">
                      <PlayerAvatar src={p.headshot_url} name={p.player_name} size={36} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold truncate">{p.player_name}</p>
                        <div className="flex items-center gap-1.5 text-[10px] text-white/35">
                          <span style={{ color: `${lc}aa` }}>{LEAGUE_LABELS[p.league_slug]}</span>
                          <span>·</span>
                          <span>{p.injury_type}</span>
                          <span>·</span>
                          <span>{p.gamesBack} game{p.gamesBack !== 1 ? "s" : ""} back</span>
                          <GameTimeBadge commenceTime={p.commence_time} gameDate={p.game_date} />
                        </div>
                      </div>
                      {topProp && (
                        <div className="text-right shrink-0">
                          <p className="text-[9px] text-white/30">{MARKET_LABELS[topProp.market] ?? topProp.market} line</p>
                          <p className="text-lg font-bold">{topProp.line}</p>
                        </div>
                      )}
                    </div>

                    {curve && impG3 && (
                      <div className="rounded-lg bg-white/[0.03] border border-white/5 px-3 py-2 mb-2">
                        <p className="text-[10px] text-white/30 mb-1">
                          Historical {p.injury_type?.toLowerCase()} return trend
                        </p>
                        <div className="flex items-center gap-4 text-[11px]">
                          {([["G1", 0], ["G3", 2], ["G5", 4]] as [string, number][]).map(([label, gIdx]) => {
                            const imp = getCurveImpact(curve, gIdx, p.league_slug);
                            return (
                              <span key={label} className="tabular-nums">
                                <span className="text-white/25">{label}: </span>
                                <span className={imp && imp.diff < 0 ? "text-red-400/80" : "text-green-400/80"}>
                                  {imp ? `${fmtD(imp.diff)} ${imp.label}` : "—"}
                                </span>
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {topEv && topEv.recommendation && topEv.bestEv != null && (
                      <div className={`rounded-lg px-3 py-2 mb-1 border ${topEv.recommendation === "OVER" ? "bg-green-500/10 border-green-500/20" : "bg-red-500/10 border-red-500/20"}`}>
                        <div className="flex items-center justify-between">
                          <div className="text-[10px] text-white/40">
                            <span>Model: <span className="text-white/60 font-medium tabular-nums">{topEv.expectedCombined.toFixed(1)}</span></span>
                            <span className="mx-1.5">·</span>
                            <span>P({topEv.recommendation.toLowerCase()}): <span className="text-white/60 font-medium tabular-nums">{Math.round((topEv.recommendation === "OVER" ? topEv.probOver : topEv.probUnder) * 100)}%</span></span>
                          </div>
                          <span className={`text-xs font-bold tabular-nums ${topEv.recommendation === "OVER" ? "text-green-400" : "text-red-400"}`}>
                            EV {formatEV(topEv.bestEv)} · {topEv.recommendation}
                          </span>
                        </div>
                        <p className="text-[9px] text-white/20 mt-0.5">
                          Confidence: {topEv.confidence} · {topEv.sampleSize.toLocaleString()} historical cases
                        </p>
                      </div>
                    )}

                    {!topEv?.recommendation && impG3 && impG3.diff < 0 && (
                      <p className="text-[10px] text-white/25 leading-snug">
                        Market may still reflect injury uncertainty — historical {impG3.label.toLowerCase()} has typically lagged baseline in early return games.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}


        {/* Source tabs */}
        {activeSources.length > 1 && (
          <div className="flex gap-1 mb-4">
            {["draftkings", "fanduel", ...activeSources.filter((s) => s !== "draftkings" && s !== "fanduel")].filter((s) => activeSources.includes(s)).map((src) => (
              <button
                key={src}
                onClick={() => setSourceFilter(src)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  sourceFilter === src ? "bg-white/15 text-white" : "bg-white/5 text-white/40 hover:text-white/60"
                }`}
              >
                {SOURCE_LABELS[src] ?? src}
              </button>
            ))}
            <button
              onClick={() => setSourceFilter("all")}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                sourceFilter === "all" ? "bg-white/15 text-white" : "bg-white/5 text-white/40 hover:text-white/60"
              }`}
            >
              All
            </button>
          </div>
        )}

        {/* League filter */}
        <div className="flex gap-1.5 mb-4 overflow-x-auto pb-1">
          <button
            onClick={() => setLeagueFilter("all")}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors shrink-0 ${
              leagueFilter === "all" ? "bg-white/15 text-white" : "bg-white/5 text-white/40 hover:text-white/60"
            }`}
          >
            All ({players.length})
          </button>
          {orderedLeagues.map((slug) => {
            const count = players.filter((p) => p.league_slug === slug).length;
            return (
              <button
                key={slug}
                onClick={() => { setLeagueFilter(slug); trackLeagueFilter(slug, "props"); }}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors shrink-0 ${
                  leagueFilter === slug ? "bg-white/15 text-white" : "bg-white/5 text-white/40 hover:text-white/60"
                }`}
              >
                {LEAGUE_LABELS[slug]} ({count})
              </button>
            );
          })}
        </div>

        {/* Sort controls */}
        <div className="flex items-center gap-2 mb-4">
          <span className="text-[10px] text-white/25 shrink-0">Sort by</span>
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setSortMode(opt.value)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                sortMode === opt.value
                  ? "bg-white/12 text-white"
                  : "bg-white/5 text-white/35 hover:text-white/55"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Stats bar */}
        {filtered.length > 0 && (
          <div className="flex gap-4 text-xs text-white/40 mb-4">
            <span>{filtered.length} players with props</span>
            <span>{injuredCount} currently injured</span>
            {recentlyReturned.length > 0 && (
              <span>{recentlyReturned.length} recently returned</span>
            )}
          </div>
        )}

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-36 rounded-xl bg-white/5 animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-white/40 text-sm">No props data for today yet.</p>
            <p className="text-white/25 text-xs mt-1">Props are fetched daily before game time.</p>
          </div>
        ) : (
          <>
            {/* Recently Returned from Injury */}
            {recentlyReturned.length > 0 && (
              <section className="mb-8">
                <div className="flex items-center gap-3 mb-3">
                  <h2 className="text-xs font-bold text-[#3DFF8F]/80 uppercase tracking-widest">Recently Returned</h2>
                  <span className="text-[10px] text-white/30">{recentlyReturned.length} players within 10 games of return</span>
                </div>
                <div className="space-y-3">
                  {recentlyReturned.map((p) => (
                    <PlayerPropCard key={p.player_id} player={p} sourceFilter={sourceFilter} curve={findCurve(p)} highlighted={highlightedPlayerId === p.player_id} />
                  ))}
                </div>
              </section>
            )}

            {/* Other Player Props */}
            {otherPlayers.length > 0 && (
              <section>
                <div className="flex items-center gap-3 mb-3">
                  <h2 className="text-xs font-bold text-white/50 uppercase tracking-widest">Other Player Props</h2>
                  <span className="text-[10px] text-white/30">{otherPlayers.length} players</span>
                </div>
                <div className="space-y-3">
                  {otherPlayers.map((p) => (
                    <PlayerPropCard key={p.player_id} player={p} sourceFilter={sourceFilter} curve={findCurve(p)} highlighted={highlightedPlayerId === p.player_id} />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
