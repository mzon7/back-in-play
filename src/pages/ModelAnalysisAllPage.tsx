/**
 * Model Analysis — All Players (General Props)
 *
 * Same structure as injury model page but for general player prop models.
 * Models bet on ALL players, not just injury returns.
 */

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { SiteHeader } from "../components/SiteHeader";
import { supabase } from "../lib/supabase";
import { ModelFilters } from "../components/ModelFilters";
import { ModelTable } from "../components/ModelTable";
import { computePEdge, computeStability } from "../lib/modelAnalysisUtils";
import type { MarketSummary, BacktestSummary, StatRow, OddsMode, TrainBook, ModelDef } from "../lib/modelAnalysisTypes";

const PAGE_PASSWORD = "purplecobras";
const LEAGUES = ["nba", "nhl", "mlb", "nfl", "premier-league"] as const;
const LEAGUE_LABELS: Record<string, string> = { all: "All Leagues", nba: "NBA", nhl: "NHL", mlb: "MLB", nfl: "NFL", "premier-league": "EPL" };

const MODEL_DEFS: readonly ModelDef[] = [
  { suffix: "_general_a", label: "General A", color: "bg-lime-500/10 text-lime-400/70" },
  { suffix: "_general_c", label: "General C", color: "bg-cyan-500/10 text-cyan-400/70" },
  { suffix: "_general_f2", label: "General F2", color: "bg-violet-500/10 text-violet-400/70" },
  { suffix: "_general_g", label: "General G", color: "bg-rose-500/10 text-rose-400/70" },
  { suffix: "_general_random", label: "Random", color: "bg-gray-500/10 text-gray-400/70" },
] as const;

const MARKET_LABELS: Record<string, string> = {
  player_points: "Points", player_rebounds: "Rebounds", player_assists: "Assists",
  player_pass_yds: "Pass Yds", player_rush_yds: "Rush Yds",
  player_reception_yds: "Rec Yds", player_receptions: "Receptions",
  player_goals: "Goals", player_shots_on_goal: "SOG", player_pass_tds: "Pass TDs",
  batter_hits: "Hits", batter_rbis: "RBIs", batter_total_bases: "Total Bases",
  player_steals: "Steals", player_blocks: "Blocks",
};

const ODDS_OPTIONS: { value: OddsMode; label: string }[] = [
  { value: "scrape", label: "Scraped Odds" },
  { value: "open", label: "Opening Odds" },
  { value: "close", label: "Closing Odds" },
  { value: "train", label: "Train Book" },
  { value: "alt", label: "Other Book" },
];

// ── Data loading ──
function useSummaries() {
  // Load both legacy keys (no suffix) and new dual-book keys (_fd, _dk)
  const keys = LEAGUES.flatMap(l => MODEL_DEFS.flatMap(m => [
    `${l}${m.suffix}`,          // legacy
    `${l}${m.suffix}_fa`,       // trained on FanDuel
    `${l}${m.suffix}_dr`,       // trained on DraftKings
  ]));
  return useQuery<Record<string, BacktestSummary>>({
    queryKey: ["general-summaries-v2"],
    queryFn: async () => {
      const { data } = await supabase.from("back_in_play_backtest_results").select("league, summary").in("league", keys).not("summary", "is", null);
      if (!data) return {};
      const out: Record<string, BacktestSummary> = {};
      for (const row of data) {
        const s = typeof row.summary === "string" ? JSON.parse(row.summary) : row.summary;
        if (s) out[row.league] = s;
      }
      return out;
    },
    staleTime: 60 * 60 * 1000,
  });
}

// ── Password Gate ──
function PasswordGate({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState(() => sessionStorage.getItem("maa_auth") === "1");
  const [pw, setPw] = useState("");
  if (authed) return <>{children}</>;
  return (
    <div className="min-h-screen bg-[#0A0E1A] flex items-center justify-center">
      <form onSubmit={(e) => { e.preventDefault(); if (pw === PAGE_PASSWORD) { sessionStorage.setItem("maa_auth", "1"); setAuthed(true); } else setPw(""); }}
        className="bg-white/5 border border-white/10 rounded-xl p-6 w-full max-w-xs">
        <p className="text-sm text-white/60 mb-3">Password protected.</p>
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password"
          className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-blue-500/40 mb-3" autoFocus />
        <button type="submit" className="w-full rounded-lg bg-blue-500/20 border border-blue-500/25 px-4 py-2 text-sm font-medium text-blue-300/80 hover:bg-blue-500/30">Enter</button>
      </form>
    </div>
  );
}

// ── Main Page ──
export default function ModelAnalysisAllPage() {
  const { data: summaries, isLoading } = useSummaries();

  // Filter state
  const [oddsMode, setOddsMode] = useState<OddsMode>("train");
  const [trainBook, setTrainBook] = useState<TrainBook>("fd");
  const [evThreshold, setEvThreshold] = useState(0);
  const [leagueFilter, setLeagueFilter] = useState("all");
  const [minBets, setMinBets] = useState(20);
  const [selectedModels, setSelectedModels] = useState<string[]>(MODEL_DEFS.map(m => m.suffix));
  const [seasonFilter, setSeasonFilter] = useState<string>("all");
  const [unitPct, setUnitPct] = useState(1);
  const [minFlatBr, setMinFlatBr] = useState<number>(-999);
  const [minPEdge, setMinPEdge] = useState(0);
  const [bonfOnly, setBonfOnly] = useState(false);
  const [minSeasonsOk, setMinSeasonsOk] = useState(0);
  const [showTableInfo, setShowTableInfo] = useState(false);

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
    return ["all", ...Array.from(seasons).sort()];
  }, [summaries]);

  const rows = useMemo(() => {
    if (!summaries) return [];
    const result: StatRow[] = [];
    const closestGn = 10; // general models don't use games-back
    const EV_THRESHOLDS = [0, 5, 10, 15, 20, 30, 40, 50];
    const closestEv = EV_THRESHOLDS.reduce((p, c) => Math.abs(c - evThreshold) < Math.abs(p - evThreshold) ? c : p);
    const seasonSuffix = seasonFilter !== "all" ? `_s${seasonFilter}` : "";
    const modeKey = `by_market_${oddsMode}_ev${closestEv}_gn${closestGn}${seasonSuffix}`;

    const bookSuffix = trainBook === "fd" ? "_fa" : "_dr";

    for (const league of LEAGUES) {
      if (leagueFilter !== "all" && league !== leagueFilter) continue;
      for (const { suffix, label } of MODEL_DEFS) {
        if (!selectedModels.includes(suffix)) continue;
        // Try new dual-book key first, fall back to legacy
        const key = summaries[`${league}${suffix}${bookSuffix}`] ? `${league}${suffix}${bookSuffix}` : `${league}${suffix}`;
        const summary = summaries[key];
        if (!summary) continue;
        const marketData = (summary as any)[modeKey] as Record<string, MarketSummary> | undefined;
        if (!marketData) continue;
        const modelSeasons = summary.seasons as string[] | undefined;

        // Load both FD and DK summaries for booksCombos
        const fdSummary = summaries[`${league}${suffix}_fa`];
        const dkSummary = summaries[`${league}${suffix}_dr`];
        const trainKey = `by_market_train_ev${closestEv}_gn${closestGn}${seasonSuffix}`;
        const altKey = `by_market_alt_ev${closestEv}_gn${closestGn}${seasonSuffix}`;

        for (const [market, stats] of Object.entries(marketData)) {
          if (!stats || stats.bets < minBets) continue;
          let seasonsOk = 0, seasonsCounted = 0;
          if (modelSeasons && modelSeasons.length > 0) {
            for (const s of modelSeasons) {
              const sKey = `by_market_${oddsMode}_ev${closestEv}_gn${closestGn}_s${s}`;
              const sMkt = ((summary as any)[sKey] as Record<string, MarketSummary> | undefined)?.[market];
              if (!sMkt || sMkt.bets < 10) continue;
              seasonsCounted++;
              if (sMkt.flat_br > 0) seasonsOk++;
            }
          }

          // Compute booksCombos: 4 train/test combinations
          const fdFd = ((fdSummary as any)?.[trainKey] as Record<string, MarketSummary> | undefined)?.[market] ?? null;
          const fdDk = ((fdSummary as any)?.[altKey] as Record<string, MarketSummary> | undefined)?.[market] ?? null;
          const dkDk = ((dkSummary as any)?.[trainKey] as Record<string, MarketSummary> | undefined)?.[market] ?? null;
          const dkFd = ((dkSummary as any)?.[altKey] as Record<string, MarketSummary> | undefined)?.[market] ?? null;

          const combos = [fdFd, fdDk, dkDk, dkFd];
          const profitCount = combos.filter(s => s && s.bets >= 20 && s.flat_roi > 0).length;
          const hasAny = combos.some(s => s && s.bets >= 20);
          const bookScore = hasAny ? `${profitCount}/4` : "—";

          // Sanity warnings
          const warnings: string[] = [];
          if (stats.flat_roi > 20) warnings.push("ROI > 20% — almost certainly unrealistic");
          else if (stats.flat_roi > 10) warnings.push("ROI > 10% — likely bias");
          if ((stats.turnover ?? 0) > 100) warnings.push("Turnover > 100x — check execution");
          if (stats.bets < 50) warnings.push("< 50 bets — insufficient sample");
          if ((stats.max_drawdown ?? 0) > 50) warnings.push("Max drawdown > 50%");

          result.push({
            league, market, model: label, bets: stats.bets, wins: stats.wins,
            winRate: stats.wins / stats.bets, flatPnl: stats.flat_pnl, flatRoi: stats.flat_roi,
            flatBr: stats.flat_br, halfKellyPnl: stats.half_kelly_br, fullKellyPnl: stats.full_kelly_br,
            pEdge: computePEdge(stats.bets, stats.wins, stats.flat_pnl),
            allSeasons: seasonsCounted >= 2 ? `${seasonsOk}/${seasonsCounted}` : "—",
            stability: computeStability(summary, market, oddsMode, closestGn),
            pctBeatClose: stats.pct_beat_close ?? -1,
            avgClvProbEdge: stats.avg_clv_prob_edge ?? 0,
            warnings,
            maxDrawdown: stats.max_drawdown ?? -1,
            turnover: stats.turnover ?? -1,
            bookScore,
            booksCombos: { fdFd, fdDk, dkDk, dkFd },
          });
        }
      }
    }
    result.sort((a, b) => b.flatRoi - a.flatRoi);

    // Apply post-filters
    let filtered = result.filter(r => minFlatBr <= -999 || r.flatBr >= minFlatBr);
    if (minPEdge > 0) filtered = filtered.filter(r => r.pEdge * 100 >= minPEdge);
    if (minSeasonsOk > 0) {
      filtered = filtered.filter(r => {
        if (r.allSeasons === "—") return false;
        const ok = parseInt(r.allSeasons.split("/")[0]);
        return ok >= minSeasonsOk;
      });
    }
    return filtered;
  }, [summaries, oddsMode, trainBook, evThreshold, leagueFilter, minBets, selectedModels, seasonFilter, minFlatBr, minPEdge, minSeasonsOk]);

  const bonfThreshold = 0.05 / Math.max(rows.length, 1);

  const displayRows = useMemo(() => {
    if (!bonfOnly) return rows;
    return rows.filter(r => (1 - r.pEdge) < bonfThreshold);
  }, [rows, bonfOnly, bonfThreshold]);

  return (
    <PasswordGate>
      <div className="min-h-screen bg-[#0a0f1a] text-white">
        <SiteHeader />
        <div className="max-w-3xl lg:max-w-[1400px] mx-auto px-4 lg:px-10 py-6">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold">General Player Props</h1>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-lime-500/15 text-lime-400/80 font-semibold">All Players</span>
            <a href="/model-analysis" className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-white/40 hover:text-white/60">
              ← Injury Models
            </a>
            <a href="/model-analysis-teams" className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-white/40 hover:text-white/60">
              Team Models →
            </a>
          </div>
          <p className="text-sm text-white/40 mb-6">Models that bet on ALL players, not just injury returns. Tests if there's a general edge in player props.</p>

          {/* TODO: Model Training Plan */}
          <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4 mb-6">
            <h3 className="text-sm font-bold text-amber-400/80 mb-2">TODO: Train Models C–G for General Player Props</h3>
            <p className="text-[11px] text-white/40 mb-3">
              Principle: <span className="text-white/60">expected opportunity × expected efficiency</span>, not raw stat stacking.
              Smooth signals, shrink toward baselines, decompose into minutes + per-minute rate.
            </p>

            {/* Feature Architecture */}
            <div className="space-y-2 mb-3">
              <div className="bg-white/[0.02] rounded-lg p-3">
                <p className="text-[10px] font-bold text-lime-400/70 mb-1">A. Expected Minutes / Role (~4 features)</p>
                <div className="text-[10px] text-white/40 space-y-0.5 ml-2">
                  <p><code className="text-white/50">expected_minutes</code> = EWA of recent minutes (α=0.3, last 10 games), shrunk toward season avg when N &lt; 5</p>
                  <p><code className="text-white/50">minute_share</code> = player minutes / total team minutes, EWA over last 5 games</p>
                  <p><code className="text-white/50">minutes_trend</code> = (EWA last 3) / (EWA last 10) — captures role changes</p>
                  <p><code className="text-white/50">role_stability</code> = 1 − CV of minute share over last 10 games (high = consistent starter)</p>
                </div>
              </div>

              <div className="bg-white/[0.02] rounded-lg p-3">
                <p className="text-[10px] font-bold text-lime-400/70 mb-1">B. Per-Minute Production (~3 features)</p>
                <div className="text-[10px] text-white/40 space-y-0.5 ml-2">
                  <p><code className="text-white/50">blended_per_min_rate</code> = w × EWA_recent(stat/min, last 10) + (1−w) × season_per_min_rate, where w = min(games_recent/10, 1)</p>
                  <p><code className="text-white/50">per_min_trend</code> = (EWA last 3 stat/min) / (season stat/min) — trending up or down</p>
                  <p><code className="text-white/50">per_min_stability</code> = 1 − CV of per-min rate over last 10 — predictability of efficiency</p>
                </div>
              </div>

              <div className="bg-white/[0.02] rounded-lg p-3">
                <p className="text-[10px] font-bold text-lime-400/70 mb-1">C. Projected Stat (core feature, ~2 variants)</p>
                <div className="text-[10px] text-white/40 space-y-0.5 ml-2">
                  <p><code className="text-white/50">projected_stat</code> = expected_minutes × blended_per_min_rate — <span className="text-lime-400/50">the single most important feature</span></p>
                  <p><code className="text-white/50">projected_stat_opp_adj</code> = projected_stat × (opp_allowance_ratio) — adjusted for opponent defense</p>
                </div>
              </div>

              <div className="bg-white/[0.02] rounded-lg p-3">
                <p className="text-[10px] font-bold text-lime-400/70 mb-1">D. Team & Opponent Context (~4 features)</p>
                <div className="text-[10px] text-white/40 space-y-0.5 ml-2">
                  <p><code className="text-white/50">team_stat_form</code> = EWA of team's total for this stat (last 5 games) / league avg</p>
                  <p><code className="text-white/50">opp_defense_ratio</code> = EWA of opponent's allowed stat (last 10) / league avg — &gt;1 = weak defense</p>
                  <p><code className="text-white/50">game_pace_factor</code> = game_total / league_avg_total — high-scoring environment</p>
                  <p><code className="text-white/50">team_implied_edge</code> = team_implied_points / league_avg_team_points</p>
                </div>
              </div>

              <div className="bg-white/[0.02] rounded-lg p-3">
                <p className="text-[10px] font-bold text-lime-400/70 mb-1">E. Market & Context (~4 features)</p>
                <div className="text-[10px] text-white/40 space-y-0.5 ml-2">
                  <p><code className="text-white/50">line_vs_projection</code> = prop_line / projected_stat — &gt;1 = line above our projection</p>
                  <p><code className="text-white/50">open_implied_prob</code> = market's implied probability</p>
                  <p><code className="text-white/50">is_home</code>, <code className="text-white/50">rest_days</code></p>
                </div>
              </div>
            </div>

            <div className="bg-white/[0.03] rounded-lg p-2 text-[10px] text-white/30">
              <span className="text-white/50 font-medium">Total: ~17 features.</span> Key principle: projected_stat = minutes × rate.
              EWA = exponentially weighted average (α=0.3). Shrinkage = blend toward season baseline when recent N is small.
              No raw last-1-game values. No stacked last-1/5/10 without combining.
              Status: General A trained with basic features. Models C–G need this architecture.
            </div>
          </div>

          {/* ── FILTERS ── */}
          {/* Train Book Toggle */}
          <div className="flex items-center gap-2 mb-3">
            <span className="text-xs text-white/30">Train Book:</span>
            {(["fd", "dk"] as TrainBook[]).map(b => (
              <button
                key={b}
                onClick={() => setTrainBook(b)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors border ${
                  trainBook === b
                    ? "bg-blue-500/20 border-blue-500/30 text-blue-300"
                    : "bg-white/5 border-white/10 text-white/30 hover:text-white/50"
                }`}
              >
                {b === "fd" ? "FanDuel" : "DraftKings"}
              </button>
            ))}
          </div>

          <ModelFilters
            modelDefs={MODEL_DEFS}
            leagues={LEAGUES}
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
            minBets={minBets}
            setMinBets={setMinBets}
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
            showGamesBack={false}
            oddsOptions={ODDS_OPTIONS}
          />

          {isLoading && <p className="text-white/30 text-center py-8">Loading...</p>}

          {!isLoading && displayRows.length === 0 && (
            <div className="text-white/30 text-center py-12 bg-white/[0.02] rounded-xl">
              No general prop model results yet. Run <code className="text-white/50">general_prop_model_a.py</code> on the droplet.
            </div>
          )}

          {displayRows.length > 0 && (
            <div className="overflow-x-auto">
              <ModelTable
                rows={displayRows}
                leagueLabels={LEAGUE_LABELS}
                marketLabels={MARKET_LABELS}
                modelDefs={MODEL_DEFS}
                bonfThreshold={bonfThreshold}
                showTableInfo={showTableInfo}
                setShowTableInfo={setShowTableInfo}
                statColumnLabel="Stat"
              />
            </div>
          )}
        </div>
      </div>
    </PasswordGate>
  );
}
