/**
 * Shared data table component for all Model Analysis pages.
 * Extracted from the injury page (ModelAnalysisPage.tsx LeagueStatTable).
 */

import { useState } from "react";
import type { MarketSummary, ModelDef, StatRow } from "../lib/modelAnalysisTypes";

export interface ModelTableProps {
  rows: StatRow[];
  leagueLabels: Record<string, string>;
  marketLabels: Record<string, string>;
  modelDefs: readonly ModelDef[];
  bonfThreshold: number;
  showTableInfo: boolean;
  setShowTableInfo: (v: boolean) => void;
  badOddsMarkets?: Set<string>;
  onRowClick?: (row: StatRow) => void;
  selectedRow?: StatRow | null;
  /** Column header for the "market/stat" column — defaults to "Stat" */
  statColumnLabel?: string;
  /** Extra column in header for "+" button (injury page only) */
  renderRowAction?: (row: StatRow, index: number) => React.ReactNode;
  /** Info panel descriptions (page-specific) */
  tableInfoContent?: React.ReactNode;
}

export function ModelTable({
  rows,
  leagueLabels,
  marketLabels,
  modelDefs,
  bonfThreshold,
  showTableInfo,
  setShowTableInfo,
  badOddsMarkets,
  onRowClick,
  selectedRow,
  statColumnLabel = "Stat",
  renderRowAction,
  tableInfoContent,
}: ModelTableProps) {
  const [expandedBooks, setExpandedBooks] = useState<number | null>(null);

  const getModelColor = (label: string) =>
    modelDefs.find((m) => m.label === label)?.color ?? "bg-white/5 text-white/50";

  const fmtRoi = (s: MarketSummary | null) => s && s.bets >= 20 ? `${s.flat_roi >= 0 ? "+" : ""}${s.flat_roi.toFixed(1)}` : "—";
  const fmtWin = (s: MarketSummary | null) => s && s.bets >= 20 ? `${(s.wins / s.bets * 100).toFixed(1)}` : "—";
  const fmtBr = (s: MarketSummary | null) => s && s.bets >= 20 ? `${s.flat_br >= 0 ? "+" : ""}${s.flat_br.toFixed(0)}` : "—";
  const roiColor = (s: MarketSummary | null) => !s || s.bets < 20 ? "text-white/20" : s.flat_roi > 0 ? "text-green-400" : "text-red-400/70";

  return (
    <>
      {/* Table header with info and copy */}
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-lg font-bold">League / {statColumnLabel} Breakdown</h2>
        <button
          onClick={() => setShowTableInfo(!showTableInfo)}
          className="shrink-0 w-6 h-6 rounded-full border border-white/15 text-white/35 hover:text-white/70 hover:border-white/30 transition-colors text-xs font-semibold flex items-center justify-center"
          title="Column explanations"
        >
          ?
        </button>
        <button
          onClick={() => {
            const header = `League\t${statColumnLabel}\tModel\tBets\tWin%\tFlat ROI\tFlat BR%\tFlat PnL\t½K BR%\tFull K BR%\tP(Edge)\tBonf\tSeasons\tStability\t%BCL\tBooks`;
            const lines = rows.map((r) => {
              const pVal = 1 - r.pEdge;
              const bonf = pVal < bonfThreshold;
              return `${leagueLabels[r.league] ?? r.league}\t${r.market === "ALL" ? "ALL" : (marketLabels[r.market] ?? r.market)}\t${r.model}\t${r.bets}\t${(r.winRate * 100).toFixed(1)}%\t${r.flatRoi >= 0 ? "+" : ""}${r.flatRoi.toFixed(1)}%\t${r.flatBr >= 0 ? "+" : ""}${r.flatBr.toFixed(1)}%\t${r.flatPnl >= 0 ? "+" : ""}${r.flatPnl.toFixed(0)}u\t${r.halfKellyPnl >= 0 ? "+" : ""}${r.halfKellyPnl.toFixed(1)}%\t${r.fullKellyPnl >= 0 ? "+" : ""}${r.fullKellyPnl.toFixed(1)}%\t${(r.pEdge * 100).toFixed(2)}%\t${bonf ? "Pass" : "—"}\t${r.allSeasons}\t${r.stability}/5\t${r.pctBeatClose >= 0 ? r.pctBeatClose.toFixed(1) + "%" : "—"}\t${r.bookScore}`;
            });
            navigator.clipboard.writeText([header, ...lines].join("\n"));
          }}
          className="shrink-0 px-2 py-1 rounded-lg border border-white/10 text-white/30 hover:text-white/60 hover:border-white/20 transition-colors text-[10px]"
          title="Copy table as tab-separated text"
        >
          Copy Table
        </button>
      </div>

      {showTableInfo && (
        tableInfoContent ?? (
          <div className="rounded-lg bg-white/[0.04] border border-white/10 p-3 mb-4 text-[11px] text-white/50 space-y-1.5">
            <p><span className="text-white/70 font-medium">League</span> — Sports league (NBA, NHL, MLB, NFL, EPL)</p>
            <p><span className="text-white/70 font-medium">{statColumnLabel}</span> — Market type (ALL = combined, or specific like PTS, AST, etc.)</p>
            <p><span className="text-white/70 font-medium">Model</span> — Which model variant</p>
            <p><span className="text-white/70 font-medium">Bets</span> — Total number of bets placed in backtest</p>
            <p><span className="text-white/70 font-medium">Win%</span> — Percentage of bets that hit (green if &gt;52.4%)</p>
            <p><span className="text-white/70 font-medium">Flat ROI</span> — Return on investment per unit bet (flat staking)</p>
            <p><span className="text-white/70 font-medium">Flat BR%</span> — Bankroll % change using flat unit sizing, with units won/lost in parentheses</p>
            <p><span className="text-white/70 font-medium">Half Kelly BR%</span> — Bankroll % change using half-Kelly criterion sizing (conservative)</p>
            <p><span className="text-white/70 font-medium">Full Kelly BR%</span> — Bankroll % change using full Kelly criterion (aggressive, higher variance)</p>
            <p><span className="text-white/70 font-medium">P(Edge)</span> — Probability that the model has a real edge (z-test on per-bet PnL)</p>
            <p><span className="text-white/70 font-medium">Bonf</span> — Bonferroni-corrected p-value. "B" badge = survives correction for multiple testing</p>
            <p><span className="text-white/70 font-medium">Seasons</span> — Seasons profitable / seasons with data (BR% &gt; 0)</p>
            <p><span className="text-white/70 font-medium">Stab</span> — Stability score 0-5: CLV+, season consistency, no period dominance, param robustness, edge monotonicity</p>
            <p><span className="text-white/70 font-medium">%BCL</span> — % of bets Beating the Closing Line (positive CLV). &gt;55% = strong signal, &lt;50% = line moving against you</p>
            <p><span className="text-white/70 font-medium">Books</span> — n/4 profitable across train/test book combos (FD→FD, FD→DK, DK→FD, DK→DK). Click to expand and see ROI, Win%, BR%, P(Edge) for all 4. Highlights worst P(Edge) and min ROI.</p>
          </div>
        )
      )}

      <div className="overflow-x-auto -mx-4 px-4">
        <table className="w-full text-xs whitespace-nowrap">
          <thead>
            <tr className="text-white/40 border-b border-white/10">
              <th className="text-left py-2 px-2">League</th>
              <th className="text-left py-2 px-2">{statColumnLabel}</th>
              <th className="text-left py-2 px-2">Model</th>
              <th className="text-right py-2 px-2">Bets</th>
              <th className="text-right py-2 px-2">Win%</th>
              <th className="text-right py-2 px-2">Flat ROI</th>
              <th className="text-right py-2 px-2">Flat BR%</th>
              <th className="text-right py-2 px-2">½K BR%</th>
              <th className="text-right py-2 px-2">Full K BR%</th>
              <th className="text-right py-2 px-2">P(Edge)</th>
              <th className="text-center py-2 px-2" title="Bonferroni correction: p < 0.05 / total hypotheses">Bonf</th>
              <th className="text-center py-2 px-2" title="Seasons profitable / seasons with data (BR% > 0)">Seasons</th>
              <th className="text-center py-2 px-2" title="Stability score 0-5: CLV+, season consistency, no period dominance, param robustness, edge monotonicity">Stab</th>
              <th className="text-right py-2 px-2" title="% of bets beating the closing line (positive CLV)">%BCL</th>
              <th className="text-center py-2 px-2" title="Book combos profitable (FD→FD, FD→DK, DK→FD, DK→DK)">Books</th>
              {renderRowAction && <th className="py-2 px-1 w-8"></th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const isAll = r.market === "ALL";
              const isSelected = selectedRow && selectedRow.league === r.league && selectedRow.market === r.market && selectedRow.model === r.model;
              return (
                <tr
                  key={i}
                  className={`border-b border-white/5 ${isAll ? "bg-white/[0.03] font-medium" : ""} ${onRowClick ? "cursor-pointer" : ""} hover:bg-white/[0.05] ${isSelected ? "ring-1 ring-blue-500/30" : ""}`}
                  onClick={onRowClick ? () => onRowClick(r) : undefined}
                >
                  <td className="py-1.5 px-2">{leagueLabels[r.league] ?? r.league}</td>
                  <td className="py-1.5 px-2">
                    {isAll ? "ALL" : (marketLabels[r.market] ?? r.market)}
                    {badOddsMarkets?.has(`${r.league}|${r.market}`) && r.model !== "Random" && (
                      <span className="ml-1 px-1 py-0.5 rounded text-[9px] bg-yellow-500/20 text-yellow-400" title="Random bets are profitable in this market — odds data may be unreliable">bad odds</span>
                    )}
                  </td>
                  <td className="py-1.5 px-2">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${getModelColor(r.model)}`}>{r.model}</span>
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{r.bets.toLocaleString()}</td>
                  <td className={`py-1.5 px-2 text-right tabular-nums ${r.winRate > 0.524 ? "text-green-400" : "text-red-400/70"}`}>
                    {(r.winRate * 100).toFixed(1)}%
                  </td>
                  <td className={`py-1.5 px-2 text-right tabular-nums ${r.flatRoi > 0 ? "text-green-400" : "text-red-400/70"}`}>
                    {r.flatRoi >= 0 ? "+" : ""}{r.flatRoi.toFixed(1)}%
                    {r.warnings.length > 0 && (
                      <span className="ml-1 text-[8px] text-orange-400 cursor-help" title={r.warnings.join("\n")}>!</span>
                    )}
                    {r.maxDrawdown >= 0 && (
                      <span className="block text-[8px] text-white/20" title={`Max drawdown: ${r.maxDrawdown.toFixed(0)}% | Turnover: ${r.turnover >= 0 ? r.turnover.toFixed(1) + "x" : "—"}`}>
                        DD:{r.maxDrawdown.toFixed(0)}% T:{r.turnover >= 0 ? r.turnover.toFixed(1) : "—"}x
                      </span>
                    )}
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
                  <td className={`py-1.5 px-2 text-right tabular-nums font-medium ${
                    r.bets < 20 ? "text-white/20" :
                    r.pEdge >= 0.95 ? "text-green-400" :
                    r.pEdge >= 0.80 ? "text-green-400/70" :
                    r.pEdge >= 0.50 ? "text-yellow-400/70" :
                    "text-red-400/50"
                  }`}>
                    {r.bets < 20 ? "—" : r.pEdge >= 0.9999 ? ">99.99%" : `${(r.pEdge * 100).toFixed(2)}%`}
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums">
                    {r.bets < 20 ? <span className="text-white/20">—</span> : (() => {
                      const pVal = 1 - r.pEdge;
                      const pass = pVal < bonfThreshold;
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
                    r.allSeasons === "—" ? "text-white/20" :
                    r.allSeasons.split("/")[0] === r.allSeasons.split("/")[1] ? "text-green-400" :
                    parseInt(r.allSeasons) > 0 ? "text-yellow-400/70" :
                    "text-red-400/50"
                  }`}>
                    {r.allSeasons}
                  </td>
                  <td className="py-1.5 px-2 text-center">
                    <span className={`text-[10px] font-bold tabular-nums ${
                      r.stability >= 4 ? "text-green-400" :
                      r.stability >= 2 ? "text-yellow-400/70" :
                      "text-red-400/50"
                    }`} title={`Stability: ${r.stability}/5 — ${
                      r.stability >= 4 ? "Stable candidate" :
                      r.stability >= 2 ? "Uncertain" :
                      "Fragile / noise"
                    }`}>
                      {r.stability}/5
                    </span>
                  </td>
                  <td className={`py-1.5 px-2 text-right tabular-nums text-[10px] font-medium ${
                    r.pctBeatClose < 0 ? "text-white/20" :
                    r.pctBeatClose >= 55 ? "text-green-400" :
                    r.pctBeatClose >= 50 ? "text-yellow-400/70" :
                    "text-red-400/70"
                  }`}>
                    {r.pctBeatClose < 0 ? "—" : `${r.pctBeatClose.toFixed(1)}%`}
                  </td>
                  <td className="py-1.5 px-2 text-center relative">
                    {r.bookScore === "—" ? (
                      <span className="text-white/20 text-[10px]">—</span>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); setExpandedBooks(expandedBooks === i ? null : i); }}
                        className={`text-[10px] font-bold tabular-nums ${
                          r.bookScore.startsWith("4") || r.bookScore.startsWith("3") ? "text-green-400" :
                          r.bookScore.startsWith("2") ? "text-yellow-400/70" :
                          "text-red-400/70"
                        }`}
                      >
                        {r.bookScore}
                      </button>
                    )}
                    {expandedBooks === i && r.bookScore !== "—" && (
                      <div className="absolute right-0 top-8 z-50 bg-[#0f1520] border border-white/10 rounded-lg shadow-xl p-2 w-[280px]" onClick={(e) => e.stopPropagation()}>
                        <table className="w-full text-[9px]">
                          <thead>
                            <tr className="text-white/30">
                              <th className="text-left px-1 py-0.5">Combo</th>
                              <th className="text-right px-1">ROI</th>
                              <th className="text-right px-1">Win%</th>
                              <th className="text-right px-1">BR%</th>
                              <th className="text-right px-1">Bets</th>
                            </tr>
                          </thead>
                          <tbody>
                            {([
                              ["FD→FD", r.booksCombos.fdFd],
                              ["FD→DK", r.booksCombos.fdDk],
                              ["DK→DK", r.booksCombos.dkDk],
                              ["DK→FD", r.booksCombos.dkFd],
                            ] as [string, MarketSummary | null][]).map(([label, s]) => {
                              const worst = [r.booksCombos.fdFd, r.booksCombos.fdDk, r.booksCombos.dkDk, r.booksCombos.dkFd]
                                .filter(x => x && x.bets >= 20)
                                .reduce((min, x) => !min || (x && x.flat_roi < min.flat_roi) ? x : min, null as MarketSummary | null);
                              const isWorst = s === worst;
                              return (
                                <tr key={label} className={`border-t border-white/5 ${isWorst ? "bg-red-500/10" : ""}`}>
                                  <td className="px-1 py-0.5 text-white/50 font-medium">{label}</td>
                                  <td className={`px-1 py-0.5 text-right font-mono ${roiColor(s)}`}>{fmtRoi(s)}%</td>
                                  <td className="px-1 py-0.5 text-right font-mono text-white/40">{fmtWin(s)}%</td>
                                  <td className={`px-1 py-0.5 text-right font-mono ${roiColor(s)}`}>{fmtBr(s)}%</td>
                                  <td className="px-1 py-0.5 text-right font-mono text-white/30">{s?.bets ?? "—"}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </td>
                  {renderRowAction && (
                    <td className="py-1.5 px-1 text-center">
                      {renderRowAction(r, i)}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Bonferroni footer */}
      <p className="text-[10px] text-white/20 mt-2">
        Bonferroni: p &lt; {bonfThreshold.toFixed(6)} (0.05 ÷ {rows.length} rows). {rows.filter(r => (1 - r.pEdge) < bonfThreshold).length} pass.
      </p>
    </>
  );
}
