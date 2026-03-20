import { useState, useMemo, useEffect, useCallback } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { SiteHeader } from "../components/SiteHeader";
import { SEO } from "../components/seo/SEO";
import { PlayerAvatar } from "../components/PlayerAvatar";
import { InjuryPlayerCard } from "../components/InjuryPlayerCard";
import { trackLeagueFilter, trackPlayerAnalysisView } from "../lib/analytics";
import { leagueColor } from "../lib/leagueColors";
import { usePerformanceCurves } from "../features/performance-curves/lib/queries";
import type { PerformanceCurve } from "../features/performance-curves/lib/types";
import { computeEV, parseOdds, type EVResult } from "../lib/evModel";
import { BlurredInsight, EarlyAccessCTA } from "../components/PremiumTease";
import { WhyThisSignal } from "../components/WhyThisSignal";
import { PremiumGate } from "../components/PremiumGate";
import { PremiumUnlockCounter } from "../components/PremiumUnlockCounter";
import { PlayerBreakdownPanel } from "../components/PlayerBreakdownPanel";


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
  batter_hits: "stat_h", batter_total_bases: "stat_stl", batter_rbis: "stat_rbi",
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

// Stat filter options per league
const STAT_FILTERS: { value: string; label: string; markets: string[] }[] = [
  { value: "all", label: "All Stats", markets: [] },
  { value: "pts", label: "PTS", markets: ["player_points"] },
  { value: "reb", label: "REB", markets: ["player_rebounds"] },
  { value: "ast", label: "AST", markets: ["player_assists"] },
  { value: "pra", label: "PRA", markets: ["player_points_rebounds_assists"] },
  { value: "3pt", label: "3PT", markets: ["player_threes"] },
  { value: "pass", label: "Pass Yds", markets: ["player_pass_yds"] },
  { value: "rush", label: "Rush Yds", markets: ["player_rush_yds"] },
  { value: "rec", label: "Rec Yds", markets: ["player_reception_yds", "player_receptions"] },
  { value: "goals", label: "Goals", markets: ["player_goals"] },
  { value: "sog", label: "SOG", markets: ["player_shots_on_goal", "player_shots", "player_shots_on_target"] },
  { value: "hits", label: "Hits", markets: ["batter_hits"] },
  { value: "tb", label: "TB", markets: ["batter_total_bases"] },
];

/** Format game status from commence_time */
function localToday(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

function gameStatus(commenceTime: string | null | undefined, gameDate: string | undefined): { label: string; started: boolean; soon: boolean; tomorrow: boolean; finished: boolean } {
  const today = localToday();
  const isTomorrow = gameDate != null && gameDate > today;

  if (!commenceTime) {
    return { label: isTomorrow ? "Tomorrow" : "Today", started: false, soon: false, tomorrow: isTomorrow, finished: false };
  }
  const ct = new Date(commenceTime);
  const now = new Date();
  if (now >= ct) {
    // ~3 hours after tip-off → likely finished
    const hrsSinceStart = (now.getTime() - ct.getTime()) / 3600000;
    if (hrsSinceStart >= 3) {
      return { label: "Final", started: false, soon: false, tomorrow: false, finished: true };
    }
    return { label: "Live", started: true, soon: false, tomorrow: false, finished: false };
  }
  const minsUntil = (ct.getTime() - now.getTime()) / 60000;
  const timeStr = ct.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return { label: isTomorrow ? `Tomorrow ${timeStr}` : timeStr, started: false, soon: minsUntil <= 30, tomorrow: isTomorrow, finished: false };
}

function GameTimeBadge({ commenceTime, gameDate }: { commenceTime?: string | null; gameDate?: string }) {
  const { label, started, soon, tomorrow, finished } = gameStatus(commenceTime, gameDate);
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold ${
      finished ? "bg-white/5 text-white/30" :
      started ? "bg-green-500/20 text-green-400" :
      soon ? "bg-amber-500/20 text-amber-400" :
      tomorrow ? "bg-blue-500/10 text-blue-400/60" :
      "bg-white/5 text-white/40"
    }`}>
      {started && <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />}
      {soon && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />}
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
 * 4. Multiply by median minutes -> per-game expected value
 */
function computeAvg(games: any[], n: number): PreInjuryAvg | null {
  if (games.length === 0) return null;

  const statKeys = ["stat_pts", "stat_reb", "stat_ast", "stat_stl", "stat_blk",
    "stat_sog", "stat_rush_yds", "stat_pass_yds", "stat_rec", "stat_rec_yds",
    "stat_goals", "stat_h", "stat_rbi"];

  // Check if this league has minutes data
  const withMinutes = games.filter((g: any) => g.minutes != null && g.minutes > 0);
  const hasMinutes = withMinutes.length > 0;

  if (hasMinutes) {
    // Minutes-adjusted: filter out injury exits, use per-minute rates
    const allMinutes = withMinutes.map((g: any) => g.minutes as number);
    const typicalMinutes = arrMedian(allMinutes);
    const minThreshold = typicalMinutes * 0.25;
    const realGames = withMinutes.filter((g: any) => g.minutes >= minThreshold);
    const slice = realGames.slice(0, n);
    if (slice.length === 0) return null;

    const result: PreInjuryAvg = { minutes: null };
    const minuteVals = slice.map((g: any) => g.minutes as number);
    const medMinutes = arrMedian(minuteVals);
    result.minutes = Math.round(medMinutes * 10) / 10;

    for (const key of statKeys) {
      const rates: number[] = [];
      for (const g of slice) {
        const val = g[key];
        if (val != null) rates.push(val / g.minutes);
      }
      result[key] = rates.length > 0
        ? Math.round(arrMedian(rates) * medMinutes * 10) / 10
        : null;
    }
    return result;
  } else {
    // No minutes data (NHL, EPL, MLB) — use simple median of raw stats
    const slice = games.slice(0, n);
    if (slice.length === 0) return null;

    const result: PreInjuryAvg = { minutes: null };
    for (const key of statKeys) {
      const vals: number[] = [];
      for (const g of slice) {
        const val = g[key];
        if (val != null) vals.push(val);
      }
      result[key] = vals.length > 0
        ? Math.round(arrMedian(vals) * 10) / 10
        : null;
    }
    return result;
  }
}

/** ML model prediction for a single prop */
interface MLPrediction {
  player_name: string;
  market: string;
  game_date: string;
  prop_line: number;
  recommendation: "OVER" | "UNDER";
  ev: number;
  p_over: number;
  baseline: number;
  recent_avg: number | null;
  model: string;
  kelly_fraction: number;
}

/** Fetch today's/tomorrow's ML predictions from backtest_results */
function useMLPredictions() {
  return useQuery<Map<string, MLPrediction>>({
    queryKey: ["ml-predictions-props"],
    queryFn: async () => {
      const LEAGUES = ["nba", "nhl", "mlb", "nfl", "premier-league"];
      // Try model_e first (user preference), fall back to model_d, model_f, model_c
      const MODEL_PRIORITY = ["model_e", "model_d", "model_f", "model_c"];
      const predKeys = LEAGUES.flatMap((l) => MODEL_PRIORITY.map((m) => `${l}_${m}_predictions`));
      const { data } = await supabase
        .from("back_in_play_backtest_results")
        .select("league, results")
        .in("league", predKeys);
      if (!data) return new Map();

      // Group by base league, pick best model per league
      const byLeague = new Map<string, MLPrediction[]>();
      for (const row of data) {
        const parsed = typeof row.results === "string" ? JSON.parse(row.results) : row.results;
        const preds: MLPrediction[] = parsed.predictions ?? [];
        // Extract base league (e.g., "nba" from "nba_model_d_predictions")
        const baseLeague = row.league.replace(/_model_[a-z]_predictions$/, "");
        if (!byLeague.has(baseLeague)) byLeague.set(baseLeague, preds);
        // model_d takes priority (loaded first due to key order)
      }

      // Build lookup: player_name|market|game_date → prediction
      const map = new Map<string, MLPrediction>();
      for (const preds of byLeague.values()) {
        for (const p of preds) {
          const key = `${p.player_name}|${p.market}|${p.game_date}`;
          if (!map.has(key)) map.set(key, p);
        }
      }
      return map;
    },
    staleTime: 5 * 60 * 1000,
  });
}

function usePropsWithPlayers() {
  // Use local date (not UTC) so 9pm ET on March 18 stays March 18
  const today = localToday();
  const tmrw = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 1);
  const tomorrow = `${tmrw.getFullYear()}-${String(tmrw.getMonth() + 1).padStart(2, "0")}-${String(tmrw.getDate()).padStart(2, "0")}`;
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
        // First find the most recent game_date
        const { data: latestRow } = await supabase
          .from("back_in_play_player_props")
          .select("game_date")
          .order("game_date", { ascending: false })
          .limit(1);
        if (latestRow && latestRow.length > 0) {
          const { data: recent } = await supabase
            .from("back_in_play_player_props")
            .select("id, player_id, player_name, market, line, over_price, under_price, source, game_date, commence_time, home_team, away_team")
            .eq("game_date", latestRow[0].game_date);
          props = recent ?? [];
        }
      }
      if (!props || props.length === 0) return [];

      // 2. Group props by player_id initially
      const propsByPlayer = new Map<string, typeof props>();
      for (const p of props) {
        if (!p.player_id) continue;
        const existing = propsByPlayer.get(p.player_id) ?? [];
        existing.push(p);
        propsByPlayer.set(p.player_id, existing);
      }

      // Collect ALL player_ids (including duplicates from different scrapers)
      const playerIds = Array.from(propsByPlayer.keys());

      // 3. Parallel: players (with team+league joins), injuries, game logs
      const [playersRes, leaguesRes, ...injuryChunks] = await Promise.all([
        supabase
          .from("back_in_play_players")
          .select("player_id, player_name, slug, position, team_id, league_id, headshot_url, espn_id, is_star, is_starter, team:back_in_play_teams(team_name, league_id), league:back_in_play_leagues!back_in_play_players_league_id_fkey(slug)")
          .in("player_id", playerIds),
        supabase.from("back_in_play_leagues").select("league_id, slug"),
        ...Array.from({ length: Math.ceil(playerIds.length / 200) }, (_, i) =>
          supabase
            .from("back_in_play_injuries")
            .select("player_id, status, injury_type, expected_return, date_injured, return_date")
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

      // 4. Game logs — parallel chunks
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
        let injury = injuryMap.get(pid);

        // Skip stale "returned" injuries — if return was >45 days ago, player is fully healthy
        if (injury) {
          const rd = injury.return_date ?? injury.date_injured;
          const daysSinceReturn = rd ? (Date.now() - new Date(rd + "T00:00:00").getTime()) / 86400000 : 999;
          if (injury.status === "returned" && daysSinceReturn > 45) {
            injury = undefined; // treat as no injury
          }
        }

        // Compute pre-injury averages from game logs
        const allGames = gameLogMap.get(pid) ?? [];
        let preInjuryGames = allGames;
        const injuryDate = injury?.date_injured;
        if (injuryDate) {
          preInjuryGames = allGames.filter((g: any) => g.game_date < injuryDate);
        }
        preInjuryGames.sort((a: any, b: any) => b.game_date.localeCompare(a.game_date));

        const avg5 = computeAvg(preInjuryGames, 5);
        const avg10 = computeAvg(preInjuryGames, 10);

        // Post-return games: use whichever is earlier — return_date or the first
        // game after the injury date — since return_date can lag behind actual appearances
        let postReturnGames: any[] = [];
        const returnDate = injury?.return_date ?? injuryDate;
        if (injuryDate) {
          // Find games after the injury date (the player's actual return games)
          const gamesAfterInjury = allGames
            .filter((g: any) => g.game_date > injuryDate)
            .sort((a: any, b: any) => a.game_date.localeCompare(b.game_date));
          // Use whichever cutoff captures more games (earlier of return_date or first game after injury)
          const effectiveReturn = returnDate && gamesAfterInjury.length > 0 && gamesAfterInjury[0].game_date < returnDate
            ? gamesAfterInjury[0].game_date
            : returnDate;
          if (effectiveReturn) {
            postReturnGames = allGames
              .filter((g: any) => g.game_date >= effectiveReturn)
              .sort((a: any, b: any) => b.game_date.localeCompare(a.game_date));
          }
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

      // Enrich missing commence_time/teams from other props on the same game_date
      // Build a map: game_date+team_name → { commence_time, home_team, away_team }
      const gameTimeMap = new Map<string, { commence_time: string; home_team: string | null; away_team: string | null }>();
      for (const p of props ?? []) {
        if (!p.commence_time || !p.game_date) continue;
        if (p.home_team) gameTimeMap.set(`${p.game_date}|${p.home_team}`, { commence_time: p.commence_time, home_team: p.home_team, away_team: p.away_team });
        if (p.away_team) gameTimeMap.set(`${p.game_date}|${p.away_team}`, { commence_time: p.commence_time, home_team: p.home_team, away_team: p.away_team });
      }
      for (const r of result) {
        if (!r.commence_time && r.team_name && r.game_date) {
          const match = gameTimeMap.get(`${r.game_date}|${r.team_name}`);
          if (match) {
            r.commence_time = match.commence_time;
            if (!r.home_team) r.home_team = match.home_team;
            if (!r.away_team) r.away_team = match.away_team;
          }
        }
      }

      // Merge duplicate player names (different player_ids from different scrapers)
      const mergedResult: PropsPlayer[] = [];
      const seenNames = new Map<string, number>(); // name → index in mergedResult
      for (const p of result) {
        const nameLower = p.player_name.toLowerCase();
        const existingIdx = seenNames.get(nameLower);
        if (existingIdx != null) {
          const existing = mergedResult[existingIdx];
          // Merge props from this duplicate into the existing entry
          existing.props.push(...p.props);
          // Prefer the entry that has injury data
          if (!existing.injury_date && p.injury_date) {
            existing.player_id = p.player_id;
            existing.status = p.status;
            existing.injury_type = p.injury_type;
            existing.injury_date = p.injury_date;
            existing.expected_return = p.expected_return;
            existing.avg5 = p.avg5;
            existing.avg10 = p.avg10;
            existing.gamesBack = p.gamesBack;
            existing.avgSinceReturn = p.avgSinceReturn;
            existing.headshot_url = p.headshot_url || existing.headshot_url;
            existing.league_slug = p.league_slug || existing.league_slug;
            existing.team_name = p.team_name || existing.team_name;
          }
          // Prefer non-null game time
          if (!existing.commence_time && p.commence_time) {
            existing.commence_time = p.commence_time;
            existing.home_team = p.home_team;
            existing.away_team = p.away_team;
          }
        } else {
          seenNames.set(nameLower, mergedResult.length);
          mergedResult.push(p);
        }
      }

      // Sort: stars first, then starters, then by name
      mergedResult.sort((a, b) => {
        if (a.is_star !== b.is_star) return a.is_star ? -1 : 1;
        if (a.is_starter !== b.is_starter) return a.is_starter ? -1 : 1;
        return a.player_name.localeCompare(b.player_name);
      });

      return mergedResult;
    },
    staleTime: 5 * 60 * 1000,
  });
}

// ─── Recovery Curve Mini Visualization ───────────────────────────────────────

function RecoveryCurveMini({ curve, leagueSlug, gamesBack }: { curve: PerformanceCurve; leagueSlug: string; gamesBack: number }) {
  const ps = PRIMARY_STAT[leagueSlug];
  if (!ps) return null;
  const baselines = curve.stat_baselines ?? {};
  const medians = curve.stat_median_pct ?? {};
  const base = baselines[ps.key];
  const pcts = medians[ps.key] as number[] | undefined;
  if (!base || !pcts || pcts.length === 0) return null;

  const points = pcts.slice(0, 10);
  const minPct = Math.min(...points, 0.7);
  const maxPct = Math.max(...points, 1.1);
  const range = maxPct - minPct || 0.1;
  const w = 160;
  const h = 40;
  const step = w / (points.length - 1 || 1);

  const pathPoints = points.map((p, i) => {
    const x = i * step;
    const y = h - ((p - minPct) / range) * h;
    return `${x},${y}`;
  });
  const path = `M${pathPoints.join(" L")}`;

  // Baseline line at pct=1.0
  const baselineY = h - ((1.0 - minPct) / range) * h;

  // Current game marker
  const curIdx = Math.min(gamesBack - 1, points.length - 1);
  const curX = curIdx >= 0 ? curIdx * step : 0;
  const curY = curIdx >= 0 ? h - ((points[curIdx] - minPct) / range) * h : h / 2;

  return (
    <svg width={w} height={h + 4} className="overflow-visible">
      {/* Baseline */}
      <line x1={0} y1={baselineY} x2={w} y2={baselineY} stroke="rgba(255,255,255,0.1)" strokeDasharray="3,3" />
      {/* Curve */}
      <path d={path} fill="none" stroke="rgba(59,130,246,0.5)" strokeWidth={1.5} />
      {/* Current position */}
      {curIdx >= 0 && (
        <circle cx={curX} cy={curY} r={3} fill="#3b82f6" stroke="#0a0f1a" strokeWidth={1.5} />
      )}
    </svg>
  );
}

// ─── Backtest-driven signal strength ──────────────────────────────────────────

/** ML model suffixes to evaluate (Model D and E only) */
const SIGNAL_MODEL_SUFFIXES = ["_model_d", "_model_e"];

/** Profitability profile per league, derived from ML backtest results */
interface LeagueModelProfile {
  bestModel: string; // suffix of best model
  roi: number; // ROI at EV>=5% filter
  winRate: number; // win rate at EV>=5% filter
  profitable: boolean;
  totalBets: number;
}

/** Compute ROI/win-rate from raw bets, filtered by minimum EV threshold */
function computeBetStats(bets: any[], minEv = 5) {
  const filtered = bets.filter((b: any) => Math.abs(b.ev ?? 0) >= minEv);
  if (filtered.length === 0) return { roi: 0, winRate: 0, total: 0 };
  const correct = filtered.filter((b: any) => b.correct).length;
  const pnl = filtered.reduce((sum: number, b: any) => sum + (b.pnl ?? 0), 0);
  return {
    roi: (pnl / filtered.length) * 100,
    winRate: (correct / filtered.length) * 100,
    total: filtered.length,
  };
}

/** Hook: fetch Model D & E backtest results and build profitability map per league */
function useBacktestProfiles() {
  const BACKTEST_LEAGUES = ["nba", "nhl", "mlb", "nfl", "premier-league"];
  const keys = BACKTEST_LEAGUES.flatMap((l) => SIGNAL_MODEL_SUFFIXES.map((s) => `${l}${s}`));

  return useQuery<Record<string, LeagueModelProfile>>({
    queryKey: ["bip-backtest-profiles"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("back_in_play_backtest_results")
        .select("league, results")
        .in("league", keys);
      if (error || !data) return {};

      // Parse results and find best ML model per base league
      const byBase: Record<string, { suffix: string; roi: number; winRate: number; total: number }[]> = {};
      for (const row of data) {
        const parsed = typeof row.results === "string" ? JSON.parse(row.results) : row.results;
        const bets = parsed?.bets;
        if (!bets || !Array.isArray(bets) || bets.length === 0) continue;

        // Extract base league from key like "nba_model_d"
        let base = row.league;
        let suffix = "";
        for (const s of SIGNAL_MODEL_SUFFIXES) {
          if (row.league.endsWith(s)) {
            base = row.league.slice(0, -s.length);
            suffix = s;
            break;
          }
        }

        // Compute stats at EV >= 5% threshold (where models tend to be profitable)
        const stats = computeBetStats(bets, 5);
        if (!byBase[base]) byBase[base] = [];
        byBase[base].push({ suffix, roi: stats.roi, winRate: stats.winRate, total: stats.total });
      }

      const profiles: Record<string, LeagueModelProfile> = {};
      for (const [base, models] of Object.entries(byBase)) {
        // Pick the model with the highest ROI (prefer models with enough bets)
        const viable = models.filter((m) => m.total >= 20);
        const candidates = viable.length > 0 ? viable : models;
        const best = candidates.reduce((a, b) => (b.roi > a.roi ? b : a), candidates[0]);
        profiles[base] = {
          bestModel: best.suffix,
          roi: best.roi,
          winRate: best.winRate,
          profitable: best.roi > 0,
          totalBets: best.total,
        };
      }
      return profiles;
    },
    staleTime: 30 * 60 * 1000, // Cache for 30 minutes
  });
}

/**
 * Percentile-based edge label.
 * Labels are relative to today's picks — top 20% Strong, next 40% Moderate, bottom 40% Lower.
 * The `percentile` (0–1) is the player's rank among today's scored picks.
 */
function edgeLabel(evPct: number, _leagueProfile?: LeagueModelProfile | null, percentile?: number): { text: string; color: string } {
  // If we have a percentile rank from today's picks, use it
  if (percentile != null) {
    if (percentile >= 0.8) {
      return { text: "Strong signal", color: evPct > 0 ? "text-green-400" : "text-red-400" };
    }
    if (percentile >= 0.4) {
      return { text: "Moderate signal", color: evPct > 0 ? "text-green-400/80" : "text-red-400/80" };
    }
    return { text: "Lean signal", color: "text-white/40" };
  }

  // Fallback: pure EV-based (no percentile data available)
  const abs = Math.abs(evPct);
  if (abs >= 15) return { text: "Strong signal", color: evPct > 0 ? "text-green-400" : "text-red-400" };
  if (abs >= 7) return { text: "Moderate signal", color: evPct > 0 ? "text-green-400/80" : "text-red-400/80" };
  return { text: "Lean signal", color: "text-white/40" };
}

/**
 * Compute percentile map for all scored players.
 * Returns player_id -> percentile (0–1), where 1 = best.
 */
function computePercentiles(
  players: PropsPlayer[],
  findCurve: (p: PropsPlayer) => PerformanceCurve | null,
): Map<string, number> {
  // Score each player by their best EV
  const scores: { playerId: string; ev: number }[] = [];
  for (const p of players) {
    if (p.gamesBack < 0) continue;
    const curve = findCurve(p);
    if (!curve) continue;
    let bestEv = 0;
    for (const prop of p.props) {
      const statKey = MARKET_TO_STAT[prop.market];
      const baseline = statKey && p.avg10 ? p.avg10[statKey] : null;
      const recent = statKey && p.avgSinceReturn ? p.avgSinceReturn[statKey] : null;
      if (!statKey || baseline == null || baseline <= 0 || prop.line == null) continue;
      const ev = computeEV({
        baseline, propLine: prop.line,
        overOdds: parseOdds(prop.over_price), underOdds: parseOdds(prop.under_price),
        gamesSinceReturn: p.gamesBack, recentAvg: recent, curve,
        leagueSlug: p.league_slug, statKey,
        preInjuryMinutes: p.avg10?.minutes, currentMinutes: p.avgSinceReturn?.minutes,
      });
      if (ev?.bestEv != null && Math.abs(ev.bestEv) > bestEv) {
        bestEv = Math.abs(ev.bestEv);
      }
    }
    if (bestEv > 0) scores.push({ playerId: p.player_id, ev: bestEv });
  }

  // Sort ascending by EV, then assign percentiles
  scores.sort((a, b) => a.ev - b.ev);
  const map = new Map<string, number>();
  for (let i = 0; i < scores.length; i++) {
    map.set(scores[i].playerId, scores.length > 1 ? i / (scores.length - 1) : 0.5);
  }
  return map;
}

// ─── STEP 4: Game return badge ──────────────────────────────────────────────

function GameReturnBadge({ gamesBack }: { gamesBack: number }) {
  if (gamesBack <= 0) return null;
  const color = gamesBack <= 3
    ? "bg-red-500/15 text-red-400/90 border-red-500/25"
    : gamesBack <= 6
    ? "bg-amber-500/15 text-amber-400/90 border-amber-500/25"
    : "bg-white/10 text-white/50 border-white/15";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[10px] font-semibold ${color}`}>
      G{gamesBack}
    </span>
  );
}

// ─── STEP 2: Auto-generate "why this edge" explanation per prop ──────────────

function generatePropExplanation(
  market: string,
  line: number | null,
  preVal: number | null,
  returnVal: number | null,
  gamesBack: number,
  impDiff: number | null,
): string | null {
  const reasons: string[] = [];
  const statLabel = MARKET_LABELS[market] ?? market;

  // Pre vs post stat difference
  if (preVal != null && returnVal != null && line != null) {
    const diff = returnVal - preVal;
    if (Math.abs(diff) > 0.3) {
      const dir = diff < 0 ? "Reduced" : "Elevated";
      reasons.push(`${dir} ${statLabel.toLowerCase()} since return (${returnVal.toFixed(1)} vs ${preVal.toFixed(1)} pre-injury)`);
    }
  }

  // Historical trend
  if (impDiff != null && impDiff < -0.3) {
    reasons.push("comparable cases show reduced output");
  }

  // Early return
  if (gamesBack <= 3) {
    reasons.push("early return suppression signal");
  }

  if (reasons.length === 0) return null;
  return reasons.join(" · ");
}

// ─── PlayerPropCard (Redesigned with Signal → Explanation → Context) ─────────

export function PlayerPropCard({ player, sourceFilter, curve, highlighted, statFilter }: {
  player: PropsPlayer;
  sourceFilter: string;
  curve?: PerformanceCurve | null;
  highlighted?: boolean;
  statFilter?: string;
}) {
  const priority = ["player_points", "player_goals", "batter_hits", "player_pass_yds", "player_rush_yds",
    "player_rebounds", "player_assists", "player_threes", "player_shots_on_goal", "batter_total_bases"];

  // Filter by source, then dedupe by market (prefer draftkings when showing all)
  let sourceProps = sourceFilter === "all"
    ? player.props
    : player.props.filter((p) => p.source === sourceFilter);

  // Apply stat filter
  if (statFilter && statFilter !== "all") {
    const sf = STAT_FILTERS.find((f) => f.value === statFilter);
    if (sf && sf.markets.length > 0) {
      sourceProps = sourceProps.filter((p) => sf.markets.includes(p.market));
    }
  }

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
      {/* RETURN SUMMARY — the most important context box */}
      {player.gamesBack > 0 && (
        <div className="px-4 pb-2">
          <div className="rounded-lg bg-gradient-to-r from-blue-500/[0.06] to-purple-500/[0.04] border border-blue-500/15 px-3.5 py-3">
            <div className="flex items-center gap-2 mb-1.5">
              <p className="text-[10px] font-bold text-blue-400/90 uppercase tracking-wider">Return Summary</p>
              <GameReturnBadge gamesBack={player.gamesBack} />
            </div>
            {(() => {
              // Build the summary lines
              const lines: string[] = [];
              if (impG3 && impG3.diff < 0) {
                lines.push(`Players returning from ${player.injury_type?.toLowerCase() ?? "this injury"} typically underperform in the first 3–5 games.`);
              } else if (impG3 && impG3.diff >= 0) {
                lines.push(`${player.injury_type ?? "This injury"} returns historically show near-baseline performance.`);
              }
              // Find the biggest gap stat
              const bestGap = sorted.reduce<{ market: string; pct: number } | null>((best, p) => {
                const sk = MARKET_TO_STAT[p.market];
                const base = sk && player.avg10 ? player.avg10[sk] : null;
                if (!curve || !sk || base == null || base <= 0 || p.line == null || player.gamesBack <= 0) return best;
                const ev = computeEV({ baseline: base, propLine: p.line, overOdds: parseOdds(p.over_price), underOdds: parseOdds(p.under_price), gamesSinceReturn: player.gamesBack, recentAvg: sk && player.avgSinceReturn ? player.avgSinceReturn[sk] : null, curve, leagueSlug: player.league_slug, statKey: sk, preInjuryMinutes: player.avg10?.minutes, currentMinutes: player.avgSinceReturn?.minutes });
                if (!ev || ev.expectedCombined == null || p.line === 0) return best;
                const pct = Math.abs(((ev.expectedCombined - p.line) / p.line) * 100);
                if (!best || pct > best.pct) return { market: p.market, pct };
                return best;
              }, null);
              if (bestGap && bestGap.pct > 5) {
                lines.push(`This player is currently projected ${Math.round(bestGap.pct)}% ${bestGap.pct > 0 ? "away from" : "from"} market expectations on ${MARKET_LABELS[bestGap.market] ?? bestGap.market}.`);
              }
              if (player.avg10?.minutes && player.avgSinceReturn?.minutes && player.gamesBack > 0) {
                const pct = player.avgSinceReturn.minutes / player.avg10.minutes;
                if (pct < 0.8) lines.push(`Minutes still below pre-injury levels (${Math.round(pct * 100)}% of usual).`);
              }
              if (lines.length === 0 && player.gamesBack <= 3) {
                lines.push(`Game ${player.gamesBack} after return — early return window with highest performance uncertainty.`);
              }
              return lines.length > 0 ? (
                <p className="text-[11px] text-white/50 leading-relaxed">{lines.join(" ")}</p>
              ) : null;
            })()}
          </div>
        </div>
      )}

      {/* WHY THIS SIGNAL — free summary + locked premium breakdown */}
      {player.gamesBack > 0 && (() => {
        // Find the primary stat's EV and data for the signal explanation
        const primaryProp = sorted[0];
        const primaryStatKey = primaryProp ? MARKET_TO_STAT[primaryProp.market] : null;
        const primaryBaseline = primaryStatKey && player.avg10 ? player.avg10[primaryStatKey] as number | undefined : null;
        const primaryReturn = primaryStatKey && player.avgSinceReturn ? player.avgSinceReturn[primaryStatKey] as number | undefined : null;
        let primaryEv: EVResult | null = null;
        if (curve && primaryStatKey && primaryBaseline != null && primaryBaseline > 0 && primaryProp?.line != null) {
          primaryEv = computeEV({
            baseline: primaryBaseline,
            propLine: primaryProp.line,
            overOdds: parseOdds(primaryProp.over_price),
            underOdds: parseOdds(primaryProp.under_price),
            gamesSinceReturn: player.gamesBack,
            recentAvg: primaryReturn ?? null,
            curve,
            leagueSlug: player.league_slug,
            statKey: primaryStatKey,
            preInjuryMinutes: player.avg10?.minutes,
            currentMinutes: player.avgSinceReturn?.minutes,
          });
        }
        return (
          <div className="px-4 pb-2">
            <WhyThisSignal
              playerName={player.player_name}
              injuryType={player.injury_type}
              gamesBack={player.gamesBack}
              ev={primaryEv}
              curve={curve ?? null}
              preBaseline={primaryBaseline ?? null}
              returnAvg={primaryReturn ?? null}
              preMinutes={player.avg10?.minutes ?? null}
              currentMinutes={player.avgSinceReturn?.minutes ?? null}
              marketLabel={MARKET_LABELS[primaryProp?.market ?? ""] ?? primaryProp?.market ?? "stat"}
              propLine={primaryProp?.line ?? null}
              leagueSlug={player.league_slug}
              statKey={primaryStatKey}
              isPremium={false}
            />
          </div>
        );
      })()}

      {/* PROP PROJECTIONS — primary stat highlighted */}
      <div className="px-4 pb-2">
        {(() => {
          // Compute EV for all props and find primary (largest gap)
          const propData = sorted.map((p) => {
            const statKey = MARKET_TO_STAT[p.market];
            const avg10Val = statKey && player.avg10 ? player.avg10[statKey] : null;
            const sinceReturnVal = statKey && player.avgSinceReturn ? player.avgSinceReturn[statKey] : null;
            let ev: EVResult | null = null;
            if (curve && statKey && avg10Val != null && p.line != null && player.gamesBack > 0) {
              ev = computeEV({ baseline: avg10Val, propLine: p.line, overOdds: parseOdds(p.over_price), underOdds: parseOdds(p.under_price), gamesSinceReturn: player.gamesBack, recentAvg: sinceReturnVal, curve, leagueSlug: player.league_slug, statKey, preInjuryMinutes: player.avg10?.minutes, currentMinutes: player.avgSinceReturn?.minutes });
            }
            const hasEdge = ev?.recommendation && ev?.bestEv != null && ev.bestEv > 0;
            const projDiffPct = ev && p.line != null && p.line > 0 ? Math.round(((ev.expectedCombined - p.line) / p.line) * 100) : null;
            return { prop: p, ev, hasEdge, projDiffPct, avg10Val, sinceReturnVal, statKey };
          });

          // Find primary stat (largest absolute gap)
          let primaryIdx = 0;
          let bestGap = 0;
          propData.forEach((d, i) => {
            const gap = Math.abs(d.projDiffPct ?? 0);
            if (gap > bestGap) { bestGap = gap; primaryIdx = i; }
          });

          function confidenceLabel(conf: string | undefined): { text: string; color: string } {
            if (conf === "High") return { text: "High confidence", color: "text-green-400/70" };
            if (conf === "Medium") return { text: "Medium confidence", color: "text-amber-400/70" };
            return { text: "Low confidence", color: "text-white/35" };
          }

          return (
            <div className="space-y-1.5">
              {propData.map((d, idx) => {
                const { prop: p, ev, hasEdge, projDiffPct, avg10Val, sinceReturnVal } = d;
                const isPrimary = idx === primaryIdx && hasEdge;
                const isOver = ev?.recommendation === "OVER";
                const edge = hasEdge && ev?.bestEv != null ? edgeLabel(ev.bestEv) : null;
                const conf = confidenceLabel(ev?.confidence);
                const propExplanation = hasEdge ? generatePropExplanation(p.market, p.line, avg10Val, sinceReturnVal, player.gamesBack, impG3?.diff ?? null) : null;

                return (
                  <div
                    key={p.id}
                    className={`rounded-lg ${isPrimary ? "px-3.5 py-3" : "px-2.5 py-2"} ${
                      hasEdge
                        ? isOver
                          ? isPrimary ? "bg-green-500/[0.1] border-2 border-green-500/30" : "bg-green-500/[0.06] border border-green-500/15"
                          : isPrimary ? "bg-red-500/[0.1] border-2 border-red-500/30" : "bg-red-500/[0.06] border border-red-500/15"
                        : "bg-white/[0.03] border border-white/5"
                    }`}
                  >
                    {/* Header: stat + confidence + direction */}
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <p className={`${isPrimary ? "text-[11px]" : "text-[10px]"} text-emerald-400/70 font-semibold`}>
                          {MARKET_LABELS[p.market] ?? p.market}
                        </p>
                        {isPrimary && <span className="text-[8px] text-blue-400/60 font-bold uppercase tracking-wider bg-blue-400/10 px-1.5 py-0.5 rounded">Primary</span>}
                      </div>
                      {/* Direction shown inside the unified PremiumGate below */}
                    </div>

                    {/* Market vs Model */}
                    <div className="flex items-baseline justify-between gap-3">
                      <div>
                        <p className="text-[9px] text-white/30">Market</p>
                        <p className={`${isPrimary ? "text-xl" : "text-base"} font-bold text-white tabular-nums`}>{p.line}</p>
                      </div>
                      {ev && (
                        <PremiumGate
                          contentId={`player-${player.player_id}`}
                          playerName={player.player_name}
                          section="prop_signal"
                          placeholder={
                            <div className="flex items-baseline gap-3">
                              <span className={`${isPrimary ? "text-[11px]" : "text-[10px]"} font-bold text-white/40`}>OVER</span>
                              <div className="text-right">
                                <p className="text-[9px] text-white/30">Model</p>
                                <p className={`${isPrimary ? "text-xl" : "text-base"} font-bold text-white/70 tabular-nums`}>24.5</p>
                              </div>
                              <div className="text-right">
                                <p className="text-[9px] text-white/30">Gap</p>
                                <p className={`${isPrimary ? "text-lg" : "text-sm"} font-bold tabular-nums text-green-400/80`}>+8%</p>
                              </div>
                            </div>
                          }
                        >
                          <div className="flex items-baseline gap-3">
                            {hasEdge && edge && ev.recommendation && (
                              <span className={`${isPrimary ? "text-[11px]" : "text-[10px]"} font-bold ${edge.color}`}>
                                {ev.recommendation}
                              </span>
                            )}
                            <div className="text-right">
                              <p className="text-[9px] text-white/30">Model</p>
                              <p className={`${isPrimary ? "text-xl" : "text-base"} font-bold text-white/70 tabular-nums`}>{ev.expectedCombined.toFixed(1)}</p>
                            </div>
                            {projDiffPct != null && projDiffPct !== 0 && (
                              <div className="text-right">
                                <p className="text-[9px] text-white/30">Gap</p>
                                <p className={`${isPrimary ? "text-lg" : "text-sm"} font-bold tabular-nums ${projDiffPct < 0 ? "text-red-400/80" : "text-green-400/80"}`}>
                                  {projDiffPct > 0 ? "+" : ""}{projDiffPct}%
                                </p>
                              </div>
                            )}
                          </div>
                        </PremiumGate>
                      )}
                    </div>

                    {/* Confidence + sample context */}
                    {ev && (
                      <div className="flex items-center gap-2 mt-1.5">
                        <span className={`text-[9px] font-medium ${conf.color}`}>{conf.text}</span>
                        {curve && (
                          <span className="text-[9px] text-white/20">· Based on {curve.sample_size.toLocaleString()} similar cases</span>
                        )}
                      </div>
                    )}

                    {/* Why explanation — blurred premium tease */}
                    {propExplanation && (
                      <p className="text-[9px] text-white/25 mt-1.5 pt-1 border-t border-white/5 leading-snug italic">
                        <BlurredInsight text={propExplanation} section="prop_explanation" page="props" playerName={player.player_name} statType={MARKET_LABELS[p.market]} gamesBack={player.gamesBack} />
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>

      {/* INJURY CURVE — typical performance after this injury */}
      {curve && (impG1 || impG3 || impG5) && (
        <div className="px-4 pb-2">
          <div className="rounded-lg bg-blue-500/[0.04] border border-blue-500/10 p-3">
            <p className="text-[11px] font-semibold text-blue-400/80 mb-0.5">
              Typical Performance After {player.injury_type ?? "This Injury"}
            </p>
            <p className="text-[10px] text-white/30 mb-2">
              Historical return trend for {player.injury_type?.toLowerCase() ?? "this injury"} in {LEAGUE_LABELS[player.league_slug]}
            </p>

            <div className="flex items-center gap-4">
              {/* Impact numbers — G1–G5 highlighted */}
              <div className="grid grid-cols-3 gap-3 flex-1">
                {([["G1", impG1, true], ["G3", impG3, true], ["G5", impG5, false]] as [string, { label: string; diff: number } | null, boolean][]).map(([label, imp, isEarly]) => (
                  <div key={label} className={`text-center rounded-lg py-1.5 ${isEarly ? "bg-white/[0.03]" : ""}`}>
                    <p className={`text-[9px] mb-0.5 ${isEarly ? "text-red-400/50 font-medium" : "text-white/25"}`}>{label}{isEarly ? " ⚠" : ""}</p>
                    <p className={`text-xs font-bold tabular-nums ${imp == null ? "text-white/20" : imp.diff >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {imp != null ? `${fmtDiff(imp.diff)} ${imp.label}` : "—"}
                    </p>
                  </div>
                ))}
              </div>

              {/* Mini recovery curve */}
              <div className="shrink-0">
                <RecoveryCurveMini curve={curve} leagueSlug={player.league_slug} gamesBack={player.gamesBack} />
              </div>
            </div>

            {/* Interpretation line */}
            <p className="text-[10px] text-white/30 mt-2 leading-snug">
              {impG3 && impG3.diff < 0
                ? "Performance typically lags baseline in the first few games after return — the early window (G1–G5) carries the highest uncertainty."
                : "Historical data suggests near-baseline performance for this injury type after return."
              }
            </p>

            <p className="text-[9px] text-white/20 mt-1.5">
              Based on {curve.sample_size.toLocaleString()} similar injury return cases
            </p>
          </div>
        </div>
      )}

      {/* EXPECTED ROLE (minutes context + interpretation) */}
      {(player.avg10?.minutes != null || player.avgSinceReturn?.minutes != null) && (
        <div className="px-4 pb-2">
          <div className="rounded-lg bg-white/[0.03] border border-white/5 p-3">
            <p className="text-[11px] font-semibold text-white/50 mb-2">Expected Role</p>
            <div className="flex items-center gap-4">
              {player.avg10?.minutes != null && (
                <div className="text-center">
                  <p className="text-[9px] text-white/25">Pre-injury</p>
                  <p className="text-sm font-bold text-white/70 tabular-nums">{player.avg10.minutes} min</p>
                </div>
              )}
              {player.avgSinceReturn?.minutes != null && player.gamesBack > 0 && (
                <div className="text-center">
                  <p className="text-[9px] text-white/25">Since return</p>
                  <p className="text-sm font-bold text-white/70 tabular-nums">{player.avgSinceReturn.minutes} min</p>
                </div>
              )}
              {/* Minutes bar */}
              {player.avg10?.minutes != null && player.avg10.minutes > 0 && player.avgSinceReturn?.minutes != null && player.gamesBack > 0 && (() => {
                const pct = player.avgSinceReturn!.minutes! / player.avg10!.minutes!;
                const pctRound = Math.round(pct * 100);
                return (
                  <div className="flex-1 min-w-[80px]">
                    <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${pct >= 0.8 ? "bg-cyan-400" : "bg-amber-400"}`}
                        style={{ width: `${Math.min(100, pctRound)}%` }}
                      />
                    </div>
                    <p className="text-[9px] text-white/25 mt-0.5 text-right tabular-nums">
                      {pctRound}% of usual
                    </p>
                  </div>
                );
              })()}
            </div>
            {/* Interpretation */}
            {player.avg10?.minutes != null && player.avg10.minutes > 0 && player.avgSinceReturn?.minutes != null && player.gamesBack > 0 && (() => {
              const pct = player.avgSinceReturn!.minutes! / player.avg10!.minutes!;
              if (pct < 0.7) return <p className="text-[10px] text-amber-400/50 mt-2">Still ramping up — significantly reduced minutes suggest a cautious return</p>;
              if (pct < 0.85) return <p className="text-[10px] text-amber-400/40 mt-2">Not yet at full workload — minutes still below pre-injury levels</p>;
              if (pct < 0.95) return <p className="text-[10px] text-white/30 mt-2">Approaching full workload — minutes nearly restored to pre-injury levels</p>;
              return <p className="text-[10px] text-green-400/40 mt-2">Full workload restored — playing at or above pre-injury minutes</p>;
            })()}
          </div>
        </div>
      )}

      {/* Analytics links */}
      {injurySlug && (
        <div className="flex items-center gap-3 px-4 pb-4 text-[10px]">
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
    </InjuryPlayerCard>
    </div>
  );
}

// ─── Teaser Generator ─────────────────────────────────────────────────────────

function generateTeaser(
  player: PropsPlayer,
  curve: PerformanceCurve | null,
  bestEv: EVResult | null,
  bestProp: PropItem | null,
): string {
  const parts: string[] = [];
  if (bestEv?.recommendation && bestProp) {
    const statLabel = MARKET_LABELS[bestProp.market] ?? bestProp.market;
    parts.push(`Historical trend supports ${bestEv.recommendation} on ${statLabel}`);
  }
  if (player.gamesBack > 0 && player.gamesBack <= 3) parts.push(`Early return window (G${player.gamesBack})`);
  else if (player.gamesBack > 0) parts.push(`G${player.gamesBack} return`);
  if (player.avg10?.minutes && player.avgSinceReturn?.minutes && player.avgSinceReturn.minutes / player.avg10.minutes < 0.85) {
    parts.push("minutes still below baseline");
  }
  if (curve) {
    const imp = getCurveImpact(curve, Math.min(player.gamesBack - 1, 2), player.league_slug);
    if (imp && imp.diff < -0.5) parts.push(`historical impact: ${imp.diff.toFixed(1)} ${imp.label}`);
  }
  return parts.slice(0, 3).join(" · ") || "Injury return analysis available";
}

// ─── Compact Player Row ──────────────────────────────────────────────────────

function CompactPlayerRow({
  player, curve, sourceFilter, statFilter, bestEv, bestProp, expanded, onToggle, forceFree, leagueProfile, percentile,
}: {
  player: PropsPlayer;
  curve: PerformanceCurve | null;
  sourceFilter: string;
  statFilter?: string;
  bestEv: EVResult | null;
  bestProp: PropItem | null;
  expanded: boolean;
  onToggle: () => void;
  forceFree?: boolean;
  leagueProfile?: LeagueModelProfile | null;
  percentile?: number;
}) {
  const lc = leagueColor(player.league_slug);
  const isOver = bestEv?.recommendation === "OVER";
  const edge = bestEv?.bestEv != null ? edgeLabel(bestEv.bestEv, leagueProfile, percentile) : null;
  const teaser = generateTeaser(player, curve, bestEv, bestProp);

  return (
    <div id={`prop-player-${player.player_id}`} className="scroll-mt-24">
      <div
        className={`rounded-xl border transition-all cursor-pointer ${
          expanded ? "border-white/15 bg-white/[0.04]" : "border-white/8 bg-white/[0.02] hover:bg-white/[0.04]"
        }`}
      >
        {/* Compact row header */}
        <div className="flex items-center gap-3 px-4 py-3" onClick={onToggle}>
          <PlayerAvatar src={player.headshot_url} name={player.player_name} size={36} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="text-[13px] font-semibold truncate">{player.player_name}</p>
              <GameReturnBadge gamesBack={player.gamesBack} />
              {forceFree && <span className="text-[8px] text-blue-400/50 font-bold uppercase tracking-wider bg-blue-400/10 px-1 py-0.5 rounded">Top pick</span>}
            </div>
            <div className="flex items-center gap-1.5 text-[10px] text-white/35">
              <span style={{ color: `${lc}aa` }}>{LEAGUE_LABELS[player.league_slug]}</span>
              <span>·</span>
              <span className="truncate max-w-[100px]">{player.injury_type}</span>
              <GameTimeBadge commenceTime={player.commence_time} gameDate={player.game_date} />
            </div>
          </div>

          {/* Right side: line + model signal */}
          <div className="flex items-center gap-3 shrink-0">
            {bestProp && (
              <>
                <div className="text-right">
                  <span className="text-[10px] text-white/30">{MARKET_LABELS[bestProp.market] ?? bestProp.market}</span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[9px] text-white/25">Line</span>
                    <span className="text-[13px] font-bold text-white tabular-nums">{bestProp.line}</span>
                    {!bestEv?.recommendation && (
                      <span className="text-[9px] text-white/20">No signal</span>
                    )}
                  </div>
                </div>
                {bestEv && (
                  <PremiumGate
                    contentId={`player-${player.player_id}`}
                    playerName={player.player_name}
                    section="compact_signal"
                    inline
                    placeholder={
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-bold text-white/40">OVER</span>
                        <span className="text-[10px] text-white/40 tabular-nums">24.5</span>
                        <span className="text-[10px] font-semibold text-green-400/40">+8%</span>
                      </div>
                    }
                  >
                    <div className="flex items-center gap-2">
                      {bestEv.recommendation && (
                        <span className={`text-[11px] font-bold ${isOver ? "text-green-400" : "text-red-400"}`}>
                          {bestEv.recommendation}
                        </span>
                      )}
                      <div className="text-right">
                        <span className="text-[9px] text-white/25">Model</span>
                        <p className="text-[12px] font-bold text-white/60 tabular-nums">{bestEv.expectedCombined.toFixed(1)}</p>
                      </div>
                      {edge && (
                        <span className={`text-[10px] font-semibold ${edge.color}`}>{edge.text}</span>
                      )}
                    </div>
                  </PremiumGate>
                )}
              </>
            )}
            {!bestProp && player.props.length > 0 && (
              <span className="text-[10px] text-white/25">{player.props.length} prop{player.props.length !== 1 ? "s" : ""}</span>
            )}
            <span className={`text-white/30 text-xs transition-transform ${expanded ? "rotate-180" : ""}`}>▾</span>
          </div>
        </div>

        {/* Teaser line */}
        {!expanded && teaser && (
          <div className="px-4 pb-2.5 -mt-1">
            <p className="text-[11px] text-white/35 italic">{teaser}</p>
          </div>
        )}

        {/* Expanded: PlayerBreakdownPanel */}
        {expanded && (
          <PlayerBreakdownPanel
            player={{
              player_id: player.player_id,
              player_name: player.player_name,
              player_slug: player.player_slug,
              league_slug: player.league_slug,
              injury_type: player.injury_type,
              gamesBack: player.gamesBack,
              avg10: player.avg10,
              avgSinceReturn: player.avgSinceReturn,
              props: player.props,
            }}
            curve={curve}
            sourceFilter={sourceFilter}
            statFilter={statFilter}
            onClose={onToggle}
            forceFree={forceFree}
          />
        )}
      </div>
    </div>
  );
}

// ─── Daily Opportunities Table ───────────────────────────────────────────────

function DailyOpportunitiesTable({ players, findCurve, freePlayerIds, onPlayerClick, backtestProfiles, percentileMap }: {
  players: PropsPlayer[];
  findCurve: (p: PropsPlayer) => PerformanceCurve | null;
  freePlayerIds?: Set<string>;
  onPlayerClick?: (playerId: string) => void;
  backtestProfiles?: Record<string, LeagueModelProfile>;
  percentileMap?: Map<string, number>;
}) {
  // Build rows: returning players with their best prop edge
  const rows = players
    .filter((p) => p.gamesBack > 0 && p.gamesBack <= 10)
    .map((p) => {
      const curve = findCurve(p);
      let bestEv: EVResult | null = null;
      let bestProp: PropItem | null = null;

      for (const prop of p.props) {
        const statKey = MARKET_TO_STAT[prop.market];
        const baseline = statKey && p.avg10 ? p.avg10[statKey] : null;
        const recent = statKey && p.avgSinceReturn ? p.avgSinceReturn[statKey] : null;
        if (!curve || !statKey || baseline == null || baseline <= 0 || prop.line == null || p.gamesBack < 0) continue;

        const ev = computeEV({
          baseline, propLine: prop.line,
          overOdds: parseOdds(prop.over_price), underOdds: parseOdds(prop.under_price),
          gamesSinceReturn: p.gamesBack, recentAvg: recent, curve,
          leagueSlug: p.league_slug, statKey,
          preInjuryMinutes: p.avg10?.minutes, currentMinutes: p.avgSinceReturn?.minutes,
        });

        if (ev && ev.bestEv != null && ev.recommendation && (!bestEv || (ev.bestEv > (bestEv.bestEv ?? 0)))) {
          bestEv = ev;
          bestProp = prop;
        }
      }

      return { player: p, curve, bestEv, bestProp };
    })
    .filter((r) => r.bestEv?.recommendation)
    .sort((a, b) => (b.bestEv?.bestEv ?? 0) - (a.bestEv?.bestEv ?? 0))
    .slice(0, 10);

  if (rows.length === 0) return null;

  // Strength label using percentile rank
  function gapStrength(evPct: number, leagueSlug: string, playerId: string): { text: string; color: string } {
    return edgeLabel(evPct, backtestProfiles?.[leagueSlug], percentileMap?.get(playerId));
  }

  // Contextual signal reason — insight language
  function whyTag(p: PropsPlayer, curve: PerformanceCurve | null): string {
    if (p.gamesBack <= 3) {
      if (p.avg10?.minutes && p.avgSinceReturn?.minutes && p.avgSinceReturn.minutes / p.avg10.minutes < 0.8)
        return "Minutes still below baseline";
      return "Early return suppression signal";
    }
    if (p.avg10?.minutes && p.avgSinceReturn?.minutes && p.avgSinceReturn.minutes / p.avg10.minutes < 0.8)
      return "Minutes still below baseline";
    if (curve) {
      const impG3 = getCurveImpact(curve, 2, p.league_slug);
      if (impG3 && impG3.diff < -0.3) return "Comparable cases show reduced output";
    }
    return "Historical trend supports signal";
  }

  return (
    <section className="mb-6">
      <h2 className="text-xs font-bold text-blue-400/80 uppercase tracking-widest mb-1">Biggest Return vs Market Gaps Today</h2>
      <p className="text-[11px] text-white/30 mb-3">Players where post-injury performance differs most from current lines</p>
      <div className="rounded-xl border border-white/8 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-[10px] text-white/35 uppercase tracking-wider border-b border-white/5 bg-white/[0.02]">
                <th className="px-3 py-2.5 font-medium w-8">#</th>
                <th className="px-3 py-2.5 font-medium">Player</th>
                <th className="px-3 py-2.5 font-medium">Return</th>
                <th className="px-3 py-2.5 font-medium">Stat</th>
                <th className="px-3 py-2.5 font-medium text-right">Market</th>
                <th className="px-3 py-2.5 font-medium text-right">Direction</th>
                <th className="px-3 py-2.5 font-medium text-right">Model ✦</th>
                <th className="px-3 py-2.5 font-medium">Strength</th>
                <th className="px-3 py-2.5 font-medium">Why</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ player: p, bestEv, bestProp, curve }, idx) => {
                const isOver = bestEv?.recommendation === "OVER";
                const lc = leagueColor(p.league_slug);
                const isTop3 = idx < 3;
                const strength = bestEv?.bestEv != null ? gapStrength(bestEv.bestEv, p.league_slug, p.player_id) : null;
                const gbColor = p.gamesBack <= 3
                  ? "bg-red-500/15 text-red-400/90 border-red-500/25"
                  : p.gamesBack <= 6
                  ? "bg-amber-500/15 text-amber-400/90 border-amber-500/25"
                  : "bg-green-500/15 text-green-400/90 border-green-500/25";
                const gapPct = bestEv && bestProp?.line != null && bestProp.line > 0
                  ? ((bestEv.expectedCombined - bestProp.line) / bestProp.line * 100)
                  : null;
                return (
                  <tr
                    key={p.player_id}
                    className={`border-b border-white/5 transition-colors cursor-pointer group ${
                      isTop3
                        ? "bg-blue-500/[0.04] hover:bg-blue-500/[0.08]"
                        : "hover:bg-white/[0.03]"
                    }`}
                    onClick={() => {
                      trackPlayerAnalysisView({
                        player_name: p.player_name,
                        injury_type: p.injury_type ?? "unknown",
                        games_since_return: p.gamesBack,
                        stat_type: bestProp ? (MARKET_LABELS[bestProp.market] ?? bestProp.market) : undefined,
                        edge_percent: bestEv?.bestEv ?? undefined,
                        page_origin: "props_page_table",
                      });
                      onPlayerClick?.(p.player_id);
                      setTimeout(() => {
                        const el = document.getElementById(`prop-player-${p.player_id}`);
                        el?.scrollIntoView({ behavior: "smooth", block: "center" });
                      }, 100);
                    }}
                  >
                    <td className="px-3 py-2.5">
                      <span className={`text-[11px] font-bold tabular-nums ${isTop3 ? "text-blue-400" : "text-white/25"}`}>
                        #{idx + 1}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <PlayerAvatar src={p.headshot_url} name={p.player_name} size={24} />
                        <div>
                          <p className="text-xs font-medium text-white truncate max-w-[120px] group-hover:text-blue-400 transition-colors">{p.player_name}</p>
                          <div className="flex items-center gap-1.5">
                            <span className="text-[9px]" style={{ color: `${lc}99` }}>{LEAGUE_LABELS[p.league_slug]}</span>
                            <span className="text-[9px] text-white/20">·</span>
                            <span className="text-[9px] text-white/30 truncate max-w-[80px]">{p.injury_type}</span>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded-md border text-[9px] font-semibold whitespace-nowrap ${gbColor}`}>
                        G{p.gamesBack}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-[11px] text-white/50">{bestProp ? (MARKET_LABELS[bestProp.market] ?? bestProp.market) : "—"}</td>
                    <td className="px-3 py-2.5 text-[12px] text-white/70 text-right tabular-nums font-medium">{bestProp?.line ?? "—"}</td>
                    <td className="px-3 py-2.5 text-right">
                      <span className={`text-[12px] font-bold ${isOver ? "text-green-400" : "text-red-400"}`}>
                        {bestEv!.recommendation}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {freePlayerIds?.has(p.player_id) ? (
                        <>
                          <span className="text-[12px] text-white/50 tabular-nums">{bestEv?.expectedCombined.toFixed(1) ?? "—"}</span>
                          {gapPct != null && (
                            <p className="text-[9px] text-white/25 tabular-nums">{gapPct > 0 ? "+" : ""}{gapPct.toFixed(0)}%</p>
                          )}
                        </>
                      ) : (
                        <PremiumGate
                          contentId={`player-${p.player_id}`}
                          playerName={p.player_name}
                          section="table_model"
                          placeholder={
                            <>
                              <span className="text-[12px] text-white/50 tabular-nums">24.5</span>
                              <p className="text-[9px] text-white/25 tabular-nums">+8%</p>
                            </>
                          }
                        >
                          <span className="text-[12px] text-white/50 tabular-nums">{bestEv?.expectedCombined.toFixed(1) ?? "—"}</span>
                          {gapPct != null && (
                            <p className="text-[9px] text-white/25 tabular-nums">{gapPct > 0 ? "+" : ""}{gapPct.toFixed(0)}%</p>
                          )}
                        </PremiumGate>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {strength && (
                        <span className={`text-[11px] font-semibold ${strength.color}`}>{strength.text}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="text-[9px] text-white/35 italic">{whyTag(p, curve)}</span>
                      <span className="text-[9px] text-blue-400/50 ml-1 opacity-0 group-hover:opacity-100 transition-opacity">→</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// ─── EV Info Modal ───────────────────────────────────────────────────────────

function EVInfoModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        className="relative bg-[#111827] border border-white/10 rounded-2xl max-w-lg w-full max-h-[85vh] overflow-y-auto p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button onClick={onClose} className="absolute top-4 right-4 text-white/30 hover:text-white/60 transition-colors text-lg">&#x2715;</button>

        <h2 className="text-lg font-bold text-white mb-1">How Our Signals Work</h2>
        <p className="text-xs text-white/40 mb-5">Injury-adjusted return analysis</p>

        <div className="space-y-5 text-[13px] text-white/70 leading-relaxed">
          <div>
            <p>
              Our model analyzes how players historically perform after returning
              from injury and compares that to current prop lines to identify
              where the market may be mispricing post-injury performance.
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
              <span className="text-white/90 font-medium">Signal strength</span> reflects how much the injury recovery
              data diverges from the current market line — stronger signals indicate larger historical gaps.
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
                <p className="text-[10px] text-white/40">100-500 cases</p>
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
              These signals are decision-support insights based on historical injury recovery patterns, not predictions or guarantees.
              They highlight where post-injury trends may create opportunities worth further analysis.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main PropsPage ──────────────────────────────────────────────────────────

export default function PropsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const qLeague = searchParams.get("league")?.toLowerCase();
  const qInjury = searchParams.get("injury")?.toLowerCase();
  const qPlayer = searchParams.get("player");
  const qSort = searchParams.get("sort");

  const { data: players = [], isLoading } = usePropsWithPlayers();
  const { data: curves = [], isLoading: curvesIsLoading } = usePerformanceCurves();
  const { data: backtestProfiles = {} } = useBacktestProfiles();
  const { data: mlPredictions } = useMLPredictions();

  const [leagueFilter, setLeagueFilter] = useState<string>(
    qLeague && LEAGUE_ORDER.includes(qLeague) ? qLeague : "all"
  );
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [statFilter, setStatFilter] = useState<string>("all");
  const [dateFilter, setDateFilter] = useState<"all" | "today" | "tomorrow">("all");
  const [sortMode, setSortMode] = useState<SortMode>(
    qSort && ["best", "gap", "early", "drop"].includes(qSort) ? qSort as SortMode : "best"
  );
  const [showEVInfo, setShowEVInfo] = useState(false);
  const [, setHighlightedPlayerId] = useState<string | null>(null);
  const [expandedPlayerId, setExpandedPlayerId] = useState<string | null>(null);

  // Build curve lookup: injury_type_slug|league_slug -> PerformanceCurve
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
    // Partial match
    for (const [key, curve] of curveMap) {
      const [cSlug, cLeague] = key.split("|");
      if (cLeague === p.league_slug && (cSlug.includes(slug) || slug.includes(cSlug))) return curve;
    }
    // Fallback to "Other" curve for this league
    const fallback = curveMap.get(`other|${p.league_slug}`);
    return fallback ?? null;
  };

  // Scroll to matched player and highlight
  useEffect(() => {
    if (!qPlayer || players.length === 0 || isLoading || curvesIsLoading) return;
    const q = qPlayer.toLowerCase();
    const match = players.find((p) => p.player_name.toLowerCase().includes(q));
    if (!match) return;

    setHighlightedPlayerId(match.player_id);
    setExpandedPlayerId(match.player_id);

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

      if (lastTop < 0 || Math.abs(currentTop - lastTop) > 20) {
        lastTop = currentTop;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      attempts++;
      if (attempts < 20) {
        setTimeout(() => { rafId = requestAnimationFrame(scrollToTarget); }, 150);
      }
    }

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

  // Compute local today/tomorrow for date filter
  const localTodayStr = localToday();
  const localTmrw = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 1);
  const localTomorrowStr = `${localTmrw.getFullYear()}-${String(localTmrw.getMonth() + 1).padStart(2, "0")}-${String(localTmrw.getDate()).padStart(2, "0")}`;

  // Which dates actually have props?
  const datesWithProps = useMemo(() => {
    const dates = new Set(players.flatMap((p) => p.props.map((pr) => pr.game_date).filter(Boolean)));
    return { today: dates.has(localTodayStr), tomorrow: dates.has(localTomorrowStr) };
  }, [players, localTodayStr, localTomorrowStr]);

  // Helper: filter a player's props by current source/stat/date filters
  // When source is "all", deduplicate by market+game_date, preferring consensus > fanduel > other
  const filterProps = useCallback((props: PropItem[]): PropItem[] => {
    let out = sourceFilter === "all" ? props : props.filter((p) => p.source === sourceFilter);
    if (statFilter && statFilter !== "all") {
      const sf = STAT_FILTERS.find((f) => f.value === statFilter);
      if (sf && sf.markets.length > 0) out = out.filter((p) => sf.markets.includes(p.market));
    }
    if (dateFilter === "today") out = out.filter((p) => p.game_date === localTodayStr);
    else if (dateFilter === "tomorrow") out = out.filter((p) => p.game_date === localTomorrowStr);
    // Deduplicate: keep best source per market+game_date
    if (sourceFilter === "all") {
      const sourcePriority: Record<string, number> = { consensus: 0, fanduel: 1, draftkings: 2, betmgm: 3 };
      const best = new Map<string, PropItem>();
      for (const p of out) {
        const key = `${p.market}|${p.game_date}`;
        const existing = best.get(key);
        if (!existing || (sourcePriority[p.source ?? ""] ?? 99) < (sourcePriority[existing.source ?? ""] ?? 99)) {
          best.set(key, p);
        }
      }
      out = Array.from(best.values());
    }
    return out;
  }, [sourceFilter, statFilter, dateFilter, localTodayStr, localTomorrowStr]);

  const filtered = useMemo(() => {
    let list = leagueFilter === "all"
      ? players
      : players.filter((p) => p.league_slug === leagueFilter);
    // Hide players with zero props matching filters, where all lines are null,
    // or whose only props come from minor/unreliable sources
    const majorSources = new Set(["consensus", "fanduel", "draftkings", "betmgm", "pointsbet"]);
    list = list.filter((p) => {
      const fp = filterProps(p.props);
      if (fp.length === 0 || !fp.some((pr) => pr.line != null)) return false;
      // If source filter is "all", require at least one prop from a major source
      if (sourceFilter === "all" && !fp.some((pr) => majorSources.has(pr.source))) return false;
      return true;
    });
    if (qInjury) {
      list = [...list].sort((a, b) => {
        const aMatch = a.injury_type && injuryToSlug(a.injury_type).includes(qInjury) ? 1 : 0;
        const bMatch = b.injury_type && injuryToSlug(b.injury_type).includes(qInjury) ? 1 : 0;
        return bMatch - aMatch;
      });
    }
    if (qPlayer) {
      const q = qPlayer.toLowerCase();
      list = [...list].sort((a, b) => {
        const aMatch = a.player_name.toLowerCase().includes(q) ? 1 : 0;
        const bMatch = b.player_name.toLowerCase().includes(q) ? 1 : 0;
        return bMatch - aMatch;
      });
    }
    return list;
  }, [players, leagueFilter, qInjury, qPlayer, filterProps]);

  // Get unique leagues that have props today
  const activeLeagues = Array.from(new Set(players.map((p) => p.league_slug))).filter(Boolean);
  const orderedLeagues = LEAGUE_ORDER.filter((l) => activeLeagues.includes(l));

  // Get unique sources
  const activeSources = Array.from(new Set(players.flatMap((p) => p.props.map((pr) => pr.source)))).filter(Boolean);

  // Fall back: consensus → fanduel → all
  useEffect(() => {
    if (sourceFilter !== "all" && players.length > 0 && !players.some((p) => p.props.some((pr) => pr.source === sourceFilter))) {
      if (sourceFilter === "consensus" && players.some((p) => p.props.some((pr) => pr.source === "fanduel"))) {
        setSourceFilter("fanduel");
      } else {
        setSourceFilter("all");
      }
    }
  }, [players, sourceFilter]);

  // Helper: get best EV for a player (respecting source/stat filters)
  function getBestEv(p: PropsPlayer): number {
    let best = 0;
    const curve = findCurve(p);
    if (!curve || p.gamesBack < 0) return 0;
    for (const prop of filterProps(p.props)) {
      const statKey = MARKET_TO_STAT[prop.market];
      const baseline = statKey && p.avg10 ? p.avg10[statKey] : null;
      const recent = statKey && p.avgSinceReturn ? p.avgSinceReturn[statKey] : null;
      if (!statKey || baseline == null || baseline <= 0 || prop.line == null) continue;
      const ev = computeEV({
        baseline, propLine: prop.line,
        overOdds: parseOdds(prop.over_price), underOdds: parseOdds(prop.under_price),
        gamesSinceReturn: p.gamesBack, recentAvg: recent, curve,
        leagueSlug: p.league_slug, statKey,
        preInjuryMinutes: p.avg10?.minutes, currentMinutes: p.avgSinceReturn?.minutes,
      });
      if (ev?.bestEv != null && ev.bestEv > best) best = ev.bestEv;
    }
    return best;
  }

  // Apply sort to a list of players
  function applySortMode(list: PropsPlayer[]): PropsPlayer[] {
    const sorted = [...list];
    if (sortMode === "best") {
      sorted.sort((a, b) => getBestEv(b) - getBestEv(a));
    } else if (sortMode === "early") {
      sorted.sort((a, b) => a.gamesBack - b.gamesBack);
    } else if (sortMode === "gap") {
      sorted.sort((a, b) => getMaxGap(b) - getMaxGap(a));
    } else if (sortMode === "drop") {
      sorted.sort((a, b) => {
        const cA = findCurve(a);
        const cB = findCurve(b);
        const dropA = cA ? getCurveImpact(cA, 0, a.league_slug)?.diff ?? 0 : 0;
        const dropB = cB ? getCurveImpact(cB, 0, b.league_slug)?.diff ?? 0 : 0;
        return dropA - dropB;
      });
    }
    return sorted;
  }

  // Split: recently returned (10 games or fewer since injury) vs rest
  const recentlyReturned = useMemo(() => {
    const list = filtered.filter(
      (p) => p.injury_date && p.gamesBack >= 0 && p.gamesBack <= 10
    );
    return applySortMode(list);
  }, [filtered, sortMode, curveMap, sourceFilter, statFilter]);

  // Get active stat markets for filter pills
  // Only show stat filters for markets that exist on recently returned players
  const activeMarkets = new Set(recentlyReturned.flatMap((p) => p.props.map((pr) => pr.market)));
  const activeStatFilters = STAT_FILTERS.filter(
    (f) => f.value === "all" || f.markets.some((m) => activeMarkets.has(m))
  );

  // Players without injury data are excluded — page only shows post-injury signals

  // Compute max gap between any prop line and return avg (respecting filters)
  function getMaxGap(p: PropsPlayer): number {
    let maxGap = 0;
    for (const prop of filterProps(p.props)) {
      if (prop.line == null) continue;
      const statKey = MARKET_TO_STAT[prop.market];
      const returnVal = statKey && p.avgSinceReturn ? p.avgSinceReturn[statKey] : null;
      if (returnVal != null) maxGap = Math.max(maxGap, Math.abs(returnVal - prop.line));
    }
    return maxGap;
  }

  // Top edges for highlight cards (respects source/stat filters)
  const topEdges = useMemo(() => {
    return recentlyReturned
      .filter((p) => findCurve(p) != null)
      .map((p) => {
        const curve = findCurve(p)!;
        let bestEv: EVResult | null = null;
        let bestProp: PropItem | null = null;

        for (const prop of filterProps(p.props)) {
          const statKey = MARKET_TO_STAT[prop.market];
          const baseline = statKey && p.avg10 ? p.avg10[statKey] : null;
          const recent = statKey && p.avgSinceReturn ? p.avgSinceReturn[statKey] : null;
          if (!statKey || baseline == null || baseline <= 0 || prop.line == null || p.gamesBack < 0) continue;

          const ev = computeEV({
            baseline, propLine: prop.line,
            overOdds: parseOdds(prop.over_price), underOdds: parseOdds(prop.under_price),
            gamesSinceReturn: p.gamesBack, recentAvg: recent, curve,
            leagueSlug: p.league_slug, statKey,
            preInjuryMinutes: p.avg10?.minutes, currentMinutes: p.avgSinceReturn?.minutes,
          });

          if (ev && ev.bestEv != null && ev.recommendation && (!bestEv || ev.bestEv > (bestEv.bestEv ?? 0))) {
            bestEv = ev;
            bestProp = prop;
          }
        }

        return { player: p, ev: bestEv, prop: bestProp, evVal: bestEv?.bestEv != null && bestEv.bestEv > 0 ? bestEv.bestEv : 0 };
      })
      .filter((e) => e.ev?.recommendation && e.evVal > 0)
      .sort((a, b) => b.evVal - a.evVal)
      .slice(0, 4);
  }, [recentlyReturned, curveMap, filterProps]);

  const topEdgePlayerIds = useMemo(() => new Set(topEdges.map((e) => e.player.player_id)), [topEdges]);

  // Percentile map: player_id -> percentile (0-1) for signal strength labels
  const percentileMap = useMemo(() => computePercentiles(players, findCurve), [players, curveMap]);

  // STEP 6: Daily hook counts
  const returningToday = recentlyReturned.filter((p) => p.gamesBack <= 1).length;
  const earlyReturn = recentlyReturned.filter((p) => p.gamesBack <= 3).length;

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white">
      <SEO
        title="Player Props Today - Injury Return Analysis | Back In Play"
        description="Today's player prop lines analyzed through injury return data. Historical performance trends, return context, and market comparison for returning players."
        path="/props"
      />
      <SiteHeader />

      <EVInfoModal open={showEVInfo} onClose={() => setShowEVInfo(false)} />

      <div className="max-w-3xl lg:max-w-[1400px] mx-auto px-4 lg:px-10 py-6">
        {/* STEP 6: Daily hook banner */}
        {(returningToday > 0 || earlyReturn > 0) && !isLoading && (
          <div className="rounded-xl bg-gradient-to-r from-blue-500/10 to-purple-500/10 border border-blue-500/20 px-4 py-3 mb-5">
            <p className="text-sm font-semibold text-white/90">Injury Return Monitor</p>
            <div className="flex items-center gap-4 mt-1 text-[12px] text-white/50">
              {returningToday > 0 && (
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                  {returningToday} player{returningToday !== 1 ? "s" : ""} returning today
                </span>
              )}
              {earlyReturn > 0 && (
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-red-400/80" />
                  <span className="font-medium text-red-400/80">{earlyReturn} in first 3 games</span>
                  <span className="text-white/30">— historically highest impact window</span>
                </span>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-[26px] font-bold">Player Props</h1>
          <button
            onClick={() => setShowEVInfo(true)}
            className="shrink-0 w-6 h-6 rounded-full border border-white/15 text-white/35 hover:text-white/70 hover:border-white/30 transition-colors text-xs font-semibold flex items-center justify-center"
            title="How the EV model works"
          >
            ?
          </button>
        </div>
        <p className="text-[14px] text-white/50 mb-5 leading-relaxed">
          Injury return analytics: model projections vs. market lines based on historical recovery data.
          Identify where the market may still reflect injury uncertainty.
        </p>

        {/* Date filter toggle */}
        {players.length > 0 && (
          <div className="flex gap-1.5 mb-4">
            <button
              onClick={() => setDateFilter("all")}
              className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${
                dateFilter === "all" ? "bg-white/12 text-white" : "bg-white/5 text-white/35 hover:text-white/55"
              }`}
            >
              All games
            </button>
            {datesWithProps.today && (
              <button
                onClick={() => setDateFilter("today")}
                className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${
                  dateFilter === "today" ? "bg-white/12 text-white" : "bg-white/5 text-white/35 hover:text-white/55"
                }`}
              >
                Today
              </button>
            )}
            <button
              onClick={() => setDateFilter("tomorrow")}
              className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${
                dateFilter === "tomorrow" ? "bg-white/12 text-white" : "bg-white/5 text-white/35 hover:text-white/55"
              }`}
            >
              Tomorrow {!datesWithProps.tomorrow && <span className="text-white/20 ml-1">(no odds yet)</span>}
            </button>
          </div>
        )}

        {/* STEP 5: League filters */}
        <div className="flex gap-1.5 mb-3 overflow-x-auto pb-1">
          <button
            onClick={() => setLeagueFilter("all")}
            className={`px-3 py-1.5 rounded-full text-[13px] font-medium transition-colors shrink-0 ${
              leagueFilter === "all" ? "bg-white/15 text-white" : "bg-white/5 text-white/40 hover:text-white/60"
            }`}
          >
            All ({players.filter((p) => p.injury_date && p.gamesBack >= 0 && p.gamesBack <= 10).length})
          </button>
          {orderedLeagues.map((slug) => {
            const count = players.filter((p) => p.league_slug === slug && p.injury_date && p.gamesBack >= 0 && p.gamesBack <= 10).length;
            if (count === 0) return null;
            return (
              <button
                key={slug}
                onClick={() => { setLeagueFilter(slug); trackLeagueFilter(slug, "props"); }}
                className={`px-3 py-1.5 rounded-full text-[13px] font-medium transition-colors shrink-0 ${
                  leagueFilter === slug ? "bg-white/15 text-white" : "bg-white/5 text-white/40 hover:text-white/60"
                }`}
              >
                {LEAGUE_LABELS[slug]} ({count})
              </button>
            );
          })}
        </div>

        {/* STEP 5: Stat filters */}
        {activeStatFilters.length > 2 && (
          <div className="flex gap-1 mb-3 overflow-x-auto pb-1">
            {activeStatFilters.map((f) => (
              <button
                key={f.value}
                onClick={() => setStatFilter(f.value)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors shrink-0 ${
                  statFilter === f.value
                    ? "bg-emerald-500/20 text-emerald-400"
                    : "bg-white/5 text-white/35 hover:text-white/55"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}

        {/* Source label */}
        <p className="text-[10px] text-white/20 mb-3">Odds via FanDuel, DraftKings, BetMGM & more</p>


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
            {/* STEP 1: Top signal cards — analytics-first design */}
            {topEdges.length > 0 && (
              <section className="mb-6">
                <h2 className="text-xs font-bold text-[#1C7CFF]/80 uppercase tracking-widest mb-3">Strongest Return Signals</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {topEdges.map(({ player: p, ev: topEv, prop: topProp }) => {
                    const lc = leagueColor(p.league_slug);
                    const side = topEv!.recommendation!;
                    const isOver = side === "OVER";
                    const curve = findCurve(p);
                    const impG3 = curve ? getCurveImpact(curve, 2, p.league_slug) : null;
                    const edge = edgeLabel(topEv!.bestEv!, backtestProfiles[p.league_slug], percentileMap.get(p.player_id));
                    const statKey = MARKET_TO_STAT[topProp?.market ?? ""];
                    const preVal = statKey && p.avg10 ? (p.avg10 as Record<string, number | undefined>)[statKey.replace("stat_", "")] ?? null : null;
                    const returnVal = statKey && p.avgSinceReturn ? (p.avgSinceReturn as Record<string, number | undefined>)[statKey.replace("stat_", "")] ?? null : null;
                    const propExplanation = topProp ? generatePropExplanation(
                      topProp.market, topProp.line, preVal, returnVal, p.gamesBack, impG3?.diff ?? null
                    ) : null;
                    const modelDiffPct = topProp && topProp.line && topEv!.expectedCombined > 0
                      ? ((topEv!.expectedCombined - topProp.line) / topProp.line * 100)
                      : null;
                    return (
                      <div
                        key={p.player_id}
                        className={`relative rounded-xl border p-4 transition-all overflow-hidden cursor-pointer ${
                          isOver
                            ? "bg-green-500/[0.06] border-green-500/20 hover:border-green-500/40"
                            : "bg-red-500/[0.06] border-red-500/20 hover:border-red-500/40"
                        }`}
                        onClick={() => {
                          trackPlayerAnalysisView({
                            player_name: p.player_name,
                            injury_type: p.injury_type ?? "unknown",
                            games_since_return: p.gamesBack,
                            stat_type: topProp ? (MARKET_LABELS[topProp.market] ?? topProp.market) : undefined,
                            edge_percent: topEv?.bestEv ?? undefined,
                            page_origin: "props_page",
                          });
                          setExpandedPlayerId(p.player_id);
                          setTimeout(() => {
                            const el = document.getElementById(`prop-player-${p.player_id}`);
                            el?.scrollIntoView({ behavior: "smooth", block: "center" });
                          }, 100);
                        }}
                      >
                        {/* Player Header + Game Return Badge */}
                        <div className="flex items-center gap-3 mb-2">
                          <PlayerAvatar src={p.headshot_url} name={p.player_name} size={40} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-semibold truncate">{p.player_name}</p>
                              <GameReturnBadge gamesBack={p.gamesBack} />
                            </div>
                            <div className="flex items-center gap-1.5 text-[10px] text-white/35">
                              <span style={{ color: `${lc}aa` }}>{LEAGUE_LABELS[p.league_slug]}</span>
                              <span>·</span>
                              <span>{p.injury_type}</span>
                              <GameTimeBadge commenceTime={p.commence_time} gameDate={p.game_date} />
                            </div>
                          </div>
                        </div>

                        {/* Signal box — market vs model comparison */}
                        {topProp && (
                          <div className={`rounded-lg px-3 py-2.5 mb-2 ${isOver ? "bg-green-500/10" : "bg-red-500/10"}`}>
                            <div className="flex items-center justify-between mb-1.5">
                              <p className="text-[10px] text-white/40">{MARKET_LABELS[topProp.market] ?? topProp.market}</p>
                              <span className={`text-[11px] font-semibold ${edge.color}`}>{edge.text}</span>
                            </div>
                            <div className="flex items-center justify-between">
                              <div className="flex items-baseline gap-4">
                                <div>
                                  <p className="text-[9px] text-white/30">Market</p>
                                  <p className="text-lg font-bold text-white tabular-nums">{topProp.line}</p>
                                </div>
                                <div>
                                  <p className="text-[9px] text-white/30">Model</p>
                                  <p className="text-lg font-bold text-white/60 tabular-nums">{topEv!.expectedCombined.toFixed(1)}</p>
                                </div>
                              </div>
                              <div className="text-right">
                                <p className={`text-xs font-bold ${isOver ? "text-green-400/80" : "text-red-400/80"}`}>
                                  {side}
                                </p>
                                {modelDiffPct != null && (
                                  <p className="text-[10px] text-white/45 mt-0.5">
                                    Model {modelDiffPct > 0 ? "+" : ""}{modelDiffPct.toFixed(1)}% vs market
                                  </p>
                                )}
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Why this signal — contextual insight */}
                        {propExplanation && (
                          <p className="text-[10px] text-white/40 italic mb-2 leading-snug">{propExplanation}</p>
                        )}

                        {/* Metadata row — signal-based language, no raw probabilities */}
                        <div className="flex items-center gap-3 text-[10px] text-white/35">
                          <span className={`font-medium ${topEv!.confidence === "High" ? "text-green-400/70" : topEv!.confidence === "Medium" ? "text-amber-400/70" : "text-white/40"}`}>
                            {topEv!.confidence} confidence
                          </span>
                          {impG3 && impG3.diff < 0 && (
                            <>
                              <span className="text-white/20">|</span>
                              <span className="text-red-400/60">Historical impact: {impG3.diff.toFixed(1)} {impG3.label}</span>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Premium unlock counter */}
            <div className="flex items-center justify-between mb-3">
              <PremiumUnlockCounter />
              <span className="text-[9px] text-white/15">Free during beta</span>
            </div>

            {/* STEP 2: Daily Opportunities Table */}
            <DailyOpportunitiesTable
              players={filtered}
              findCurve={findCurve}
              freePlayerIds={topEdgePlayerIds}
              onPlayerClick={(pid) => {
                setExpandedPlayerId(pid);
              }}
              backtestProfiles={backtestProfiles}
              percentileMap={percentileMap}
            />

            {/* Recently Returned from Injury */}
            {recentlyReturned.length > 0 && (
              <section className="mb-8">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <h2 className="text-xs font-bold text-[#3DFF8F]/80 uppercase tracking-widest">Recently Returned</h2>
                    <span className="text-[10px] text-white/30">{recentlyReturned.length} players</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-white/25 shrink-0">Sort</span>
                    {SORT_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => setSortMode(opt.value)}
                        className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                          sortMode === opt.value
                            ? "bg-white/12 text-white"
                            : "bg-white/5 text-white/30 hover:text-white/50"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  {recentlyReturned.map((p) => {
                    const curve = findCurve(p);
                    // Get best EV for this player — prefer ML model prediction, fall back to heuristic
                    let bestEv: EVResult | null = null;
                    let bestProp: PropItem | null = null;

                    // 1. Try ML model predictions first
                    if (mlPredictions && mlPredictions.size > 0) {
                      for (const prop of filterProps(p.props)) {
                        const mlKey = `${p.player_name}|${prop.market}|${prop.game_date}`;
                        const ml = mlPredictions.get(mlKey);
                        if (ml && ml.recommendation) {
                          // Convert ML prediction to EVResult format
                          const mlEv: EVResult = {
                            recommendation: ml.recommendation,
                            bestEv: ml.ev / 100,
                            expectedCombined: ml.baseline * (ml.recent_avg && ml.baseline > 0 ? ml.recent_avg / ml.baseline : 1),
                            confidence: ml.ev >= 20 ? "High" : ml.ev >= 10 ? "Medium" : "Low",
                          } as EVResult;
                          if (!bestEv || ml.ev > (bestEv.bestEv ?? 0) * 100) {
                            bestEv = mlEv;
                            bestProp = prop;
                          }
                        }
                      }
                    }

                    // 2. Fall back to heuristic EV if no ML prediction
                    if (!bestEv) {
                      for (const prop of filterProps(p.props)) {
                        const statKey = MARKET_TO_STAT[prop.market];
                        const baseline = statKey && p.avg10 ? p.avg10[statKey] : null;
                        const recent = statKey && p.avgSinceReturn ? p.avgSinceReturn[statKey] : null;
                        if (!curve || !statKey || baseline == null || baseline <= 0 || prop.line == null || p.gamesBack < 0) continue;
                        const ev = computeEV({
                          baseline, propLine: prop.line,
                          overOdds: parseOdds(prop.over_price), underOdds: parseOdds(prop.under_price),
                          gamesSinceReturn: p.gamesBack, recentAvg: recent, curve,
                          leagueSlug: p.league_slug, statKey,
                          preInjuryMinutes: p.avg10?.minutes, currentMinutes: p.avgSinceReturn?.minutes,
                        });
                        if (ev && ev.bestEv != null && ev.recommendation && (!bestEv || ev.bestEv > (bestEv.bestEv ?? 0))) {
                          bestEv = ev;
                          bestProp = prop;
                        }
                      }
                    }

                    // Fallback: show the first filtered prop even without EV signal
                    const filteredPlayerProps = filterProps(p.props);
                    if (!bestProp && filteredPlayerProps.length > 0) {
                      bestProp = filteredPlayerProps[0];
                    }
                    // Ultimate fallback: show any prop if filters excluded everything
                    if (!bestProp && p.props.length > 0) {
                      bestProp = p.props[0];
                    }
                    return (
                      <CompactPlayerRow
                        key={p.player_id}
                        player={p}
                        curve={curve}
                        sourceFilter={sourceFilter}
                        statFilter={statFilter}
                        bestEv={bestEv}
                        bestProp={bestProp}
                        expanded={expandedPlayerId === p.player_id}
                        onToggle={() => setExpandedPlayerId(expandedPlayerId === p.player_id ? null : p.player_id)}
                        forceFree={topEdgePlayerIds.has(p.player_id)}
                        leagueProfile={backtestProfiles[p.league_slug]}
                        percentile={percentileMap.get(p.player_id)}
                      />
                    );
                  })}
                </div>
              </section>
            )}

            {/* Empty state when players have props but none are within 10 games of return */}
            {recentlyReturned.length === 0 && filtered.length > 0 && (
              <div className="text-center py-10 border border-white/5 rounded-xl bg-white/[0.02]">
                <p className="text-white/40 text-sm mb-1">No recently returned players with props today</p>
                <p className="text-white/25 text-xs">
                  {filtered.length} player{filtered.length !== 1 ? "s" : ""} have props but {filtered.length === 1 ? "is" : "are"} past the 10-game return window where the model has edge.
                </p>
              </div>
            )}
            {/* Early access CTA */}
            <EarlyAccessCTA className="mt-6 border-t border-white/5" page="props" location="page_footer" />
          </>
        )}
      </div>
    </div>
  );
}
