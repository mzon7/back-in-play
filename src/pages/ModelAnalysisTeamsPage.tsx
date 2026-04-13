/**
 * Model Analysis — Team Bets
 *
 * Same structure as player prop pages but for team-level bets:
 * spreads, totals, team totals, moneylines.
 */

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { SiteHeader } from "../components/SiteHeader";
import { supabase } from "../lib/supabase";
import { ModelFilters } from "../components/ModelFilters";
import { ModelTable } from "../components/ModelTable";
import { computePEdge, computeStability } from "../lib/modelAnalysisUtils";
import type { MarketSummary, BacktestSummary, StatRow, OddsMode, ModelDef } from "../lib/modelAnalysisTypes";

const PAGE_PASSWORD = "purplecobras";
const LEAGUES = ["nba", "nhl", "mlb", "nfl", "premier-league"] as const;
const LEAGUE_LABELS: Record<string, string> = { all: "All Leagues", nba: "NBA", nhl: "NHL", mlb: "MLB", nfl: "NFL", "premier-league": "EPL" };

const MODEL_DEFS: readonly ModelDef[] = [
  { suffix: "_team_c", label: "Team C", color: "bg-orange-500/10 text-orange-400/70" },
  { suffix: "_team_f2", label: "Team F2", color: "bg-violet-500/10 text-violet-400/70" },
  { suffix: "_team_g", label: "Team G", color: "bg-rose-500/10 text-rose-400/70" },
  { suffix: "_team_random", label: "Random", color: "bg-gray-500/10 text-gray-400/70" },
] as const;

const MARKET_LABELS: Record<string, string> = {
  h2h: "Moneyline", spreads: "Spread", totals: "Total", team_totals: "Team Total",
  alternate_spreads: "Alt Spread", alternate_totals: "Alt Total",
  btts: "BTTS", h2h_3_way: "3-Way ML",
};

const ODDS_OPTIONS: { value: OddsMode; label: string }[] = [
  { value: "open", label: "Opening Odds" },
  { value: "close", label: "Closing Odds" },
];

function useSummaries() {
  const keys = LEAGUES.flatMap(l => MODEL_DEFS.map(m => `${l}${m.suffix}`));
  return useQuery<Record<string, BacktestSummary>>({
    queryKey: ["team-summaries"],
    queryFn: async () => {
      const { data } = await supabase.from("back_in_play_backtest_results").select("league, summary").in("league", keys).not("summary", "is", null);
      if (!data) return {};
      const out: Record<string, BacktestSummary> = {};
      for (const row of data) { const s = typeof row.summary === "string" ? JSON.parse(row.summary) : row.summary; if (s) out[row.league] = s; }
      return out;
    },
    staleTime: 60 * 60 * 1000,
  });
}

function PasswordGate({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState(() => sessionStorage.getItem("mat_auth") === "1");
  const [pw, setPw] = useState("");
  if (authed) return <>{children}</>;
  return (
    <div className="min-h-screen bg-[#0A0E1A] flex items-center justify-center">
      <form onSubmit={(e) => { e.preventDefault(); if (pw === PAGE_PASSWORD) { sessionStorage.setItem("mat_auth", "1"); setAuthed(true); } else setPw(""); }}
        className="bg-white/5 border border-white/10 rounded-xl p-6 w-full max-w-xs">
        <p className="text-sm text-white/60 mb-3">Password protected.</p>
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password"
          className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-blue-500/40 mb-3" autoFocus />
        <button type="submit" className="w-full rounded-lg bg-blue-500/20 border border-blue-500/25 px-4 py-2 text-sm font-medium text-blue-300/80 hover:bg-blue-500/30">Enter</button>
      </form>
    </div>
  );
}

export default function ModelAnalysisTeamsPage() {
  const { data: summaries, isLoading } = useSummaries();

  // ── Filter state ──
  const [oddsMode, setOddsMode] = useState<OddsMode>("open");
  const [leagueFilter, setLeagueFilter] = useState("all");
  const [selectedModels, setSelectedModels] = useState<string[]>(MODEL_DEFS.map(m => m.suffix));
  const [evThreshold, setEvThreshold] = useState(0);
  const [seasonFilter, setSeasonFilter] = useState<string>("all");
  const [unitPct, setUnitPct] = useState(1);
  const [minBets, setMinBets] = useState(20);
  const [minFlatBr, setMinFlatBr] = useState<number>(-999);
  const [minPEdge, setMinPEdge] = useState(0);
  const [bonfOnly, setBonfOnly] = useState(false);
  const [minSeasonsOk, setMinSeasonsOk] = useState(0);
  const [showTableInfo, setShowTableInfo] = useState(false);

  // ── Available seasons from summaries ──
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

  // ── Build rows from summaries ──
  const rows = useMemo(() => {
    if (!summaries) return [];
    const result: StatRow[] = [];
    const closestGn = 10; // team models don't use games-back
    const EV_THRESHOLDS = [0, 5, 10, 15, 20, 30, 40, 50];
    const closestEv = EV_THRESHOLDS.reduce((prev, curr) =>
      Math.abs(curr - evThreshold) < Math.abs(prev - evThreshold) ? curr : prev
    );
    const seasonSuffix = seasonFilter !== "all" ? `_s${seasonFilter}` : "";
    const modeKey = `by_market_${oddsMode}_ev${closestEv}_gn${closestGn}${seasonSuffix}`;

    for (const league of LEAGUES) {
      if (leagueFilter !== "all" && league !== leagueFilter) continue;
      for (const { suffix, label } of MODEL_DEFS) {
        if (!selectedModels.includes(suffix)) continue;
        const key = `${league}${suffix}`;
        const summary = summaries[key];
        if (!summary) continue;
        const marketData = (summary as any)[modeKey] as Record<string, MarketSummary> | undefined;
        if (!marketData) continue;
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

          const warnings: string[] = [];
          if (stats.flat_roi > 20) warnings.push("ROI > 20% — unrealistic");
          else if (stats.flat_roi > 10) warnings.push("ROI > 10% — likely bias");
          if ((stats.turnover ?? 0) > 100) warnings.push("Turnover > 100x");
          if (stats.bets < 50) warnings.push("< 50 bets");
          if ((stats.max_drawdown ?? 0) > 50) warnings.push("Max DD > 50%");

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
            bookScore: "—",
            booksCombos: { fdFd: null, fdDk: null, dkDk: null, dkFd: null },
          });
        }
      }
    }

    // Sort by ROI descending
    result.sort((a, b) => b.flatRoi - a.flatRoi);

    // Apply filters
    let filtered = result.filter(r => r.bets >= minBets && (minFlatBr <= -999 || r.flatBr >= minFlatBr));
    if (minPEdge > 0) filtered = filtered.filter(r => r.pEdge * 100 >= minPEdge);
    if (minSeasonsOk > 0) {
      filtered = filtered.filter(r => {
        if (r.allSeasons === "—") return false;
        const ok = parseInt(r.allSeasons.split("/")[0]);
        return ok >= minSeasonsOk;
      });
    }
    return filtered;
  }, [summaries, oddsMode, leagueFilter, selectedModels, evThreshold, seasonFilter, unitPct, minBets, minFlatBr, minPEdge, minSeasonsOk]);

  // ── Bonferroni ──
  const totalHypotheses = useMemo(() => {
    if (!summaries) return rows.length;
    const EV_VALS = [0, 5, 10, 15, 20, 30, 40, 50];
    const GN_VAL = 10;
    let count = 0;
    for (const league of LEAGUES) {
      for (const { suffix } of MODEL_DEFS) {
        if (!selectedModels.includes(suffix)) continue;
        const key = `${league}${suffix}`;
        const summary = summaries[key];
        if (!summary) continue;
        for (const ev of EV_VALS) {
          const mk = `by_market_${oddsMode}_ev${ev}_gn${GN_VAL}`;
          const marketData = (summary as any)[mk] as Record<string, MarketSummary> | undefined;
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
    return rows.filter(r => (1 - r.pEdge) < bonfThreshold);
  }, [rows, bonfOnly, bonfThreshold]);

  // Count game odds we have
  const { data: oddsCount } = useQuery({
    queryKey: ["team-odds-count"],
    queryFn: async () => {
      const { count } = await supabase.from("back_in_play_game_odds").select("id", { count: "exact", head: true });
      return count ?? 0;
    },
    staleTime: 60 * 60 * 1000,
  });

  return (
    <PasswordGate>
      <div className="min-h-screen bg-[#0a0f1a] text-white">
        <SiteHeader />
        <div className="max-w-3xl lg:max-w-[1400px] mx-auto px-4 lg:px-10 py-6">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold">Team Betting Models</h1>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-400/80 font-semibold">Teams</span>
            <a href="/model-analysis" className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-white/40 hover:text-white/60">← Injury Models</a>
            <a href="/model-analysis-all" className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-white/40 hover:text-white/60">Player Props →</a>
          </div>
          <p className="text-sm text-white/40 mb-6">Models for team-level bets: spreads, totals, team totals, moneylines.</p>

          {/* Data overview */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            <div className="bg-white/5 rounded-xl p-4 text-center">
              <p className="text-[11px] text-white/40 mb-1">Game Odds Scraped</p>
              <p className="text-2xl font-black text-white">{(oddsCount ?? 0).toLocaleString()}</p>
              <p className="text-[10px] text-white/30">Events with odds data</p>
            </div>
            <div className="bg-white/5 rounded-xl p-4 text-center">
              <p className="text-[11px] text-white/40 mb-1">Coverage</p>
              <p className="text-2xl font-black text-white">2021+</p>
              <p className="text-[10px] text-white/30">~4-5 years per league</p>
            </div>
            <div className="bg-white/5 rounded-xl p-4 text-center">
              <p className="text-[11px] text-white/40 mb-1">Markets</p>
              <p className="text-2xl font-black text-white">8</p>
              <p className="text-[10px] text-white/30">H2H, spreads, totals, team totals, alts, BTTS</p>
            </div>
            <div className="bg-white/5 rounded-xl p-4 text-center">
              <p className="text-[11px] text-white/40 mb-1">Game Logs</p>
              <p className="text-2xl font-black text-white">4.1M+</p>
              <p className="text-[10px] text-white/30">For team stat aggregation</p>
            </div>
          </div>

          {/* TODO: Model Training Plan */}
          <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4 mb-6">
            <h3 className="text-sm font-bold text-amber-400/80 mb-2">TODO: Train Models C–G for Team Bets</h3>
            <p className="text-[11px] text-white/40 mb-3">
              Principle: <span className="text-white/60">lineup-based projection + smoothed team/opponent form</span>.
              Don't just use raw team averages — build projections from who's actually playing and how they produce per minute.
            </p>

            {/* Feature Architecture */}
            <div className="space-y-2 mb-3">
              <div className="bg-white/[0.02] rounded-lg p-3">
                <p className="text-[10px] font-bold text-orange-400/70 mb-1">A. Team Recent Form (~3 features)</p>
                <div className="text-[10px] text-white/40 space-y-0.5 ml-2">
                  <p><code className="text-white/50">team_stat_ewa</code> = EWA of team's total for this stat (α=0.3, last 10 games), shrunk toward season avg</p>
                  <p><code className="text-white/50">team_stat_trend</code> = (EWA last 3) / (EWA last 10) — recent trajectory</p>
                  <p><code className="text-white/50">team_vs_league</code> = team season avg / league season avg — relative strength</p>
                </div>
              </div>

              <div className="bg-white/[0.02] rounded-lg p-3">
                <p className="text-[10px] font-bold text-orange-400/70 mb-1">B. Opponent Context (~3 features)</p>
                <div className="text-[10px] text-white/40 space-y-0.5 ml-2">
                  <p><code className="text-white/50">opp_allowed_ewa</code> = EWA of stat opponent allows per game (last 10), shrunk toward season avg</p>
                  <p><code className="text-white/50">opp_allowed_trend</code> = (EWA last 3 allowed) / (EWA last 10 allowed) — getting tighter or leaking more</p>
                  <p><code className="text-white/50">opp_vs_league</code> = opponent season allowed / league avg — &gt;1 = weak defense</p>
                </div>
              </div>

              <div className="bg-white/[0.02] rounded-lg p-3">
                <p className="text-[10px] font-bold text-orange-400/70 mb-1">C. Lineup-Based Projection (~3 features) — <span className="text-amber-400/70">most important</span></p>
                <div className="text-[10px] text-white/40 space-y-0.5 ml-2">
                  <p><code className="text-white/50">lineup_projected_stat</code> = Σ over recently active players: blended_per_min_rate × expected_minutes</p>
                  <p className="ml-4 text-white/30">where blended_per_min_rate = w × EWA(stat/min, last 10) + (1−w) × season_rate, w = min(N/10, 1)</p>
                  <p className="ml-4 text-white/30">where expected_minutes = EWA of their minutes (last 5 games)</p>
                  <p><code className="text-white/50">lineup_projected_last_game_mins</code> = same but using last-game minutes instead of EWA minutes</p>
                  <p><code className="text-white/50">lineup_projected_10g_mins</code> = same but using 10-game avg minutes</p>
                </div>
              </div>

              <div className="bg-white/[0.02] rounded-lg p-3">
                <p className="text-[10px] font-bold text-orange-400/70 mb-1">D. Combined Projection (~2 features)</p>
                <div className="text-[10px] text-white/40 space-y-0.5 ml-2">
                  <p><code className="text-white/50">blended_team_projection</code> = 0.5 × lineup_projected_stat + 0.3 × team_stat_ewa + 0.2 × league_avg — hedges lineup uncertainty</p>
                  <p><code className="text-white/50">opp_adjusted_projection</code> = blended_team_projection × opp_vs_league — scale by opponent quality</p>
                </div>
              </div>

              <div className="bg-white/[0.02] rounded-lg p-3">
                <p className="text-[10px] font-bold text-orange-400/70 mb-1">E. Market & Context (~4 features)</p>
                <div className="text-[10px] text-white/40 space-y-0.5 ml-2">
                  <p><code className="text-white/50">line_vs_projection</code> = market_line / opp_adjusted_projection — &gt;1 = line above our projection</p>
                  <p><code className="text-white/50">open_implied_prob</code> = market's implied probability for this side</p>
                  <p><code className="text-white/50">is_home</code>, <code className="text-white/50">rest_days</code></p>
                </div>
              </div>

              <div className="bg-white/[0.02] rounded-lg p-3">
                <p className="text-[10px] font-bold text-orange-400/70 mb-1">F. League Baseline (~1 feature)</p>
                <div className="text-[10px] text-white/40 space-y-0.5 ml-2">
                  <p><code className="text-white/50">league_avg_stat</code> = league-wide average of the stat up to this point in the season (baseline anchor)</p>
                </div>
              </div>
            </div>

            <div className="bg-white/[0.02] rounded-lg p-3 mt-2">
              <p className="text-[10px] font-bold text-orange-400/70 mb-1">G–I. MLB Pitching Features (~10 features) — <span className="text-amber-400/70">MLB only</span></p>
              <div className="text-[10px] text-white/40 space-y-0.5 ml-2">
                <p><code className="text-white/50">sp_k_per_ip_ewa</code> = starter's EWA strikeout rate (K/IP, last 5 starts, shrunk to season)</p>
                <p><code className="text-white/50">sp_ip_ewa</code> = starter's expected innings (EWA of last 5 starts)</p>
                <p><code className="text-white/50">sp_ip_consistency</code> = 1 − CV of starter's IP (consistent = better)</p>
                <p><code className="text-white/50">sp_vs_league</code> = starter K/IP vs league avg starter K/IP</p>
                <p><code className="text-white/50">bp_quality</code> = team bullpen season K/IP (non-starter appearances)</p>
                <p><code className="text-white/50">bp_fatigue</code> = bullpen IP in last 3 days (heavy use = tired arms)</p>
                <p><code className="text-white/50">pitching_quality_index</code> = 0.6×starter + 0.25×bullpen + 0.15×fatigue blend</p>
              </div>
            </div>

            <div className="bg-white/[0.02] rounded-lg p-3 mt-2">
              <p className="text-[10px] font-bold text-orange-400/70 mb-1">J. Park Factors (~2 features) — <span className="text-amber-400/70">MLB only</span></p>
              <div className="text-[10px] text-white/40 space-y-0.5 ml-2">
                <p><code className="text-white/50">park_runs_factor</code> = home runs scored+allowed / away runs scored+allowed (per season)</p>
                <p><code className="text-white/50">park_factor_vs_league</code> = team park factor / league avg park factor</p>
                <p className="text-white/30 mt-1">Known park changes: Camden Yards (2022), Rogers Centre (2022), Globe Life (2020), Truist Park (2017). Using per-season factors auto-captures renovations.</p>
              </div>
            </div>

            <div className="bg-white/[0.03] rounded-lg p-2 text-[10px] text-white/30 mt-2">
              <span className="text-white/50 font-medium">Total: 28 features (16 base + 10 pitcher + 2 park).</span> Key principle: lineup projection = Σ(player rate × expected minutes).
              MLB adds starting pitcher quality, bullpen fatigue, and park effects. Pitcher ID = highest IP on team per game.
              EWA (α=0.3) for all recent averages. Shrinkage toward season baseline when recent N is small.
            </div>
          </div>

          {/* ── FILTERS ── */}
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
            totalHypotheses={totalHypotheses}
          />

          {/* ── TABLE ── */}

          {isLoading && <p className="text-white/30 text-center py-8">Loading...</p>}

          {!isLoading && displayRows.length === 0 && (
            <div className="bg-white/[0.02] rounded-xl p-8 text-center mb-6">
              <p className="text-white/30 text-lg font-bold mb-2">No Team Models Yet</p>
              <p className="text-white/20 text-sm mb-4">Team odds are being scraped from the Odds API (2021-2026). Once complete, we can train models on:</p>
              <div className="flex flex-wrap justify-center gap-2 mb-4">
                {["Spread prediction", "Total prediction", "Team total prediction", "Moneyline value", "BTTS (hockey/soccer)"].map(m => (
                  <span key={m} className="px-2 py-1 rounded bg-orange-500/10 text-orange-400/60 text-[10px]">{m}</span>
                ))}
              </div>
              <p className="text-white/20 text-xs">Features: team recent form, player availability, home/away, rest days, historical H2H, pace, defensive rating</p>
            </div>
          )}

          {displayRows.length > 0 && (
            <>
              <ModelTable
                rows={displayRows}
                leagueLabels={LEAGUE_LABELS}
                marketLabels={MARKET_LABELS}
                modelDefs={MODEL_DEFS}
                bonfThreshold={bonfThreshold}
                showTableInfo={showTableInfo}
                setShowTableInfo={setShowTableInfo}
                statColumnLabel="Market"
                tableInfoContent={
                  <div className="rounded-lg bg-white/[0.04] border border-white/10 p-3 mb-4 text-[11px] text-white/50 space-y-1.5">
                    <p><span className="text-white/70 font-medium">League</span> — Sports league (NBA, NHL, MLB, NFL, EPL)</p>
                    <p><span className="text-white/70 font-medium">Market</span> — Bet type (Spread, Total, Team Total, Moneyline, etc.)</p>
                    <p><span className="text-white/70 font-medium">Model</span> — Which model variant (Team C, Team F2, Team G, Random)</p>
                    <p><span className="text-white/70 font-medium">Bets</span> — Total number of bets placed in backtest</p>
                    <p><span className="text-white/70 font-medium">Win%</span> — Percentage of bets that hit (green if &gt;52.4%)</p>
                    <p><span className="text-white/70 font-medium">Flat ROI</span> — Return on investment per unit bet (flat staking)</p>
                    <p><span className="text-white/70 font-medium">Flat BR%</span> — Bankroll % change using flat unit sizing, with units won/lost in parentheses</p>
                    <p><span className="text-white/70 font-medium">½K BR%</span> — Bankroll % change using half-Kelly criterion sizing (conservative)</p>
                    <p><span className="text-white/70 font-medium">Full K BR%</span> — Bankroll % change using full Kelly criterion (aggressive, higher variance)</p>
                    <p><span className="text-white/70 font-medium">P(Edge)</span> — Statistical confidence that the model has a real edge (&gt;95% = strong)</p>
                    <p><span className="text-white/70 font-medium">Bonf</span> — Bonferroni-corrected p-value; "B" badge = survives multiple-hypothesis correction</p>
                    <p><span className="text-white/70 font-medium">Seasons</span> — Profitable seasons / total seasons with data (BR% &gt; 0)</p>
                    <p><span className="text-white/70 font-medium">Stab</span> — Stability score 0-5: CLV+, season consistency, no period dominance, param robustness, edge monotonicity</p>
                  </div>
                }
              />
            </>
          )}

          {/* DB Functions available */}
          <div className="mt-8 bg-white/[0.02] rounded-xl p-4">
            <h3 className="text-sm font-bold text-white/50 mb-2">Available DB Functions</h3>
            <div className="space-y-1 text-[10px] text-white/30 font-mono">
              <p>get_team_recent_form(league, player_name, before_date, limit) — team stats last N games</p>
              <p>get_league_averages(league, start_date, end_date) — league-wide averages</p>
              <p>get_player_rolling_avg(player_id, before_date, n_games) — player rolling averages</p>
              <p>get_game_roster_with_stats(league, game_date) — all players + half-season stats</p>
            </div>
          </div>
        </div>
      </div>
    </PasswordGate>
  );
}
