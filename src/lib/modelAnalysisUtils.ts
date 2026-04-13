/**
 * Shared utility functions for Model Analysis pages.
 * Copied exactly from the injury page (ModelAnalysisPage.tsx).
 */

import type { BacktestSummary, MarketSummary, OddsMode } from "./modelAnalysisTypes";

/** Normal CDF (Abramowitz & Stegun). */
export function normalCDF(z: number): number {
  if (z < -8) return 0;
  if (z > 8) return 1;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/**
 * Estimate P(real edge) from summary stats.
 * Uses a z-test on per-bet returns, approximating variance from win rate + average win profit.
 */
export function computePEdge(bets: number, wins: number, flatPnl: number): number {
  if (bets < 20 || wins === 0 || wins === bets) return 0;
  const mean = flatPnl / bets;
  if (mean <= 0) return 0;
  const losses = bets - wins;
  const avgWinProfit = (flatPnl + losses) / wins; // derive avg profit on wins
  const wr = wins / bets;
  const variance = wr * (avgWinProfit - mean) ** 2 + (1 - wr) * (-1 - mean) ** 2;
  if (variance <= 0) return 0;
  const se = Math.sqrt(variance / bets);
  if (se <= 0) return 0;
  const z = mean / se;
  return normalCDF(z); // P(mean > 0) under normal approx
}

/**
 * Compute model stability score (0-5) from summary data.
 *
 * 1. CLV positive: open ROI > close ROI (captures early line value)
 * 2. Rolling stability: majority of seasons have positive BR%
 * 3. No single-period dominance: no season > 50% of total PnL
 * 4. Parameter robustness: ROI positive at >=3 EV thresholds
 * 5. Edge monotonicity: higher EV buckets -> higher ROI
 */
export function computeStability(
  summary: BacktestSummary | undefined,
  market: string,
  oddsMode: OddsMode,
  closestGn: number,
): number {
  if (!summary) return 0;
  let score = 0;

  // Helper: get market stats for a specific key
  const getStats = (key: string): MarketSummary | undefined =>
    ((summary as any)[key] as Record<string, MarketSummary> | undefined)?.[market];

  // 1. CLV positive: open ROI > close ROI
  const openStats = getStats(`by_market_open_ev0_gn${closestGn}`);
  const closeStats = getStats(`by_market_close_ev0_gn${closestGn}`);
  if (openStats && closeStats && openStats.bets >= 20 && closeStats.bets >= 20) {
    if (openStats.flat_roi > closeStats.flat_roi) score++;
  }

  // 2. Rolling stability: majority of seasons profitable (BR% > 0)
  const seasons = (summary as any).seasons as string[] | undefined;
  if (seasons && seasons.length >= 2) {
    let profitSeasons = 0;
    for (const s of seasons) {
      const sStats = getStats(`by_market_${oddsMode}_ev0_gn${closestGn}_s${s}`);
      if (sStats && sStats.bets >= 10 && sStats.flat_br > 0) profitSeasons++;
    }
    if (profitSeasons > seasons.length / 2) score++;
  }

  // 3. No single period dominance: no season > 50% of total PnL
  const totalStats = getStats(`by_market_${oddsMode}_ev0_gn${closestGn}`);
  if (seasons && seasons.length >= 2 && totalStats && totalStats.flat_pnl > 0) {
    let dominated = false;
    for (const s of seasons) {
      const sStats = getStats(`by_market_${oddsMode}_ev0_gn${closestGn}_s${s}`);
      if (sStats && sStats.flat_pnl > totalStats.flat_pnl * 0.5) {
        dominated = true;
        break;
      }
    }
    if (!dominated) score++;
  }

  // 4. Parameter robustness: ROI positive at >=3 EV thresholds
  const evLevels = [0, 5, 10, 20];
  let positiveEvCount = 0;
  for (const ev of evLevels) {
    const evStats = getStats(`by_market_${oddsMode}_ev${ev}_gn${closestGn}`);
    if (evStats && evStats.bets >= 20 && evStats.flat_roi > 0) positiveEvCount++;
  }
  if (positiveEvCount >= 3) score++;

  // 5. Edge monotonicity: higher EV -> higher ROI
  const evRois: number[] = [];
  for (const ev of [0, 5, 10, 20, 30]) {
    const evStats = getStats(`by_market_${oddsMode}_ev${ev}_gn${closestGn}`);
    if (evStats && evStats.bets >= 15) {
      evRois.push(evStats.flat_roi);
    }
  }
  if (evRois.length >= 3) {
    let monotonic = true;
    for (let i = 1; i < evRois.length; i++) {
      if (evRois[i] < evRois[i - 1] - 1) { // allow 1% tolerance
        monotonic = false;
        break;
      }
    }
    if (monotonic) score++;
  }

  return score;
}
