import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { SiteHeader } from "../components/SiteHeader";
import { supabase } from "../lib/supabase";
import { usePerformanceCurves } from "../features/performance-curves/lib/queries";
import { computeEV, formatEV, parseOdds, oddsToProfit, type EVResult } from "../lib/evModel";
import type { PerformanceCurve } from "../features/performance-curves/lib/types";

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
] as const;
const ALL_RESULT_KEYS = BACKTEST_LEAGUES.flatMap((l) =>
  MODEL_SUFFIXES.map((m) => `${l}${m.suffix}`)
);

interface ModelMeta {
  features: string[];
  feature_importance: Record<string, number>;
  accuracy?: number;
  auc?: number;
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
          };
        }
      }
      return { bets: allBets, byLeague, modelMeta };
    },
    staleTime: 60 * 60 * 1000,
  });
}

/** Kelly criterion: f* = (p*b - q) / b */
function kellyFraction(winRate: number, oddsProfit: number): number {
  const p = winRate;
  const q = 1 - p;
  const b = oddsProfit;
  if (b <= 0) return 0;
  return Math.max((p * b - q) / b, 0);
}

/** Compute Kelly PnL by simulating sequential bets with compounding bankroll. */
function kellyProfit(bets: BacktestBet[], fraction: number, mode: OddsMode = "scrape"): number {
  if (bets.length === 0) return 0;
  const avgOddsProfit = 0.909;
  const winRate = bets.filter((b) => betCorrect(b, mode)).length / bets.length;
  const kf = kellyFraction(winRate, avgOddsProfit) * fraction;
  if (kf <= 0) return 0;

  let bankroll = 100;
  for (const b of bets) {
    const stake = bankroll * kf;
    const p = betPnl(b, mode);
    if (p > 0) {
      bankroll += stake * p;
    } else {
      bankroll -= stake;
    }
  }
  return bankroll - 100;
}

interface StatRow {
  league: string;
  market: string;
  model: string;
  bets: number;
  wins: number;
  winRate: number;
  flatPnl: number;
  flatRoi: number;
  halfKellyPnl: number;
  fullKellyPnl: number;
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

function LeagueStatTable({ allData, modelMeta }: { allData: Record<string, BacktestBet[]>; modelMeta: Record<string, ModelMeta> }) {
  const [evThreshold, setEvThreshold] = useState(0);
  const [selectedModels, setSelectedModels] = useState<string[]>(MODEL_SUFFIXES.map((m) => m.suffix));
  const [showFeatures, setShowFeatures] = useState<string | null>(null);
  const [oddsMode, setOddsMode] = useState<OddsMode>("open");

  const toggleModel = (suffix: string) => {
    setSelectedModels((prev) =>
      prev.includes(suffix) ? prev.filter((s) => s !== suffix) : [...prev, suffix]
    );
  };

  const rows = useMemo(() => {
    const result: StatRow[] = [];
    for (const leagueBase of BACKTEST_LEAGUES) {
      for (const { suffix, label } of MODEL_SUFFIXES) {
        if (!selectedModels.includes(suffix)) continue;
        const key = `${leagueBase}${suffix}`;
        const bets = (allData[key] ?? []).filter((b) => b.ev >= evThreshold);
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
            halfKellyPnl: kellyProfit(mBets, 0.5, oddsMode),
            fullKellyPnl: kellyProfit(mBets, 1.0, oddsMode),
          });
        }
      }
    }
    return result;
  }, [allData, evThreshold, selectedModels, oddsMode]);

  const evOptions = [0, 5, 10, 15, 20, 30];

  const getModelColor = (label: string) =>
    MODEL_SUFFIXES.find((m) => m.label === label)?.color ?? "bg-white/5 text-white/50";

  return (
    <div className="mb-8">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-lg font-bold">League / Stat Breakdown</h2>
      </div>

      {/* Model selector */}
      <div className="mb-4">
        <p className="text-[11px] text-white/40 mb-2">Models</p>
        <div className="flex flex-wrap gap-1.5">
          {MODEL_SUFFIXES.map((m) => (
            <button key={m.suffix} onClick={() => toggleModel(m.suffix)}
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

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-white/40 border-b border-white/10">
              <th className="text-left py-2 px-2">League</th>
              <th className="text-left py-2 px-2">Stat</th>
              <th className="text-left py-2 px-2">Model</th>
              <th className="text-right py-2 px-2">Bets</th>
              <th className="text-right py-2 px-2">Win%</th>
              <th className="text-right py-2 px-2">Flat ROI</th>
              <th className="text-right py-2 px-2">Flat PnL</th>
              <th className="text-right py-2 px-2">0.5K PnL</th>
              <th className="text-right py-2 px-2">1.0K PnL</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const isAll = r.market === "ALL";
              return (
                <tr key={i} className={`border-b border-white/5 ${isAll ? "bg-white/[0.03] font-medium" : ""}`}>
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
                  <td className={`py-1.5 px-2 text-right tabular-nums ${r.flatPnl > 0 ? "text-green-400" : "text-red-400/70"}`}>
                    {r.flatPnl >= 0 ? "+" : ""}{r.flatPnl.toFixed(0)}u
                  </td>
                  <td className={`py-1.5 px-2 text-right tabular-nums ${r.halfKellyPnl > 0 ? "text-green-400" : "text-red-400/70"}`}>
                    {r.halfKellyPnl >= 0 ? "+" : ""}{r.halfKellyPnl.toFixed(0)}u
                  </td>
                  <td className={`py-1.5 px-2 text-right tabular-nums ${r.fullKellyPnl > 0 ? "text-green-400" : "text-red-400/70"}`}>
                    {r.fullKellyPnl >= 0 ? "+" : ""}{r.fullKellyPnl.toFixed(0)}u
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const LEAGUE_LABELS: Record<string, string> = {
  all: "All Leagues",
  nba: "NBA",
  nhl: "NHL",
  mlb: "MLB",
  "premier-league": "EPL",
};

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
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-lg font-bold">Historical Backtest</h2>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400/80 font-semibold">
          {allBets.length.toLocaleString()} bets · Holdout
        </span>
      </div>

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
    <div className="min-h-screen bg-[#0a0f1a] text-white">
      <SiteHeader />
      <div className="max-w-3xl mx-auto px-4 py-6">
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

        <h2 className="text-lg font-bold mb-4">Live Model Tracking</h2>

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
  );
}
