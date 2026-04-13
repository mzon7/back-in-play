import { useState, useMemo, useEffect } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { useQuery } from "@tanstack/react-query";
import { SiteHeader } from "../components/SiteHeader";
import { supabase } from "../lib/supabase";
import { usePerformanceCurves } from "../features/performance-curves/lib/queries";
import { computeEV, formatEV, parseOdds, oddsToProfit, type EVResult } from "../lib/evModel";
import type { PerformanceCurve } from "../features/performance-curves/lib/types";
import { EdgeValidation } from "../components/EdgeValidation";
import { ModelFilters } from "../components/ModelFilters";
import { ModelTable } from "../components/ModelTable";
import { computePEdge, computeStability } from "../lib/modelAnalysisUtils";
import type { MarketSummary, BacktestSummary, StatRow, OddsMode } from "../lib/modelAnalysisTypes";

const MODEL_ANALYSIS_PASSWORD = "purplecobras";

const MARKET_TO_STAT: Record<string, string> = {
  player_points: "stat_pts", player_rebounds: "stat_reb", player_assists: "stat_ast",
  player_pass_yds: "stat_pass_yds", player_rush_yds: "stat_rush_yds",
  player_reception_yds: "stat_rec_yds", player_receptions: "stat_rec",
  player_goals: "stat_goals", player_shots_on_goal: "stat_sog",
  player_shots: "stat_sog", player_shots_on_target: "stat_sog",
  batter_hits: "stat_h", batter_total_bases: "stat_stl", batter_rbis: "stat_rbi",
};

const MARKET_LABELS: Record<string, string> = {
  player_points: "Points", player_rebounds: "Rebounds", player_assists: "Assists",
  player_pass_yds: "Pass Yds", player_rush_yds: "Rush Yds",
  player_reception_yds: "Rec Yds", player_receptions: "Receptions",
  player_goals: "Goals", player_shots_on_goal: "SOG",
  batter_hits: "Hits", batter_rbis: "RBIs",
};

function arrMedian(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

interface SettledProp {
  propId: string;
  playerName: string;
  market: string;
  line: number;
  overPrice: string | null;
  underPrice: string | null;
  gameDate: string;
  leagueSlug: string;
  injuryType: string;
  gamesBack: number;
  actualValue: number;
  actualResult: "OVER" | "UNDER" | "PUSH";
  ev: EVResult;
  modelCorrect: boolean;
  betProfit: number; // profit/loss on 1-unit bet following model
}

/** Compute minutes-weighted baseline from game logs */
function computeBaseline(games: any[], statKey: string): { stat: number; minutes: number } | null {
  const withMin = games.filter((g: any) => g.minutes != null && g.minutes > 0);
  if (withMin.length === 0) return null;
  const typicalMin = arrMedian(withMin.map((g: any) => g.minutes));
  const threshold = typicalMin * 0.25;
  const real = withMin.filter((g: any) => g.minutes >= threshold).slice(0, 10);
  if (real.length === 0) return null;
  const rates: number[] = [];
  const mins: number[] = [];
  for (const g of real) {
    if (g[statKey] != null) {
      rates.push(g[statKey] / g.minutes);
      mins.push(g.minutes);
    }
  }
  if (rates.length === 0) return null;
  const medRate = arrMedian(rates);
  const medMin = arrMedian(mins);
  return { stat: medRate * medMin, minutes: medMin };
}

function useModelAnalysis() {
  const { data: curves } = usePerformanceCurves();

  return useQuery<SettledProp[]>({
    queryKey: ["model-analysis"],
    enabled: (curves ?? []).length > 0,
    queryFn: async () => {
      const today = new Date().toISOString().slice(0, 10);

      // Fetch ALL historical props (before today) — paginate to get everything
      let allProps: any[] = [];
      let offset = 0;
      const PAGE = 1000;
      while (true) {
        const { data: batch } = await supabase
          .from("back_in_play_player_props")
          .select("id, player_id, player_name, market, line, over_price, under_price, game_date, source")
          .lt("game_date", today)
          .order("game_date", { ascending: false })
          .range(offset, offset + PAGE - 1);
        if (!batch || batch.length === 0) break;
        allProps = allProps.concat(batch);
        if (batch.length < PAGE) break;
        offset += PAGE;
      }
      const props = allProps;

      if (!props || props.length === 0) return [];

      // Deduplicate: keep one prop per player+market+game_date (first source)
      const seen = new Set<string>();
      const dedupedProps = props.filter((p: any) => {
        const key = `${p.player_id}|${p.market}|${p.game_date}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const playerIds = [...new Set(dedupedProps.map((p: any) => p.player_id).filter(Boolean))];

      // 2. Fetch players with league info
      const { data: players } = await supabase
        .from("back_in_play_players")
        .select("player_id, player_name, league:back_in_play_leagues!back_in_play_players_league_id_fkey(slug)")
        .in("player_id", playerIds.slice(0, 500));

      const playerLeague = new Map<string, string>();
      for (const p of players ?? []) {
        playerLeague.set(p.player_id, (p as any).league?.slug ?? "");
      }

      // 3. Fetch injuries for these players
      const { data: injuries } = await supabase
        .from("back_in_play_injuries")
        .select("player_id, injury_type, date_injured, status")
        .in("player_id", playerIds.slice(0, 500))
        .order("date_injured", { ascending: false });

      const injuryMap = new Map<string, any>();
      for (const inj of injuries ?? []) {
        if (!injuryMap.has(inj.player_id)) injuryMap.set(inj.player_id, inj);
      }

      // 4. Fetch game logs (chunked)
      const CHUNK = 20;
      const logChunks = await Promise.all(
        Array.from({ length: Math.ceil(playerIds.length / CHUNK) }, (_, i) =>
          supabase
            .from("back_in_play_player_game_logs")
            .select("player_id, game_date, minutes, stat_pts, stat_reb, stat_ast, stat_stl, stat_blk, stat_sog, stat_rush_yds, stat_pass_yds, stat_rec, stat_rec_yds, stat_goals, stat_h, stat_rbi")
            .in("player_id", playerIds.slice(i * CHUNK, (i + 1) * CHUNK))
            .gte("game_date", "2024-01-01")
            .order("game_date", { ascending: false })
            .limit(1000)
        )
      );
      const gameLogMap = new Map<string, any[]>();
      for (const chunk of logChunks) {
        for (const g of chunk.data ?? []) {
          const arr = gameLogMap.get(g.player_id) ?? [];
          arr.push(g);
          gameLogMap.set(g.player_id, arr);
        }
      }

      // 5. Build curve lookup
      const curveMap = new Map<string, PerformanceCurve>();
      for (const c of curves ?? []) {
        curveMap.set(`${c.injury_type_slug}|${c.league_slug}`, c);
      }

      // 6. Settle each prop
      const results: SettledProp[] = [];

      for (const prop of dedupedProps) {
        const pid = prop.player_id;
        if (!pid) continue;
        const statKey = MARKET_TO_STAT[prop.market];
        if (!statKey) continue;

        const leagueSlug = playerLeague.get(pid) ?? "";
        const injury = injuryMap.get(pid);
        if (!injury?.injury_type || !injury?.date_injured) continue;

        const injurySlug = injury.injury_type.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        const curve = curveMap.get(`${injurySlug}|${leagueSlug}`);
        if (!curve) continue;

        const allGames = gameLogMap.get(pid) ?? [];

        // Find actual game on prop date (allow ±1 day for timezone)
        const propDate = prop.game_date;
        const gameOnDate = allGames.find((g: any) =>
          g.game_date === propDate ||
          g.game_date === new Date(new Date(propDate).getTime() + 86400000).toISOString().slice(0, 10) ||
          g.game_date === new Date(new Date(propDate).getTime() - 86400000).toISOString().slice(0, 10)
        );
        if (!gameOnDate || gameOnDate[statKey] == null) continue;

        const actualValue = gameOnDate[statKey];
        const actualResult: "OVER" | "UNDER" | "PUSH" =
          actualValue > prop.line ? "OVER" : actualValue < prop.line ? "UNDER" : "PUSH";

        // Compute pre-injury baseline
        const preGames = allGames
          .filter((g: any) => g.game_date < injury.date_injured)
          .sort((a: any, b: any) => b.game_date.localeCompare(a.game_date));
        const baseline = computeBaseline(preGames, statKey);
        if (!baseline || baseline.stat <= 0) continue;

        // Count games back at time of this prop
        const postGames = allGames
          .filter((g: any) => g.game_date > injury.date_injured && g.game_date <= propDate)
          .sort((a: any, b: any) => b.game_date.localeCompare(a.game_date));
        const gamesBack = postGames.length;
        if (gamesBack === 0) continue; // not a returning player prop

        const recentBaseline = computeBaseline(postGames, statKey);

        const ev = computeEV({
          baseline: baseline.stat,
          propLine: prop.line,
          overOdds: parseOdds(prop.over_price),
          underOdds: parseOdds(prop.under_price),
          gamesSinceReturn: gamesBack,
          recentAvg: recentBaseline?.stat ?? null,
          curve,
          leagueSlug,
          statKey,
          preInjuryMinutes: baseline.minutes,
          currentMinutes: recentBaseline?.minutes ?? null,
        });
        if (!ev || !ev.recommendation) continue;

        // Model correct if recommendation matches actual result
        const modelCorrect = actualResult === "PUSH" ? true : ev.recommendation === actualResult;

        // Profit calculation: bet 1 unit on model's recommended side
        let betProfit = 0;
        if (actualResult === "PUSH") {
          betProfit = 0;
        } else if (ev.recommendation === "OVER") {
          const odds = parseOdds(prop.over_price);
          betProfit = actualResult === "OVER" && odds != null ? oddsToProfit(odds) : -1;
        } else {
          const odds = parseOdds(prop.under_price);
          betProfit = actualResult === "UNDER" && odds != null ? oddsToProfit(odds) : -1;
        }

        results.push({
          propId: prop.id,
          playerName: prop.player_name,
          market: prop.market,
          line: prop.line,
          overPrice: prop.over_price,
          underPrice: prop.under_price,
          gameDate: prop.game_date,
          leagueSlug,
          injuryType: injury.injury_type,
          gamesBack,
          actualValue,
          actualResult,
          ev,
          modelCorrect,
          betProfit,
        });
      }

      return results.sort((a, b) => b.gameDate.localeCompare(a.gameDate));
    },
    staleTime: 5 * 60 * 1000,
  });
}

function StatsCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-white/5 rounded-xl p-4 text-center">
      <p className="text-[11px] text-white/40 mb-1">{label}</p>
      <p className={`text-2xl font-black tabular-nums ${color ?? "text-white"}`}>{value}</p>
      {sub && <p className="text-[10px] text-white/30 mt-0.5">{sub}</p>}
    </div>
  );
}

interface BacktestBet {
  player: string;
  date: string;
  market: string;
  line: number;
  ev: number; // percentage
  rec: "OVER" | "UNDER";
  actual: number;
  correct: boolean;
  pnl: number;
  gn: number; // game number (1-10)
  conf: "High" | "Medium" | "Low";
  injury: string;
  league?: string;
  open_pnl?: number | null;
  close_pnl?: number | null;
  scrape_pnl?: number | null;
  open_line?: number | null;
  close_line?: number | null;
  open_correct?: boolean | null;
  close_correct?: boolean | null;
  scrape_correct?: boolean | null;
  season?: string; // e.g. "2023-24", "2024-25"
  kelly_f?: number;
  p_over?: number;
}

// OddsMode imported from modelAnalysisTypes

/** Get the PnL for a bet based on the selected odds mode.
 * Models C/D: correct/pnl = open, scrape_pnl = scrape, close_pnl = close
 * Older models: correct/pnl = scrape, open_pnl = open, close_pnl = close */
function betPnl(b: BacktestBet, mode: OddsMode): number {
  if (mode === "open") {
    if (b.open_pnl != null) return b.open_pnl;
    // For Models C/D, correct/pnl IS already at open
    if (b.scrape_pnl != null) return b.pnl;
  }
  if (mode === "close" && b.close_pnl != null) return b.close_pnl;
  if (mode === "scrape") {
    if (b.scrape_pnl != null) return b.scrape_pnl;
    return b.pnl; // older models: pnl is scrape
  }
  return b.pnl;
}

/** Did the bet win at the given odds mode's line? */
function betCorrect(b: BacktestBet, mode: OddsMode): boolean {
  if (mode === "open") {
    if (b.open_correct != null) return b.open_correct;
    // For Models C/D, correct IS already at open
    if (b.scrape_correct != null) return b.correct;
  }
  if (mode === "close" && b.close_correct != null) return b.close_correct;
  if (mode === "scrape") {
    if (b.scrape_correct != null) return b.scrape_correct;
    return b.correct; // older models: correct is scrape
  }
  return b.correct;
}

const BACKTEST_LEAGUES = ["nba", "nhl", "mlb", "nfl", "premier-league"] as const;
const MODEL_SUFFIXES = [
  { suffix: "", label: "Heuristic", color: "bg-white/5 text-white/50" },
  { suffix: "_lgbm", label: "LightGBM V1", color: "bg-blue-500/10 text-blue-400/70" },
  { suffix: "_v2", label: "V2 Edge", color: "bg-purple-500/10 text-purple-400/70" },
  { suffix: "_model_c", label: "Model C", color: "bg-amber-500/10 text-amber-400/70" },
  { suffix: "_model_d", label: "Model D", color: "bg-emerald-500/10 text-emerald-400/70" },
  { suffix: "_model_e", label: "Model E", color: "bg-rose-500/10 text-rose-400/70" },
  { suffix: "_model_f", label: "Model F", color: "bg-cyan-500/10 text-cyan-400/70" },
  { suffix: "_model_g", label: "Model G", color: "bg-pink-500/10 text-pink-400/70" },
  { suffix: "_model_f2", label: "Model F2", color: "bg-sky-500/10 text-sky-400/70" },
  { suffix: "_model_h", label: "Model H", color: "bg-indigo-500/10 text-indigo-400/70" },
  { suffix: "_general_a", label: "General A", color: "bg-lime-500/10 text-lime-400/70" },
  { suffix: "_random", label: "Random", color: "bg-gray-500/10 text-gray-400/70" },
] as const;
const ALL_RESULT_KEYS = BACKTEST_LEAGUES.flatMap((l) =>
  MODEL_SUFFIXES.map((m) => `${l}${m.suffix}`)
);

interface ModelMeta {
  features: string[];
  feature_importance: Record<string, number>;
  accuracy?: number;
  auc?: number;
  skip_counts?: Record<string, number>;
  total_bets?: number;
}

// MarketSummary and BacktestSummary imported from modelAnalysisTypes

function useBacktestSummaries() {
  return useQuery<{ summaries: Record<string, BacktestSummary>; modelMeta: Record<string, ModelMeta> }>({
    queryKey: ["backtest-summaries-all"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("back_in_play_backtest_results")
        .select("league, summary")
        .in("league", ALL_RESULT_KEYS)
        .not("summary", "is", null);
      if (error || !data) return { summaries: {}, modelMeta: {} };
      const summaries: Record<string, BacktestSummary> = {};
      const modelMeta: Record<string, ModelMeta> = {};
      for (const row of data) {
        const s: BacktestSummary = typeof row.summary === "string" ? JSON.parse(row.summary) : row.summary;
        if (!s) continue;
        summaries[row.league] = s;
        if (s.features || s.feature_importance) {
          modelMeta[row.league] = {
            features: s.features ?? [],
            feature_importance: s.feature_importance ?? {},
            accuracy: s.accuracy,
            auc: s.auc,
            skip_counts: s.skip_counts,
            total_bets: s.total_bets,
          };
        }
      }
      return { summaries, modelMeta };
    },
    staleTime: 60 * 60 * 1000,
  });
}

/** Lazy-load bets for a specific league key (for bankroll chart) */
function useBacktestBetsForLeague(leagueKey: string | null) {
  return useQuery<BacktestBet[]>({
    queryKey: ["backtest-bets", leagueKey],
    enabled: !!leagueKey,
    queryFn: async () => {
      if (!leagueKey) return [];
      const { data, error } = await supabase
        .from("back_in_play_backtest_results")
        .select("results")
        .eq("league", leagueKey)
        .single();
      if (error || !data) return [];
      const parsed = typeof data.results === "string" ? JSON.parse(data.results) : data.results;
      return (parsed.bets ?? []).map((b: BacktestBet) => ({ ...b, league: leagueKey }));
    },
    staleTime: 60 * 60 * 1000,
  });
}

// Keep legacy hook for backward compatibility (used by bankroll chart)
function useBacktestBets() {
  const { data: summaryData } = useBacktestSummaries();
  return useQuery<{ bets: BacktestBet[]; byLeague: Record<string, BacktestBet[]>; modelMeta: Record<string, ModelMeta> }>({
    queryKey: ["backtest-bets-all-stub"],
    queryFn: async () => {
      // Return empty bets — summaries are used for the table now
      return { bets: [], byLeague: {}, modelMeta: summaryData?.modelMeta ?? {} };
    },
    staleTime: 60 * 60 * 1000,
  });
}

/**
 * Bankroll simulation: start at 100, bet a fixed % of current bankroll each bet.
 * Returns final bankroll % return (e.g., +12.5 means 12.5% profit).
 */
function bankrollSim(bets: BacktestBet[], betPctFn: (b: BacktestBet) => number, mode: OddsMode = "scrape"): number {
  if (bets.length === 0) return 0;
  let bankroll = 100;
  for (const b of bets) {
    const pct = betPctFn(b);
    if (pct <= 0) continue;
    const stake = bankroll * pct;
    const isWin = betCorrect(b, mode);
    if (isWin) {
      const profit = betPnl(b, mode); // e.g. 0.909 for -110
      bankroll += stake * (profit > 0 ? profit : 0.909);
    } else {
      bankroll -= stake;
    }
    if (bankroll <= 0) return -100; // busted
  }
  return bankroll - 100;
}

/** Flat PnL: bet a fixed 1% of bankroll per bet, bankroll simulation */
function flatBankrollPnl(bets: BacktestBet[], unitPct: number, mode: OddsMode = "scrape"): number {
  return bankrollSim(bets, () => unitPct / 100, mode);
}

/**
 * Kelly bankroll sim: use per-bet Kelly fraction as bet size.
 * f* = (p*b - q) / b where p = model probability, b = odds profit
 * fraction: 1.0 for full Kelly, 0.5 for half Kelly
 * cap: max bet size as fraction of bankroll (3.5% for full, 2.5% for half)
 */
function kellyProfit(bets: BacktestBet[], fraction: number, mode: OddsMode = "scrape"): number {
  const cap = fraction >= 1.0 ? 0.035 : 0.025;
  return bankrollSim(bets, (b) => {
    // Use model's kelly_f if available, otherwise compute from p_over and odds
    let kf = b.kelly_f ?? 0;
    if (kf <= 0 && b.p_over != null) {
      const pnl = betPnl(b, mode);
      const oddsProfit = pnl > 0 ? pnl : 0.909;
      const p = b.rec === "OVER" ? b.p_over : 1 - b.p_over;
      const q = 1 - p;
      kf = Math.max((p * oddsProfit - q) / oddsProfit, 0);
    }
    return Math.min(kf * fraction, cap);
  }, mode);
}

// StatRow imported from modelAnalysisTypes

// computeStability imported from modelAnalysisUtils

// normalCDF and computePEdge imported from modelAnalysisUtils

function ModelFeatures({ meta }: { meta: ModelMeta }) {
  const sorted = Object.entries(meta.feature_importance).sort((a, b) => b[1] - a[1]);
  const maxImp = sorted.length > 0 ? sorted[0][1] : 1;
  return (
    <div className="bg-white/[0.03] rounded-xl p-4 mb-4">
      <div className="flex items-center gap-3 mb-3">
        <h3 className="text-xs font-bold text-white/40 uppercase tracking-widest">Feature Importance</h3>
        {meta.accuracy != null && (
          <span className="text-[10px] text-white/30">Acc: {(meta.accuracy * 100).toFixed(1)}% | AUC: {((meta.auc ?? 0) * 100).toFixed(1)}%</span>
        )}
      </div>
      <div className="space-y-1">
        {sorted.map(([name, imp]) => (
          <div key={name} className="flex items-center gap-2 text-[11px]">
            <span className="w-44 text-white/50 shrink-0 font-mono truncate">{name}</span>
            <div className="flex-1 h-3 bg-white/5 rounded overflow-hidden">
              <div className={`h-full rounded ${imp > 0 ? "bg-blue-500/30" : ""}`}
                style={{ width: `${maxImp > 0 ? Math.max((imp / maxImp) * 100, 0.5) : 0}%` }} />
            </div>
            <span className="w-12 text-right text-white/30 tabular-nums">{imp}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const LEAGUE_LABELS: Record<string, string> = {
  all: "All Leagues",
  nba: "NBA",
  nhl: "NHL",
  mlb: "MLB",
  nfl: "NFL",
  "premier-league": "EPL",
};

/** Daily bankroll chart for a selected model/league/market */
function BankrollChart({ bets, unitPct, oddsMode, title, onClose }: {
  bets: BacktestBet[];
  unitPct: number;
  oddsMode: OddsMode;
  title: string;
  onClose: () => void;
}) {
  const chartData = useMemo(() => {
    // Sort bets by date
    const sorted = [...bets].sort((a, b) => a.date.localeCompare(b.date));
    let bankroll = 100;
    const points: { date: string; bankroll: number; bets: number; wins: number }[] = [];
    let currentDate = "";
    let dayBets = 0;
    let dayWins = 0;

    for (const b of sorted) {
      if (b.date !== currentDate) {
        if (currentDate) {
          points.push({ date: currentDate, bankroll: Math.round(bankroll * 100) / 100, bets: dayBets, wins: dayWins });
        }
        currentDate = b.date;
        dayBets = 0;
        dayWins = 0;
      }
      const stake = bankroll * (unitPct / 100);
      const isWin = betCorrect(b, oddsMode);
      if (isWin) {
        const profit = betPnl(b, oddsMode);
        bankroll += stake * (profit > 0 ? profit : 0.909);
        dayWins++;
      } else {
        bankroll -= stake;
      }
      if (bankroll <= 0) bankroll = 0;
      dayBets++;
    }
    if (currentDate) {
      points.push({ date: currentDate, bankroll: Math.round(bankroll * 100) / 100, bets: dayBets, wins: dayWins });
    }
    return points;
  }, [bets, unitPct, oddsMode]);

  return (
    <div className="bg-white/[0.03] rounded-xl p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-bold text-white/40 uppercase tracking-widest">{title} — Bankroll Over Time</h3>
        <button onClick={onClose} className="text-white/30 hover:text-white/60 text-xs">Close</button>
      </div>
      <ResponsiveContainer width="100%" height={250}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: "rgba(255,255,255,0.3)" }} tickFormatter={(d: string) => d.slice(5)} />
          <YAxis tick={{ fontSize: 10, fill: "rgba(255,255,255,0.3)" }} domain={["dataMin - 5", "dataMax + 5"]} />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload;
              return (
                <div style={{ background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: "8px 12px", fontSize: 12 }}>
                  <div style={{ color: "rgba(255,255,255,0.5)" }}>{String(label)}</div>
                  <div style={{ color: d.bankroll >= 100 ? "#4ade80" : "#f87171" }}>Bankroll: ${d.bankroll.toFixed(2)}</div>
                  <div style={{ color: "rgba(255,255,255,0.4)" }}>{d.bets} bets ({d.wins} wins)</div>
                </div>
              );
            }}
          />
          <Line type="monotone" dataKey="bankroll" stroke={chartData[chartData.length - 1]?.bankroll >= 100 ? "#4ade80" : "#f87171"} strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

const FINAL_BETS_PASSWORD = "sonic_77";
const isLocalhost = typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

function requireFinalBetsAuth(): boolean {
  if (isLocalhost) return true;
  if (sessionStorage.getItem("final_bets_auth") === "1") return true;
  const pw = prompt("Password required to modify Final Betting Models:");
  if (pw === FINAL_BETS_PASSWORD) {
    sessionStorage.setItem("final_bets_auth", "1");
    return true;
  }
  return false;
}

function LeagueStatTable({ allData, modelMeta, summaries }: { allData: Record<string, BacktestBet[]>; modelMeta: Record<string, ModelMeta>; summaries?: Record<string, BacktestSummary> }) {
  const [evThreshold, setEvThreshold] = useState(0);
  const [selectedModels, setSelectedModels] = useState<string[]>(MODEL_SUFFIXES.map((m) => m.suffix));
  const [showFeatures, setShowFeatures] = useState<string | null>(null);
  const [oddsMode, setOddsMode] = useState<OddsMode>("open");
  const [unitPct, setUnitPct] = useState(1); // 1u = 1% of bankroll by default
  const [seasonFilter, setSeasonFilter] = useState<string>("all");
  const [leagueFilter, setLeagueFilter] = useState<string>("all");
  const [selectedRow, setSelectedRow] = useState<StatRow | null>(null);
  const [maxGnFilter, setMaxGnFilter] = useState(10); // max games back filter
  const [minGnFilter, setMinGnFilter] = useState(1); // min games back filter (1 = all)
  const [minBetsFilter, setMinBetsFilter] = useState(20); // min bets to show a row
  const [minFlatBr, setMinFlatBr] = useState<number>(0); // min flat BR% filter — default to positive only
  const [minPEdge, setMinPEdge] = useState(0); // min P(Edge) % filter (0 = all)
  const [bonfOnly, setBonfOnly] = useState(false); // only show Bonferroni-passing rows
  const [minSeasonsOk, setMinSeasonsOk] = useState(0); // min profitable seasons (0 = all)
  const [showTableInfo, setShowTableInfo] = useState(false);

  // Final Betting Models
  interface SavedBet extends StatRow {
    evMin: number;
    maxGn: number;
    minGn: number;
    season: string;
    oddsMode: OddsMode;
  }
  const [savedBets, setSavedBets] = useState<SavedBet[]>(() => {
    // Load from localStorage as fast initial state; Supabase will overwrite
    try { return JSON.parse(localStorage.getItem("ma_saved_bets") ?? "[]"); }
    catch { return []; }
  });
  const [savedBetsLoaded, setSavedBetsLoaded] = useState(false);

  // Load from Supabase on mount (source of truth)
  useEffect(() => {
    supabase.from("back_in_play_app_config")
      .select("value")
      .eq("key", "final_betting_models")
      .single()
      .then(({ data }) => {
        if (data?.value && Array.isArray(data.value)) {
          setSavedBets(data.value as SavedBet[]);
          localStorage.setItem("ma_saved_bets", JSON.stringify(data.value));
        }
        setSavedBetsLoaded(true);
      })
      .catch(() => setSavedBetsLoaded(true));
  }, []);

  // Persist to both localStorage and Supabase
  useEffect(() => {
    localStorage.setItem("ma_saved_bets", JSON.stringify(savedBets));
    if (savedBetsLoaded && savedBets.length >= 0) {
      supabase.from("back_in_play_app_config")
        .upsert({ key: "final_betting_models", value: savedBets, updated_at: new Date().toISOString() })
        .then(() => {});
    }
  }, [savedBets, savedBetsLoaded]);

  // Derive season from bet date (e.g. "2024-11-05" → "2024-25", "2024-03-05" → "2023-24")
  const getBetSeason = (b: BacktestBet): string => {
    if (b.season) return b.season;
    const d = b.date;
    if (!d) return "unknown";
    const year = parseInt(d.slice(0, 4));
    const month = parseInt(d.slice(5, 7));
    // Sports seasons: Oct-Jun = same season. Jul-Sep = preseason of next
    const startYear = month >= 7 ? year : year - 1;
    return `${startYear}-${String(startYear + 1).slice(2)}`;
  };

  // Collect all available seasons from summaries
  const availableSeasons = useMemo(() => {
    const seasons = new Set<string>();
    if (summaries) {
      for (const s of Object.values(summaries)) {
        for (const season of (s as any).seasons ?? []) {
          seasons.add(season);
        }
      }
    }
    // Fallback to raw bets if no summaries
    for (const key of Object.keys(allData)) {
      for (const b of allData[key] ?? []) {
        seasons.add(getBetSeason(b));
      }
    }
    return ["all", ...Array.from(seasons).sort()];
  }, [allData, summaries]);

  const rows = useMemo(() => {
    const result: StatRow[] = [];
    // Find the closest pre-computed EV threshold
    const EV_THRESHOLDS = [0, 5, 10, 15, 20, 30, 40, 50];
    const MAX_GN_VALUES = [1, 2, 3, 5, 10];
    const closestEv = EV_THRESHOLDS.reduce((prev, curr) =>
      Math.abs(curr - evThreshold) < Math.abs(prev - evThreshold) ? curr : prev
    );
    const closestGn = MAX_GN_VALUES.reduce((prev, curr) =>
      Math.abs(curr - maxGnFilter) < Math.abs(prev - maxGnFilter) ? curr : prev
    );
    const seasonSuffix = seasonFilter !== "all" ? `_s${seasonFilter}` : "";
    const modeKey = `by_market_${oddsMode}_ev${closestEv}_gn${closestGn}${seasonSuffix}`;

    for (const leagueBase of BACKTEST_LEAGUES) {
      if (leagueFilter !== "all" && leagueBase !== leagueFilter) continue;
      for (const { suffix, label } of MODEL_SUFFIXES) {
        if (!selectedModels.includes(suffix)) continue;
        const key = `${leagueBase}${suffix}`;

        // Use pre-computed summaries if available (fast path)
        const summary = summaries?.[key];
        if (summary) {
          let marketData: Record<string, MarketSummary> | undefined;

          if (minGnFilter <= 1) {
            // Simple case: G1-N, use summary directly
            marketData = (summary as any)[modeKey] as Record<string, MarketSummary> | undefined;
          } else {
            // Range case (e.g. G6-10): compute as gn(max) minus gn(minGn-1)
            // gn10 includes G1-10, gn5 includes G1-5, so G6-10 = gn10 - gn5
            const closestLower = MAX_GN_VALUES.reduce((prev, curr) =>
              curr < minGnFilter && curr > prev ? curr : prev, 0
            );
            if (closestLower > 0) {
              const upperKey = `by_market_${oddsMode}_ev${closestEv}_gn${closestGn}${seasonSuffix}`;
              const lowerKey = `by_market_${oddsMode}_ev${closestEv}_gn${closestLower}${seasonSuffix}`;
              const upper = (summary as any)[upperKey] as Record<string, MarketSummary> | undefined;
              const lower = (summary as any)[lowerKey] as Record<string, MarketSummary> | undefined;
              if (upper) {
                marketData = {} as Record<string, MarketSummary>;
                for (const [mkt, uStats] of Object.entries(upper)) {
                  const lStats = lower?.[mkt];
                  if (lStats && uStats.bets > lStats.bets) {
                    const bets = uStats.bets - lStats.bets;
                    const wins = uStats.wins - lStats.wins;
                    const pnl = uStats.flat_pnl - lStats.flat_pnl;
                    marketData[mkt] = {
                      bets, wins,
                      win_rate: bets > 0 ? wins / bets : 0,
                      flat_pnl: pnl,
                      flat_roi: bets > 0 ? (pnl / bets) * 100 : 0,
                      flat_br: uStats.flat_br, // approximation — can't subtract BR sims
                      half_kelly_br: uStats.half_kelly_br,
                      full_kelly_br: uStats.full_kelly_br,
                    };
                  } else if (!lStats) {
                    // Lower window has no data for this market — use upper as-is
                    marketData[mkt] = uStats;
                  }
                }
              }
            } else {
              // Can't compute range — fall through to raw bets
              marketData = undefined;
            }
          }

          if (!marketData) continue;

          // Collect seasons for this model's summary
          const modelSeasons = (summary as any).seasons as string[] | undefined;

          for (const [market, stats] of Object.entries(marketData)) {
            if (!stats || stats.bets === 0) continue;

            // Check per-season profitability
            let seasonsOk = 0, seasonsCounted = 0;
            if (modelSeasons && modelSeasons.length > 0) {
              for (const season of modelSeasons) {
                const sKey = `by_market_${oddsMode}_ev${closestEv}_gn${closestGn}_s${season}`;
                const sMkt = ((summary as any)[sKey] as Record<string, MarketSummary> | undefined)?.[market];
                if (!sMkt || sMkt.bets < 10) continue;
                seasonsCounted++;
                if (sMkt.flat_br > 0) seasonsOk++;
              }
            }

            result.push({
              league: leagueBase, market, model: label,
              bets: stats.bets, wins: stats.wins,
              winRate: stats.wins / stats.bets,
              flatPnl: stats.flat_pnl,
              flatRoi: stats.flat_roi,
              flatBr: stats.flat_br,
              halfKellyPnl: stats.half_kelly_br,
              fullKellyPnl: stats.full_kelly_br,
              pEdge: computePEdge(stats.bets, stats.wins, stats.flat_pnl),
              allSeasons: seasonsCounted >= 2 ? `${seasonsOk}/${seasonsCounted}` : "—",
              stability: computeStability(summary, market, oddsMode, closestGn),
              pctBeatClose: stats.pct_beat_close ?? -1,
              avgClvProbEdge: stats.avg_clv_prob_edge ?? 0,
              warnings: stats.flat_roi > 10 ? ["ROI > 10%"] : [],
              maxDrawdown: stats.max_drawdown ?? -1,
              turnover: stats.turnover ?? -1,
              bookScore: "—",
              booksCombos: { fdFd: null, fdDk: null, dkDk: null, dkFd: null },
            });
          }
          continue;
        }

        // Fallback: compute from raw bets (legacy path)
        const bets = (allData[key] ?? []).filter((b) => {
          if (b.ev < evThreshold) return false;
          if (seasonFilter !== "all" && getBetSeason(b) !== seasonFilter) return false;
          if (b.gn > maxGnFilter || b.gn < minGnFilter) return false;
          return true;
        });
        if (bets.length === 0) continue;

        const byMarket: Record<string, BacktestBet[]> = {};
        for (const b of bets) {
          const m = b.market || "all";
          if (!byMarket[m]) byMarket[m] = [];
          byMarket[m].push(b);
        }

        const allBets = bets;
        const allWins = allBets.filter((b) => betCorrect(b, oddsMode)).length;
        const allFlatPnl = allBets.reduce((s, b) => s + betPnl(b, oddsMode), 0);
        const allClvBets = allBets.filter((b: any) => b.beat_close != null);
        const allPctBcl = allClvBets.length > 0 ? allClvBets.filter((b: any) => b.beat_close).length / allClvBets.length * 100 : -1;
        result.push({
          league: leagueBase, market: "ALL", model: label,
          bets: allBets.length, wins: allWins, winRate: allWins / allBets.length,
          flatPnl: allFlatPnl,
          flatRoi: allFlatPnl / allBets.length * 100,
          flatBr: flatBankrollPnl(allBets, unitPct, oddsMode),
          halfKellyPnl: kellyProfit(allBets, 0.5, oddsMode),
          fullKellyPnl: kellyProfit(allBets, 1.0, oddsMode),
          pEdge: computePEdge(allBets.length, allWins, allFlatPnl),
          allSeasons: "—",
          stability: 0,
          pctBeatClose: allPctBcl,
          avgClvProbEdge: 0,
          warnings: [],
          maxDrawdown: -1,
          turnover: -1,
          bookScore: "—",
          booksCombos: { fdFd: null, fdDk: null, dkDk: null, dkFd: null },
        });

        for (const [market, mBets] of Object.entries(byMarket)) {
          const mWins = mBets.filter((b) => betCorrect(b, oddsMode)).length;
          const mFlatPnl = mBets.reduce((s, b) => s + betPnl(b, oddsMode), 0);
          const mClvBets = mBets.filter((b: any) => b.beat_close != null);
          const mPctBcl = mClvBets.length > 0 ? mClvBets.filter((b: any) => b.beat_close).length / mClvBets.length * 100 : -1;
          result.push({
            league: leagueBase, market, model: label,
            bets: mBets.length, wins: mWins,
            winRate: mWins / mBets.length,
            flatPnl: mFlatPnl,
            flatRoi: mFlatPnl / mBets.length * 100,
            flatBr: flatBankrollPnl(mBets, unitPct, oddsMode),
            halfKellyPnl: kellyProfit(mBets, 0.5, oddsMode),
            fullKellyPnl: kellyProfit(mBets, 1.0, oddsMode),
            pEdge: computePEdge(mBets.length, mWins, mFlatPnl),
            allSeasons: "—",
            stability: 0,
            pctBeatClose: mPctBcl,
            avgClvProbEdge: 0,
            warnings: [],
            maxDrawdown: -1,
            turnover: -1,
            bookScore: "—",
            booksCombos: { fdFd: null, fdDk: null, dkDk: null, dkFd: null },
          });
        }
      }
    }
    // Sort: ALL rows first, then sub-rows; within each league group sort models by ROI (best first)
    result.sort((a, b) => {
      const la = BACKTEST_LEAGUES.indexOf(a.league as any);
      const lb = BACKTEST_LEAGUES.indexOf(b.league as any);
      if (la !== lb) return la - lb;
      if (a.market === "ALL" && b.market === "ALL") return b.flatRoi - a.flatRoi;
      if (a.market === "ALL") return -1;
      if (b.market === "ALL") return 1;
      return b.flatRoi - a.flatRoi;
    });
    let filtered = result.filter((r) => r.bets >= minBetsFilter && (minFlatBr <= -999 || r.flatBr >= minFlatBr));
    // P(Edge) filter
    if (minPEdge > 0) filtered = filtered.filter((r) => r.pEdge * 100 >= minPEdge);
    // Min seasons filter
    if (minSeasonsOk > 0) {
      filtered = filtered.filter((r) => {
        if (r.allSeasons === "—") return false;
        const ok = parseInt(r.allSeasons.split("/")[0]);
        return ok >= minSeasonsOk;
      });
    }
    return filtered;
  }, [allData, summaries, evThreshold, selectedModels, oddsMode, seasonFilter, leagueFilter, unitPct, maxGnFilter, minGnFilter, minBetsFilter, minFlatBr, minPEdge, minSeasonsOk]);

  // Build lookup of random model by league+market to flag bad odds data
  // Flag as bad odds if Random has positive BR% (bankroll growth = free money from odds bias)
  const badOddsMarkets = useMemo(() => {
    const bad = new Set<string>();
    // Market name aliases — Random and ML models sometimes use different names for same stat
    const MARKET_ALIASES: Record<string, string[]> = {
      player_shots_on_target: ["player_shots", "player_shots_on_target", "SOG"],
      player_shots: ["player_shots_on_target", "player_shots", "SOG"],
    };
    const addBad = (league: string, market: string) => {
      bad.add(`${league}|${market}`);
      for (const alias of MARKET_ALIASES[market] ?? []) {
        bad.add(`${league}|${alias}`);
      }
    };
    const modeKey = `by_market_${oddsMode}_ev0_gn10`;
    for (const leagueBase of BACKTEST_LEAGUES) {
      const randomSummary = summaries?.[`${leagueBase}_random`];
      if (!randomSummary) continue;
      const marketData = (randomSummary as any)[modeKey] as Record<string, MarketSummary> | undefined;
      if (!marketData) continue;
      for (const [market, stats] of Object.entries(marketData)) {
        if (stats && stats.bets >= 50 && stats.flat_br > 0) {
          addBad(leagueBase, market);
          if (market === "ALL") {
            for (const [m2] of Object.entries(marketData)) {
              addBad(leagueBase, m2);
            }
          }
        }
      }
    }
    // Also check from rows for backward compat
    for (const r of rows) {
      if (r.model === "Random" && r.flatBr > 0 && r.bets >= 50) {
        bad.add(`${r.league}|${r.market}`);
        if (r.market === "ALL") {
          for (const r2 of rows) {
            if (r2.league === r.league) bad.add(`${r2.league}|${r2.market}`);
          }
        }
      }
    }
    return bad;
  }, [rows]);

  // Total hypothesis count: all (model × league × market × EV threshold) combos
  // that exist in the data for the selected models. This is what Bonferroni should
  // divide by — not just the visible rows, which change with filters.
  const totalHypotheses = useMemo(() => {
    if (!summaries) return rows.length;
    const EV_VALS = [0, 5, 10, 15, 20, 30, 40, 50];
    const GN_VAL = 10; // user only uses G1-10
    let count = 0;
    for (const leagueBase of BACKTEST_LEAGUES) {
      for (const { suffix } of MODEL_SUFFIXES) {
        if (!selectedModels.includes(suffix)) continue;
        const key = `${leagueBase}${suffix}`;
        const summary = summaries[key];
        if (!summary) continue;
        for (const ev of EV_VALS) {
          const modeKey = `by_market_${oddsMode}_ev${ev}_gn${GN_VAL}`;
          const marketData = (summary as any)[modeKey] as Record<string, MarketSummary> | undefined;
          if (!marketData) continue;
          for (const stats of Object.values(marketData)) {
            if (stats && stats.bets >= 20) count++;
          }
        }
      }
    }
    return Math.max(count, rows.length);
  }, [summaries, selectedModels, oddsMode, rows.length]);

  const bonfThreshold = 0.05 / Math.max(totalHypotheses, 1);
  const displayRows = useMemo(() => {
    if (!bonfOnly) return rows;
    return rows.filter((r) => (1 - r.pEdge) < bonfThreshold);
  }, [rows, bonfOnly, bonfThreshold]);

  const getModelColor = (label: string) =>
    MODEL_SUFFIXES.find((m) => m.label === label)?.color ?? "bg-white/5 text-white/50";

  return (
    <div className="mb-8">
      {/* Show features for a selected model */}
      <div className="mb-4">
        <p className="text-[11px] text-white/40 mb-2">View Model Variables</p>
        <div className="flex flex-wrap gap-1.5">
          {MODEL_SUFFIXES.filter((m) => m.suffix !== "").map((m) => {
            const metaKey = Object.keys(modelMeta).find((k) => k.endsWith(m.suffix));
            if (!metaKey) return null;
            return (
              <button key={m.suffix}
                onClick={() => setShowFeatures(showFeatures === m.suffix ? null : m.suffix)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                  showFeatures === m.suffix
                    ? `${m.color} border-current`
                    : "bg-white/[0.02] text-white/30 border-transparent"
                }`}>
                {m.label} Features
              </button>
            );
          })}
        </div>
      </div>

      {showFeatures && (() => {
        const metaKey = Object.keys(modelMeta).find((k) => k.endsWith(showFeatures));
        return metaKey ? <ModelFeatures meta={modelMeta[metaKey]} /> : null;
      })()}

      <ModelFilters
        modelDefs={MODEL_SUFFIXES}
        leagues={BACKTEST_LEAGUES}
        leagueLabels={LEAGUE_LABELS}
        selectedModels={selectedModels}
        setSelectedModels={setSelectedModels}
        oddsMode={oddsMode}
        setOddsMode={setOddsMode}
        leagueFilter={leagueFilter}
        setLeagueFilter={setLeagueFilter}
        seasonFilter={seasonFilter}
        setSeasonFilter={setSeasonFilter}
        evThreshold={evThreshold}
        setEvThreshold={setEvThreshold}
        unitPct={unitPct}
        setUnitPct={setUnitPct}
        minBets={minBetsFilter}
        setMinBets={setMinBetsFilter}
        minFlatBr={minFlatBr}
        setMinFlatBr={setMinFlatBr}
        minPEdge={minPEdge}
        setMinPEdge={setMinPEdge}
        bonfOnly={bonfOnly}
        setBonfOnly={setBonfOnly}
        minSeasonsOk={minSeasonsOk}
        setMinSeasonsOk={setMinSeasonsOk}
        availableSeasons={availableSeasons}
        bonfThreshold={bonfThreshold}
        rows={rows}
        showGamesBack={true}
        minGnFilter={minGnFilter}
        setMinGnFilter={setMinGnFilter}
        maxGnFilter={maxGnFilter}
        setMaxGnFilter={setMaxGnFilter}
        oddsOptions={[
          { value: "scrape" as OddsMode, label: "Scraped Odds" },
          { value: "open" as OddsMode, label: "Opening Odds" },
          { value: "close" as OddsMode, label: "Closing Odds" },
        ]}
        totalHypotheses={totalHypotheses}
      />

      {/* Data Coverage */}
      {Object.keys(modelMeta).some((k) => modelMeta[k]?.skip_counts) && (
        <div className="mb-4 bg-white/[0.03] rounded-xl p-3">
          <p className="text-[11px] text-white/40 mb-2 font-bold uppercase tracking-widest">Data Coverage <span className="font-normal">(games 1–10 only)</span></p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {BACKTEST_LEAGUES.map((league) => {
              const meta = MODEL_SUFFIXES.map((m) => modelMeta[`${league}${m.suffix}`]).find((m) => m?.skip_counts);
              if (!meta?.skip_counts) return null;
              const sc = meta.skip_counts;
              const built = meta.total_bets ?? 0;
              // Exclude too_far_back — those are outside the model's G1-10 window
              const noPlayer = sc.no_player ?? 0;
              const noActual = sc.no_actual ?? 0;
              const noPostGames = sc.no_post_games ?? 0;
              const fewGames = sc.few_games ?? 0;
              const fewPre = sc.few_pre_stats ?? 0;
              const other = (sc.unknown_market ?? 0) + (sc.missing ?? 0) + (sc.push ?? 0) + (sc.no_injury ?? 0);
              const validTotal = built + noPlayer + noActual + noPostGames + fewGames + fewPre + other;
              // noInjury excluded from denominator — healthy players aren't candidates
              const pct = validTotal > 0 ? Math.round((built / validTotal) * 100) : 0;
              return (
                <div key={league} className="bg-white/[0.03] rounded-lg p-2">
                  <p className="text-[11px] font-medium text-white/60">{LEAGUE_LABELS[league] ?? league}</p>
                  <p className={`text-lg font-bold tabular-nums ${pct >= 50 ? "text-green-400" : pct >= 25 ? "text-yellow-400" : "text-red-400"}`}>{pct}%</p>
                  <p className="text-[9px] text-white/30">{built.toLocaleString()} of {validTotal.toLocaleString()} valid props</p>
                  <div className="text-[9px] text-white/20 mt-0.5 space-y-px">
                    {noPlayer > 0 && <p>{noPlayer.toLocaleString()} name mismatch</p>}
                    {noActual > 0 && <p>{noActual.toLocaleString()} no game stat</p>}
                    {noPostGames > 0 && <p>{noPostGames.toLocaleString()} no post-return games</p>}
                    {fewGames > 0 && <p>{fewGames.toLocaleString()} few game logs</p>}
                    {fewPre > 0 && <p>{fewPre.toLocaleString()} few pre-injury stats</p>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <ModelTable
        rows={displayRows}
        leagueLabels={LEAGUE_LABELS}
        marketLabels={MARKET_LABELS}
        modelDefs={MODEL_SUFFIXES}
        bonfThreshold={bonfThreshold}
        showTableInfo={showTableInfo}
        setShowTableInfo={setShowTableInfo}
        badOddsMarkets={badOddsMarkets}
        onRowClick={(r) => setSelectedRow(selectedRow === r ? null : r)}
        selectedRow={selectedRow}
        statColumnLabel="Stat"
        renderRowAction={(r) => (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (!requireFinalBetsAuth()) return;
              const already = savedBets.some((s) => s.league === r.league && s.market === r.market && s.model === r.model && s.evMin === evThreshold && s.maxGn === maxGnFilter);
              if (!already) {
                setSavedBets([...savedBets, { ...r, evMin: evThreshold, maxGn: maxGnFilter, minGn: minGnFilter, season: seasonFilter, oddsMode }]);
              }
            }}
            className="w-5 h-5 rounded bg-green-500/20 text-green-400 hover:bg-green-500/30 text-[11px] font-bold leading-none"
            title="Add to Final Betting Models"
          >+</button>
        )}
      />

      {/* Data quality notes */}
      <div className="mt-4 p-4 bg-white/[0.03] rounded-xl text-[11px] text-white/40 space-y-2">
        <p className="font-bold text-white/50 uppercase tracking-widest text-[10px] mb-2">Data Quality Notes</p>
        <p><span className="text-orange-400">NFL:</span> player_rush_attempts, player_pass_completions, and player_pass_attempts are excluded from model results — stat columns only 33% populated. Needs ESPN re-scrape to backfill (nflverse fuzzy match produced unreliable data).</p>
        <p><span className="text-orange-400">NBA:</span> player_threes has limited bets — stat_3pm is missing for all holdout-period games. Needs backfill from NBA-Betting/NBA_AI repo or ESPN re-scrape.</p>
        <p><span className="text-yellow-400">EPL:</span> Odds data from non-DK/FD bookmakers may be unreliable. Only DraftKings/FanDuel odds used for random baseline. EPL has very few two-sided props from DK/FD.</p>
        <p><span className="text-white/30">All leagues:</span> Random model uses DraftKings/FanDuel odds only, skips one-sided props. Kelly BR% is 0% for Random (no model probability to size bets).</p>
      </div>

      {/* Final Betting Models */}
      {savedBets.length > 0 && (
        <div className="mt-6 p-4 bg-white/[0.03] rounded-xl">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold text-white/70 uppercase tracking-widest">Final Betting Models</h3>
            <button onClick={() => { if (requireFinalBetsAuth()) setSavedBets([]); }} className="text-[10px] text-white/30 hover:text-white/50">Clear all</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs whitespace-nowrap">
              <thead>
                <tr className="text-white/40 border-b border-white/10">
                  <th className="text-left py-2 px-2">League</th>
                  <th className="text-left py-2 px-2">Stat</th>
                  <th className="text-left py-2 px-2">Model</th>
                  <th className="text-right py-2 px-2">EV≥</th>
                  <th className="text-right py-2 px-2">Games</th>
                  <th className="text-right py-2 px-2">Odds</th>
                  <th className="text-right py-2 px-2">Season</th>
                  <th className="text-right py-2 px-2">Bets</th>
                  <th className="text-right py-2 px-2">Win%</th>
                  <th className="text-right py-2 px-2">Flat ROI</th>
                  <th className="text-right py-2 px-2">Flat BR%</th>
                  <th className="text-right py-2 px-2">½K BR%</th>
                  <th className="text-right py-2 px-2">Full K BR%</th>
                  <th className="text-right py-2 px-2">P(Edge)</th>
                  <th className="text-center py-2 px-2">Bonf</th>
                  <th className="text-center py-2 px-2">Seasons</th>
                  <th className="text-center py-2 px-2">Stab</th>
                  <th className="py-2 px-1 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {savedBets.map((s, i) => (
                  <tr key={i} className="border-b border-white/5 hover:bg-white/[0.03]">
                    <td className="py-1.5 px-2">{LEAGUE_LABELS[s.league] ?? s.league}</td>
                    <td className="py-1.5 px-2">{s.market === "ALL" ? "ALL" : (MARKET_LABELS[s.market] ?? s.market)}</td>
                    <td className="py-1.5 px-2">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] ${getModelColor(s.model)}`}>{s.model}</span>
                    </td>
                    <td className="py-1.5 px-2 text-right text-white/50">{s.evMin}%</td>
                    <td className="py-1.5 px-2 text-right text-white/50">{(s.minGn ?? 1) > 1 ? `${s.minGn}-${s.maxGn}` : `1-${s.maxGn}`}</td>
                    <td className="py-1.5 px-2 text-right text-white/50 capitalize">{s.oddsMode ?? "open"}</td>
                    <td className="py-1.5 px-2 text-right text-white/50">{s.season === "all" ? "All" : s.season}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{s.bets.toLocaleString()}</td>
                    <td className={`py-1.5 px-2 text-right tabular-nums ${s.winRate > 0.524 ? "text-green-400" : "text-red-400/70"}`}>
                      {(s.winRate * 100).toFixed(1)}%
                    </td>
                    <td className={`py-1.5 px-2 text-right tabular-nums ${s.flatRoi > 0 ? "text-green-400" : "text-red-400/70"}`}>
                      {s.flatRoi >= 0 ? "+" : ""}{s.flatRoi.toFixed(1)}%
                    </td>
                    <td className={`py-1.5 px-2 text-right tabular-nums ${s.flatBr > 0 ? "text-green-400" : "text-red-400/70"}`}>
                      {s.flatBr >= 0 ? "+" : ""}{s.flatBr.toFixed(1)}%
                    </td>
                    <td className={`py-1.5 px-2 text-right tabular-nums ${s.halfKellyPnl > 0 ? "text-green-400" : "text-red-400/70"}`}>
                      {s.halfKellyPnl >= 0 ? "+" : ""}{s.halfKellyPnl.toFixed(1)}%
                    </td>
                    <td className={`py-1.5 px-2 text-right tabular-nums ${s.fullKellyPnl > 0 ? "text-green-400" : "text-red-400/70"}`}>
                      {s.fullKellyPnl >= 0 ? "+" : ""}{s.fullKellyPnl.toFixed(1)}%
                    </td>
                    <td className={`py-1.5 px-2 text-right tabular-nums font-medium ${
                      s.pEdge >= 0.95 ? "text-green-400" :
                      s.pEdge >= 0.80 ? "text-green-400/70" :
                      s.pEdge >= 0.50 ? "text-yellow-400/70" :
                      "text-red-400/50"
                    }`}>
                      {s.pEdge >= 0.9999 ? ">99.99%" : `${(s.pEdge * 100).toFixed(2)}%`}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums">
                      {(() => {
                        const pVal = 1 - s.pEdge;
                        const bonf = 0.05 / Math.max(savedBets.length, 1);
                        const pass = pVal < bonf;
                        const display = pVal < 0.0001 ? "<.0001" : pVal.toFixed(4);
                        return (
                          <span className={`text-[10px] font-medium ${
                            pass       ? "text-green-400" :
                            pVal < 0.01 ? "text-green-400/70" :
                            pVal < 0.05 ? "text-yellow-400/70" :
                                          "text-white/25"
                          }`}>
                            {display}{pass && <span className="ml-0.5 text-[8px] text-green-400/50">B</span>}
                          </span>
                        );
                      })()}
                    </td>
                    <td className={`py-1.5 px-2 text-center text-[10px] font-medium ${
                      s.allSeasons === "—" ? "text-white/20" :
                      s.allSeasons.split("/")[0] === s.allSeasons.split("/")[1] ? "text-green-400" :
                      "text-yellow-400/70"
                    }`}>
                      {s.allSeasons}
                    </td>
                    <td className="py-1.5 px-2 text-center">
                      <span className={`text-[10px] font-bold tabular-nums ${
                        (s.stability ?? 0) >= 4 ? "text-green-400" :
                        (s.stability ?? 0) >= 2 ? "text-yellow-400/70" :
                        "text-red-400/50"
                      }`}>{s.stability ?? 0}/5</span>
                    </td>
                    <td className="py-1.5 px-1 text-center">
                      <button
                        onClick={() => { if (requireFinalBetsAuth()) setSavedBets(savedBets.filter((_, j) => j !== i)); }}
                        className="w-5 h-5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 text-[11px] font-bold leading-none"
                      >×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Bankroll chart for selected row */}
      {selectedRow && (() => {
        // Get bets for the selected league + model
        const modelSuffix = MODEL_SUFFIXES.find((m) => m.label === selectedRow.model)?.suffix ?? "";
        const dataKey = `${selectedRow.league}${modelSuffix}`;
        const modelBets = allData[dataKey] ?? [];
        // Filter by market if not ALL
        const chartBets = selectedRow.market === "ALL"
          ? modelBets
          : modelBets.filter((b) => b.market === selectedRow.market);
        // Apply same season filter
        const filteredBets = seasonFilter === "all"
          ? chartBets
          : chartBets.filter((b) => (b.season ?? "") === seasonFilter);
        const title = `${LEAGUE_LABELS[selectedRow.league] ?? selectedRow.league} · ${selectedRow.model} · ${selectedRow.market === "ALL" ? "All Markets" : selectedRow.market}`;
        return (
          <BankrollChart
            bets={filteredBets}
            unitPct={unitPct}
            oddsMode={oddsMode}
            title={title}
            onClose={() => setSelectedRow(null)}
          />
        );
      })()}
    </div>
  );
}

function HistoricalBacktest() {
  const { data, isLoading: betsLoading } = useBacktestBets();
  const allBetsRaw = data?.bets ?? [];
  const [minEv, setMinEv] = useState(0);
  const [maxGamesBack, setMaxGamesBack] = useState(10);
  const [league, setLeague] = useState("all");

  const allBets = useMemo(() => {
    if (league === "all") return allBetsRaw;
    return allBetsRaw.filter((b) => b.league === league);
  }, [allBetsRaw, league]);

  const filtered = useMemo(() => {
    return allBets.filter((b) => b.ev >= minEv && b.gn <= maxGamesBack);
  }, [allBets, minEv, maxGamesBack]);

  const stats = useMemo(() => {
    if (filtered.length === 0) return null;
    const wins = filtered.filter((b) => b.correct).length;
    const total = filtered.length;
    const profit = filtered.reduce((s, b) => s + b.pnl, 0);

    // By game number
    const byGn: Record<number, { total: number; correct: number; profit: number }> = {};
    for (let g = 1; g <= 10; g++) byGn[g] = { total: 0, correct: 0, profit: 0 };
    for (const b of filtered) {
      byGn[b.gn].total++;
      if (b.correct) byGn[b.gn].correct++;
      byGn[b.gn].profit += b.pnl;
    }

    // By EV tier
    const tiers = ["<5%", "5-10%", "10-20%", "20-30%", "30-50%", "≥50%"] as const;
    const byEv: Record<string, { total: number; correct: number; profit: number }> = {};
    for (const t of tiers) byEv[t] = { total: 0, correct: 0, profit: 0 };
    for (const b of filtered) {
      const tier = b.ev >= 50 ? "≥50%" : b.ev >= 30 ? "30-50%" : b.ev >= 20 ? "20-30%" : b.ev >= 10 ? "10-20%" : b.ev >= 5 ? "5-10%" : "<5%";
      byEv[tier].total++;
      if (b.correct) byEv[tier].correct++;
      byEv[tier].profit += b.pnl;
    }

    // By confidence
    const byConf: Record<string, { total: number; correct: number; profit: number }> = { High: { total: 0, correct: 0, profit: 0 }, Medium: { total: 0, correct: 0, profit: 0 }, Low: { total: 0, correct: 0, profit: 0 } };
    for (const b of filtered) {
      byConf[b.conf].total++;
      if (b.correct) byConf[b.conf].correct++;
      byConf[b.conf].profit += b.pnl;
    }

    // By market
    const byMarket: Record<string, { total: number; correct: number; profit: number }> = {};
    for (const b of filtered) {
      if (!byMarket[b.market]) byMarket[b.market] = { total: 0, correct: 0, profit: 0 };
      byMarket[b.market].total++;
      if (b.correct) byMarket[b.market].correct++;
      byMarket[b.market].profit += b.pnl;
    }

    return { wins, total, profit, byGn, byEv, byConf, byMarket };
  }, [filtered]);

  const evThresholds = [0, 5, 10, 15, 20, 30, 50];
  const gamesBackOptions = [1, 2, 3, 5, 7, 10];

  if (betsLoading) return <div className="text-white/30 text-center py-10">Loading backtest data...</div>;
  if (allBetsRaw.length === 0) return <div className="text-white/30 text-center py-10">No backtest data. Run the simulation on the droplet first.</div>;

  const leagueCounts = Object.fromEntries(
    ["all", ...BACKTEST_LEAGUES].map((l) => [l, l === "all" ? allBetsRaw.length : (data?.byLeague[l]?.length ?? 0)])
  );

  return (
    <div className="mb-8">
      <div className="flex items-center gap-3 mb-1">
        <h2 className="text-lg font-bold">Historical Backtest</h2>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400/80 font-semibold">
          {allBets.length.toLocaleString()} bets · Heuristic Model · Holdout
        </span>
        {stats && (
          <button
            onClick={() => {
              const lines: string[] = [];
              lines.push(`Win Rate: ${(stats.wins / stats.total * 100).toFixed(1)}% (${stats.wins}/${stats.total})`);
              lines.push(`ROI: ${(stats.profit / stats.total * 100).toFixed(1)}% (${stats.profit >= 0 ? "+" : ""}${stats.profit.toFixed(0)}u)`);
              lines.push("");
              lines.push("Game#\tWin%\tBets\tROI");
              Object.entries(stats.byGn).filter(([, d]) => d.total > 0).forEach(([gn, d]) => {
                lines.push(`G${gn}\t${(d.correct / d.total * 100).toFixed(1)}%\t${d.total}\t${(d.profit / d.total * 100).toFixed(1)}%`);
              });
              lines.push("");
              lines.push("EV Tier\tWin%\tBets\tROI");
              ["<5%", "5-10%", "10-20%", "20-30%", "30-50%", "≥50%"].forEach((tier) => {
                const d = stats.byEv[tier];
                if (d?.total > 0) lines.push(`${tier}\t${(d.correct / d.total * 100).toFixed(1)}%\t${d.total}\t${(d.profit / d.total * 100).toFixed(1)}%`);
              });
              lines.push("");
              lines.push("Market\tWin%\tBets\tROI");
              Object.entries(stats.byMarket).sort((a, b) => b[1].total - a[1].total).forEach(([market, d]) => {
                lines.push(`${MARKET_LABELS[market] ?? market}\t${(d.correct / d.total * 100).toFixed(1)}%\t${d.total}\t${(d.profit / d.total * 100).toFixed(1)}%`);
              });
              navigator.clipboard.writeText(lines.join("\n"));
            }}
            className="shrink-0 px-2 py-1 rounded-lg border border-white/10 text-white/30 hover:text-white/60 hover:border-white/20 transition-colors text-[10px]"
            title="Copy backtest summary"
          >
            Copy
          </button>
        )}
      </div>
      <p className="text-[11px] text-white/40 mb-4">
        Results from the heuristic EV model on holdout data. See League/Stat Breakdown below for all model comparisons.
      </p>

      {/* League selector */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {["all", ...BACKTEST_LEAGUES].map((l) => (
          <button key={l} onClick={() => setLeague(l)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              league === l ? "bg-[#1C7CFF]/20 text-[#1C7CFF] border border-[#1C7CFF]/30" : "bg-white/5 text-white/50 hover:text-white/70 border border-transparent"
            }`}>
            {LEAGUE_LABELS[l] ?? l} ({leagueCounts[l]?.toLocaleString()})
          </button>
        ))}
      </div>

      {/* Parameter controls */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <div>
          <p className="text-[11px] text-white/40 mb-2">Min EV % to bet</p>
          <div className="flex flex-wrap gap-1.5">
            {evThresholds.map((t) => (
              <button key={t} onClick={() => setMinEv(t)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  minEv === t ? "bg-[#1C7CFF]/20 text-[#1C7CFF] border border-[#1C7CFF]/30" : "bg-white/5 text-white/50 hover:text-white/70 border border-transparent"
                }`}>
                {t === 0 ? "All" : `≥${t}%`}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="text-[11px] text-white/40 mb-2">Max games back to bet</p>
          <div className="flex flex-wrap gap-1.5">
            {gamesBackOptions.map((g) => (
              <button key={g} onClick={() => setMaxGamesBack(g)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  maxGamesBack === g ? "bg-[#1C7CFF]/20 text-[#1C7CFF] border border-[#1C7CFF]/30" : "bg-white/5 text-white/50 hover:text-white/70 border border-transparent"
                }`}>
                G1{g > 1 ? `-G${g}` : ""}
              </button>
            ))}
          </div>
        </div>
      </div>

      {stats && (
        <>
          {/* Overall */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            <StatsCard label="Win Rate" value={`${(stats.wins / stats.total * 100).toFixed(1)}%`}
              sub={`${stats.wins.toLocaleString()}/${stats.total.toLocaleString()}`}
              color={stats.wins / stats.total > 0.524 ? "text-green-400" : "text-red-400"} />
            <StatsCard label="ROI" value={`${(stats.profit / stats.total * 100).toFixed(1)}%`}
              sub={`${stats.profit >= 0 ? "+" : ""}${stats.profit.toFixed(0)}u`}
              color={stats.profit > 0 ? "text-green-400" : "text-red-400"} />
            <StatsCard label="Total Bets" value={stats.total.toLocaleString()}
              sub={`of ${allBets.length.toLocaleString()}`} />
            <StatsCard label="Break-Even" value="52.4%" sub="at -110 juice" color="text-white/60" />
          </div>

          {/* By Game Number */}
          <h3 className="text-xs font-bold text-white/40 uppercase tracking-widest mb-3">Win Rate by Game # After Return</h3>
          <div className="bg-white/5 rounded-xl p-4 mb-6">
            <div className="space-y-2">
              {Object.entries(stats.byGn).filter(([, d]) => d.total > 0).sort((a, b) => Number(a[0]) - Number(b[0])).map(([gn, d]) => {
                const wr = d.correct / d.total;
                const roi = d.profit / d.total * 100;
                return (
                  <div key={gn} className="flex items-center gap-3 text-xs">
                    <span className="w-8 text-white/40 shrink-0 text-right tabular-nums">G{gn}</span>
                    <div className="flex-1 h-5 bg-white/5 rounded overflow-hidden relative">
                      <div className={`h-full rounded ${wr > 0.524 ? "bg-green-500/40" : "bg-red-500/30"}`}
                        style={{ width: `${Math.max(wr * 100, 2)}%` }} />
                      <span className="absolute inset-0 flex items-center justify-center text-[10px] text-white/60 font-medium tabular-nums">
                        {(wr * 100).toFixed(1)}% ({d.correct}/{d.total}) · ROI {roi >= 0 ? "+" : ""}{roi.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* By EV Tier */}
          <h3 className="text-xs font-bold text-white/40 uppercase tracking-widest mb-3">Win Rate by EV Tier</h3>
          <div className="bg-white/5 rounded-xl p-4 mb-6">
            <div className="space-y-2">
              {["<5%", "5-10%", "10-20%", "20-30%", "30-50%", "≥50%"].map((tier) => {
                const d = stats.byEv[tier];
                if (!d || d.total === 0) return null;
                const wr = d.correct / d.total;
                const roi = d.profit / d.total * 100;
                return (
                  <div key={tier} className="flex items-center gap-3 text-xs">
                    <span className="w-14 text-white/40 shrink-0 text-right tabular-nums">{tier}</span>
                    <div className="flex-1 h-5 bg-white/5 rounded overflow-hidden relative">
                      <div className={`h-full rounded ${wr > 0.524 ? "bg-green-500/40" : "bg-red-500/30"}`}
                        style={{ width: `${Math.max(wr * 100, 2)}%` }} />
                      <span className="absolute inset-0 flex items-center justify-center text-[10px] text-white/60 font-medium tabular-nums">
                        {(wr * 100).toFixed(1)}% ({d.correct}/{d.total}) · ROI {roi >= 0 ? "+" : ""}{roi.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* By Confidence + Market */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-6">
            <div>
              <h3 className="text-xs font-bold text-white/40 uppercase tracking-widest mb-3">By Confidence</h3>
              <div className="space-y-2">
                {(["High", "Medium", "Low"] as const).map((conf) => {
                  const d = stats.byConf[conf];
                  if (d.total === 0) return null;
                  return (
                    <div key={conf} className="bg-white/5 rounded-xl p-3 text-center">
                      <p className="text-[10px] text-white/40 mb-1">{conf}</p>
                      <p className="text-lg font-bold">{(d.correct / d.total * 100).toFixed(1)}%</p>
                      <p className="text-[10px] text-white/30">{d.correct}/{d.total} · ROI {(d.profit / d.total * 100).toFixed(1)}%</p>
                    </div>
                  );
                })}
              </div>
            </div>
            <div>
              <h3 className="text-xs font-bold text-white/40 uppercase tracking-widest mb-3">By Market</h3>
              <div className="space-y-2">
                {Object.entries(stats.byMarket).sort((a, b) => b[1].total - a[1].total).map(([market, d]) => (
                  <div key={market} className="bg-white/5 rounded-xl p-3 text-center">
                    <p className="text-[10px] text-white/40 mb-1">{MARKET_LABELS[market] ?? market}</p>
                    <p className="text-lg font-bold">{(d.correct / d.total * 100).toFixed(1)}%</p>
                    <p className="text-[10px] text-white/30">{d.correct}/{d.total} · ROI {(d.profit / d.total * 100).toFixed(1)}%</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function LeagueStatTableWrapper() {
  const { data: summaryData, isLoading: summaryLoading } = useBacktestSummaries();
  if (summaryLoading) return <div className="text-white/30 text-center py-6">Loading summaries...</div>;
  if (!summaryData || Object.keys(summaryData.summaries).length === 0) return <div className="text-white/30 text-center py-6">No backtest data available</div>;
  return <LeagueStatTable allData={{}} modelMeta={summaryData.modelMeta} summaries={summaryData.summaries} />;
}

// ─── Game Time Helper ────────────────────────────────────────────────────────

function formatGameTime(commenceTime: string | null | undefined, gameDate: string): { label: string; started: boolean; soon: boolean } {
  const today = new Date().toISOString().slice(0, 10);
  const isTomorrow = gameDate > today;
  if (!commenceTime) return { label: isTomorrow ? "Tomorrow" : gameDate, started: false, soon: false };
  const ct = new Date(commenceTime);
  const now = new Date();
  if (now >= ct) return { label: "Live", started: true, soon: false };
  const minsUntil = (ct.getTime() - now.getTime()) / 60000;
  const isSoon = minsUntil <= 30;
  const timeStr = ct.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const soonLabel = isSoon ? `${Math.ceil(minsUntil)}min · ${timeStr}` : timeStr;
  return { label: isTomorrow ? `Tomorrow ${timeStr}` : soonLabel, started: false, soon: isSoon };
}

// ─── Today's / Tomorrow's Model Bets ──────────────────────────────────────────

interface StoredPrediction {
  player_name: string;
  league: string;
  model: string;
  market: string;
  game_date: string;
  prop_line: number | null;
  over_odds: string | null;
  under_odds: string | null;
  p_over: number;
  ev: number;
  recommendation: string;
  game_number_back: number;
  injury_type: string;
  days_missed: number;
  baseline: number;
  recent_avg: number;
  form_ratio: number;
  curve_pct: number;
  position: string;
  kelly_fraction: number;
  features_json: Record<string, number>;
  predicted_at: string;
  // Enriched from props
  commence_time?: string | null;
  home_team?: string | null;
  away_team?: string | null;
}

/** Fetch ALL model predictions across all leagues and models */
function useAllModelPredictions() {
  return useQuery<StoredPrediction[]>({
    queryKey: ["all-model-predictions"],
    queryFn: async () => {
      const MODELS = ["model_c", "model_d", "model_e", "model_f", "model_g", "model_h", "model_f2"];
      const predKeys = BACKTEST_LEAGUES.flatMap((l) => MODELS.map((m) => `${l}_${m}_predictions`));
      const { data, error } = await supabase
        .from("back_in_play_backtest_results")
        .select("league, results")
        .in("league", predKeys);
      if (error || !data) return [];

      const all: StoredPrediction[] = [];
      for (const row of data) {
        const parsed = typeof row.results === "string" ? JSON.parse(row.results) : row.results;
        const preds: StoredPrediction[] = parsed.predictions ?? [];
        all.push(...preds);
      }

      // Enrich with commence_time from player_props
      const gameDates = [...new Set(all.map((p) => p.game_date))];
      if (gameDates.length > 0) {
        const { data: propsData } = await supabase
          .from("back_in_play_player_props")
          .select("player_name, game_date, commence_time, home_team, away_team")
          .in("game_date", gameDates)
          .limit(2000);
        if (propsData) {
          const propMap = new Map<string, { commence_time: string | null; home_team: string | null; away_team: string | null }>();
          for (const p of propsData) {
            const key = `${p.player_name}|${p.game_date}`;
            if (!propMap.has(key) && p.commence_time) propMap.set(key, p);
          }
          for (const pred of all) {
            const match = propMap.get(`${pred.player_name}|${pred.game_date}`);
            if (match) {
              pred.commence_time = match.commence_time;
              pred.home_team = match.home_team;
              pred.away_team = match.away_team;
            }
          }
        }
      }

      all.sort((a, b) => {
        const timeA = a.commence_time ?? "9999";
        const timeB = b.commence_time ?? "9999";
        if (timeA !== timeB) return timeA > timeB ? 1 : -1;
        if (a.game_date !== b.game_date) return a.game_date > b.game_date ? 1 : -1;
        return Math.abs(b.ev) - Math.abs(a.ev);
      });
      return all;
    },
    staleTime: 5 * 60 * 1000,
  });
}

const MODEL_CONFIG_PASSWORD = "sonic_77";

function TodaysBets() {
  const { data: allPredictions = [], isLoading } = useAllModelPredictions();

  // Load Final Betting Models from Supabase (same source as LeagueStatTable)
  const [finalModels, setFinalModels] = useState<SavedBetGlobal[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);

  useEffect(() => {
    supabase.from("back_in_play_app_config")
      .select("value")
      .eq("key", "final_betting_models")
      .single()
      .then(({ data }) => {
        if (data?.value && Array.isArray(data.value)) {
          setFinalModels(data.value as SavedBetGlobal[]);
        }
        setModelsLoaded(true);
      })
      .catch(() => setModelsLoaded(true));
  }, []);

  // Match predictions against Final Betting Models configs
  const filtered = useMemo(() => {
    if (!finalModels.length || !allPredictions.length) return [];

    return allPredictions.filter((p) => {
      // Check if any Final Betting Model config matches this prediction
      return finalModels.some((fm) => {
        // Match league
        if (fm.league !== p.league) return false;
        // Match model (fm.model is like "Model D", p.model is like "model_d")
        const fmModelKey = MODEL_SUFFIXES.find((m) => m.label === fm.model)?.suffix.replace(/^_/, "");
        if (fmModelKey && fmModelKey !== p.model) return false;
        // Match market (fm.market is like "player_points" or "ALL")
        if (fm.market !== "ALL" && fm.market !== p.market) return false;
        // EV threshold
        if (fm.evMin > 0 && Math.abs(p.ev) < fm.evMin) return false;
        // Games back range
        const minGn = (fm as any).minGn ?? 1;
        if (p.game_number_back < minGn || p.game_number_back > fm.maxGn) return false;
        return true;
      });
    });
  }, [allPredictions, finalModels]);

  if (isLoading || !modelsLoaded) return <div className="text-white/30 text-center py-6">Loading predictions...</div>;

  return (
    <div className="mb-8">
      <h2 className="text-lg font-bold mb-2">Today's & Tomorrow's Bets</h2>
      <p className="text-[11px] text-white/40 mb-4">
        Filtered by your <span className="text-white/60">Final Betting Models</span> — {finalModels.length} active configs.
        Add models in the League/Stat Breakdown table above.
      </p>

      {finalModels.length === 0 ? (
        <div className="text-white/30 text-center py-8 bg-white/[0.02] rounded-xl">
          No Final Betting Models configured. Add models from the table above using the + button.
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-white/30 text-center py-8 bg-white/[0.02] rounded-xl">
          {allPredictions.length === 0
            ? "No predictions stored yet. Run predict_live.py on the droplet."
            : `No predictions match your ${finalModels.length} Final Betting Models.`}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <p className="text-[10px] text-white/25 mb-2">
            {filtered.length} bets from {finalModels.length} model configs ·
            Generated {allPredictions[0]?.predicted_at ? new Date(allPredictions[0].predicted_at).toLocaleString() : "—"}
          </p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-white/40 border-b border-white/10">
                <th className="text-left py-2 px-2">Player</th>
                <th className="text-left py-2 px-2">League</th>
                <th className="text-left py-2 px-2">Injury</th>
                <th className="text-center py-2 px-2">G#</th>
                <th className="text-left py-2 px-2">Market</th>
                <th className="text-right py-2 px-2">Line</th>
                <th className="text-right py-2 px-2">Odds</th>
                <th className="text-center py-2 px-2">Rec</th>
                <th className="text-right py-2 px-2">EV</th>
                <th className="text-right py-2 px-2">Kelly</th>
                <th className="text-left py-2 px-2">Game</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p, i) => {
                const hasOdds = p.prop_line != null && (p.over_odds || p.under_odds);
                const gt = formatGameTime(p.commence_time, p.game_date);
                return (
                  <tr key={i} className={`border-b border-white/5 hover:bg-white/[0.03] ${
                    gt.started ? "bg-green-500/[0.04] border-l-2 border-l-green-500/30" :
                    gt.soon ? "bg-amber-500/[0.04] border-l-2 border-l-amber-500/30" : ""
                  }`}>
                    <td className="py-1.5 px-2 font-medium">{p.player_name}</td>
                    <td className="py-1.5 px-2 text-white/50">{LEAGUE_LABELS[p.league] ?? p.league}</td>
                    <td className="py-1.5 px-2 text-white/40 max-w-[80px] truncate">{p.injury_type}</td>
                    <td className="py-1.5 px-2 text-center">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                        p.game_number_back <= 2 ? "bg-amber-500/20 text-amber-400" : "bg-white/5 text-white/50"
                      }`}>G{p.game_number_back}</span>
                    </td>
                    <td className="py-1.5 px-2">{MARKET_LABELS[p.market] ?? p.market}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">
                      {hasOdds ? p.prop_line?.toFixed(1) : <span className="text-white/20 italic">—</span>}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-white/40">
                      {hasOdds ? `${p.over_odds ?? "—"} / ${p.under_odds ?? "—"}` : "—"}
                    </td>
                    <td className="py-1.5 px-2 text-center">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        p.recommendation === "OVER" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"
                      }`}>{p.recommendation}</span>
                    </td>
                    <td className={`py-1.5 px-2 text-right tabular-nums font-medium ${
                      p.ev > 0 ? "text-green-400" : "text-red-400/70"
                    }`}>
                      {p.ev >= 0 ? "+" : ""}{p.ev.toFixed(1)}%
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-white/40">
                      {p.kelly_fraction > 0 ? `${(p.kelly_fraction * 100).toFixed(1)}%` : "—"}
                    </td>
                    <td className="py-1.5 px-2">
                      <div className="flex flex-col gap-0.5">
                        {p.home_team && p.away_team && (
                          <span className="text-[9px] text-white/35 whitespace-nowrap">{p.away_team} @ {p.home_team}</span>
                        )}
                        <span className={`text-[10px] font-medium whitespace-nowrap ${gt.started ? "text-green-400" : gt.soon ? "text-amber-400" : "text-white/40"}`}>
                          {gt.started && <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse mr-1 align-middle" />}
                          {gt.soon && !gt.started && <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse mr-1 align-middle" />}
                          {gt.label}
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Type for Final Betting Models loaded from Supabase (matches SavedBet from LeagueStatTable) */
interface SavedBetGlobal {
  league: string;
  market: string;
  model: string;
  evMin: number;
  maxGn: number;
  minGn?: number;
  season: string;
  oddsMode?: string;
  bets: number;
  winRate: number;
  flatRoi: number;
  flatBr: number;
  pEdge: number;
  [key: string]: unknown;
}

// ─── Adaptive Strategies Section ─────────────────────────────────────────────

interface AdaptiveResult {
  league: string;
  model: string;
  max_gn: number | null;
  ev_threshold: number;
  roi_threshold: number;
  total_bets: number;
  original_total_bets: number;
  bets: BacktestBet[];
  adaptive_history: {
    season: string;
    filter_applied: boolean;
    filter_combos?: string[];
    total_bets: number;
    kept_bets: number;
    dropped_bets?: number;
    combo_roi?: Record<string, number>;
    combo_br?: Record<string, number>;
    profitable_combos: string[];
  }[];
}

const ADAPTIVE_MODELS = ["c", "d", "e", "f"] as const;
const ADAPTIVE_GN = [1, 2, 3, 5, 10, 0] as const; // 0 = no cap
const ADAPTIVE_EV = [0, 5, 10, 15, 20] as const;

function useAdaptiveResults() {
  return useQuery<Record<string, AdaptiveResult>>({
    queryKey: ["adaptive-strategies"],
    queryFn: async () => {
      // Query all adaptive results using a LIKE filter instead of a massive in() list
      const { data, error } = await supabase
        .from("back_in_play_backtest_results")
        .select("league, results")
        .like("league", "%_adaptive%")
        .limit(1000);
      if (error || !data) return {};
      const results: Record<string, AdaptiveResult> = {};
      for (const row of data) {
        const parsed = typeof row.results === "string" ? JSON.parse(row.results) : row.results;
        results[row.league] = parsed;
      }
      return results;
    },
    staleTime: 60 * 60 * 1000,
  });
}

/** Bankroll sim for adaptive bets: sort by date, bet 1% of current bankroll per bet. */
function adaptiveBankrollSim(bets: BacktestBet[], startBankroll = 100): number {
  let br = startBankroll;
  const sorted = [...bets].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  for (const b of sorted) {
    const stake = br * 0.01;
    if (b.correct) {
      br += stake * (b.pnl > 0 ? b.pnl : 0.909);
    } else {
      br -= stake;
    }
    if (br <= 0) return -100;
  }
  return br - startBankroll;
}

function AdaptiveStrategies() {
  const { data: allAdaptive, isLoading } = useAdaptiveResults();
  const [selModel, setSelModel] = useState<string>("e");
  const [selGn, setSelGn] = useState<number>(0);
  const [selEv, setSelEv] = useState<number>(0);
  const [expandedLeague, setExpandedLeague] = useState<string | null>(null);

  if (isLoading) return <div className="text-white/30 text-center py-6">Loading adaptive strategies...</div>;
  if (!allAdaptive || Object.keys(allAdaptive).length === 0) return null;

  // Build the key for the selected combo
  const buildKey = (league: string, model: string, gn: number, ev: number) => {
    const parts = [`model_${model}_adaptive`];
    if (gn > 0) parts.push(`gn${gn}`);
    if (ev > 0) parts.push(`ev${ev}`);
    return `${league}_${parts.join("_")}`;
  };

  // Summary rows for selected filters
  const rows: { league: string; result: AdaptiveResult; key: string }[] = [];
  for (const league of BACKTEST_LEAGUES) {
    const key = buildKey(league, selModel, selGn, selEv);
    if (allAdaptive[key]) {
      rows.push({ league, result: allAdaptive[key], key });
    }
  }

  const gnLabel = (gn: number) => gn === 0 ? "All" : `G1${gn > 1 ? `-G${gn}` : ""}`;
  const evLabel = (ev: number) => ev === 0 ? "All" : `≥${ev}%`;

  // Available options (only show ones that have data)
  const availableModels = ADAPTIVE_MODELS.filter(m =>
    BACKTEST_LEAGUES.some(l => allAdaptive[buildKey(l, m, selGn, selEv)])
  );
  const availableGn = ADAPTIVE_GN.filter(gn =>
    BACKTEST_LEAGUES.some(l => allAdaptive[buildKey(l, selModel, gn, selEv)])
  );
  const availableEv = ADAPTIVE_EV.filter(ev =>
    BACKTEST_LEAGUES.some(l => allAdaptive[buildKey(l, selModel, selGn, ev)])
  );

  return (
    <div className="mb-8">
      <div className="flex items-center gap-3 mb-1">
        <h2 className="text-lg font-bold">Adaptive Strategies</h2>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-400/80 font-semibold">
          Walk-Forward
        </span>
      </div>
      <p className="text-[11px] text-white/40 mb-4">
        Year N results decide which (market, side) combos to bet in Year N+1. Only combos with ROI &gt;10% carry forward.
      </p>

      {/* Model selector */}
      <div className="mb-3">
        <p className="text-[10px] text-white/30 mb-1.5">Model</p>
        <div className="flex flex-wrap gap-1.5">
          {ADAPTIVE_MODELS.map(m => (
            <button key={m} onClick={() => setSelModel(m)}
              disabled={!availableModels.includes(m)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                selModel === m
                  ? "bg-violet-500/20 text-violet-300 border-violet-500/30"
                  : availableModels.includes(m)
                    ? "bg-white/5 text-white/50 hover:text-white/70 border-transparent"
                    : "bg-white/[0.02] text-white/15 border-transparent cursor-not-allowed"
              }`}>
              Model {m.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Games back + EV selectors */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <p className="text-[10px] text-white/30 mb-1.5">Games Back</p>
          <div className="flex flex-wrap gap-1.5">
            {ADAPTIVE_GN.map(gn => (
              <button key={gn} onClick={() => setSelGn(gn)}
                disabled={!availableGn.includes(gn)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors border ${
                  selGn === gn
                    ? "bg-violet-500/20 text-violet-300 border-violet-500/30"
                    : availableGn.includes(gn)
                      ? "bg-white/5 text-white/50 hover:text-white/70 border-transparent"
                      : "bg-white/[0.02] text-white/15 border-transparent cursor-not-allowed"
                }`}>
                {gnLabel(gn)}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="text-[10px] text-white/30 mb-1.5">Min EV</p>
          <div className="flex flex-wrap gap-1.5">
            {ADAPTIVE_EV.map(ev => (
              <button key={ev} onClick={() => setSelEv(ev)}
                disabled={!availableEv.includes(ev)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors border ${
                  selEv === ev
                    ? "bg-violet-500/20 text-violet-300 border-violet-500/30"
                    : availableEv.includes(ev)
                      ? "bg-white/5 text-white/50 hover:text-white/70 border-transparent"
                      : "bg-white/[0.02] text-white/15 border-transparent cursor-not-allowed"
                }`}>
                {evLabel(ev)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Results table */}
      {rows.length === 0 ? (
        <p className="text-white/30 text-xs text-center py-4">No adaptive results for this combination.</p>
      ) : (
        <div className="space-y-3">
          {rows.map(({ league, result }) => {
            const wins = result.bets.filter(b => b.correct).length;
            const pnl = result.bets.reduce((s, b) => s + b.pnl, 0);
            const _roi = result.total_bets > 0 ? (pnl / result.total_bets * 100) : 0; void _roi;
            const isExpanded = expandedLeague === league;

            return (
              <div key={league} className="bg-white/[0.03] rounded-xl overflow-hidden">
                {/* Summary row */}
                <button className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-white/[0.02]"
                  onClick={() => setExpandedLeague(isExpanded ? null : league)}>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium">{LEAGUE_LABELS[league] ?? league}</span>
                    <span className="text-[10px] text-white/30">{result.total_bets} bets (of {result.original_total_bets})</span>
                  </div>
                  <div className="flex items-center gap-4 text-xs tabular-nums">
                    {(() => {
                      const br = adaptiveBankrollSim(result.bets);
                      return (
                        <span className={br > 0 ? "text-green-400" : "text-red-400/70"}>
                          BR {br >= 0 ? "+" : ""}{br.toFixed(1)}%
                        </span>
                      );
                    })()}
                    <span className={pnl > 0 ? "text-green-400" : "text-red-400/70"}>
                      {pnl >= 0 ? "+" : ""}{pnl.toFixed(1)}u
                    </span>
                    <span className="text-white/40">
                      Win {(wins / result.total_bets * 100).toFixed(1)}%
                    </span>
                    <span className="text-white/20">{isExpanded ? "▲" : "▼"}</span>
                  </div>
                </button>

                {/* Expanded: year-by-year prop selection */}
                {isExpanded && result.adaptive_history && (
                  <div className="px-4 pb-4 space-y-3">
                    {result.adaptive_history.map((h) => (
                      <div key={h.season} className="bg-white/[0.03] rounded-lg p-3">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-medium">{h.season}</span>
                          <div className="flex items-center gap-3 text-[10px]">
                            {h.filter_applied ? (
                              <span className="text-violet-400/70">
                                {h.kept_bets} kept / {h.total_bets} total ({h.dropped_bets} filtered out)
                              </span>
                            ) : (
                              <span className="text-white/30">Baseline — {h.total_bets} bets (no filter)</span>
                            )}
                          </div>
                        </div>

                        {/* Which combos are active */}
                        {h.filter_applied && h.filter_combos && (
                          <div className="mb-2">
                            <p className="text-[9px] text-white/25 mb-1">Betting on (from prior year):</p>
                            <div className="flex flex-wrap gap-1">
                              {h.filter_combos.map(c => {
                                const [market, side] = c.split("|");
                                return (
                                  <span key={c} className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${
                                    side === "OVER" ? "bg-green-500/10 text-green-400/60" : "bg-red-500/10 text-red-400/60"
                                  }`}>
                                    {MARKET_LABELS[market] ?? market} {side}
                                  </span>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Combo bankroll/ROI breakdown */}
                        <div className="space-y-1">
                          {Object.entries(h.combo_br ?? h.combo_roi ?? {})
                            .sort(([, a], [, b]) => b - a)
                            .map(([combo, val]) => {
                              const [market, side] = combo.split("|");
                              const isProfitable = h.profitable_combos.includes(combo);
                              const isBr = !!h.combo_br;
                              return (
                                <div key={combo} className="flex items-center gap-2 text-[10px]">
                                  <span className={`w-3 h-3 rounded-full shrink-0 ${isProfitable ? "bg-green-500/30" : "bg-red-500/20"}`} />
                                  <span className="text-white/50 w-24 truncate">{MARKET_LABELS[market] ?? market}</span>
                                  <span className={`w-12 ${side === "OVER" ? "text-green-400/50" : "text-red-400/50"}`}>{side}</span>
                                  <span className={`tabular-nums ${val > 0 ? "text-green-400/70" : "text-red-400/50"}`}>
                                    {val >= 0 ? "+" : ""}{isBr ? `$${val.toFixed(2)}` : `${val.toFixed(1)}%`}
                                  </span>
                                  {isProfitable && <span className="text-[8px] text-violet-400/50">→ next year</span>}
                                </div>
                              );
                            })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AdaptiveStrategiesWrapper() {
  const { data, isLoading } = useAdaptiveResults();
  if (isLoading) return <div className="text-white/30 text-center py-6">Loading...</div>;
  if (!data || Object.keys(data).length === 0) return null;
  return <AdaptiveStrategies />;
}

function PasswordGate({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState(() => sessionStorage.getItem("ma_auth") === "1");
  const [pw, setPw] = useState("");
  if (authed) return <>{children}</>;
  return (
    <div className="min-h-screen bg-[#0A0E1A] flex items-center justify-center">
      <form onSubmit={(e) => { e.preventDefault(); if (pw === MODEL_ANALYSIS_PASSWORD) { sessionStorage.setItem("ma_auth", "1"); setAuthed(true); } else { setPw(""); } }}
        className="bg-white/5 border border-white/10 rounded-xl p-6 w-full max-w-xs">
        <p className="text-sm text-white/60 mb-3">This page is password protected.</p>
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password"
          className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-blue-500/40 mb-3" autoFocus />
        <button type="submit" className="w-full rounded-lg bg-blue-500/20 border border-blue-500/25 px-4 py-2 text-sm font-medium text-blue-300/80 hover:bg-blue-500/30 transition-colors">Enter</button>
      </form>
    </div>
  );
}

export default function ModelAnalysisPage() {
  const { data: settled, isLoading } = useModelAnalysis();
  const [minEv, setMinEv] = useState(0);

  const filtered = useMemo(() => {
    if (!settled) return [];
    if (minEv === 0) return settled;
    return settled.filter((s) => s.ev.bestEv != null && s.ev.bestEv * 100 >= minEv);
  }, [settled, minEv]);

  const stats = useMemo(() => {
    if (filtered.length === 0) return null;
    const wins = filtered.filter((s) => s.modelCorrect).length;
    const total = filtered.length;
    const winRate = wins / total;
    const totalProfit = filtered.reduce((s, p) => s + p.betProfit, 0);
    const roi = totalProfit / total;

    // By confidence
    const byConf = { High: { w: 0, t: 0, p: 0 }, Medium: { w: 0, t: 0, p: 0 }, Low: { w: 0, t: 0, p: 0 } };
    for (const s of filtered) {
      const c = byConf[s.ev.confidence];
      c.t++;
      if (s.modelCorrect) c.w++;
      c.p += s.betProfit;
    }

    // By side
    const overBets = filtered.filter((s) => s.ev.recommendation === "OVER");
    const underBets = filtered.filter((s) => s.ev.recommendation === "UNDER");
    const overWins = overBets.filter((s) => s.modelCorrect).length;
    const underWins = underBets.filter((s) => s.modelCorrect).length;

    return { wins, total, winRate, totalProfit, roi, byConf, overBets: overBets.length, underBets: underBets.length, overWins, underWins };
  }, [filtered]);

  const evThresholds = [0, 5, 10, 15, 20, 30, 50];

  return (
    <PasswordGate>
    <div className="min-h-screen bg-[#0a0f1a] text-white">
      <SiteHeader />
      <div className="max-w-3xl lg:max-w-[1400px] mx-auto px-4 lg:px-10 py-6">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-2xl font-bold">Model Analysis</h1>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400/80 font-semibold">Local Only</span>
          <a href="/model-analysis-all" className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400/60 hover:text-blue-400 transition-colors">
            All Players →
          </a>
          <a href="/model-analysis-teams" className="text-[10px] px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-400/60 hover:text-orange-400 transition-colors">
            Teams →
          </a>
        </div>
        <p className="text-sm text-white/40 mb-6">
          Historical backtest + live model tracking for injury-adjusted player props.
        </p>

        {/* League / Stat breakdown table (uses pre-computed summaries) */}
        <LeagueStatTableWrapper />

        {/* Today's / Tomorrow's Bets */}
        <TodaysBets />

        {/* Adaptive strategies */}
        <AdaptiveStrategiesWrapper />

        {/* Edge Validation — statistical significance testing */}
        <EdgeValidation />

        <h2 className="text-lg font-bold mb-1">Live Model Tracking</h2>
        <p className="text-[11px] text-white/40 mb-4">
          Real-time results from the heuristic EV model. Shows all settled props where the model had a recommendation, computed from live scraped odds and injury curves. Not a backtest — these are actual forward predictions.
        </p>

        {isLoading && (
          <div className="text-center py-20 text-white/30">Loading settled props...</div>
        )}

        {!isLoading && (!settled || settled.length === 0) && (
          <div className="text-center py-20 text-white/30">No settled props with model recommendations found.</div>
        )}

        {stats && (
          <>
            {/* EV threshold filter */}
            <div className="mb-6">
              <p className="text-[11px] text-white/40 mb-2">Filter by minimum EV %</p>
              <div className="flex flex-wrap gap-1.5">
                {evThresholds.map((t) => (
                  <button
                    key={t}
                    onClick={() => setMinEv(t)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      minEv === t
                        ? "bg-[#1C7CFF]/20 text-[#1C7CFF] border border-[#1C7CFF]/30"
                        : "bg-white/5 text-white/50 hover:text-white/70 border border-transparent"
                    }`}
                  >
                    {t === 0 ? "All" : `≥ ${t}%`}
                  </button>
                ))}
              </div>
            </div>

            {/* Overall stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
              <StatsCard
                label="Win Rate"
                value={`${(stats.winRate * 100).toFixed(1)}%`}
                sub={`${stats.wins}/${stats.total}`}
                color={stats.winRate > 0.52 ? "text-green-400" : stats.winRate < 0.48 ? "text-red-400" : "text-white"}
              />
              <StatsCard
                label="ROI"
                value={`${(stats.roi * 100).toFixed(1)}%`}
                sub={`${stats.totalProfit >= 0 ? "+" : ""}${stats.totalProfit.toFixed(2)}u`}
                color={stats.roi > 0 ? "text-green-400" : "text-red-400"}
              />
              <StatsCard
                label="Over Bets"
                value={`${stats.overBets > 0 ? ((stats.overWins / stats.overBets) * 100).toFixed(0) : 0}%`}
                sub={`${stats.overWins}/${stats.overBets}`}
              />
              <StatsCard
                label="Under Bets"
                value={`${stats.underBets > 0 ? ((stats.underWins / stats.underBets) * 100).toFixed(0) : 0}%`}
                sub={`${stats.underWins}/${stats.underBets}`}
              />
            </div>

            {/* By confidence */}
            <h3 className="text-xs font-bold text-white/40 uppercase tracking-widest mb-3">By Confidence</h3>
            <div className="grid grid-cols-3 gap-3 mb-6">
              {(["High", "Medium", "Low"] as const).map((conf) => {
                const c = stats.byConf[conf];
                const wr = c.t > 0 ? (c.w / c.t * 100).toFixed(0) : "—";
                const roi = c.t > 0 ? (c.p / c.t * 100).toFixed(1) : "—";
                return (
                  <div key={conf} className="bg-white/5 rounded-xl p-3 text-center">
                    <p className="text-[10px] text-white/40 mb-1">{conf}</p>
                    <p className="text-lg font-bold">{wr}%</p>
                    <p className="text-[10px] text-white/30">{c.w}/{c.t} · ROI {roi}%</p>
                  </div>
                );
              })}
            </div>

            {/* Win rate by EV tier chart */}
            <h3 className="text-xs font-bold text-white/40 uppercase tracking-widest mb-3">Win Rate by EV Tier</h3>
            <div className="bg-white/5 rounded-xl p-4 mb-6">
              <div className="space-y-2">
                {[
                  { label: "0–5%", min: 0, max: 5 },
                  { label: "5–10%", min: 5, max: 10 },
                  { label: "10–20%", min: 10, max: 20 },
                  { label: "20–30%", min: 20, max: 30 },
                  { label: "30–50%", min: 30, max: 50 },
                  { label: "50%+", min: 50, max: 999 },
                ].map(({ label, min, max }) => {
                  const tier = (settled ?? []).filter((s) => {
                    const pct = (s.ev.bestEv ?? 0) * 100;
                    return pct >= min && pct < max;
                  });
                  const wins = tier.filter((s) => s.modelCorrect).length;
                  const total = tier.length;
                  const wr = total > 0 ? wins / total : 0;
                  return (
                    <div key={label} className="flex items-center gap-3 text-xs">
                      <span className="w-14 text-white/40 shrink-0 text-right tabular-nums">{label}</span>
                      <div className="flex-1 h-5 bg-white/5 rounded overflow-hidden relative">
                        <div
                          className={`h-full rounded transition-all ${wr > 0.52 ? "bg-green-500/40" : wr > 0.48 ? "bg-white/15" : "bg-red-500/40"}`}
                          style={{ width: `${Math.max(wr * 100, 2)}%` }}
                        />
                        {total > 0 && (
                          <span className="absolute inset-0 flex items-center justify-center text-[10px] text-white/60 font-medium tabular-nums">
                            {(wr * 100).toFixed(0)}% ({wins}/{total})
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Recent settled props */}
            <h3 className="text-xs font-bold text-white/40 uppercase tracking-widest mb-3">
              Settled Props ({filtered.length})
            </h3>
            <div className="space-y-1.5">
              {filtered.slice(0, 50).map((s) => (
                <div
                  key={s.propId}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg text-xs ${
                    s.modelCorrect ? "bg-green-500/[0.06] border border-green-500/10" : "bg-red-500/[0.06] border border-red-500/10"
                  }`}
                >
                  <span className={`text-sm font-bold w-5 text-center ${s.modelCorrect ? "text-green-400" : "text-red-400"}`}>
                    {s.modelCorrect ? "✓" : "✗"}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{s.playerName}</p>
                    <p className="text-[10px] text-white/30">
                      {s.gameDate} · {s.injuryType} · {s.gamesBack}G back
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-medium tabular-nums">
                      {MARKET_LABELS[s.market] ?? s.market} {s.line}
                    </p>
                    <p className="text-[10px] text-white/40 tabular-nums">
                      Actual: {s.actualValue} ({s.actualResult})
                    </p>
                  </div>
                  <div className="text-right shrink-0 w-20">
                    <p className={`font-bold tabular-nums ${s.ev.recommendation === "OVER" ? "text-green-400/80" : "text-red-400/80"}`}>
                      {s.ev.recommendation} {formatEV(s.ev.bestEv!)}
                    </p>
                    <p className={`text-[10px] tabular-nums ${s.betProfit >= 0 ? "text-green-400/60" : "text-red-400/60"}`}>
                      {s.betProfit >= 0 ? "+" : ""}{s.betProfit.toFixed(2)}u
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
    </PasswordGate>
  );
}
