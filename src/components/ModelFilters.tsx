/**
 * Shared filter UI for all Model Analysis pages.
 * Extracted from the injury page (ModelAnalysisPage.tsx LeagueStatTable).
 */

import type { ModelDef, OddsMode, StatRow } from "../lib/modelAnalysisTypes";

interface OddsOption {
  value: OddsMode;
  label: string;
}

export interface ModelFiltersProps {
  modelDefs: readonly ModelDef[];
  leagues: readonly string[];
  leagueLabels: Record<string, string>;

  // Filter state + setters
  selectedModels: string[];
  setSelectedModels: React.Dispatch<React.SetStateAction<string[]>>;
  oddsMode: OddsMode;
  setOddsMode: (mode: OddsMode) => void;
  leagueFilter: string;
  setLeagueFilter: (league: string) => void;
  seasonFilter: string;
  setSeasonFilter: (season: string) => void;
  evThreshold: number;
  setEvThreshold: (ev: number) => void;
  unitPct: number;
  setUnitPct: (pct: number) => void;
  minBets: number;
  setMinBets: (n: number) => void;
  minFlatBr: number;
  setMinFlatBr: (n: number) => void;
  minPEdge: number;
  setMinPEdge: (n: number) => void;
  bonfOnly: boolean;
  setBonfOnly: (v: boolean) => void;
  minSeasonsOk: number;
  setMinSeasonsOk: (n: number) => void;

  // Computed values
  availableSeasons: string[];
  bonfThreshold: number;
  rows: StatRow[];

  // Games Back (injury page only)
  showGamesBack: boolean;
  minGnFilter?: number;
  setMinGnFilter?: (n: number) => void;
  maxGnFilter?: number;
  setMaxGnFilter?: (n: number) => void;

  // Odds options vary per page
  oddsOptions: OddsOption[];

  // Total hypotheses for Bonferroni display (optional, defaults to rows.length)
  totalHypotheses?: number;
}

export function ModelFilters({
  modelDefs,
  leagues,
  leagueLabels,
  selectedModels,
  setSelectedModels,
  oddsMode,
  setOddsMode,
  leagueFilter,
  setLeagueFilter,
  seasonFilter,
  setSeasonFilter,
  evThreshold,
  setEvThreshold,
  unitPct,
  setUnitPct,
  minBets,
  setMinBets,
  minFlatBr,
  setMinFlatBr,
  minPEdge,
  setMinPEdge,
  bonfOnly,
  setBonfOnly,
  minSeasonsOk,
  setMinSeasonsOk,
  availableSeasons,
  bonfThreshold,
  rows,
  showGamesBack,
  minGnFilter,
  setMinGnFilter,
  maxGnFilter,
  setMaxGnFilter,
  oddsOptions,
  totalHypotheses,
}: ModelFiltersProps) {
  const hypotheses = totalHypotheses ?? rows.length;
  const bonfPassCount = rows.filter(r => (1 - r.pEdge) < bonfThreshold).length;

  return (
    <>
      {/* Models */}
      <div className="mb-4">
        <p className="text-[11px] text-white/40 mb-2">Models</p>
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setSelectedModels(modelDefs.map(m => m.suffix))}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
              selectedModels.length === modelDefs.length
                ? "bg-white/10 text-white border-white/20"
                : "bg-white/[0.02] text-white/20 border-transparent"
            }`}>
            All
          </button>
          {modelDefs.map((m) => (
            <button key={m.suffix} onClick={() => {
              setSelectedModels((prev) => {
                if (prev.includes(m.suffix)) {
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

      {/* Bet at Odds */}
      <div className="mb-4">
        <p className="text-[11px] text-white/40 mb-2">Bet at Odds</p>
        <div className="flex flex-wrap gap-1.5">
          {oddsOptions.map(({ value, label }) => (
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
          {oddsMode !== "scrape" && oddsOptions.some(o => o.value === "scrape") && " — only available for Model D bets with open/close data"}
        </p>
      </div>

      {/* League */}
      <div className="mb-4">
        <p className="text-[11px] text-white/40 mb-2">League</p>
        <div className="flex flex-wrap gap-1.5">
          {["all", ...leagues].map((l) => (
            <button key={l} onClick={() => setLeagueFilter(l)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                leagueFilter === l
                  ? "bg-[#1C7CFF]/20 text-[#1C7CFF] border-[#1C7CFF]/30"
                  : "bg-white/5 text-white/50 hover:text-white/70 border-transparent"
              }`}>
              {leagueLabels[l] ?? l}
            </button>
          ))}
        </div>
      </div>

      {/* Season */}
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

      {/* Min EV % threshold */}
      <div className="mb-4">
        <p className="text-[11px] text-white/40 mb-2">Min EV % threshold</p>
        <div className="flex flex-wrap gap-1.5">
          {[0, 5, 10, 15, 20, 30, 40, 50].map((t) => (
            <button key={t} onClick={() => setEvThreshold(t)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                evThreshold === t ? "bg-[#1C7CFF]/20 text-[#1C7CFF] border border-[#1C7CFF]/30" : "bg-white/5 text-white/50 hover:text-white/70 border border-transparent"
              }`}>
              {t === 0 ? "All" : `>=${t}%`}
            </button>
          ))}
        </div>
      </div>

      {/* Unit Size */}
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

      {/* Games back filter (injury page only) */}
      {showGamesBack && setMinGnFilter && setMaxGnFilter && minGnFilter != null && maxGnFilter != null && (
        <div className="mb-4">
          <p className="text-[11px] text-white/40 mb-2">Games Back From Injury</p>
          <div className="flex flex-wrap gap-1.5">
            {([
              { min: 1, max: 1, label: "G1" },
              { min: 1, max: 2, label: "G1-2" },
              { min: 1, max: 3, label: "G1-3" },
              { min: 1, max: 5, label: "G1-5" },
              { min: 1, max: 10, label: "G1-10" },
              { min: 4, max: 10, label: "G4-10" },
              { min: 6, max: 10, label: "G6-10" },
            ] as const).map((opt) => (
              <button key={opt.label} onClick={() => { setMinGnFilter(opt.min); setMaxGnFilter(opt.max); }}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                  minGnFilter === opt.min && maxGnFilter === opt.max
                    ? "bg-[#3DFF8F]/20 text-[#3DFF8F] border-[#3DFF8F]/30"
                    : "bg-white/5 text-white/50 hover:text-white/70 border-transparent"
                }`}>
                {opt.label}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-white/25 mt-1">Filter bets by game number after injury return.</p>
        </div>
      )}

      {/* Min Bets to Show */}
      <div className="mb-4">
        <p className="text-[11px] text-white/40 mb-2">Min Bets to Show</p>
        <div className="flex flex-wrap gap-1.5 items-center">
          {[0, 10, 20, 50, 100].map((n) => (
            <button key={n} onClick={() => setMinBets(n)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                minBets === n
                  ? "bg-white/10 text-white border-white/20"
                  : "bg-white/5 text-white/50 hover:text-white/70 border-transparent"
              }`}>
              {n === 0 ? "All" : `>=${n}`}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-white/25 mt-1">Hide rows with fewer than {minBets} bets.</p>
      </div>

      {/* Min Flat BR% */}
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

      {/* Statistical filters */}
      <div className="mb-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <p className="text-[11px] text-white/40 mb-2">Min P(Edge)</p>
          <div className="flex flex-wrap gap-1.5">
            {[0, 50, 80, 90, 95, 99].map((n) => (
              <button key={n} onClick={() => setMinPEdge(n)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                  minPEdge === n
                    ? "bg-teal-500/20 text-teal-300 border-teal-500/30"
                    : "bg-white/5 text-white/50 hover:text-white/70 border-transparent"
                }`}>
                {n === 0 ? "All" : `>=${n}%`}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="text-[11px] text-white/40 mb-2">Bonferroni</p>
          <div className="flex flex-wrap gap-1.5 items-center">
            <button onClick={() => setBonfOnly(false)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                !bonfOnly ? "bg-teal-500/20 text-teal-300 border-teal-500/30" : "bg-white/5 text-white/50 hover:text-white/70 border-transparent"
              }`}>All</button>
            <button onClick={() => setBonfOnly(true)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                bonfOnly ? "bg-teal-500/20 text-teal-300 border-teal-500/30" : "bg-white/5 text-white/50 hover:text-white/70 border-transparent"
              }`}>Pass Only</button>
          </div>
          <p className="text-[10px] text-white/25 mt-1">
            p &lt; <span className="text-white/60 font-mono">{bonfThreshold.toFixed(6)}</span>{" "}
            = 0.05 ÷ <span className="text-white/60">{hypotheses}</span> hypotheses.{" "}
            <span className={bonfPassCount > 0 ? "text-green-400/70" : "text-red-400/50"}>
              {bonfPassCount}
            </span> of {rows.length} visible rows pass.
          </p>
        </div>
        <div>
          <p className="text-[11px] text-white/40 mb-2">Min Seasons Profitable</p>
          <div className="flex flex-wrap gap-1.5">
            {[0, 1, 2, 3].map((n) => (
              <button key={n} onClick={() => setMinSeasonsOk(n)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                  minSeasonsOk === n
                    ? "bg-teal-500/20 text-teal-300 border-teal-500/30"
                    : "bg-white/5 text-white/50 hover:text-white/70 border-transparent"
                }`}>
                {n === 0 ? "All" : `>=${n}`}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
