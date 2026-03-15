import { useState, useMemo, useEffect, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { SiteHeader } from "../../../components/SiteHeader";
import { SEO } from "../../../components/seo/SEO";
import { breadcrumbJsonLd, datasetJsonLd, faqJsonLd, jsonLdGraph } from "../../../components/seo/seoHelpers";
import { usePerformanceCurves, usePerformanceCurve, usePositionsWithCurves } from "../lib/queries";
import { PerformanceCurveChart } from "./PerformanceCurveChart";
import type { PerformanceCurve, LeagueFilter } from "../lib/types";
import { LEAGUE_LABELS, STAT_LABELS, LEAGUE_STATS } from "../lib/types";
import { trackCurveExpand, trackStatDrillDown, trackLeagueFilter } from "../../../lib/analytics";
import { leagueColor } from "../../../lib/leagueColors";
import { isRealInjury } from "../../../lib/injuryFilters";

const LEAGUE_ORDER: LeagueFilter[] = ["all", "nba", "nfl", "mlb", "nhl", "premier-league"];

const LEAGUE_POSITIONS: Record<string, string[]> = {
  nba: ["G", "F", "C", "PG", "SG", "PF", "SF"],
  nfl: ["QB", "RB", "WR", "TE", "OL", "DL", "LB", "DB", "K"],
  mlb: ["P", "IF", "OF", "C", "1B", "2B", "3B", "SS", "SP", "RP"],
  nhl: ["W", "D", "C", "G", "LW", "RW"],
  "premier-league": ["FWD", "MID", "DEF", "GK"],
};

/** Short unit labels for raw stat display */
const STAT_UNITS: Record<string, string> = {
  stat_pts: "PPG", stat_reb: "RPG", stat_ast: "APG", stat_stl: "SPG", stat_blk: "BPG",
  stat_pass_yds: "yds", stat_pass_td: "TDs", stat_rush_yds: "yds", stat_rush_td: "TDs",
  stat_rec: "rec", stat_rec_yds: "yds",
  stat_goals: "goals", stat_assists: "assists", stat_sog: "SOG",
  stat_h: "hits", stat_hr: "HR", stat_rbi: "RBI", stat_r: "runs", stat_sb: "SB",
  stat_sv: "saves", stat_ga: "GA", stat_sv_pct: "SV%", stat_w: "wins",
  composite: "comp",
};

function getStatsForCurve(curve: PerformanceCurve): string[] {
  // NHL goalies get goalie-specific stats, not skater stats
  if (curve.league_slug === "nhl" && curve.position === "G") {
    return LEAGUE_STATS["nhl-goalie"] ?? [];
  }
  return LEAGUE_STATS[curve.league_slug] ?? [];
}

/** Compute raw stat change: baseline * (pct - 1.0) */
function rawImpact(pct: number | null | undefined, baseline: number | undefined): number | null {
  if (pct == null || baseline == null || baseline === 0) return null;
  return baseline * (pct - 1.0);
}

/** Format raw impact: –2.3, +0.5, 0.0 */
function fmtImpact(val: number | null, unit?: string): string {
  if (val == null) return "—";
  const sign = val >= 0 ? "+" : "";
  const formatted = `${sign}${val.toFixed(1)}`;
  return unit ? `${formatted} ${unit}` : formatted;
}


function StatFilterBar({ curve, selectedStat, onSelect, useMedian }: { curve: PerformanceCurve; selectedStat: string | null; onSelect: (s: string | null) => void; useMedian: boolean }) {
  const stats = getStatsForCurve(curve);
  const availableStats = stats.filter(
    (s) => curve.stat_avg_pct?.[s]?.some((v) => v != null)
  );
  if (availableStats.length === 0) return null;

  const statSource = useMedian ? curve.stat_median_pct : curve.stat_avg_pct;
  const hasComposite = statSource?.["composite"]?.some((v) => v != null);
  const baselines = curve.stat_baselines;

  return (
    <div className="mb-3">
      <p className="text-[10px] text-white/35 mb-1.5">Stat impact relative to pre-injury baseline</p>
      <div className="flex flex-wrap gap-1">
        <button
          onClick={() => onSelect(null)}
          className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
            selectedStat === null
              ? "bg-[#1C7CFF]/20 text-[#1C7CFF] border border-[#1C7CFF]/30"
              : "bg-white/5 text-white/50 hover:text-white/70 border border-transparent"
          }`}
        >
          Overall
        </button>
        {hasComposite && (
          <button
            onClick={() => { onSelect(selectedStat === "composite" ? null : "composite"); if (selectedStat !== "composite") trackStatDrillDown("composite", curve.injury_type_slug); }}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
              selectedStat === "composite"
                ? "bg-[#1C7CFF]/20 text-[#1C7CFF] border border-[#1C7CFF]/30"
                : "bg-white/5 text-white/50 hover:text-white/70 border border-transparent"
            }`}
          >
            Composite
            {statSource?.["composite"]?.[9] != null && (
              <span className={`ml-1 ${statSource["composite"][9]! >= 1.0 ? "text-green-400" : statSource["composite"][9]! >= 0.8 ? "text-amber-400" : "text-red-400"}`}>
                {Math.round(statSource["composite"][9]! * 100)}%
              </span>
            )}
          </button>
        )}
        {availableStats.map((stat) => {
          const val10 = statSource?.[stat]?.[9];
          const baseline = baselines?.[stat];
          const impact = rawImpact(val10, baseline);
          const impactColor = impact == null ? "text-white/30"
            : impact >= 0 ? "text-green-400" : impact >= -1 ? "text-amber-400" : "text-red-400";
          return (
            <button
              key={stat}
              onClick={() => { onSelect(selectedStat === stat ? null : stat); if (selectedStat !== stat) trackStatDrillDown(stat, curve.injury_type_slug); }}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                selectedStat === stat
                  ? "bg-[#1C7CFF]/20 text-[#1C7CFF] border border-[#1C7CFF]/30"
                  : "bg-white/5 text-white/50 hover:text-white/70 border border-transparent"
              }`}
            >
              {STAT_LABELS[stat] ?? stat}
              {impact != null ? (
                <span className={`ml-1 ${impactColor}`}>{fmtImpact(impact)}</span>
              ) : val10 != null ? (
                <span className={`ml-1 ${val10 >= 1.0 ? "text-green-400" : val10 >= 0.8 ? "text-amber-400" : "text-red-400"}`}>
                  {Math.round(val10 * 100)}%
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MinutesBreakdown({ curve }: { curve: PerformanceCurve }) {
  const hasMinutes = curve.avg_minutes_pct.some((v) => v != null);
  if (!hasMinutes) return null;
  return (
    <div className="bg-white/[0.03] rounded-lg p-3 border border-white/5 mb-3">
      <p className="text-xs text-white/50 mb-2">
        Minutes — % of pre-injury playing time over 10 games
        <span className="text-white/25 ml-2">(n={curve.sample_size})</span>
      </p>
      <div className="grid grid-cols-10 gap-1">
        {curve.avg_minutes_pct.slice(0, 10).map((val, i) => {
          const pct = val != null ? Math.round(val * 100) : null;
          const color = pct == null ? "text-white/20"
            : pct >= 100 ? "text-green-400"
            : pct >= 85 ? "text-amber-400"
            : "text-red-400";
          return (
            <div key={i} className="text-center">
              <p className="text-[9px] text-white/30">G{i + 1}</p>
              <p className={`text-xs font-bold ${color}`}>{pct != null ? `${pct}%` : "—"}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PositionDrillDown({ curve, localPosition, onSelectPosition }: {
  curve: PerformanceCurve;
  localPosition: string;
  onSelectPosition: (pos: string) => void;
}) {
  const positions = LEAGUE_POSITIONS[curve.league_slug];
  if (!positions) return null;
  return (
    <div className="mb-3">
      <p className="text-[10px] text-white/35 mb-1.5">Filter by position</p>
      <div className="flex flex-wrap gap-1">
        <button
          onClick={() => onSelectPosition("all")}
          className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors border ${
            localPosition === "all"
              ? "bg-cyan-500/15 text-cyan-400 border-cyan-500/30"
              : "bg-white/5 text-white/50 hover:text-white/70 border-transparent hover:border-cyan-500/30"
          }`}
        >
          All
        </button>
        {positions.map((pos) => (
          <button
            key={pos}
            onClick={() => onSelectPosition(pos)}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors border ${
              localPosition === pos
                ? "bg-cyan-500/15 text-cyan-400 border-cyan-500/30"
                : "bg-white/5 text-white/50 hover:text-white/70 border-transparent hover:border-cyan-500/30"
            }`}
          >
            {pos}
          </button>
        ))}
      </div>
    </div>
  );
}

function CurveCard({ curve: baseCurve, forceExpand, allCurves = [] }: {
  curve: PerformanceCurve;
  forceExpand?: boolean;
  allCurves?: PerformanceCurve[];
}) {
  const [expanded, setExpanded] = useState(forceExpand ?? false);
  const [selectedStat, setSelectedStat] = useState<string | null>(null);
  const [showMinutes, setShowMinutes] = useState(false);
  const [useMedian, setUseMedian] = useState(true);
  const [showInfo, setShowInfo] = useState(false);
  const [localPosition, setLocalPosition] = useState("all");
  const [compareSlug, setCompareSlug] = useState("");
  const cardRef = useRef<HTMLDivElement>(null);

  // Listen for external stat selection (from discovery section clicks)
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const handler = (e: Event) => {
      const statKey = (e as CustomEvent).detail;
      if (typeof statKey === "string") {
        setSelectedStat(statKey);
        setShowMinutes(false);
      }
    };
    el.addEventListener("select-stat", handler);
    return () => el.removeEventListener("select-stat", handler);
  }, []);

  // Fetch position-specific curve when a position is selected
  const { data: posCurves } = usePerformanceCurves(
    baseCurve.league_slug,
    baseCurve.injury_type_slug,
    localPosition !== "all" ? localPosition : undefined,
  );
  const curve = localPosition !== "all" && posCurves && posCurves.length > 0 ? posCurves[0] : baseCurve;

  // Fetch comparison curve
  const compareInjurySlug = compareSlug ? compareSlug.split("|")[0] : "";
  const compareLeagueSlug = compareSlug ? compareSlug.split("|")[1] : "";
  const { data: compareCurve } = usePerformanceCurve(compareLeagueSlug, compareInjurySlug);

  const mainData = useMedian ? curve.median_pct_recent : curve.avg_pct_recent;
  const leagueLabel = LEAGUE_LABELS[curve.league_slug] ?? curve.league_slug.toUpperCase();

  const minuteG10 = curve.avg_minutes_pct[9];
  const minuteChange = minuteG10 != null ? Math.round(minuteG10 * 100) : null;

  const nextSeasonPct = curve.next_season_pct;

  // Build a view curve that shows stat-specific data when a stat is selected
  const viewCurve = useMemo(() => {
    if (!selectedStat) return curve;
    const medianArr = (curve.stat_median_pct?.[selectedStat] ?? []) as number[];
    const avgArr = (curve.stat_avg_pct?.[selectedStat] ?? []) as number[];
    const stderrArr = (curve.stat_stderr_pct?.[selectedStat] ?? []) as number[];
    return {
      ...curve,
      median_pct_recent: medianArr,
      avg_pct_recent: avgArr,
      p25_pct_recent: new Array(10).fill(null) as number[],
      p75_pct_recent: new Array(10).fill(null) as number[],
      stderr_pct_recent: stderrArr,
    };
  }, [curve, selectedStat]);

  // Data array for the selected view (used in summary cards)
  const viewData = selectedStat
    ? (useMedian ? (curve.stat_median_pct?.[selectedStat] ?? []) : (curve.stat_avg_pct?.[selectedStat] ?? []))
    : mainData;
  const statBaseline = selectedStat ? curve.stat_baselines?.[selectedStat] : undefined;
  const statUnit = selectedStat ? (STAT_UNITS[selectedStat] ?? "") : "";

  return (
    <div ref={cardRef} id={`curve-${curve.injury_type_slug}-${curve.league_slug}`} className="rounded-xl border border-white/10 bg-white/5 overflow-hidden" style={{ borderLeftColor: `${leagueColor(baseCurve.league_slug)}35`, borderLeftWidth: 2 }}>
      <button
        onClick={() => { if (!expanded) trackCurveExpand(curve.injury_type_slug, curve.league_slug); setExpanded(!expanded); }}
        className="w-full text-left px-5 py-4 flex items-center gap-3 hover:bg-white/[0.03] transition-colors"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-sm text-white truncate">{curve.injury_type}</h3>
            <span className="text-[10px] px-2 py-0.5 rounded-full shrink-0" style={{ color: leagueColor(curve.league_slug), backgroundColor: `${leagueColor(curve.league_slug)}12` }}>{leagueLabel}</span>
            {curve.position && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400/60 shrink-0">{curve.position}</span>
            )}
            {curve.sample_size < 30 && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400/80 shrink-0" title="Small sample size — interpret with caution">Low n</span>
            )}
            {nextSeasonPct != null && nextSeasonPct > 0 && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-400/70 shrink-0" title={`${nextSeasonPct}% of cases returned the following season`}>
                {Math.round(nextSeasonPct)}% next season
              </span>
            )}
          </div>
          <div className="flex items-center gap-4 mt-1 text-xs text-white/40">
            <span className="font-medium">{curve.sample_size} cases</span>
            {curve.games_missed_avg != null && <span>{curve.games_missed_avg} games missed</span>}
            {curve.recovery_days_avg != null && <span>{Math.round(curve.recovery_days_avg)}d recovery</span>}
          </div>
          {/* Overall stat + minute change summary — reflects selected stat */}
          <div className="flex items-center gap-3 mt-1 text-[11px]">
            {(() => {
              const g10 = viewData[9];
              const g10Pct = g10 != null ? Math.round(g10 * 100) : null;
              const label = selectedStat ? (STAT_LABELS[selectedStat] ?? selectedStat) : (useMedian ? "Median" : "Average");
              return g10Pct != null ? (
                <span className={g10Pct >= 100 ? "text-green-400/70" : "text-amber-400/70"}>
                  {label}: {g10Pct}% by G10
                </span>
              ) : null;
            })()}
            {minuteChange != null && (
              <span className={minuteChange >= 95 ? "text-green-400/70" : "text-amber-400/70"}>
                Minutes: {minuteChange}%
              </span>
            )}
          </div>
        </div>

        {/* Quick stat — reflects selected stat when expanded */}
        <div className="text-right shrink-0">
          {(() => {
            const displayVal = viewData[9];
            const full = displayVal != null && displayVal >= 1.0;
            return displayVal != null ? (
              <div className={`text-lg font-bold ${full ? "text-green-400" : "text-amber-400"}`}>
                {Math.round(displayVal * 100)}%
              </div>
            ) : (
              <div className="text-lg font-bold text-white/20">—</div>
            );
          })()}
          <div className="text-[10px] text-white/30">
            {selectedStat ? `${STAT_LABELS[selectedStat] ?? selectedStat} G10` : "of baseline by G10"}
          </div>
        </div>

        <span className="text-white/30 text-sm ml-2 transition-transform" style={{ transform: expanded ? "rotate(0)" : "rotate(-90deg)" }}>
          &#9660;
        </span>
      </button>

      {expanded && (
        <div className="px-5 pb-5 border-t border-white/5">
          {/* Position drill-down */}
          <div className="mt-4">
            <PositionDrillDown curve={baseCurve} localPosition={localPosition} onSelectPosition={(pos) => { setLocalPosition(pos); setSelectedStat(null); }} />
          </div>
          {localPosition !== "all" && (
            <div className="mb-2">
              <p className="text-[10px] text-cyan-400/60">
                Showing {localPosition} data · {curve.sample_size} cases
              </p>
              {curve.sample_size < 30 && (
                <p className="text-[10px] text-amber-400/70 mt-0.5">
                  Small sample size — interpret with caution
                </p>
              )}
            </div>
          )}

          {/* Median/Average toggle + Info button */}
          <div className="mt-2 flex items-center gap-2 mb-3">
            <div className="flex rounded-lg overflow-hidden border border-white/10">
              <button
                onClick={() => setUseMedian(true)}
                className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                  useMedian ? "bg-[#1C7CFF]/20 text-[#1C7CFF]" : "bg-white/5 text-white/40 hover:text-white/60"
                }`}
              >
                Median
              </button>
              <button
                onClick={() => setUseMedian(false)}
                className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                  !useMedian ? "bg-[#1C7CFF]/20 text-[#1C7CFF]" : "bg-white/5 text-white/40 hover:text-white/60"
                }`}
              >
                Average
              </button>
            </div>
            <button
              onClick={() => setShowInfo(!showInfo)}
              className="w-5 h-5 rounded-full border border-white/20 text-[10px] text-white/40 hover:text-white/60 hover:border-white/40 transition-colors flex items-center justify-center shrink-0"
              title="Methodology"
            >
              i
            </button>
          </div>

          {/* Methodology info panel */}
          {showInfo && (
            <div className="mb-3 rounded-lg border border-white/10 bg-white/[0.03] p-3 text-[11px] text-white/50 leading-relaxed space-y-1.5">
              <p>Performance curves show how players perform after returning from injury, compared to their pre-injury baseline.</p>
              <p><strong className="text-white/70">Overall (default):</strong> For each game back, we compute each stat as a % of the player's pre-injury average, then average those stat percentages together. The curve shows the {useMedian ? "median" : "average"} across all players.</p>
              <p><strong className="text-white/70">Per-stat view:</strong> Shows a single stat's % of pre-injury baseline.</p>
              <p><strong className="text-white/70">Composite:</strong> A weighted fantasy-style score combining all stats. NBA: PTS + 1.2xREB + 1.5xAST + 3xSTL + 3xBLK. NFL: 0.04xPassYds + 4xPassTD + 0.1xRushYds + 6xRushTD + REC + 0.1xRecYds. MLB Hitters: H + 4xHR + RBI + R + 2xSB. MLB Pitchers: 3xIP + 2xK - 2xH - 3xER. NHL Skaters: 3xGoals + 2xAssists + 0.5xSOG.</p>
              <p><strong className="text-white/70">Median vs Average:</strong> Median is less affected by outliers. Average (trimmed 5%) gives the typical outcome.</p>
            </div>
          )}

          {/* Stat filter pills + Minutes toggle */}
          <div>
            <StatFilterBar curve={curve} selectedStat={selectedStat} onSelect={(s) => { setSelectedStat(s); setShowMinutes(false); }} useMedian={useMedian} />
            {/* Minutes toggle button */}
            {curve.avg_minutes_pct.some((v) => v != null) && (
              <div className="flex gap-1 mt-1">
                <button
                  onClick={() => { setShowMinutes(!showMinutes); setSelectedStat(null); }}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                    showMinutes
                      ? "bg-purple-500/20 text-purple-400 border border-purple-500/30"
                      : "bg-white/5 text-white/50 hover:text-white/70 border border-transparent"
                  }`}
                >
                  Minutes
                  {minuteChange != null && (
                    <span className={`ml-1 ${minuteChange >= 95 ? "text-green-400" : "text-amber-400"}`}>{minuteChange}%</span>
                  )}
                </button>
              </div>
            )}
          </div>

          {/* Raw stat impact summary when stat is selected */}
          {selectedStat && statBaseline != null && statBaseline > 0 && (
            <div className="bg-white/[0.03] rounded-lg p-3 border border-white/5 mb-3 mt-3">
              <p className="text-xs text-white/60 mb-2 font-medium">
                {STAT_LABELS[selectedStat] ?? selectedStat} impact after return
                <span className="text-white/25 ml-2">(baseline: {statBaseline.toFixed(1)} {statUnit}/game, n={curve.sample_size})</span>
              </p>
              <div className="flex items-center gap-4 text-sm">
                {[0, 4, 9].map((idx) => {
                  const pct = (useMedian ? curve.stat_median_pct : curve.stat_avg_pct)?.[selectedStat]?.[idx];
                  const impact = rawImpact(pct, statBaseline);
                  const color = impact == null ? "text-white/30" : impact >= 0 ? "text-green-400" : "text-amber-400";
                  return (
                    <div key={idx}>
                      <span className="text-white/40 text-xs">G{idx + 1}: </span>
                      <span className={`font-bold ${color}`}>{fmtImpact(impact, statUnit)}</span>
                    </div>
                  );
                })}
              </div>
              <p className="text-[10px] text-white/30 mt-1.5">
                ({[0, 4, 9].map((idx) => {
                  const pct = (useMedian ? curve.stat_median_pct : curve.stat_avg_pct)?.[selectedStat]?.[idx];
                  return pct != null ? `${Math.round(pct * 100)}%` : "—";
                }).join(" → ")} of baseline)
              </p>
            </div>
          )}

          {/* Stat detail grid (percentage view, shown when stat selected but no baselines available) */}
          {selectedStat && (statBaseline == null || statBaseline === 0) && (useMedian ? curve.stat_median_pct : curve.stat_avg_pct)?.[selectedStat] && (
            <div className="bg-white/[0.03] rounded-lg p-3 border border-white/5 mb-3 mt-3">
              <p className="text-xs text-white/50 mb-2">
                {STAT_LABELS[selectedStat] ?? (selectedStat === "composite" ? "Composite" : selectedStat)} — {useMedian ? "median" : "avg"} % of pre-injury baseline over 10 games
                <span className="text-white/25 ml-2">(n={curve.sample_size})</span>
              </p>
              <div className="grid grid-cols-10 gap-1">
                {((useMedian ? curve.stat_median_pct : curve.stat_avg_pct)?.[selectedStat] ?? []).map((val, i) => {
                  const pct = val != null ? Math.round(val * 100) : null;
                  const color = pct == null ? "text-white/20"
                    : pct >= 100 ? "text-green-400"
                    : pct >= 80 ? "text-amber-400"
                    : "text-red-400";
                  return (
                    <div key={i} className="text-center">
                      <p className="text-[9px] text-white/30">G{i + 1}</p>
                      <p className={`text-xs font-bold ${color}`}>{pct != null ? `${pct}%` : "—"}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Minutes G1-G10 breakdown */}
          {showMinutes && <div className="mt-3"><MinutesBreakdown curve={curve} /></div>}

          {/* Injury comparison dropdown */}
          {allCurves.length > 1 && (
            <div className="flex items-center gap-2 mt-3 mb-1">
              <span className="text-[10px] text-white/35 shrink-0">Compare with:</span>
              <select
                value={compareSlug}
                onChange={(e) => setCompareSlug(e.target.value)}
                className="flex-1 border border-white/10 rounded-lg px-2 py-1 text-xs cursor-pointer hover:border-white/20 transition-colors max-w-xs"
                style={{ backgroundColor: "#151B2E", color: "rgba(255,255,255,0.7)" }}
              >
                <option value="" style={{ backgroundColor: "#151B2E", color: "#ccc" }}>None</option>
                {allCurves
                  .filter((c) => c.curve_id !== baseCurve.curve_id)
                  .map((c) => (
                    <option key={c.curve_id} value={`${c.injury_type_slug}|${c.league_slug}`} style={{ backgroundColor: "#151B2E", color: "#ccc" }}>
                      {c.injury_type} ({LEAGUE_LABELS[c.league_slug]})
                    </option>
                  ))}
              </select>
              {compareSlug && (
                <button
                  onClick={() => setCompareSlug("")}
                  className="text-[10px] text-white/30 hover:text-white/50"
                >
                  Clear
                </button>
              )}
            </div>
          )}

          {/* Comparison legend */}
          {compareCurve && (
            <div className="mb-1">
              <div className="flex items-center gap-4 text-[10px] text-white/40">
                <span className="flex items-center gap-1.5">
                  <span className="w-4 h-0.5 bg-[#1C7CFF] rounded" /> {baseCurve.injury_type} <span className="text-white/20">({curve.sample_size})</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-4 h-0.5 bg-[#FF8C00] rounded" style={{ borderBottom: "2px dashed #FF8C00" }} /> {compareCurve.injury_type} <span className="text-white/20">({compareCurve.sample_size})</span>
                </span>
              </div>
              {compareCurve.sample_size < 30 && (
                <p className="text-[10px] text-amber-400/70 mt-1">
                  ⚠ {compareCurve.injury_type} has only {compareCurve.sample_size} cases — interpret with caution
                </p>
              )}
            </div>
          )}

          {/* Chart — shows selected stat curve or overall */}
          <div className="mt-3">
            <p className="text-[10px] text-white/40 text-center mb-1">
              {selectedStat
                ? `${STAT_LABELS[selectedStat] ?? selectedStat} — performance relative to pre-injury baseline`
                : "Overall performance relative to pre-injury baseline"}
            </p>
            <PerformanceCurveChart
              curve={viewCurve}
              compareCurve={compareCurve ?? undefined}
              compareLabel={compareCurve?.injury_type}
            />
          </div>

          {/* Key stats — show raw impact when stat selected, % otherwise */}
          <div className="grid grid-cols-3 gap-3 mt-4">
            {[{ idx: 0, label: "Game 1 Return" }, { idx: 4, label: "Game 5 Return" }, { idx: 9, label: "By Game 10" }].map(({ idx, label }) => {
              const pctVal = viewData[idx];
              const impact = rawImpact(pctVal, statBaseline);
              const pctDisplay = pctVal != null ? `${Math.round(pctVal * 100)}%` : "—";
              // Compare curve value at same index
              const comparePctVal = compareCurve
                ? (selectedStat
                    ? (useMedian ? compareCurve.stat_median_pct?.[selectedStat]?.[idx] : compareCurve.stat_avg_pct?.[selectedStat]?.[idx])
                    : (useMedian ? compareCurve.median_pct_recent[idx] : compareCurve.avg_pct_recent[idx]))
                : null;
              const comparePctDisplay = comparePctVal != null ? `${Math.round(comparePctVal * 100)}%` : null;
              return (
                <div key={idx} className="bg-white/5 rounded-lg p-3 text-center">
                  <p className="text-xs text-white/40 mb-1">{label}</p>
                  {selectedStat && impact != null ? (
                    <>
                      <p className={`text-sm font-bold ${impact >= 0 ? "text-green-400" : "text-amber-400"}`}>
                        {fmtImpact(impact, statUnit)}
                      </p>
                      <p className="text-[10px] text-white/25">{pctDisplay} of baseline</p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm font-bold text-white">{pctDisplay}</p>
                      {idx === 9 && curve.games_to_full != null ? (
                        <p className="text-[10px] text-white/25">~{Math.round(curve.games_to_full)} games to full</p>
                      ) : (
                        <p className="text-[10px] text-white/25">of baseline</p>
                      )}
                    </>
                  )}
                  {comparePctDisplay && (
                    <p className="text-[10px] text-[#FF8C00] mt-1">{comparePctDisplay}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const RETURN_TYPE_OPTIONS = [
  { value: "", label: "All Returns" },
  { value: "same_season", label: "Same Season" },
  { value: "next_season", label: "Next Season" },
] as const;

export default function PerformanceCurvesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const qLeague = searchParams.get("league");
  const qInjury = searchParams.get("injury");
  // Capture the initial injury param so it survives URL clearing
  const [initialInjury] = useState(() => searchParams.get("injury"));

  const [league, setLeague] = useState<LeagueFilter>(
    qLeague && ["nba", "nfl", "mlb", "nhl", "premier-league"].includes(qLeague) ? qLeague as LeagueFilter : "all"
  );
  const [position, setPosition] = useState<string>("all");
  const [returnType, setReturnType] = useState<string>("");
  const { data: curves = [], isLoading } = usePerformanceCurves(
    league === "all" ? undefined : league,
    undefined,
    position,
    returnType
  );
  const { data: positions = [] } = usePositionsWithCurves(league === "all" ? undefined : league);

  // Filter out "other" category and require n >= 30
  const filteredCurves = useMemo(() => {
    const base = curves.filter((c) => isRealInjury(c.injury_type_slug, c.injury_type) && c.sample_size >= 30 && (c.median_pct_recent[0] == null || c.median_pct_recent[0] > 0));
    // Deduplicate by injury_type_slug + league_slug (keep highest sample_size)
    const seen = new Map<string, typeof base[0]>();
    for (const c of base) {
      const key = `${c.injury_type_slug}|${c.league_slug}`;
      const existing = seen.get(key);
      if (!existing || c.sample_size > existing.sample_size) seen.set(key, c);
    }
    return Array.from(seen.values());
  }, [curves]);

  // Auto-scroll to injury from query param after data loads
  useEffect(() => {
    if (!qInjury || filteredCurves.length === 0) return;
    // Find the matching curve
    const target = filteredCurves.find((c) => c.injury_type_slug === qInjury);
    if (!target) return;
    const elId = `curve-${target.injury_type_slug}-${target.league_slug}`;
    // Small delay to let DOM render
    const timer = setTimeout(() => {
      const el = document.getElementById(elId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        // Highlight briefly
        el.style.transition = "box-shadow 0.3s ease, border-color 0.3s ease";
        el.style.boxShadow = "0 0 0 2px rgba(28,124,255,0.5), 0 0 20px rgba(28,124,255,0.15)";
        el.style.borderColor = "rgba(28,124,255,0.4)";
        // Auto-expand the card, then re-scroll so the chart is visible
        setTimeout(() => {
          el.querySelector("button")?.click();
          // After expand animation, scroll to show the chart at the top
          setTimeout(() => {
            el.scrollIntoView({ behavior: "smooth", block: "start" });
          }, 300);
        }, 400);
        // Remove highlight after 2s
        setTimeout(() => {
          el.style.boxShadow = "";
          el.style.borderColor = "";
        }, 2500);
      }
    }, 200);
    // Clear param after use so it doesn't re-trigger
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("injury");
      next.delete("league");
      return next;
    }, { replace: true });
    return () => clearTimeout(timer);
  }, [qInjury, filteredCurves, setSearchParams]);

  const totalCases = filteredCurves.reduce((sum, c) => sum + c.sample_size, 0);
  const year = new Date().getFullYear();

  // Reliable curves = sample_size >= 10
  const reliableCurves = useMemo(
    () => filteredCurves.filter((c) => c.sample_size >= 30),
    [filteredCurves]
  );

  // Most impactful injuries: 1 per league when "All", top 5 when specific league selected
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const mostImpactful = useMemo(() => {
    const candidates = reliableCurves.filter((c) => c.median_pct_recent[0] != null);
    if (league !== "all") {
      return [...candidates]
        .sort((a, b) => (a.median_pct_recent[0] ?? 1) - (b.median_pct_recent[0] ?? 1))
        .slice(0, 5);
    }
    const byLeague = new Map<string, PerformanceCurve>();
    for (const c of candidates) {
      const existing = byLeague.get(c.league_slug);
      if (!existing || c.median_pct_recent[0]! < existing.median_pct_recent[0]!) {
        byLeague.set(c.league_slug, c);
      }
    }
    return [...byLeague.values()].sort((a, b) => (a.median_pct_recent[0] ?? 1) - (b.median_pct_recent[0] ?? 1));
  }, [reliableCurves, league]);
  void mostImpactful; // used in a future section

  // Latest computed_at date across all curves
  const latestComputedAt = useMemo(() => {
    if (filteredCurves.length === 0) return null;
    return filteredCurves.reduce((latest, c) =>
      c.computed_at > latest ? c.computed_at : latest, filteredCurves[0].computed_at
    );
  }, [filteredCurves]);


  // Group injuries by body region for "Comparable Injuries"
  const injuryGroups = useMemo(() => {
    const lowerBody = ["ankle", "knee", "acl", "hamstring", "quad", "calf", "groin", "hip", "foot", "achilles", "shin", "leg", "mcl", "meniscus", "plantar"];
    const upperBody = ["shoulder", "elbow", "wrist", "hand", "finger", "thumb", "arm", "rotator"];
    const headNeck = ["concussion", "head", "neck", "jaw", "face", "eye"];
    const softTissue = ["hamstring", "calf", "groin", "quad", "oblique", "abdominal", "muscle"];

    const categorize = (slug: string) => {
      const s = slug.toLowerCase();
      if (headNeck.some((k) => s.includes(k))) return "Head & Neck";
      if (softTissue.some((k) => s.includes(k))) return "Soft Tissue / Muscle";
      if (lowerBody.some((k) => s.includes(k))) return "Lower Body";
      if (upperBody.some((k) => s.includes(k))) return "Upper Body";
      return "Other";
    };

    const groups: Record<string, PerformanceCurve[]> = {};
    for (const c of filteredCurves) {
      const cat = categorize(c.injury_type_slug);
      if (cat === "Other") continue;
      (groups[cat] ??= []).push(c);
    }
    return groups;
  }, [filteredCurves]);

  const [showMethodology, setShowMethodology] = useState(false);

  // Featured curve: default to a well-known high-sample injury
  const defaultFeaturedSlug = useMemo(() => {
    // If navigated with an injury query param, feature that injury (use initialInjury so it persists after URL clearing)
    if (initialInjury) {
      const qMatch = filteredCurves.find((c) => c.injury_type_slug === initialInjury);
      if (qMatch) return `${qMatch.injury_type_slug}|${qMatch.league_slug}`;
    }
    const preferred = ["knee", "acl", "hamstring", "ankle", "concussion"];
    for (const pref of preferred) {
      const match = filteredCurves.find((c) => c.injury_type_slug.includes(pref));
      if (match) return `${match.injury_type_slug}|${match.league_slug}`;
    }
    return filteredCurves[0] ? `${filteredCurves[0].injury_type_slug}|${filteredCurves[0].league_slug}` : "";
  }, [filteredCurves, initialInjury]);

  const [featuredCurveSlug, setFeaturedCurveSlug] = useState("");
  const activeFeaturedSlug = featuredCurveSlug || defaultFeaturedSlug;
  const featuredCurve = useMemo(() => {
    if (!activeFeaturedSlug) return null;
    const [injSlug, leagSlug] = activeFeaturedSlug.split("|");
    return filteredCurves.find((c) => c.injury_type_slug === injSlug && c.league_slug === leagSlug) ?? null;
  }, [activeFeaturedSlug, filteredCurves]);

  // Key findings: one highlight per league
  const keyFindings = useMemo(() => {
    const findings: { league: string; label: string; detail: string; color: string }[] = [];
    const leagueGroups = new Map<string, PerformanceCurve[]>();
    for (const c of reliableCurves) {
      const arr = leagueGroups.get(c.league_slug) ?? [];
      arr.push(c);
      leagueGroups.set(c.league_slug, arr);
    }
    for (const [ls, lCurves] of leagueGroups) {
      const withG1 = lCurves.filter((c) => c.median_pct_recent[0] != null);
      if (withG1.length === 0) continue;
      const worst = withG1.reduce((a, b) => (a.median_pct_recent[0]! < b.median_pct_recent[0]! ? a : b));
      const g1 = Math.round(worst.median_pct_recent[0]! * 100);
      const g10 = worst.median_pct_recent[9] != null ? Math.round(worst.median_pct_recent[9]! * 100) : null;
      findings.push({
        league: LEAGUE_LABELS[ls] ?? ls.toUpperCase(),
        label: `${worst.injury_type}: ${g1}% at G1${g10 != null ? `, ${g10}% by G10` : ""}`,
        detail: `${worst.sample_size} cases`,
        color: leagueColor(ls),
      });
    }
    return findings;
  }, [reliableCurves]);

  return (
    <div className="min-h-screen bg-[#0A0F1E] text-white">
      <SEO
        title={`Post-Injury Performance Curves (${year}) - Recovery Analytics`}
        description={`How do players perform after returning from injury? Explore recovery curves across NFL, NBA, MLB, NHL, and EPL. ${totalCases.toLocaleString()} injury cases analyzed.`}
        path="/performance-curves"
        jsonLd={jsonLdGraph(
          breadcrumbJsonLd([
            { name: "Home", path: "/" },
            { name: "Performance Curves", path: "/performance-curves" },
          ]),
          datasetJsonLd({
            name: "Post-Injury Player Performance Data",
            description: `Recovery performance curves for professional athletes returning from injury. ${totalCases.toLocaleString()} cases across NBA, NFL, MLB, NHL, and EPL.`,
            url: "/performance-curves",
            sampleSize: totalCases,
            keywords: ["injury recovery", "player performance after injury", "return to play", "sports analytics"],
          }),
          faqJsonLd([
            {
              question: "How do players perform after returning from injury?",
              answer: "Most players return to 85-95% of pre-injury performance in their first game back, with gradual improvement over the following 10 games. Recovery rates vary significantly by injury type and sport.",
            },
            {
              question: "How long does it take to return to full performance after injury?",
              answer: "On average, players reach pre-injury performance levels within 5-10 games of returning. Soft tissue injuries like hamstrings recover faster than structural injuries like ACL tears.",
            },
            {
              question: "What sports injuries have the biggest performance impact?",
              answer: "ACL tears, Achilles injuries, and concussions typically show the largest performance drops upon return. Soft tissue injuries like hamstrings, calves, and groin strains generally have shorter recovery curves.",
            },
          ])
        )}
      />
      <SiteHeader />

      {/* Hero */}
      <div className="relative overflow-hidden border-b border-white/10 bg-gradient-to-br from-[#0A0F1E] via-[#0d1529] to-[#0A0F1E]">
        <div className="pointer-events-none absolute -top-32 -left-32 w-96 h-96 rounded-full bg-[#1C7CFF] opacity-10 blur-3xl" />
        <div className="pointer-events-none absolute -top-32 -right-32 w-96 h-96 rounded-full bg-[#3DFF8F] opacity-8 blur-3xl" />

        <div className="relative max-w-4xl mx-auto px-4 sm:px-6 py-10">
          <nav className="text-sm text-white/40 mb-4">
            <Link to="/" className="hover:text-white/60">Home</Link>
            {" / "}
            <span className="text-white/60">Performance Curves</span>
          </nav>

          <div className="flex items-center gap-3 mb-3">
            <span className="text-xs font-bold uppercase tracking-[0.2em] text-[#3DFF8F]">
              Recovery Analytics
            </span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-3">
            <span className="text-white">Post-Injury </span>
            <span className="bg-gradient-to-r from-[#1C7CFF] to-[#3DFF8F] bg-clip-text text-transparent">
              Performance Curves
            </span>
          </h1>
          <p className="text-white/50 text-sm max-w-xl">
            How does player performance change in the first 10 games after returning from injury?
            Curves show percentage of pre-injury baseline performance. Click any curve for per-stat breakdowns.
          </p>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">

        {/* League filter */}
        <div className="flex gap-1.5 overflow-x-auto pb-4 mb-4">
          {LEAGUE_ORDER.map((slug) => (
            <button
              key={slug}
              onClick={() => { setLeague(slug); setPosition("all"); trackLeagueFilter(slug, "performance_curves"); }}
              className={`shrink-0 px-4 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                league === slug
                  ? "border-[#1C7CFF]/50 bg-[#1C7CFF]/15 text-[#1C7CFF]"
                  : "border-white/10 text-white/40 hover:text-white/60"
              }`}
            >
              {LEAGUE_LABELS[slug]}
            </button>
          ))}
        </div>

        {/* Position filter — grouped by league */}
        {positions.length > 0 && (
          <div className="pb-3 mb-4 space-y-1.5">
            <div className="flex items-center gap-1 flex-wrap">
              <button
                onClick={() => setPosition("all")}
                className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  position === "all" ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/30" : "bg-white/5 text-white/40 hover:text-white/60 border border-transparent"
                }`}
              >
                All Positions
              </button>
            </div>
            {league !== "all" ? (
              <div className="flex items-center gap-1 flex-wrap">
                <span className="text-[10px] text-white/30 font-medium w-10 shrink-0">{LEAGUE_LABELS[league]}</span>
                {positions.map((pos) => (
                  <button
                    key={pos}
                    onClick={() => setPosition(pos)}
                    className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
                      position === pos ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/30" : "bg-white/5 text-white/40 hover:text-white/60 border border-transparent"
                    }`}
                  >
                    {pos}
                  </button>
                ))}
              </div>
            ) : (
              LEAGUE_ORDER.filter((s) => s !== "all").map((ls) => {
                const leaguePositions = (LEAGUE_POSITIONS[ls] ?? []).filter((p) => positions.includes(p));
                if (leaguePositions.length === 0) return null;
                return (
                  <div key={ls} className="flex items-center gap-1 flex-wrap">
                    <span className="text-[10px] text-white/30 font-medium w-10 shrink-0">{LEAGUE_LABELS[ls]}</span>
                    {leaguePositions.map((pos) => (
                      <button
                        key={`${ls}-${pos}`}
                        onClick={() => { setLeague(ls as LeagueFilter); setPosition(pos); }}
                        className="shrink-0 px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors bg-white/5 text-white/40 hover:text-white/60 border border-transparent"
                      >
                        {pos}
                      </button>
                    ))}
                  </div>
                );
              })
            )}
          </div>
        )}

        {position !== "all" && (
          <p className="text-xs text-white/30 mt-1 mb-3">Only showing injury types with &ge; 3 cases for this position</p>
        )}

        {/* Return type filter: all / same season / next season */}
        <div className="flex items-center gap-2 mb-4">
          <span className="text-[10px] text-white/30 font-medium shrink-0">Return window</span>
          {RETURN_TYPE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setReturnType(opt.value)}
              className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                returnType === opt.value
                  ? "bg-purple-500/15 text-purple-400 border border-purple-500/30"
                  : "bg-white/5 text-white/40 hover:text-white/60 border border-transparent"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Featured Interactive Curve */}
        {!isLoading && featuredCurve && (
          <section className="mb-8">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold uppercase tracking-widest text-[#3DFF8F]/80">Interactive Recovery Curve</h2>
              <select
                value={activeFeaturedSlug}
                onChange={(e) => setFeaturedCurveSlug(e.target.value)}
                className="border border-white/10 rounded-lg px-3 py-1.5 text-xs cursor-pointer hover:border-white/20 transition-colors max-w-[220px]"
                style={{ backgroundColor: "#151B2E", color: "rgba(255,255,255,0.7)" }}
              >
                {filteredCurves.map((c) => (
                  <option key={c.curve_id} value={`${c.injury_type_slug}|${c.league_slug}`} style={{ backgroundColor: "#151B2E", color: "#ccc" }}>
                    {c.injury_type} ({LEAGUE_LABELS[c.league_slug]})
                  </option>
                ))}
              </select>
            </div>
            <CurveCard curve={featuredCurve} forceExpand allCurves={filteredCurves} />
          </section>
        )}

        {/* Key Findings by League */}
        {!isLoading && keyFindings.length > 0 && (
          <section className="mb-6 rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <h2 className="text-xs font-bold uppercase tracking-widest text-white/50 mb-3">Key Findings by League</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {keyFindings.map((f) => (
                <div key={f.league} className="flex items-start gap-2 rounded-lg bg-white/[0.03] border border-white/5 px-3 py-2.5">
                  <span className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0" style={{ backgroundColor: f.color }} />
                  <div className="min-w-0">
                    <p className="text-xs font-semibold" style={{ color: f.color }}>{f.league}</p>
                    <p className="text-xs text-white/60">{f.label}</p>
                    <p className="text-[10px] text-white/25">{f.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Discovery sections */}
        {!isLoading && reliableCurves.length > 0 && (() => {
          // Primary stat per league for stat impact display
          const PRIMARY_STAT: Record<string, { key: string; label: string }> = {
            nba: { key: "stat_pts", label: "PTS" },
            nfl: { key: "stat_rush_yds", label: "Rush Yds" },
            mlb: { key: "stat_h", label: "Hits" },
            nhl: { key: "stat_goals", label: "Goals" },
            "premier-league": { key: "stat_goals", label: "Goals" },
          };
          const getImpact = (c: PerformanceCurve, gIdx: number) => {
            // Use primary stat for the league first — most representative
            const baselines = c.stat_baselines ?? {};
            const medians = c.stat_median_pct ?? {};

            const ps = PRIMARY_STAT[c.league_slug];
            if (ps) {
              const base = baselines[ps.key];
              const pct = (medians[ps.key] as number[] | undefined)?.[gIdx];
              if (base && base > 0 && pct != null) {
                return { label: ps.label, diff: base * (pct - 1.0), statKey: ps.key };
              }
            }

            // Fallback: pick stat with largest % deviation (not raw absolute),
            // so high-baseline stats like pass yards don't dominate
            let best: { label: string; diff: number; statKey: string; pctDev: number } | null = null;
            for (const [sk, base] of Object.entries(baselines)) {
              if (sk === "composite" || !base || base === 0) continue;
              const pct = (medians[sk] as number[] | undefined)?.[gIdx];
              if (pct == null) continue;
              const pctDev = Math.abs(pct - 1.0);
              const diff = base * (pct - 1.0);
              if (!best || pctDev > best.pctDev) {
                best = { label: STAT_UNITS[sk] ?? STAT_LABELS[sk] ?? sk.replace("stat_", ""), diff, statKey: sk, pctDev };
              }
            }
            return best ? { label: best.label, diff: best.diff, statKey: best.statKey } : null;
          };

          // Use G1 (index 0) for discovery rankings
          const withImpact = reliableCurves
            .map((c) => ({ curve: c, impact: getImpact(c, 0) }))
            .filter((x): x is { curve: PerformanceCurve; impact: { label: string; diff: number; statKey: string } } => x.impact != null);

          const biggestDrops = [...withImpact]
            .sort((a, b) => a.impact.diff - b.impact.diff)
            .slice(0, 6);

          const fastestRecoveries = [...withImpact]
            .sort((a, b) => b.impact.diff - a.impact.diff)
            .filter((x) => x.impact.diff > -0.5) // near-zero or positive
            .slice(0, 6);

          const scrollToCurve = (c: PerformanceCurve, statKey?: string) => {
            const el = document.getElementById(`curve-${c.injury_type_slug}-${c.league_slug}`);
            if (el) {
              el.scrollIntoView({ behavior: "smooth", block: "center" });
              setTimeout(() => {
                // Expand the card
                el.querySelector("button")?.click();
                // If a specific stat was requested, dispatch event to select it
                if (statKey) {
                  setTimeout(() => {
                    el.dispatchEvent(new CustomEvent("select-stat", { detail: statKey }));
                  }, 300);
                }
              }, 400);
            }
          };

          return (
            <>
              {/* Biggest Performance Drops */}
              {biggestDrops.length > 0 && (
                <section className="mb-6 rounded-xl border border-red-500/15 bg-gradient-to-br from-red-500/5 to-transparent p-4">
                  <h2 className="text-xs font-bold uppercase tracking-widest text-red-400/80 mb-3">Biggest Performance Drops (Game 1)</h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                    {biggestDrops.map(({ curve: c, impact }) => (
                      <button
                        key={c.curve_id}
                        onClick={() => scrollToCurve(c, impact.statKey)}
                        className="flex items-center justify-between gap-2 rounded-lg bg-white/[0.03] border border-white/5 px-3 py-2.5 text-left hover:bg-white/[0.07] hover:border-red-500/20 transition-colors"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-white truncate">{c.injury_type}</p>
                          <p className="text-[10px] text-white/30"><span className="inline-block w-1.5 h-1.5 rounded-full mr-1" style={{ backgroundColor: leagueColor(c.league_slug) }} />{LEAGUE_LABELS[c.league_slug]} · {c.sample_size} cases</p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-sm font-bold text-red-400 tabular-nums">{impact.diff >= 0 ? "+" : ""}{impact.diff.toFixed(1)}</p>
                          <p className="text-[9px] text-white/25">{impact.label}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {/* Fastest Recoveries */}
              {fastestRecoveries.length > 0 && (
                <section className="mb-6 rounded-xl border border-green-500/15 bg-gradient-to-br from-green-500/5 to-transparent p-4">
                  <h2 className="text-xs font-bold uppercase tracking-widest text-green-400/80 mb-3">Fastest Recoveries (Game 1)</h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                    {fastestRecoveries.map(({ curve: c, impact }) => (
                      <button
                        key={c.curve_id}
                        onClick={() => scrollToCurve(c, impact.statKey)}
                        className="flex items-center justify-between gap-2 rounded-lg bg-white/[0.03] border border-white/5 px-3 py-2.5 text-left hover:bg-white/[0.07] hover:border-green-500/20 transition-colors"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-white truncate">{c.injury_type}</p>
                          <p className="text-[10px] text-white/30"><span className="inline-block w-1.5 h-1.5 rounded-full mr-1" style={{ backgroundColor: leagueColor(c.league_slug) }} />{LEAGUE_LABELS[c.league_slug]} · {c.sample_size} cases</p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className={`text-sm font-bold tabular-nums ${impact.diff >= 0 ? "text-green-400" : "text-amber-400"}`}>
                            {impact.diff >= 0 ? "+" : ""}{impact.diff.toFixed(1)}
                          </p>
                          <p className="text-[9px] text-white/25">{impact.label}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </>
          );
        })()}

        {/* Legend + summary + info button */}
        <div className="flex flex-wrap items-center justify-between gap-4 text-xs text-white/40 mb-6 pb-4 border-b border-white/8">
          <div className="flex flex-wrap items-center gap-4">
            <span className="flex items-center gap-1.5">
              <span className="w-4 h-0.5 bg-[#1C7CFF] rounded" /> Median
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-4 h-3 bg-[#1C7CFF]/15 rounded" /> 25th–75th pctl
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-4 h-0.5 border-b border-dashed border-white/25" /> Average
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-4 h-0.5 border-b border-dashed border-[#3DFF8F]/40" /> Baseline
            </span>
            <button
              onClick={() => setShowMethodology(!showMethodology)}
              className="ml-2 w-5 h-5 rounded-full border border-white/20 text-[10px] text-white/40 hover:text-white/60 hover:border-white/40 transition-colors flex items-center justify-center"
              title="How is this calculated?"
            >
              i
            </button>
          </div>
          {!isLoading && filteredCurves.length > 0 && (
            <span className="text-white/30">
              {filteredCurves.length} injury types · {totalCases.toLocaleString()} return cases
            </span>
          )}
        </div>

        {/* Methodology panel (toggled by info button) */}
        {showMethodology && (
          <div className="mb-6 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-xs text-white/50 leading-relaxed space-y-2">
            <p className="font-semibold text-white/70 text-sm">How Performance Curves Are Calculated</p>
            <p>
              Each curve compares a player's post-return game performance against their <strong className="text-white/70">10-game pre-injury baseline</strong>.
              A value of 100% means the player performed at their pre-injury level.
            </p>
            <p>
              <strong className="text-white/70">Outlier protection:</strong> Individual game ratios are capped at 300% to prevent
              bench players or low-minute games from inflating averages. Averages use a trimmed mean (top/bottom 5% excluded).
            </p>
            <p>
              <strong className="text-white/70">Minimum thresholds:</strong> Players must have at least 5 pre-injury games for inclusion.
              Each curve requires at least 3 historical cases. Data sourced from Basketball-Reference, Pro-Football-Reference,
              Hockey-Reference, Baseball-Reference, and FBref. Updated daily.
            </p>
          </div>
        )}

        {/* Full Injury List Explorer */}
        {!isLoading && filteredCurves.length > 0 && (
          <h2 className="text-sm font-bold uppercase tracking-widest text-white/50 mb-1">Full Injury List Explorer</h2>
        )}

        {/* Curves list */}
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-20 rounded-xl bg-white/10 animate-pulse" />
            ))}
          </div>
        ) : filteredCurves.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-8 text-center">
            <p className="text-white/50">No performance curve data available{position !== "all" ? ` for ${position}` : ""}.</p>
            <p className="text-xs text-white/30 mt-2">
              {position !== "all" ? "Try selecting 'All Positions'." : "Curves are computed from historical game log data. The pipeline runs daily."}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredCurves.map((curve) => (
              <CurveCard key={curve.curve_id} curve={curve} allCurves={filteredCurves} />
            ))}
          </div>
        )}

        {/* Comparable Injuries by Body Region */}
        {!isLoading && Object.keys(injuryGroups).length > 0 && (
          <section className="mt-10 border-t border-white/8 pt-6">
            <h2 className="text-lg font-bold mb-1">Comparable Injuries by Body Region</h2>
            <p className="text-xs text-white/40 mb-4">Injuries grouped by anatomical similarity to help compare recovery timelines within the same category.</p>
            <div className="space-y-4">
              {Object.entries(injuryGroups).sort(([, a], [, b]) => b.length - a.length).map(([group, groupCurves]) => {
                const sorted = [...groupCurves].sort((a, b) => (a.median_pct_recent[0] ?? 1) - (b.median_pct_recent[0] ?? 1));
                const reliableInGroup = sorted.filter((c) => c.sample_size >= 30);
                const medianGroupVals = reliableInGroup.filter((c) => c.median_pct_recent[0] != null).map((c) => c.median_pct_recent[0]!).sort((a, b) => a - b);
                const avgG1 = medianGroupVals.length > 0
                  ? Math.round(medianGroupVals[Math.floor(medianGroupVals.length / 2)] * 100)
                  : null;
                return (
                  <div key={group} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-semibold text-white/80">{group}</h3>
                      <span className="text-[10px] text-white/30">
                        {sorted.length} injury type{sorted.length !== 1 ? "s" : ""} · {sorted.reduce((s, c) => s + c.sample_size, 0).toLocaleString()} cases
                        {avgG1 != null && <> · Median G1: {avgG1}%</>}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {sorted.map((c) => {
                        const g1 = c.median_pct_recent[0] != null ? Math.round(c.median_pct_recent[0] * 100) : null;
                        const color = g1 == null ? "text-white/30" : g1 >= 95 ? "text-green-400" : g1 >= 85 ? "text-amber-400" : "text-red-400";
                        return (
                          <span key={c.curve_id} className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-white/5 text-xs text-white/50 border border-white/5">
                            {c.injury_type}
                            <span className="text-[10px]" style={{ color: `${leagueColor(c.league_slug)}99` }}>({LEAGUE_LABELS[c.league_slug]})</span>
                            {g1 != null && <span className={`font-bold ${color}`}>{g1}%</span>}
                            {c.sample_size < 30 && <span className="text-[9px] text-amber-400/60">*</span>}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Latest data update */}
        {latestComputedAt && (
          <p className="text-[10px] text-white/20 mt-6 mb-2">
            Data last updated: {new Date(latestComputedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
          </p>
        )}

        {/* Methodology note */}
        <div className="mt-10 border-t border-white/8 pt-6">
          <h3 className="text-xs font-bold uppercase tracking-wide text-white/40 mb-2">Methodology</h3>
          <div className="text-xs text-white/30 leading-relaxed space-y-2">
            <p>
              Performance curves are generated by comparing each player's post-return game statistics against their
              pre-injury 10-game rolling average (the "recent baseline"). For each game after a player returns from
              the injured list, we compute the ratio of their actual performance to their baseline across multiple
              statistical categories — points, assists, rebounds, passing yards, goals, hits, and other sport-specific
              metrics depending on the league. This produces a per-game recovery percentage where 100% indicates
              the player has returned to their pre-injury production level.
            </p>
            <p>
              To ensure statistical reliability, individual game ratios are capped at 300% of baseline to prevent
              low-minute or bench players from distorting averages. We apply a trimmed mean (excluding the top and
              bottom 5% of values) when aggregating across all historical cases of a given injury type. Each curve
              requires a minimum of 3 historical return cases, and each individual case requires 5+ pre-injury games
              to establish a meaningful baseline. The current dataset encompasses {totalCases.toLocaleString()} verified
              return-from-injury cases across {filteredCurves.length} distinct injury types spanning the NBA, NFL, MLB,
              NHL, and English Premier League.
            </p>
            <p>
              Data is sourced from Basketball-Reference, Pro-Football-Reference, Hockey-Reference, Baseball-Reference,
              and FBref (for EPL). The pipeline runs daily, pulling new game logs, matching them against active injury
              reports, and recomputing curves when new return cases are detected. Injury classifications are standardized
              across leagues using a normalized taxonomy that maps league-specific injury descriptions to canonical types
              (e.g., "left ankle sprain," "rolled ankle," and "ankle injury" all map to "Ankle"). Position-specific curves
              are generated when sufficient data exists, as recovery patterns can differ by position — for example, a
              hamstring injury may impact a wide receiver's production differently than a quarterback's.
            </p>
            <p>
              Percentile bands (25th to 75th) are displayed on each chart to show the range of outcomes rather than just
              the central tendency. Standard error margins are calculated for each game point to indicate confidence
              in the median estimate. Curves with fewer than 10 cases are flagged with a "Low n" warning badge, as
              the smaller sample may not represent the true population recovery pattern.
            </p>
          </div>
        </div>

        {/* SEO content: Understanding recovery */}
        <section className="mt-8 border-t border-white/8 pt-6">
          <h2 className="text-lg font-bold mb-3">Understanding Post-Injury Performance Data</h2>
          <div className="text-sm text-white/50 leading-relaxed space-y-3">
            <p>
              When a professional athlete returns from injury, their performance rarely matches
              pre-injury levels immediately. Our recovery performance curves quantify this effect
              by tracking how players perform in their first 10 games back relative to their
              pre-injury baseline. This data is essential for fantasy sports managers making
              roster decisions, sports bettors evaluating player props, and analysts studying
              return-to-play trends.
            </p>
            <p>
              Each curve represents the median performance across all historical cases of that
              injury type, with percentile bands showing the range of outcomes. A value of 100%
              means a player is performing at their pre-injury level, while values below indicate
              a performance dip that is common during the initial return period.
            </p>
          </div>
        </section>

        {/* Internal links for SEO */}
        <section className="mt-8 border-t border-white/8 pt-6">
          <h2 className="text-sm font-bold uppercase tracking-wide text-white/40 mb-3">
            Explore More Injury & Recovery Data
          </h2>
          <div className="grid gap-2 sm:grid-cols-2">
            <Link to="/recovery-stats" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              Recovery Statistics — All Leagues
            </Link>
            <Link to="/returning-today" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              Players Returning from Injury Today
            </Link>
            <Link to="/minutes-restriction-after-injury" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              Minutes Restrictions After Injury
            </Link>
            <Link to="/players-returning-from-injury-this-week" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              Players Returning from Injury This Week
            </Link>
            {(["nba", "nfl", "mlb", "nhl", "premier-league"] as const).map((slug) => (
              <Link
                key={`perf-${slug}`}
                to={`/${slug}-injury-performance`}
                className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors"
              >
                {LEAGUE_LABELS[slug]} Injury Performance Analysis
              </Link>
            ))}
            {(["nba", "nfl", "mlb", "nhl", "premier-league"] as const).map((slug) => (
              <Link
                key={`recovery-${slug}`}
                to={`/${slug}/recovery-stats`}
                className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors"
              >
                {LEAGUE_LABELS[slug]} Recovery Statistics
              </Link>
            ))}
            {(["nba", "nfl", "mlb", "nhl", "premier-league"] as const).map((slug) => (
              <Link
                key={`analysis-${slug}`}
                to={`/${slug}-injury-analysis`}
                className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors"
              >
                {LEAGUE_LABELS[slug]} Injury Analysis & Trends
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
