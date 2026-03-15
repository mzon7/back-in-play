/**
 * Injury-Adjusted Expected Value (EV) Model
 *
 * Estimates whether a sportsbook prop line offers positive EV using
 * historical injury recovery data and the player's recent form.
 */

import type { PerformanceCurve } from "../features/performance-curves/lib/types";

// ── Types ──

export interface EVResult {
  /** Blended expected stat value */
  expectedCombined: number;
  /** Historical injury-adjusted expectation */
  expectedHistorical: number;
  /** Recent form expectation */
  expectedRecent: number | null;
  /** Weight given to historical (0–1) */
  historicalWeight: number;
  /** Weight given to recent (0–1) */
  recentWeight: number;
  /** P(over the line) */
  probOver: number;
  /** P(under the line) */
  probUnder: number;
  /** Breakeven probability for over bet */
  breakevenOver: number | null;
  /** Breakeven probability for under bet */
  breakevenUnder: number | null;
  /** EV for over bet (units, 1 = 1% of stake) */
  evOver: number | null;
  /** EV for under bet */
  evUnder: number | null;
  /** Best side recommendation */
  recommendation: "OVER" | "UNDER" | null;
  /** Best-side EV (the higher positive EV) */
  bestEv: number | null;
  /** Confidence level */
  confidence: "High" | "Medium" | "Low";
  /** Sample size from historical data */
  sampleSize: number;
}

export interface EVInput {
  /** Player's pre-injury baseline stat (season avg or last 10 games) */
  baseline: number;
  /** Sportsbook line */
  propLine: number;
  /** American odds for over (e.g. -110) */
  overOdds: number | null;
  /** American odds for under (e.g. -120) */
  underOdds: number | null;
  /** Number of games since return from injury */
  gamesSinceReturn: number;
  /** Player's average stat since returning (if games > 0) */
  recentAvg: number | null;
  /** Historical injury curve */
  curve: PerformanceCurve;
  /** League slug for stat lookup */
  leagueSlug: string;
  /** Stat key to evaluate (e.g. "stat_pts") */
  statKey: string;
  /** Player's pre-injury minutes (for minutes adjustment) */
  preInjuryMinutes?: number | null;
  /** Player's current minutes since return */
  currentMinutes?: number | null;
  /** Historical standard deviation for the stat (from curve or game logs) */
  stddev?: number | null;
}

// ── Odds conversion ──

/** Convert American odds to implied probability (0–1) */
export function oddsToImpliedProb(americanOdds: number): number {
  if (americanOdds < 0) return Math.abs(americanOdds) / (Math.abs(americanOdds) + 100);
  return 100 / (americanOdds + 100);
}

/** Convert American odds to profit per 1-unit stake */
export function oddsToProfit(americanOdds: number): number {
  if (americanOdds < 0) return 100 / Math.abs(americanOdds);
  return americanOdds / 100;
}

// ── Core model ──

export function computeEV(input: EVInput): EVResult | null {
  const {
    baseline, propLine, overOdds, underOdds,
    gamesSinceReturn, recentAvg, curve, leagueSlug,
    statKey, preInjuryMinutes, currentMinutes, stddev,
  } = input;

  if (baseline <= 0) return null;

  // ── Step 1: Historical injury adjustment ──
  const medians = curve.stat_median_pct ?? {};
  const gIdx = Math.min(Math.max(gamesSinceReturn - 1, 0), 9);
  const pct = (medians[statKey] as number[] | undefined)?.[gIdx];

  // Fallback: use composite median_pct_recent
  const compositePct = pct ?? curve.median_pct_recent[gIdx];
  if (compositePct == null) return null;

  const expectedHistorical = baseline * compositePct;

  // ── Step 2: Recent form adjustment ──
  let expectedRecent: number | null = null;
  if (recentAvg != null && gamesSinceReturn > 0) {
    // Minutes adjustment if available
    if (preInjuryMinutes && currentMinutes && preInjuryMinutes > 0 && currentMinutes > 0) {
      const minuteRatio = currentMinutes / preInjuryMinutes;
      // Only adjust if minutes ratio suggests significant load management (< 0.9)
      if (minuteRatio < 0.9) {
        expectedRecent = recentAvg * (1 / minuteRatio) * minuteRatio; // net effect: keep recentAvg but acknowledge minutes
      } else {
        expectedRecent = recentAvg;
      }
    } else {
      expectedRecent = recentAvg;
    }
  }

  // ── Step 3: Blend estimates ──
  let historicalWeight: number;
  let recentWeight: number;

  if (gamesSinceReturn <= 2) {
    historicalWeight = 0.8;
    recentWeight = 0.2;
  } else if (gamesSinceReturn <= 5) {
    historicalWeight = 0.6;
    recentWeight = 0.4;
  } else {
    historicalWeight = 0.4;
    recentWeight = 0.6;
  }

  let expectedCombined: number;
  if (expectedRecent != null) {
    expectedCombined = historicalWeight * expectedHistorical + recentWeight * expectedRecent;
  } else {
    expectedCombined = expectedHistorical;
    historicalWeight = 1;
    recentWeight = 0;
  }

  // ── Step 4: Estimate probability distribution ──
  // Use stddev from curve or approximate as 25% of baseline
  const curveStddev = (curve.stat_stddev_pct ?? {})[statKey];
  const stddevPct = (curveStddev as number[] | undefined)?.[gIdx];
  const estimatedStddev = stddev
    ?? (stddevPct != null ? baseline * stddevPct : baseline * 0.25);

  // Normal CDF approximation for P(X > line) and P(X < line)
  const z = estimatedStddev > 0
    ? (propLine - expectedCombined) / estimatedStddev
    : (propLine > expectedCombined ? 10 : -10);
  const probUnder = normalCDF(z);
  const probOver = 1 - probUnder;

  // ── Step 5: Convert odds to breakeven probabilities ──
  const breakevenOver = overOdds != null ? oddsToImpliedProb(overOdds) : null;
  const breakevenUnder = underOdds != null ? oddsToImpliedProb(underOdds) : null;

  // ── Step 6: Calculate EV ──
  let evOver: number | null = null;
  let evUnder: number | null = null;

  if (overOdds != null) {
    const profit = oddsToProfit(overOdds);
    evOver = probOver * profit - probUnder * 1; // per 1-unit stake
  }
  if (underOdds != null) {
    const profit = oddsToProfit(underOdds);
    evUnder = probUnder * profit - probOver * 1;
  }

  // ── Step 7: Determine best side ──
  let recommendation: "OVER" | "UNDER" | null = null;
  let bestEv: number | null = null;

  if (evOver != null && evUnder != null) {
    if (evOver > evUnder && evOver > 0) {
      recommendation = "OVER";
      bestEv = evOver;
    } else if (evUnder > evOver && evUnder > 0) {
      recommendation = "UNDER";
      bestEv = evUnder;
    }
  } else if (evOver != null && evOver > 0) {
    recommendation = "OVER";
    bestEv = evOver;
  } else if (evUnder != null && evUnder > 0) {
    recommendation = "UNDER";
    bestEv = evUnder;
  }

  // ── Step 8: Confidence ──
  const sampleSize = curve.sample_size;
  let confidence: "High" | "Medium" | "Low";
  if (sampleSize >= 500 && gamesSinceReturn >= 2) {
    confidence = "High";
  } else if (sampleSize >= 100) {
    confidence = "Medium";
  } else {
    confidence = "Low";
  }

  return {
    expectedCombined,
    expectedHistorical,
    expectedRecent,
    historicalWeight,
    recentWeight,
    probOver,
    probUnder,
    breakevenOver,
    breakevenUnder,
    evOver,
    evUnder,
    recommendation,
    bestEv,
    confidence,
    sampleSize,
  };
}

// ── Normal CDF approximation (Abramowitz & Stegun) ──
function normalCDF(z: number): number {
  if (z < -8) return 0;
  if (z > 8) return 1;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/** Format EV as percentage string with sign */
export function formatEV(ev: number): string {
  const pct = ev * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

/** Parse American odds string (e.g. "-110", "+150") to number */
export function parseOdds(odds: string | number | null): number | null {
  if (odds == null) return null;
  const n = typeof odds === "number" ? odds : parseFloat(String(odds));
  return isNaN(n) ? null : n;
}
