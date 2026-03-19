import { useState, useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { useQuery } from "@tanstack/react-query";
import { SiteHeader } from "../components/SiteHeader";
import { supabase } from "../lib/supabase";
import { usePerformanceCurves } from "../features/performance-curves/lib/queries";
import { computeEV, formatEV, parseOdds, oddsToProfit, type EVResult } from "../lib/evModel";
import type { PerformanceCurve } from "../features/performance-curves/lib/types";

const MODEL_ANALYSIS_PASSWORD = "purplecobras";

const MARKET_TO_STAT: Record<string, string> = {
  player_points: "stat_pts", player_rebounds: "stat_reb", player_assists: "stat_ast",
  player_pass_yds: "stat_pass_yds", player_rush_yds: "stat_rush_yds",
  player_reception_yds: "stat_rec_yds", player_receptions: "stat_rec",
  player_goals: "stat_goals", player_shots_on_goal: "stat_sog",
  player_shots: "stat_sog", player_shots_on_target: "stat_sog",
  batter_hits: "stat_h", batter_total_bases: "stat_h", batter_rbis: "stat_rbi",
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

type OddsMode = "scrape" | "open" | "close";

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

function useBacktestBets() {
  return useQuery<{ bets: BacktestBet[]; byLeague: Record<string, BacktestBet[]>; modelMeta: Record<string, ModelMeta> }>({
    queryKey: ["backtest-bets-all"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("back_in_play_backtest_results")
        .select("league, results")
        .in("league", ALL_RESULT_KEYS);
      if (error || !data) return { bets: [], byLeague: {}, modelMeta: {} };
      const allBets: BacktestBet[] = [];
      const byLeague: Record<string, BacktestBet[]> = {};
      const modelMeta: Record<string, ModelMeta> = {};
      for (const row of data) {
        const parsed = typeof row.results === "string" ? JSON.parse(row.results) : row.results;
        const bets: BacktestBet[] = (parsed.bets ?? []).map((b: BacktestBet) => ({ ...b, league: row.league }));
        // Only include heuristic (no suffix) bets in allBets for the top-level backtest view
        if (!row.league.includes("_")) {
          allBets.push(...bets);
        }
        byLeague[row.league] = bets;
        if (parsed.features || parsed.feature_importance) {
          modelMeta[row.league] = {
            features: parsed.features ?? [],
            feature_importance: parsed.feature_importance ?? {},
            accuracy: parsed.accuracy,
            auc: parsed.auc,
            skip_counts: parsed.skip_counts,
            total_bets: parsed.total_bets,
          };
        }
      }
      return { bets: allBets, byLeague, modelMeta };
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

interface StatRow {
  league: string;
  market: string;
  model: string;
  bets: number;
  wins: number;
  winRate: number;
  flatPnl: number;      // unit-based PnL (sum of bet outcomes)
  flatRoi: number;       // unit ROI %
  flatBr: number;        // bankroll sim return % (bet unitPct% per bet)
  halfKellyPnl: number;  // half Kelly bankroll sim return %
  fullKellyPnl: number;  // full Kelly bankroll sim return %
}

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

function LeagueStatTable({ allData, modelMeta }: { allData: Record<string, BacktestBet[]>; modelMeta: Record<string, ModelMeta> }) {
  const [evThreshold, setEvThreshold] = useState(0);
  const [selectedModels, setSelectedModels] = useState<string[]>(MODEL_SUFFIXES.map((m) => m.suffix));
  const [showFeatures, setShowFeatures] = useState<string | null>(null);
  const [oddsMode, setOddsMode] = useState<OddsMode>("open");
  const [unitPct, setUnitPct] = useState(1); // 1u = 1% of bankroll by default
  const [seasonFilter, setSeasonFilter] = useState<string>("all");
  const [leagueFilter, setLeagueFilter] = useState<string>("all");
  const [selectedRow, setSelectedRow] = useState<StatRow | null>(null);
  const [maxGnFilter, setMaxGnFilter] = useState(10); // max games back filter
  const [minBetsFilter, setMinBetsFilter] = useState(20); // min bets to show a row
  const [minFlatBr, setMinFlatBr] = useState<number>(0); // min flat BR% filter — default to positive only
  const [showTableInfo, setShowTableInfo] = useState(false);

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

  // Collect all available seasons across all data
  const availableSeasons = useMemo(() => {
    const seasons = new Set<string>();
    for (const key of Object.keys(allData)) {
      for (const b of allData[key] ?? []) {
        seasons.add(getBetSeason(b));
      }
    }
    return ["all", ...Array.from(seasons).sort()];
  }, [allData]);

  const rows = useMemo(() => {
    const result: StatRow[] = [];
    for (const leagueBase of BACKTEST_LEAGUES) {
      if (leagueFilter !== "all" && leagueBase !== leagueFilter) continue;
      for (const { suffix, label } of MODEL_SUFFIXES) {
        if (!selectedModels.includes(suffix)) continue;
        const key = `${leagueBase}${suffix}`;
        const bets = (allData[key] ?? []).filter((b) => {
          if (b.ev < evThreshold) return false;
          if (seasonFilter !== "all" && getBetSeason(b) !== seasonFilter) return false;
          if (b.gn > maxGnFilter) return false;
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
        const wr = allWins / allBets.length;
        const allFlatPnl = allBets.reduce((s, b) => s + betPnl(b, oddsMode), 0);
        result.push({
          league: leagueBase, market: "ALL", model: label,
          bets: allBets.length, wins: allWins, winRate: wr,
          flatPnl: allFlatPnl,
          flatRoi: allFlatPnl / allBets.length * 100,
          flatBr: flatBankrollPnl(allBets, unitPct, oddsMode),
          halfKellyPnl: kellyProfit(allBets, 0.5, oddsMode),
          fullKellyPnl: kellyProfit(allBets, 1.0, oddsMode),
        });

        for (const [market, mBets] of Object.entries(byMarket)) {
          const mWins = mBets.filter((b) => betCorrect(b, oddsMode)).length;
          const mFlatPnl = mBets.reduce((s, b) => s + betPnl(b, oddsMode), 0);
          result.push({
            league: leagueBase, market, model: label,
            bets: mBets.length, wins: mWins,
            winRate: mWins / mBets.length,
            flatPnl: mFlatPnl,
            flatRoi: mFlatPnl / mBets.length * 100,
            flatBr: flatBankrollPnl(mBets, unitPct, oddsMode),
            halfKellyPnl: kellyProfit(mBets, 0.5, oddsMode),
            fullKellyPnl: kellyProfit(mBets, 1.0, oddsMode),
          });
        }
      }
    }
    // Sort: ALL rows first, then sub-rows; within each league group sort models by ROI (best first)
    result.sort((a, b) => {
      // Primary: league order
      const la = BACKTEST_LEAGUES.indexOf(a.league as any);
      const lb = BACKTEST_LEAGUES.indexOf(b.league as any);
      if (la !== lb) return la - lb;
      // Secondary: ALL rows before market sub-rows
      if (a.market === "ALL" && b.market === "ALL") return b.flatRoi - a.flatRoi; // best ROI first
      if (a.market === "ALL") return -1;
      if (b.market === "ALL") return 1;
      // Same league sub-rows: same model group, then by market
      return b.flatRoi - a.flatRoi;
    });
    // Filter out rows with fewer bets than minBetsFilter and below flat BR threshold
    return result.filter((r) => r.bets >= minBetsFilter && (minFlatBr <= -999 || r.flatBr >= minFlatBr));
  }, [allData, evThreshold, selectedModels, oddsMode, seasonFilter, leagueFilter, unitPct, maxGnFilter, minBetsFilter, minFlatBr]);

  const evOptions = [0, 5, 10, 15, 20, 30];

  const getModelColor = (label: string) =>
    MODEL_SUFFIXES.find((m) => m.label === label)?.color ?? "bg-white/5 text-white/50";

  return (
    <div className="mb-8">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-lg font-bold">League / Stat Breakdown</h2>
        <button
          onClick={() => setShowTableInfo(!showTableInfo)}
          className="shrink-0 w-6 h-6 rounded-full border border-white/15 text-white/35 hover:text-white/70 hover:border-white/30 transition-colors text-xs font-semibold flex items-center justify-center"
          title="Column explanations"
        >
          ?
        </button>
      </div>
      {showTableInfo && (
        <div className="rounded-lg bg-white/[0.04] border border-white/10 p-3 mb-4 text-[11px] text-white/50 space-y-1.5">
          <p><span className="text-white/70 font-medium">League</span> — Sports league (NBA, NHL, MLB, EPL)</p>
          <p><span className="text-white/70 font-medium">Stat</span> — Market type (ALL = combined, or specific like PTS, AST, etc.)</p>
          <p><span className="text-white/70 font-medium">Model</span> — Which LightGBM model variant (C, D, E, F) with different feature sets</p>
          <p><span className="text-white/70 font-medium">Bets</span> — Total number of bets placed in backtest</p>
          <p><span className="text-white/70 font-medium">Win%</span> — Percentage of bets that hit (green if &gt;52.4%)</p>
          <p><span className="text-white/70 font-medium">Flat ROI</span> — Return on investment per unit bet (flat staking)</p>
          <p><span className="text-white/70 font-medium">Flat BR%</span> — Bankroll % change using flat unit sizing, with units won/lost in parentheses</p>
          <p><span className="text-white/70 font-medium">Half Kelly BR%</span> — Bankroll % change using half-Kelly criterion sizing (conservative)</p>
          <p><span className="text-white/70 font-medium">Full Kelly BR%</span> — Bankroll % change using full Kelly criterion (aggressive, higher variance)</p>
        </div>
      )}

      {/* Model selector */}
      <div className="mb-4">
        <p className="text-[11px] text-white/40 mb-2">Models</p>
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setSelectedModels(MODEL_SUFFIXES.map((m) => m.suffix))}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
              selectedModels.length === MODEL_SUFFIXES.length
                ? "bg-white/10 text-white border-white/20"
                : "bg-white/[0.02] text-white/20 border-transparent"
            }`}>
            All
          </button>
          {MODEL_SUFFIXES.map((m) => (
            <button key={m.suffix} onClick={() => {
              setSelectedModels((prev) => {
                if (prev.includes(m.suffix)) {
                  // Don't allow deselecting the last model
                  const next = prev.filter((s) => s !== m.suffix);
                  return next.length > 0 ? next : prev;
                }
                return [...prev, m.suffix];
              });
            }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                selectedModels.includes(m.suffix)
                  ? `${m.color} border-current`
                  : "bg-white/[0.02] text-white/20 border-transparent"
              }`}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

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

      {/* Odds mode toggle */}
      <div className="mb-4">
        <p className="text-[11px] text-white/40 mb-2">Bet at Odds</p>
        <div className="flex flex-wrap gap-1.5">
          {([
            { value: "scrape" as OddsMode, label: "Scraped Odds" },
            { value: "open" as OddsMode, label: "Opening Odds" },
            { value: "close" as OddsMode, label: "Closing Odds" },
          ]).map(({ value, label }) => (
            <button key={value} onClick={() => setOddsMode(value)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                oddsMode === value
                  ? "bg-[#1C7CFF]/20 text-[#1C7CFF] border-[#1C7CFF]/30"
                  : "bg-white/5 text-white/50 hover:text-white/70 border-transparent"
              }`}>
              {label}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-white/25 mt-1">
          {oddsMode === "scrape" ? "PnL at odds from when props were scraped" :
           oddsMode === "open" ? "PnL if you bet at opening odds (best value)" :
           "PnL if you bet at closing odds (market-adjusted)"}
          {oddsMode !== "scrape" && " — only available for Model D bets with open/close data"}
        </p>
      </div>

      {/* League filter */}
      <div className="mb-4">
        <p className="text-[11px] text-white/40 mb-2">League</p>
        <div className="flex flex-wrap gap-1.5">
          {["all", ...BACKTEST_LEAGUES].map((l) => (
            <button key={l} onClick={() => setLeagueFilter(l)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                leagueFilter === l
                  ? "bg-[#1C7CFF]/20 text-[#1C7CFF] border-[#1C7CFF]/30"
                  : "bg-white/5 text-white/50 hover:text-white/70 border-transparent"
              }`}>
              {LEAGUE_LABELS[l] ?? l}
            </button>
          ))}
        </div>
      </div>

      {/* Season filter */}
      <div className="mb-4">
        <p className="text-[11px] text-white/40 mb-2">Season</p>
        <div className="flex flex-wrap gap-1.5">
          {availableSeasons.map((s) => (
            <button key={s} onClick={() => setSeasonFilter(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                seasonFilter === s
                  ? "bg-amber-500/20 text-amber-400 border-amber-500/30"
                  : "bg-white/5 text-white/50 hover:text-white/70 border-transparent"
              }`}>
              {s === "all" ? "All Seasons" : s}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4">
        <p className="text-[11px] text-white/40 mb-2">Min EV % threshold</p>
        <div className="flex flex-wrap gap-1.5">
          {evOptions.map((t) => (
            <button key={t} onClick={() => setEvThreshold(t)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                evThreshold === t ? "bg-[#1C7CFF]/20 text-[#1C7CFF] border border-[#1C7CFF]/30" : "bg-white/5 text-white/50 hover:text-white/70 border border-transparent"
              }`}>
              {t === 0 ? "All" : `>=${t}%`}
            </button>
          ))}
        </div>
      </div>

      {/* Unit size selector */}
      <div className="mb-4">
        <p className="text-[11px] text-white/40 mb-2">Unit Size (% of bankroll)</p>
        <div className="flex flex-wrap gap-1.5">
          {[0.5, 1, 2, 3, 5].map((pct) => (
            <button key={pct} onClick={() => setUnitPct(pct)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                unitPct === pct
                  ? "bg-[#3DFF8F]/20 text-[#3DFF8F] border-[#3DFF8F]/30"
                  : "bg-white/5 text-white/50 hover:text-white/70 border-transparent"
              }`}>
              {pct}%
            </button>
          ))}
        </div>
        <p className="text-[10px] text-white/25 mt-1">1u = {unitPct}% of bankroll. Flat PnL shown as bankroll %.</p>
        <p className="text-[10px] text-white/25 mt-0.5">Flat PnL bets a fixed amount each time. Kelly sizes each bet as a % of current bankroll — bets shrink as you lose, grow as you win. Kelly shows 0% when the edge isn't large enough to bet.</p>
      </div>

      {/* Games back filter */}
      <div className="mb-4">
        <p className="text-[11px] text-white/40 mb-2">Max Games Back From Injury</p>
        <div className="flex flex-wrap gap-1.5">
          {[1, 2, 3, 5, 10].map((gn) => (
            <button key={gn} onClick={() => setMaxGnFilter(gn)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                maxGnFilter === gn
                  ? "bg-[#3DFF8F]/20 text-[#3DFF8F] border-[#3DFF8F]/30"
                  : "bg-white/5 text-white/50 hover:text-white/70 border-transparent"
              }`}>
              {gn === 1 ? "Game 1" : `Games 1-${gn}`}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-white/25 mt-1">Only include bets from the first N games after injury return.</p>
      </div>

      {/* Min bets filter */}
      <div className="mb-4">
        <p className="text-[11px] text-white/40 mb-2">Min Bets to Show</p>
        <div className="flex flex-wrap gap-1.5 items-center">
          {[0, 10, 20, 50, 100].map((n) => (
            <button key={n} onClick={() => setMinBetsFilter(n)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                minBetsFilter === n
                  ? "bg-white/10 text-white border-white/20"
                  : "bg-white/5 text-white/50 hover:text-white/70 border-transparent"
              }`}>
              {n === 0 ? "All" : `≥${n}`}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-white/25 mt-1">Hide rows with fewer than {minBetsFilter} bets.</p>
      </div>

      {/* Min Flat BR% filter */}
      <div className="mb-4">
        <p className="text-[11px] text-white/40 mb-2">Min Flat BR%</p>
        <div className="flex flex-wrap gap-1.5">
          {[
            { value: -999, label: "All" },
            { value: 0, label: ">0%" },
            { value: 5, label: ">5%" },
            { value: 10, label: ">10%" },
            { value: 20, label: ">20%" },
          ].map((opt) => (
            <button key={opt.value} onClick={() => setMinFlatBr(opt.value)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                minFlatBr === opt.value
                  ? "bg-green-500/20 text-green-400 border-green-500/30"
                  : "bg-white/5 text-white/50 hover:text-white/70 border-transparent"
              }`}>
              {opt.label}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-white/25 mt-1">Only show rows with flat bankroll return above this threshold.</p>
      </div>

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

      <div className="overflow-x-auto -mx-4 px-4">
        <table className="w-full text-xs whitespace-nowrap">
          <thead>
            <tr className="text-white/40 border-b border-white/10">
              <th className="text-left py-2 px-2">League</th>
              <th className="text-left py-2 px-2">Stat</th>
              <th className="text-left py-2 px-2">Model</th>
              <th className="text-right py-2 px-2">Bets</th>
              <th className="text-right py-2 px-2">Win%</th>
              <th className="text-right py-2 px-2">Flat ROI</th>
              <th className="text-right py-2 px-2">Flat BR%</th>
              <th className="text-right py-2 px-2">½K BR%</th>
              <th className="text-right py-2 px-2">Full K BR%</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const isAll = r.market === "ALL";
              return (
                <tr key={i} className={`border-b border-white/5 ${isAll ? "bg-white/[0.03] font-medium" : ""} cursor-pointer hover:bg-white/[0.05]`}
                    onClick={() => setSelectedRow(selectedRow === r ? null : r)}>
                  <td className="py-1.5 px-2">{isAll ? (LEAGUE_LABELS[r.league] ?? r.league) : ""}</td>
                  <td className="py-1.5 px-2">{isAll ? "ALL" : (MARKET_LABELS[r.market] ?? r.market)}</td>
                  <td className="py-1.5 px-2">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${getModelColor(r.model)}`}>{r.model}</span>
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{r.bets.toLocaleString()}</td>
                  <td className={`py-1.5 px-2 text-right tabular-nums ${r.winRate > 0.524 ? "text-green-400" : "text-red-400/70"}`}>
                    {(r.winRate * 100).toFixed(1)}%
                  </td>
                  <td className={`py-1.5 px-2 text-right tabular-nums ${r.flatRoi > 0 ? "text-green-400" : "text-red-400/70"}`}>
                    {r.flatRoi >= 0 ? "+" : ""}{r.flatRoi.toFixed(1)}%
                  </td>
                  <td className={`py-1.5 px-2 text-right tabular-nums ${r.flatBr > 0 ? "text-green-400" : "text-red-400/70"}`}>
                    {r.flatBr >= 0 ? "+" : ""}{r.flatBr.toFixed(1)}%
                    <span className="text-white/20 ml-1">({r.flatPnl >= 0 ? "+" : ""}{r.flatPnl.toFixed(0)}u)</span>
                  </td>
                  <td className={`py-1.5 px-2 text-right tabular-nums ${r.halfKellyPnl > 0 ? "text-green-400" : "text-red-400/70"}`}>
                    {r.halfKellyPnl >= 0 ? "+" : ""}{r.halfKellyPnl.toFixed(1)}%
                  </td>
                  <td className={`py-1.5 px-2 text-right tabular-nums ${r.fullKellyPnl > 0 ? "text-green-400" : "text-red-400/70"}`}>
                    {r.fullKellyPnl >= 0 ? "+" : ""}{r.fullKellyPnl.toFixed(1)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

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
  const { data, isLoading } = useBacktestBets();
  if (isLoading) return <div className="text-white/30 text-center py-6">Loading...</div>;
  if (!data || Object.keys(data.byLeague).length === 0) return null;
  return <LeagueStatTable allData={data.byLeague} modelMeta={data.modelMeta} />;
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

function useModelPredictions(selectedModel: string) {
  return useQuery<StoredPrediction[]>({
    queryKey: ["model-predictions", selectedModel],
    queryFn: async () => {
      // Fetch predictions for all leagues for the selected model
      const predKeys = BACKTEST_LEAGUES.map((l) => `${l}_${selectedModel}_predictions`);
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

      // Sort by commence_time (earliest first), then EV descending
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

function TodaysBets() {
  const [selectedModel, setSelectedModel] = useState("model_d");
  const [maxGn, setMaxGn] = useState(10);
  const [minEv, setMinEv] = useState(0);
  const { data: predictions = [], isLoading } = useModelPredictions(selectedModel);

  const MODELS_WITH_BETS = MODEL_SUFFIXES.filter((m) => m.suffix.includes("model_"));

  const filtered = useMemo(() => {
    return predictions.filter((p) => {
      if (p.game_number_back > maxGn) return false;
      if (minEv > 0 && Math.abs(p.ev) < minEv) return false;
      return true;
    });
  }, [predictions, maxGn, minEv]);

  if (isLoading) return <div className="text-white/30 text-center py-6">Loading predictions...</div>;

  return (
    <div className="mb-8">
      <h2 className="text-lg font-bold mb-2">Today's & Tomorrow's Model Bets</h2>
      <p className="text-[11px] text-white/40 mb-4">
        Predictions from the trained LGBM model using the exact same feature engineering as the backtest. Each prediction stores its feature vector for verification.
      </p>

      <div className="flex flex-wrap gap-4 mb-4">
        {/* Model selector */}
        <div>
          <p className="text-[11px] text-white/40 mb-2">Model</p>
          <div className="flex flex-wrap gap-1.5">
            {MODELS_WITH_BETS.map((m) => {
              const modelKey = m.suffix.replace(/^_/, "");
              return (
                <button key={m.suffix} onClick={() => setSelectedModel(modelKey)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                    selectedModel === modelKey
                      ? `${m.color} border-current`
                      : "bg-white/[0.02] text-white/20 border-transparent"
                  }`}>
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Games back filter */}
        <div>
          <p className="text-[11px] text-white/40 mb-2">Max Games Back</p>
          <div className="flex flex-wrap gap-1.5">
            {[1, 2, 3, 5, 10].map((gn) => (
              <button key={gn} onClick={() => setMaxGn(gn)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                  maxGn === gn
                    ? "bg-[#3DFF8F]/20 text-[#3DFF8F] border-[#3DFF8F]/30"
                    : "bg-white/5 text-white/50 hover:text-white/70 border-transparent"
                }`}>
                {gn === 1 ? "G1" : `G1-${gn}`}
              </button>
            ))}
          </div>
        </div>

        {/* Min EV filter */}
        <div>
          <p className="text-[11px] text-white/40 mb-2">Min EV%</p>
          <div className="flex flex-wrap gap-1.5">
            {[0, 5, 10, 15, 20].map((ev) => (
              <button key={ev} onClick={() => setMinEv(ev)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                  minEv === ev
                    ? "bg-[#1C7CFF]/20 text-[#1C7CFF] border-[#1C7CFF]/30"
                    : "bg-white/5 text-white/50 hover:text-white/70 border-transparent"
                }`}>
                {ev === 0 ? "All" : `≥${ev}%`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="text-white/30 text-center py-8 bg-white/[0.02] rounded-xl">
          {predictions.length === 0
            ? "No predictions stored yet. Run predict_live.py on the droplet to generate."
            : "No predictions match current filters."}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <p className="text-[10px] text-white/25 mb-2">{filtered.length} bets · Generated {predictions[0]?.predicted_at ? new Date(predictions[0].predicted_at).toLocaleString() : "—"}</p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-white/40 border-b border-white/10">
                <th className="text-left py-2 px-2">Player</th>
                <th className="text-left py-2 px-2">League</th>
                <th className="text-left py-2 px-2">Injury</th>
                <th className="text-center py-2 px-2">Game #</th>
                <th className="text-left py-2 px-2">Market</th>
                <th className="text-right py-2 px-2">Line</th>
                <th className="text-right py-2 px-2">Odds</th>
                <th className="text-right py-2 px-2">Baseline</th>
                <th className="text-right py-2 px-2">Recent</th>
                <th className="text-center py-2 px-2">Rec</th>
                <th className="text-right py-2 px-2">p(over)</th>
                <th className="text-right py-2 px-2">EV</th>
                <th className="text-right py-2 px-2">Kelly</th>
                <th className="text-left py-2 px-2">Game</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p, i) => {
                const hasOdds = p.prop_line != null && (p.over_odds || p.under_odds);
                return (
                  <tr key={i} className={`border-b border-white/5 hover:bg-white/[0.03] ${
                    (() => {
                      const gt = formatGameTime(p.commence_time, p.game_date);
                      if (gt.started) return "bg-green-500/[0.04] border-l-2 border-l-green-500/30";
                      if (gt.soon) return "bg-amber-500/[0.04] border-l-2 border-l-amber-500/30";
                      return "";
                    })()
                  }`}>
                    <td className="py-1.5 px-2 font-medium">{p.player_name}</td>
                    <td className="py-1.5 px-2 text-white/50">{LEAGUE_LABELS[p.league] ?? p.league}</td>
                    <td className="py-1.5 px-2 text-white/40 max-w-[100px] truncate">{p.injury_type}</td>
                    <td className="py-1.5 px-2 text-center">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                        p.game_number_back <= 2 ? "bg-amber-500/20 text-amber-400" : "bg-white/5 text-white/50"
                      }`}>G{p.game_number_back}</span>
                    </td>
                    <td className="py-1.5 px-2">{MARKET_LABELS[p.market] ?? p.market}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">
                      {hasOdds ? p.prop_line?.toFixed(1) : <span className="text-white/20 italic">no odds yet</span>}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-white/40">
                      {hasOdds ? (
                        <span>{p.over_odds ?? "—"} / {p.under_odds ?? "—"}</span>
                      ) : (
                        <span className="text-white/20">—</span>
                      )}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{p.baseline ? p.baseline.toFixed(1) : "—"}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{p.recent_avg ? p.recent_avg.toFixed(1) : "—"}</td>
                    <td className="py-1.5 px-2 text-center">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        p.recommendation === "OVER" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"
                      }`}>{p.recommendation}</span>
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-white/50">{p.p_over.toFixed(3)}</td>
                    <td className={`py-1.5 px-2 text-right tabular-nums font-medium ${
                      p.ev > 0 ? "text-green-400" : "text-red-400/70"
                    }`}>
                      {p.ev >= 0 ? "+" : ""}{p.ev.toFixed(1)}%
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-white/40">
                      {p.kelly_fraction > 0 ? `${(p.kelly_fraction * 100).toFixed(1)}%` : "—"}
                    </td>
                    <td className="py-1.5 px-2">
                      {(() => {
                        const gt = formatGameTime(p.commence_time, p.game_date);
                        return (
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
                        );
                      })()}
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
      // Build all possible adaptive keys
      const keys: string[] = [];
      for (const league of BACKTEST_LEAGUES) {
        for (const model of ADAPTIVE_MODELS) {
          for (const gn of ADAPTIVE_GN) {
            for (const ev of ADAPTIVE_EV) {
              const parts = [`model_${model}_adaptive`];
              if (gn > 0) parts.push(`gn${gn}`);
              if (ev > 0) parts.push(`ev${ev}`);
              keys.push(`${league}_${parts.join("_")}`);
            }
          }
        }
      }
      const { data, error } = await supabase
        .from("back_in_play_backtest_results")
        .select("league, results")
        .in("league", keys);
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
        </div>
        <p className="text-sm text-white/40 mb-6">
          Historical backtest + live model tracking for injury-adjusted player props.
        </p>

        {/* Historical backtest results */}
        <HistoricalBacktest />

        {/* League / Stat breakdown table */}
        <LeagueStatTableWrapper />

        {/* Today's / Tomorrow's Bets */}
        <TodaysBets />

        {/* Adaptive strategies */}
        <AdaptiveStrategiesWrapper />

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
