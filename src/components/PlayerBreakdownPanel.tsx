import { useState } from "react";
import { Link } from "react-router-dom";
import { PremiumGate } from "./PremiumGate";
import { PremiumUnlockCounter } from "./PremiumUnlockCounter";
import type { PerformanceCurve } from "../features/performance-curves/lib/types";
import { computeEV, parseOdds, type EVResult } from "../lib/evModel";

const MARKET_LABELS: Record<string, string> = {
  player_points: "PTS", player_rebounds: "REB", player_assists: "AST",
  player_threes: "3PT", player_points_rebounds_assists: "PRA",
  player_pass_yds: "Pass Yds", player_rush_yds: "Rush Yds",
  player_reception_yds: "Rec Yds", player_receptions: "Rec",
  player_goals: "Goals", player_shots_on_goal: "SOG",
  player_shots: "Shots", player_shots_on_target: "SOT",
  batter_hits: "Hits", batter_total_bases: "TB", batter_rbis: "RBI",
};

const MARKET_TO_STAT: Record<string, string> = {
  player_points: "stat_pts", player_rebounds: "stat_reb", player_assists: "stat_ast",
  player_pass_yds: "stat_pass_yds", player_rush_yds: "stat_rush_yds",
  player_reception_yds: "stat_rec_yds", player_receptions: "stat_rec",
  player_goals: "stat_goals", player_shots_on_goal: "stat_sog",
  player_shots: "stat_sog", player_shots_on_target: "stat_sog",
  batter_hits: "stat_h", batter_total_bases: "stat_h", batter_rbis: "stat_rbi",
};

const PRIMARY_STAT: Record<string, { key: string; label: string }> = {
  nba: { key: "stat_pts", label: "PTS" },
  nfl: { key: "stat_rush_yds", label: "Rush Yds" },
  mlb: { key: "stat_h", label: "Hits" },
  nhl: { key: "stat_goals", label: "Goals" },
  "premier-league": { key: "stat_goals", label: "Goals" },
};

interface PreInjuryAvg {
  minutes: number | null;
  [statKey: string]: number | null;
}

interface PropItem {
  id: string;
  market: string;
  line: number | null;
  over_price: string | null;
  under_price: string | null;
  source: string;
}

interface PlayerData {
  player_id: string;
  player_name: string;
  player_slug: string;
  league_slug: string;
  injury_type: string;
  gamesBack: number;
  avg10: PreInjuryAvg | null;
  avgSinceReturn: PreInjuryAvg | null;
  props: PropItem[];
}

function getCurveImpact(curve: PerformanceCurve, gIdx: number, leagueSlug: string): { label: string; diff: number } | null {
  const baselines = curve.stat_baselines ?? {};
  const medians = curve.stat_median_pct ?? {};
  const ps = PRIMARY_STAT[leagueSlug];
  if (ps) {
    const base = baselines[ps.key];
    const pct = (medians[ps.key] as number[] | undefined)?.[gIdx];
    if (base && base > 0 && pct != null) return { label: ps.label, diff: base * (pct - 1.0) };
  }
  return null;
}

function injuryToSlug(injuryType: string): string {
  return injuryType.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Compact expandable breakdown panel for a single player.
 * Designed to fit within one viewport (~800px) without scrolling.
 */
export function PlayerBreakdownPanel({
  player,
  curve,
  sourceFilter,
  statFilter,
  onClose,
  forceFree,
}: {
  player: PlayerData;
  curve?: PerformanceCurve | null;
  sourceFilter: string;
  statFilter?: string;
  onClose: () => void;
  forceFree?: boolean;
}) {
  // Filter and dedupe props
  const SOURCE_PRIORITY = ["draftkings", "fanduel"];
  let sourceProps = sourceFilter === "all"
    ? player.props
    : player.props.filter((p) => p.source === sourceFilter);

  if (statFilter && statFilter !== "all") {
    const STAT_FILTERS_MARKETS: Record<string, string[]> = {
      pts: ["player_points"], reb: ["player_rebounds"], ast: ["player_assists"],
      pra: ["player_points_rebounds_assists"], "3pt": ["player_threes"],
      pass: ["player_pass_yds"], rush: ["player_rush_yds"],
      rec: ["player_reception_yds", "player_receptions"],
      goals: ["player_goals"], sog: ["player_shots_on_goal", "player_shots", "player_shots_on_target"],
      hits: ["batter_hits"], tb: ["batter_total_bases"],
    };
    const markets = STAT_FILTERS_MARKETS[statFilter];
    if (markets) sourceProps = sourceProps.filter((p) => markets.includes(p.market));
  }

  const deduped = new Map<string, PropItem>();
  for (const p of sourceProps) {
    const existing = deduped.get(p.market);
    if (!existing) {
      deduped.set(p.market, p);
    } else if (sourceFilter === "all") {
      const curIdx = SOURCE_PRIORITY.indexOf(existing.source);
      const newIdx = SOURCE_PRIORITY.indexOf(p.source);
      if (newIdx !== -1 && (curIdx === -1 || newIdx < curIdx)) deduped.set(p.market, p);
    }
  }

  const priority = ["player_points", "player_goals", "batter_hits", "player_pass_yds", "player_rush_yds",
    "player_rebounds", "player_assists", "player_threes", "player_shots_on_goal", "batter_total_bases"];
  const sorted = [...deduped.values()].sort((a, b) => {
    const ai = priority.indexOf(a.market);
    const bi = priority.indexOf(b.market);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  // Compute EV for each prop
  const propData = sorted.map((p) => {
    const statKey = MARKET_TO_STAT[p.market];
    const avg10Val = statKey && player.avg10 ? player.avg10[statKey] : null;
    const sinceReturnVal = statKey && player.avgSinceReturn ? player.avgSinceReturn[statKey] : null;
    let ev: EVResult | null = null;
    if (curve && statKey && avg10Val != null && p.line != null && player.gamesBack > 0) {
      ev = computeEV({
        baseline: avg10Val, propLine: p.line,
        overOdds: parseOdds(p.over_price), underOdds: parseOdds(p.under_price),
        gamesSinceReturn: player.gamesBack, recentAvg: sinceReturnVal, curve,
        leagueSlug: player.league_slug, statKey,
        preInjuryMinutes: player.avg10?.minutes, currentMinutes: player.avgSinceReturn?.minutes,
      });
    }
    const gapPct = ev && p.line != null && p.line > 0
      ? Math.round(((ev.expectedCombined - p.line) / p.line) * 100)
      : null;
    return { prop: p, ev, avg10Val, sinceReturnVal, statKey, gapPct };
  });

  // Curve impact
  const impG1 = curve ? getCurveImpact(curve, 0, player.league_slug) : null;
  const impG3 = curve ? getCurveImpact(curve, 2, player.league_slug) : null;

  // Build WHY bullets (max 3)
  const whyBullets: string[] = [];
  if (player.gamesBack <= 3) whyBullets.push(`Game ${player.gamesBack} after return — early recovery window`);
  else if (player.gamesBack <= 6) whyBullets.push(`Game ${player.gamesBack} after return — mid recovery`);
  if (impG3 && impG3.diff < 0) whyBullets.push(`Historical: ${impG3.diff.toFixed(1)} ${impG3.label} vs baseline at G3`);
  if (player.avg10?.minutes && player.avgSinceReturn?.minutes && player.gamesBack > 0) {
    const pct = Math.round((player.avgSinceReturn.minutes / player.avg10.minutes) * 100);
    if (pct < 85) whyBullets.push(`Minutes at ${pct}% of pre-injury levels`);
  }
  if (curve && whyBullets.length < 3) whyBullets.push(`Based on ${curve.sample_size.toLocaleString()} similar injury cases`);

  // Summary line
  const bestProp = propData.find((d) => d.ev?.recommendation && d.ev?.bestEv != null && d.ev.bestEv > 0);
  const summaryParts: string[] = [];
  if (bestProp?.gapPct) summaryParts.push(`${bestProp.gapPct > 0 ? "+" : ""}${bestProp.gapPct}% vs market`);
  summaryParts.push(`Game ${player.gamesBack} return`);
  if (player.avg10?.minutes && player.avgSinceReturn?.minutes && player.avgSinceReturn.minutes / player.avg10.minutes < 0.85) {
    summaryParts.push("Minutes limited");
  }

  const injurySlug = player.injury_type ? injuryToSlug(player.injury_type) : "";
  const [showDeepDive, setShowDeepDive] = useState(false);

  // Additional curve impacts for deep dive
  const impG5 = curve ? getCurveImpact(curve, 4, player.league_slug) : null;

  // Minutes analysis
  const minutesPct = player.avg10?.minutes && player.avgSinceReturn?.minutes && player.gamesBack > 0
    ? player.avgSinceReturn.minutes / player.avg10.minutes
    : null;

  return (
    <div className="border-t border-white/8 bg-white/[0.02] animate-in fade-in duration-200">
      <div className="px-4 py-4">
        {/* Close button */}
        <div className="flex items-center justify-between mb-3">
          <p className="text-[11px] font-medium text-white/40 uppercase tracking-wider">Player Breakdown</p>
          <button onClick={onClose} className="text-white/30 hover:text-white/60 text-sm transition-colors">&times;</button>
        </div>

        {/* SECTION 1 — Summary (1 line) */}
        <p className="text-[13px] text-white/60 mb-3">
          {summaryParts.join(" · ")}
        </p>

        {/* 3-column grid: WHY | KEY STATS | PREMIUM */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {/* SECTION 2 — WHY (max 3 bullets) — FREE */}
          <div className="rounded-lg bg-white/[0.03] border border-white/5 p-3">
            <p className="text-[10px] font-bold text-white/40 uppercase tracking-wider mb-2">Why this signal</p>
            <div className="space-y-1.5">
              {whyBullets.slice(0, 3).map((b, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className={`shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full ${i === 0 ? "bg-red-400/70" : i === 1 ? "bg-amber-400/60" : "bg-blue-400/50"}`} />
                  <p className="text-[12px] text-white/55 leading-snug">{b}</p>
                </div>
              ))}
            </div>
          </div>

          {/* SECTION 3 — Key Stats (FREE: direction + market; PREMIUM: model + gap) */}
          <div className="rounded-lg bg-white/[0.03] border border-white/5 p-3">
            <p className="text-[10px] font-bold text-white/40 uppercase tracking-wider mb-2">Key stats</p>
            <div className="space-y-2">
              {propData.slice(0, 3).map(({ prop: p, ev, avg10Val, sinceReturnVal, gapPct }) => {
                const isOver = ev?.recommendation === "OVER";
                return (
                  <div key={p.id} className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[11px] text-emerald-400/70 font-semibold shrink-0">{MARKET_LABELS[p.market] ?? p.market}</span>
                      {/* Signal direction — FREE */}
                      {ev?.recommendation && (
                        <span className={`text-[11px] font-bold ${isOver ? "text-green-400" : "text-red-400"}`}>
                          {ev.recommendation}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-right">
                      {/* Market line — FREE */}
                      <span className="text-sm font-bold text-white tabular-nums">{p.line}</span>
                      {/* Model — PREMIUM (free for top 4) */}
                      {ev && (forceFree ? (
                        <span className="text-sm text-white/60 tabular-nums">{ev.expectedCombined.toFixed(1)}</span>
                      ) : (
                        <PremiumGate
                          contentId={`bp-${p.id}-model`}
                          playerName={player.player_name}
                          section="breakdown_model"
                          inline
                          placeholder={<span className="text-sm text-white/40 tabular-nums">—</span>}
                        >
                          <span className="text-sm text-white/60 tabular-nums">{ev.expectedCombined.toFixed(1)}</span>
                        </PremiumGate>
                      ))}
                      {/* Gap — PREMIUM (free for top 4) */}
                      {gapPct != null && gapPct !== 0 && (forceFree ? (
                        <span className={`text-xs font-bold tabular-nums ${gapPct < 0 ? "text-red-400/80" : "text-green-400/80"}`}>
                          {gapPct > 0 ? "+" : ""}{gapPct}%
                        </span>
                      ) : (
                        <PremiumGate
                          contentId={`bp-${p.id}-gap`}
                          playerName={player.player_name}
                          section="breakdown_gap"
                          inline
                          placeholder={<span className="text-xs text-white/30 tabular-nums">+?%</span>}
                        >
                          <span className={`text-xs font-bold tabular-nums ${gapPct < 0 ? "text-red-400/80" : "text-green-400/80"}`}>
                            {gapPct > 0 ? "+" : ""}{gapPct}%
                          </span>
                        </PremiumGate>
                      ))}
                    </div>
                  </div>
                );
              })}
              {/* Pre-injury vs return avg for primary stat */}
              {propData[0] && propData[0].avg10Val != null && propData[0].sinceReturnVal != null && (
                <div className="pt-1.5 border-t border-white/5 text-[11px] text-white/40">
                  {MARKET_LABELS[propData[0].prop.market]}: {propData[0].sinceReturnVal?.toFixed(1)} since return vs {propData[0].avg10Val?.toFixed(1)} pre-injury
                </div>
              )}
            </div>
          </div>

          {/* SECTION 4 — Full breakdown (gated, free for top 4) */}
          <div className="rounded-lg bg-white/[0.03] border border-white/5 p-3 relative">
            <p className="text-[10px] font-bold text-white/40 uppercase tracking-wider mb-2">Full breakdown</p>
            {(() => {
              const content = (
                <div className="space-y-2 text-[11px]">
                  {bestProp?.ev && (
                    <>
                      <p className="text-white/50">
                        <span className={`font-medium ${bestProp.ev.confidence === "high" ? "text-green-400/70" : bestProp.ev.confidence === "medium" ? "text-amber-400/70" : "text-white/40"}`}>
                          {bestProp.ev.confidence} confidence
                        </span>
                        {" · "}P({bestProp.ev.recommendation?.toLowerCase()}) {Math.round((bestProp.ev.recommendation === "OVER" ? bestProp.ev.probOver : bestProp.ev.probUnder) * 100)}%
                      </p>
                      {impG1 && <p className="text-white/40">G1 impact: {impG1.diff >= 0 ? "+" : ""}{impG1.diff.toFixed(1)} {impG1.label}</p>}
                      {impG3 && <p className="text-white/40">G3 impact: {impG3.diff >= 0 ? "+" : ""}{impG3.diff.toFixed(1)} {impG3.label}</p>}
                    </>
                  )}
                  {player.avg10?.minutes && player.avgSinceReturn?.minutes && player.gamesBack > 0 && (
                    <p className="text-white/40">
                      Minutes: {player.avgSinceReturn.minutes} vs {player.avg10.minutes} pre-injury ({Math.round((player.avgSinceReturn.minutes / player.avg10.minutes) * 100)}%)
                    </p>
                  )}
                  {curve && <p className="text-white/30">Based on {curve.sample_size.toLocaleString()} comparable returns</p>}
                </div>
              );
              return forceFree ? content : (
                <PremiumGate
                  contentId={`bp-${player.player_id}-full`}
                  playerName={player.player_name}
                  section="full_breakdown"
                  placeholder={
                    <div className="space-y-2 text-[11px] text-white/40">
                      <p>Confidence: High · P(over) 68%</p>
                      <p>G1–G3 trend: −2.1 PTS vs baseline</p>
                      <p>Comparable cases: 1,200 returns</p>
                      <p className="text-[10px] text-white/25 mt-1">Minutes context · Usage rate · Full model</p>
                    </div>
                  }
                >
                  {content}
                </PremiumGate>
              );
            })()}
          </div>
        </div>

        {/* LAYER 3 — Deep dive toggle */}
        <button
          onClick={() => setShowDeepDive(!showDeepDive)}
          className="mt-3 flex items-center gap-1.5 text-[11px] text-[#1C7CFF]/70 hover:text-[#1C7CFF] transition-colors font-medium"
        >
          <span>{showDeepDive ? "Hide" : "Deep dive"}</span>
          <span className={`text-[9px] transition-transform ${showDeepDive ? "rotate-180" : ""}`}>▾</span>
        </button>

        {/* LAYER 3 — Rich analysis panel */}
        {showDeepDive && (
          <div className="mt-3 space-y-3 animate-in fade-in slide-in-from-top-1 duration-200">

            {/* ── FREE: Return Summary ── */}
            {player.gamesBack > 0 && (
              <div className="rounded-lg bg-gradient-to-r from-blue-500/[0.06] to-purple-500/[0.04] border border-blue-500/15 p-3.5">
                <p className="text-[11px] font-bold text-blue-400/90 uppercase tracking-wider mb-2">Return Summary</p>
                <div className="space-y-1.5 text-[12px] text-white/50 leading-relaxed">
                  {player.gamesBack <= 3 && (
                    <p>Game {player.gamesBack} after return — the early return window (G1–G3) carries the highest performance uncertainty and is where the model finds the strongest edges.</p>
                  )}
                  {player.gamesBack > 3 && player.gamesBack <= 6 && (
                    <p>Game {player.gamesBack} — mid-recovery window. Most players are ramping toward baseline but haven't fully stabilized.</p>
                  )}
                  {player.gamesBack > 6 && (
                    <p>Game {player.gamesBack} — late recovery. Performance typically approaching pre-injury levels, though some lag may persist.</p>
                  )}
                  {impG3 && impG3.diff < 0 && (
                    <p>Players returning from {player.injury_type?.toLowerCase() ?? "this injury"} typically underperform in the first 3–5 games.</p>
                  )}
                  {impG3 && impG3.diff >= 0 && (
                    <p>{player.injury_type ?? "This injury"} returns historically show near-baseline performance — relatively low-risk injury type.</p>
                  )}
                </div>
              </div>
            )}

            {/* ── FREE: Injury Trend + ONE supporting stat + recovery curve ── */}
            {curve && (impG1 || impG3) && (
              <div className="rounded-lg bg-blue-500/[0.04] border border-blue-500/10 p-3.5">
                <p className="text-[11px] font-bold text-blue-400/80 uppercase tracking-wider mb-1.5">
                  Injury Trend
                </p>
                <p className="text-[12px] text-white/50 leading-relaxed mb-2">
                  {impG3 && impG3.diff < 0
                    ? `Historically underperforms in first 3 games after ${player.injury_type?.toLowerCase() ?? "this injury"}.`
                    : `Near-baseline performance expected after ${player.injury_type?.toLowerCase() ?? "this injury"}.`
                  }
                </p>

                {/* Recovery curve visualization */}
                {(() => {
                  const ps = PRIMARY_STAT[player.league_slug];
                  const pcts = ps ? (curve.stat_median_pct?.[ps.key] as number[] | undefined) : null;
                  if (!pcts || pcts.length === 0) return null;
                  const points = pcts.slice(0, 10);
                  const minPct = Math.min(...points, 0.6);
                  const maxPct = Math.max(...points, 1.15);
                  const range = maxPct - minPct || 0.1;
                  const w = 500;
                  const h = 64;
                  const step = w / (points.length - 1 || 1);
                  const baselineY = h - ((1.0 - minPct) / range) * h;
                  const curIdx = Math.min(Math.max(player.gamesBack - 1, 0), points.length - 1);
                  const curX = curIdx * step;
                  const curY = h - ((points[curIdx] - minPct) / range) * h;
                  const pathPoints = points.map((p, i) => `${i * step},${h - ((p - minPct) / range) * h}`);
                  // Area fill
                  const areaPath = `M0,${h} L${pathPoints.join(" L")} L${w},${h} Z`;

                  return (
                    <div className="mb-2">
                      <svg className="overflow-visible w-full" viewBox={`0 0 ${w} ${h + 16}`} preserveAspectRatio="xMidYMid meet" style={{ height: "auto", maxHeight: "80px" }}>
                        {/* Baseline */}
                        <line x1={0} y1={baselineY} x2={w} y2={baselineY} stroke="rgba(255,255,255,0.12)" strokeDasharray="4,4" />
                        <text x={w + 4} y={baselineY + 3} fill="rgba(255,255,255,0.2)" fontSize="8" fontFamily="monospace">baseline</text>
                        {/* Area fill */}
                        <path d={areaPath} fill="rgba(59,130,246,0.08)" />
                        {/* Curve line */}
                        <path d={`M${pathPoints.join(" L")}`} fill="none" stroke="rgba(59,130,246,0.5)" strokeWidth={2} />
                        {/* Game markers */}
                        {points.map((p, i) => {
                          const x = i * step;
                          const y = h - ((p - minPct) / range) * h;
                          const isCurrent = i === curIdx;
                          return (
                            <g key={i}>
                              <circle cx={x} cy={y} r={isCurrent ? 4 : 2} fill={isCurrent ? "#3b82f6" : "rgba(59,130,246,0.3)"} stroke={isCurrent ? "#0a0f1a" : "none"} strokeWidth={isCurrent ? 2 : 0} />
                              <text x={x} y={h + 12} fill="rgba(255,255,255,0.2)" fontSize="7" textAnchor="middle" fontFamily="monospace">G{i + 1}</text>
                            </g>
                          );
                        })}
                      </svg>
                      <div className="flex items-center gap-3 mt-1 text-[9px] text-white/25">
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500" /> Current position (G{player.gamesBack})</span>
                        <span>--- Baseline (pre-injury)</span>
                      </div>
                    </div>
                  );
                })()}

                {/* ONE supporting stat — the "oh shit" moment */}
                {impG1 && (
                  <div className="rounded-lg bg-white/[0.03] px-3 py-2 flex items-center justify-between">
                    <span className="text-[11px] text-white/40">G1 historical impact</span>
                    <span className={`text-[14px] font-bold tabular-nums ${impG1.diff >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {impG1.diff >= 0 ? "+" : ""}{impG1.diff.toFixed(1)} {impG1.label}
                    </span>
                  </div>
                )}
                <p className="text-[10px] text-white/25 mt-2">
                  Based on {curve.sample_size.toLocaleString()} similar injury returns
                </p>
              </div>
            )}

            {/* ── FREE: Minutes Context ── */}
            {(player.avg10?.minutes != null || player.avgSinceReturn?.minutes != null) && (
              <div className="rounded-lg bg-white/[0.03] border border-white/5 p-3.5">
                <p className="text-[11px] font-bold text-white/50 uppercase tracking-wider mb-2">Minutes Context</p>
                <div className="flex items-center gap-4">
                  {player.avg10?.minutes != null && (
                    <div className="text-center">
                      <p className="text-[10px] text-white/25">Pre-injury</p>
                      <p className="text-[15px] font-bold text-white/70 tabular-nums">{player.avg10.minutes} min</p>
                    </div>
                  )}
                  {player.avgSinceReturn?.minutes != null && player.gamesBack > 0 && (
                    <div className="text-center">
                      <p className="text-[10px] text-white/25">Since return</p>
                      <p className="text-[15px] font-bold text-white/70 tabular-nums">{player.avgSinceReturn.minutes} min</p>
                    </div>
                  )}
                  {minutesPct != null && (
                    <div className="flex-1 min-w-[80px]">
                      <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${minutesPct >= 0.8 ? "bg-cyan-400" : "bg-amber-400"}`}
                          style={{ width: `${Math.min(100, Math.round(minutesPct * 100))}%` }}
                        />
                      </div>
                      <p className="text-[9px] text-white/25 mt-0.5 text-right tabular-nums">
                        {Math.round(minutesPct * 100)}% of usual
                      </p>
                    </div>
                  )}
                </div>
                {minutesPct != null && (
                  <p className="text-[10px] mt-2 leading-snug" style={{ color: minutesPct < 0.7 ? "rgba(251,191,36,0.5)" : minutesPct < 0.85 ? "rgba(251,191,36,0.4)" : minutesPct < 0.95 ? "rgba(255,255,255,0.3)" : "rgba(74,222,128,0.4)" }}>
                    {minutesPct < 0.7 ? "Still ramping up — significantly reduced minutes suggest a cautious return" :
                     minutesPct < 0.85 ? "Not yet at full workload — minutes still below pre-injury levels" :
                     minutesPct < 0.95 ? "Approaching full workload — minutes nearly restored" :
                     "Full workload restored — playing at or above pre-injury minutes"}
                  </p>
                )}
              </div>
            )}

            {/* ── PREMIUM: Precision Edge — model projections, gap%, confidence, multi-stat breakdown (free for top 4) ── */}
            {propData.length > 0 && (() => {
              const precisionContent = (
                <div className="rounded-lg bg-white/[0.03] border border-white/5 p-3.5">
                  <p className="text-[11px] font-bold text-white/50 uppercase tracking-wider mb-2">Precision Edge</p>

                  {/* G1/G3/G5 impact grid */}
                  {curve && (impG1 || impG3 || impG5) && (
                    <div className="grid grid-cols-3 gap-2 mb-3">
                      {([["G1", impG1, true], ["G3", impG3, true], ["G5", impG5, false]] as [string, { label: string; diff: number } | null, boolean][]).map(([label, imp, isEarly]) => (
                        <div key={label} className={`text-center rounded-lg py-2 ${isEarly ? "bg-white/[0.03]" : ""}`}>
                          <p className={`text-[10px] mb-0.5 ${isEarly ? "text-red-400/50 font-medium" : "text-white/25"}`}>{label}{isEarly ? " ⚠" : ""}</p>
                          <p className={`text-[13px] font-bold tabular-nums ${imp == null ? "text-white/20" : imp.diff >= 0 ? "text-green-400" : "text-red-400"}`}>
                            {imp != null ? `${imp.diff >= 0 ? "+" : ""}${imp.diff.toFixed(1)} ${imp.label}` : "—"}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Full prop-by-prop breakdown */}
                  <div className="space-y-2.5">
                    {propData.map(({ prop: p, ev, avg10Val, sinceReturnVal, gapPct }) => {
                      const isOver = ev?.recommendation === "OVER";
                      return (
                        <div key={p.id} className={`rounded-lg p-2.5 ${ev?.recommendation ? isOver ? "bg-green-500/[0.06] border border-green-500/15" : "bg-red-500/[0.06] border border-red-500/15" : "bg-white/[0.02] border border-white/5"}`}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[11px] text-emerald-400/70 font-semibold">{MARKET_LABELS[p.market] ?? p.market}</span>
                            {ev?.recommendation && (
                              <span className={`text-[11px] font-bold ${isOver ? "text-green-400" : "text-red-400"}`}>{ev.recommendation}</span>
                            )}
                          </div>
                          <div className="flex items-baseline gap-4 mb-1">
                            <div>
                              <p className="text-[9px] text-white/25">Market</p>
                              <p className="text-base font-bold text-white tabular-nums">{p.line}</p>
                            </div>
                            {ev && (
                              <div>
                                <p className="text-[9px] text-white/25">Model</p>
                                <p className="text-base font-bold text-white/60 tabular-nums">{ev.expectedCombined.toFixed(1)}</p>
                              </div>
                            )}
                            {gapPct != null && gapPct !== 0 && (
                              <div>
                                <p className="text-[9px] text-white/25">Gap</p>
                                <p className={`text-sm font-bold tabular-nums ${gapPct < 0 ? "text-red-400/80" : "text-green-400/80"}`}>{gapPct > 0 ? "+" : ""}{gapPct}%</p>
                              </div>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-white/35">
                            {ev && <span>P({ev.recommendation?.toLowerCase()}) {Math.round((isOver ? ev.probOver : ev.probUnder) * 100)}%</span>}
                            {ev && <span>{ev.confidence} confidence</span>}
                            {avg10Val != null && <span>Pre-injury avg: {avg10Val.toFixed(1)}</span>}
                            {sinceReturnVal != null && <span>Since return: {sinceReturnVal.toFixed(1)}</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Comparable cases footer */}
                  {curve && (
                    <p className="text-[10px] text-white/25 mt-2.5 pt-2 border-t border-white/5">
                      Analysis based on {curve.sample_size.toLocaleString()} comparable injury return cases
                    </p>
                  )}
                </div>
              );
              return forceFree ? precisionContent : (
                <PremiumGate
                  contentId={`deep-${player.player_id}-precision`}
                  playerName={player.player_name}
                  section="deep_dive_precision"
                  placeholder={
                    <div className="rounded-lg bg-white/[0.03] border border-white/5 p-3.5">
                      <p className="text-[11px] font-bold text-white/50 uppercase tracking-wider mb-2">Precision Edge</p>
                      <div className="space-y-2 text-[11px] text-white/30">
                        <p>Exact model projections for {propData.length} prop{propData.length !== 1 ? "s" : ""}</p>
                        <p>Gap % · Confidence % · P(over/under)</p>
                        <p>Multi-stat breakdown · Comparable case depth</p>
                      </div>
                    </div>
                  }
                >
                  {precisionContent}
                </PremiumGate>
              );
            })()}
          </div>
        )}

        {/* Footer links */}
        {injurySlug && (
          <div className="flex items-center gap-4 mt-3 text-[11px]">
            <Link
              to={`/performance-curves?league=${player.league_slug}&injury=${injurySlug}`}
              className="text-white/25 hover:text-[#1C7CFF]/70 transition-colors"
            >
              View recovery curve →
            </Link>
            <Link
              to={`/injuries/${injurySlug}?league=${player.league_slug}`}
              className="text-white/25 hover:text-[#1C7CFF]/70 transition-colors"
            >
              View recovery stats →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
