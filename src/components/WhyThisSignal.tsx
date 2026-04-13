import { useState, useMemo, useCallback } from "react";
import {
  trackPremiumContentHover,
  trackPremiumContentClick,
  trackPremiumLockSeen,
  trackPremiumWaitlistClick,
} from "../lib/analytics";
import { WaitlistModal, useWaitlistModal } from "./WaitlistModal";
import type { EVResult } from "../lib/evModel";
import type { PerformanceCurve } from "../features/performance-curves/lib/types";

// ── Types ──

/**
 * Driver classification:
 *   primary   – quantitative performance factors (minutes, usage, stat output)
 *   context   – injury timing and return position (game #, injury type, recovery phase)
 *   supporting – population-level effects (historical curves, comparable outcomes)
 *
 * "market" and "matchup" are NOT valid driver types — they are outputs, not causes.
 */
type DriverType = "primary" | "context" | "supporting";

interface SignalDriver {
  /** Short, plain-English label with partial quantification */
  label: string;
  /** Sentiment: positive = supporting signal, negative = counter */
  sentiment: "positive" | "negative" | "neutral";
  /** Driver classification */
  type: DriverType;
}

interface ScoredDriver extends SignalDriver {
  /** Impact score — how much this factor explains the signal. Higher = more important. */
  impact: number;
  /** Premium-expanded label with precise numbers */
  premiumLabel: string;
}

interface ComparableCase {
  label: string;
  value: string;
}

// ── Confidence Score ──

interface ConfidenceComponent {
  name: string;
  score: number;
  max: number;
  /** Plain-English explanation for this component */
  explanation: string;
}

interface ConfidenceScore {
  total: number;
  label: "High" | "Medium" | "Low";
  components: ConfidenceComponent[];
  /** One-line summary for free users */
  summary: string;
  /** Short interpretation for premium users */
  interpretation: string;
}

interface WhyThisSignalProps {
  playerName: string;
  injuryType: string | null;
  gamesBack: number;
  ev: EVResult | null;
  curve: PerformanceCurve | null;
  /** Pre-injury average for the stat */
  preBaseline: number | null;
  /** Average since return */
  returnAvg: number | null;
  /** Pre-injury minutes */
  preMinutes: number | null;
  /** Current minutes since return */
  currentMinutes: number | null;
  /** Market label (e.g. "Points") */
  marketLabel: string;
  /** Prop line */
  propLine: number | null;
  /** League slug */
  leagueSlug: string;
  /** Stat key for curve lookup (e.g. "stat_pts") */
  statKey?: string | null;
  /** Whether user has premium access */
  isPremium?: boolean;
}

// ── Helpers ──

function SentimentDot({ sentiment }: { sentiment: "positive" | "negative" | "neutral" }) {
  if (sentiment === "positive") return <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400/70 shrink-0 mt-[5px]" />;
  if (sentiment === "negative") return <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-400/70 shrink-0 mt-[5px]" />;
  return <span className="inline-block w-1.5 h-1.5 rounded-full bg-white/20 shrink-0 mt-[5px]" />;
}

function ConfidenceBadge({ level }: { level: "strong" | "moderate" | "weak" }) {
  const styles = {
    strong: "bg-green-500/15 text-green-400/80 border-green-500/20",
    moderate: "bg-amber-500/15 text-amber-400/80 border-amber-500/20",
    weak: "bg-white/5 text-white/40 border-white/10",
  };
  const labels = { strong: "Strong", moderate: "Medium", weak: "Low" };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[9px] font-semibold ${styles[level]}`}>
      {labels[level]}
    </span>
  );
}

/** Approximate a percentage for free-tier display: "~30%" instead of "28.4%" */
function approxPct(pct: number): string {
  const abs = Math.abs(pct);
  if (abs < 5) return `~${Math.round(pct)}%`;
  // Round to nearest 5 for cleaner display
  const rounded = Math.round(abs / 5) * 5;
  return `~${pct < 0 ? "-" : ""}${rounded}%`;
}

// ══════════════════════════════════════════════════
// DRIVER GENERATION
// ══════════════════════════════════════════════════
//
// All drivers are built once as ScoredDrivers with:
//   - label: free-tier text with partial quantification
//   - premiumLabel: precise numbers for premium display
//   - impact: numeric score for ranking
//   - type: primary | context | supporting
//
// Free selection picks from this ranked pool.
// Premium expands the SAME drivers (not a separate set).
// ══════════════════════════════════════════════════

function buildAllDrivers(props: WhyThisSignalProps): ScoredDriver[] {
  const { gamesBack, preBaseline, returnAvg, preMinutes, currentMinutes, curve, injuryType, marketLabel } = props;
  const candidates: ScoredDriver[] = [];

  // ────────────────────────────────
  // PRIMARY DRIVERS (quantitative)
  // ────────────────────────────────

  // Minutes / workload vs baseline
  if (preMinutes && currentMinutes && preMinutes > 0) {
    const minutesPct = currentMinutes / preMinutes;
    const gapPct = (minutesPct - 1) * 100; // negative = below baseline
    const absGap = Math.abs(gapPct);

    if (minutesPct < 0.75) {
      candidates.push({
        label: `Minutes projected ${approxPct(gapPct)} vs pre-injury baseline`,
        premiumLabel: `Minutes projection: ${currentMinutes.toFixed(1)} vs ${preMinutes.toFixed(1)} pre-injury (${Math.round(gapPct)}%)`,
        sentiment: "negative",
        type: "primary",
        impact: absGap, // 25% gap → score 25
      });
    } else if (minutesPct < 0.9) {
      candidates.push({
        label: `Minutes projected ${approxPct(gapPct)} vs pre-injury baseline`,
        premiumLabel: `Minutes projection: ${currentMinutes.toFixed(1)} vs ${preMinutes.toFixed(1)} pre-injury (${Math.round(gapPct)}%)`,
        sentiment: "negative",
        type: "primary",
        impact: absGap,
      });
    } else if (minutesPct >= 0.95) {
      candidates.push({
        label: "Workload restored to pre-injury levels",
        premiumLabel: `Minutes projection: ${currentMinutes.toFixed(1)} vs ${preMinutes.toFixed(1)} pre-injury (${Math.round(minutesPct * 100)}% restored)`,
        sentiment: "positive",
        type: "primary",
        impact: 5, // low — confirms stability, doesn't explain a gap
      });
    }
  }

  // Stat output vs baseline (form gap)
  if (preBaseline != null && returnAvg != null && preBaseline > 0 && gamesBack > 0) {
    const formPct = ((returnAvg - preBaseline) / preBaseline) * 100;
    const absFormGap = Math.abs(formPct);

    if (formPct < -15) {
      candidates.push({
        label: `Post-injury ${marketLabel.toLowerCase()} still ${approxPct(formPct)} vs baseline`,
        premiumLabel: `${marketLabel} output: ${returnAvg.toFixed(1)} vs ${preBaseline.toFixed(1)} pre-injury (${Math.round(formPct)}%)`,
        sentiment: "negative",
        type: "primary",
        impact: absFormGap,
      });
    } else if (formPct < -5) {
      candidates.push({
        label: `Post-injury ${marketLabel.toLowerCase()} slightly below baseline`,
        premiumLabel: `${marketLabel} output: ${returnAvg.toFixed(1)} vs ${preBaseline.toFixed(1)} pre-injury (${Math.round(formPct)}%)`,
        sentiment: "negative",
        type: "primary",
        impact: absFormGap,
      });
    } else if (formPct > 5) {
      candidates.push({
        label: `Post-injury ${marketLabel.toLowerCase()} above baseline`,
        premiumLabel: `${marketLabel} output: ${returnAvg.toFixed(1)} vs ${preBaseline.toFixed(1)} pre-injury (+${Math.round(formPct)}%)`,
        sentiment: "positive",
        type: "primary",
        impact: absFormGap,
      });
    }
  }

  // ────────────────────────────────
  // CONTEXT DRIVERS (injury timing)
  // ────────────────────────────────

  // Games since return — impact scales with how early in the return window
  if (gamesBack > 0) {
    if (gamesBack <= 3) {
      candidates.push({
        label: `Game ${gamesBack} after return — early recovery window`,
        premiumLabel: `Game ${gamesBack} after return — highest performance uncertainty phase`,
        sentiment: "negative",
        type: "context",
        impact: 20 - gamesBack * 3, // G1=17, G2=14, G3=11
      });
    } else if (gamesBack <= 6) {
      candidates.push({
        label: `Game ${gamesBack} after return — mid-recovery window`,
        premiumLabel: `Game ${gamesBack} after return — most players still normalizing`,
        sentiment: "neutral",
        type: "context",
        impact: 7,
      });
    } else {
      candidates.push({
        label: `Game ${gamesBack} after return — approaching full recovery`,
        premiumLabel: `Game ${gamesBack} after return — most injury effects have normalized`,
        sentiment: "positive",
        type: "context",
        impact: 3,
      });
    }
  }

  // Workload management context (early games + reduced minutes = likely managed)
  if (gamesBack <= 3 && preMinutes && currentMinutes && preMinutes > 0 && currentMinutes / preMinutes < 0.85) {
    const reducedPct = Math.round((1 - currentMinutes / preMinutes) * 100);
    candidates.push({
      label: `Role still ramping up — workload likely being managed`,
      premiumLabel: `Workload managed: minutes reduced ${reducedPct}% — typical for Game ${gamesBack} returns`,
      sentiment: "negative",
      type: "context",
      impact: 8,
    });
  }

  // ────────────────────────────────
  // SUPPORTING DRIVERS (population)
  // ────────────────────────────────

  // Historical injury curve suppression
  if (curve && injuryType) {
    const gIdx = Math.min(Math.max(gamesBack - 1, 0), 9);
    const compositePct = curve.median_pct_recent?.[gIdx];

    if (compositePct != null && compositePct < 0.95) {
      const dropPct = Math.round((1 - compositePct) * 100);
      candidates.push({
        label: `Similar ${injuryType.toLowerCase()} returns average ${approxPct(-dropPct)} output at Game ${gamesBack}`,
        premiumLabel: `Historical ${marketLabel.toLowerCase()} impact: -${dropPct}% at Game ${gamesBack} across ${curve.sample_size.toLocaleString()} similar ${injuryType.toLowerCase()} return cases`,
        sentiment: dropPct > 5 ? "negative" : "neutral",
        type: "supporting",
        impact: dropPct,
      });
    } else if (compositePct != null && compositePct >= 0.97) {
      candidates.push({
        label: `${injuryType} returns historically show near-baseline output at this stage`,
        premiumLabel: `Historical ${marketLabel.toLowerCase()} impact: ${Math.round((compositePct - 1) * 100)}% at Game ${gamesBack} across ${curve.sample_size.toLocaleString()} cases — minimal suppression`,
        sentiment: "positive",
        type: "supporting",
        impact: 4,
      });
    } else if (compositePct != null) {
      // Mild suppression (95-97%)
      const dropPct = Math.round((1 - compositePct) * 100);
      candidates.push({
        label: `Slight historical suppression for ${injuryType.toLowerCase()} returns at this stage`,
        premiumLabel: `Historical ${marketLabel.toLowerCase()} impact: -${dropPct}% at Game ${gamesBack} across ${curve.sample_size.toLocaleString()} cases`,
        sentiment: "neutral",
        type: "supporting",
        impact: dropPct,
      });
    }
  }

  // Sort by impact — highest first
  candidates.sort((a, b) => b.impact - a.impact);

  return candidates;
}

// ══════════════════════════════════════════════════
// FREE DRIVER SELECTION
// ══════════════════════════════════════════════════
//
// Rules:
//   1. ALWAYS include the #1 most impactful driver (regardless of type)
//   2. MUST include at least one PRIMARY driver (quantitative factor)
//   3. MUST include at least one CONTEXT driver (injury timing)
//   4. OPTIONAL one SUPPORTING driver (if room and available)
//   5. Never duplicate types unless no alternatives
//   6. Cap at 3 total
// ══════════════════════════════════════════════════

function selectFreeDrivers(allDrivers: ScoredDriver[]): ScoredDriver[] {
  if (allDrivers.length === 0) return [];

  const selected: ScoredDriver[] = [];
  const usedTypes = new Set<DriverType>();

  // Step 1: Always include the #1 most impactful driver
  const top = allDrivers[0];
  selected.push(top);
  usedTypes.add(top.type);

  // Step 2: Ensure we have a PRIMARY driver
  if (!usedTypes.has("primary")) {
    const bestPrimary = allDrivers.find((d) => d.type === "primary" && !selected.includes(d));
    if (bestPrimary) {
      selected.push(bestPrimary);
      usedTypes.add("primary");
    }
  }

  // Step 3: Ensure we have a CONTEXT driver
  if (!usedTypes.has("context")) {
    const bestContext = allDrivers.find((d) => d.type === "context" && !selected.includes(d));
    if (bestContext) {
      selected.push(bestContext);
      usedTypes.add("context");
    }
  }

  // Step 4: If room, add the best SUPPORTING driver
  if (selected.length < 3 && !usedTypes.has("supporting")) {
    const bestSupporting = allDrivers.find((d) => d.type === "supporting" && !selected.includes(d));
    if (bestSupporting) {
      selected.push(bestSupporting);
    }
  }

  // Step 5: If we still only have 1 (e.g. only context drivers exist), fill with next best
  if (selected.length < 2) {
    for (const d of allDrivers) {
      if (selected.length >= 3) break;
      if (!selected.includes(d)) {
        selected.push(d);
      }
    }
  }

  // Cap at 3
  return selected.slice(0, 3);
}

// ══════════════════════════════════════════════════
// PREMIUM SECTIONS (expanded from the same drivers)
// ══════════════════════════════════════════════════

function buildComparableCases(props: WhyThisSignalProps): ComparableCase[] {
  const { curve, injuryType, gamesBack } = props;
  const cases: ComparableCase[] = [];

  if (curve) {
    cases.push({
      label: "Based on",
      value: `${curve.sample_size.toLocaleString()} similar ${injuryType?.toLowerCase() ?? "injury"} return cases`,
    });

    const gIdx = Math.min(Math.max(gamesBack - 1, 0), 9);
    const compositePct = curve.median_pct_recent?.[gIdx];
    if (compositePct != null) {
      const changePct = Math.round((compositePct - 1) * 100);
      cases.push({
        label: `Average Game ${gamesBack} output change`,
        value: `${changePct >= 0 ? "+" : ""}${changePct}% vs baseline`,
      });
    }

    const normIdx = curve.median_pct_recent?.findIndex((p, i) => i > 0 && p >= 0.97);
    if (normIdx != null && normIdx >= 0) {
      cases.push({
        label: "Most players normalize by",
        value: `Game ${normIdx + 1}`,
      });
    }
  }

  return cases;
}

// ══════════════════════════════════════════════════
// CONFIDENCE SCORING SYSTEM (0–100)
// ══════════════════════════════════════════════════
//
// Confidence = reliability of the signal, NOT size of the edge.
// A large gap can have low confidence (thin data).
// A small gap can have high confidence (strong support).
//
// Components:
//   1. Sample Strength    (0–30)  — historical data depth
//   2. Minutes Certainty  (0–25)  — workload predictability
//   3. Historical Fit     (0–20)  — how well this case matches the comparison group
//   4. Model Agreement    (0–15)  — sub-model alignment
//   5. Output Stability   (0–10)  — sensitivity to assumption changes
// ══════════════════════════════════════════════════

function computeConfidenceScore(props: WhyThisSignalProps): ConfidenceScore {
  const { curve, gamesBack, preMinutes, currentMinutes, preBaseline, returnAvg, ev, injuryType, statKey } = props;
  const components: ConfidenceComponent[] = [];

  // ── 1. Sample Strength (0–30) ──
  // How much relevant historical data supports this signal?
  let sampleScore = 0;
  let sampleExplanation = "No historical curve data available";

  if (curve) {
    const n = curve.sample_size;
    // Curve sample size: 0–20 points (logarithmic scale, diminishing returns past 500)
    const curvePts = Math.min(20, Math.round(Math.log10(Math.max(n, 1)) / Math.log10(1000) * 20));
    sampleScore += curvePts;

    // Player-specific return games: 0–7 points
    const playerGamePts = gamesBack >= 5 ? 7 : gamesBack >= 3 ? 5 : gamesBack >= 2 ? 3 : gamesBack === 1 ? 1 : 0;
    sampleScore += playerGamePts;

    // Stat-specific data available in curve: 0–3 points
    if (statKey && curve.stat_median_pct?.[statKey]) {
      sampleScore += 3;
    }

    sampleScore = Math.min(30, sampleScore);
    sampleExplanation = n >= 500
      ? `Strong sample: ${n.toLocaleString()} comparable cases, ${gamesBack} post-return games`
      : n >= 100
      ? `Moderate sample: ${n.toLocaleString()} comparable cases, ${gamesBack} post-return games`
      : `Limited sample: ${n} comparable cases, ${gamesBack} post-return games`;
  }

  components.push({ name: "Sample strength", score: sampleScore, max: 30, explanation: sampleExplanation });

  // ── 2. Minutes Certainty (0–25) ──
  // How stable and predictable is expected workload?
  let minutesScore = 0;
  let minutesExplanation = "No minutes data available";

  if (preMinutes && preMinutes > 0) {
    if (currentMinutes && currentMinutes > 0) {
      const ratio = currentMinutes / preMinutes;
      // Stability of minutes ratio: closer to pre-injury = more certain
      if (ratio >= 0.92) {
        minutesScore = 22; // Very stable — near pre-injury
        minutesExplanation = `Stable workload: ${currentMinutes.toFixed(1)} vs ${preMinutes.toFixed(1)} min pre-injury (${Math.round(ratio * 100)}%)`;
      } else if (ratio >= 0.8) {
        minutesScore = 15; // Somewhat reduced but predictable
        minutesExplanation = `Moderate certainty: minutes at ${Math.round(ratio * 100)}% of pre-injury — some restriction likely`;
      } else if (ratio >= 0.65) {
        minutesScore = 8; // Significantly restricted
        minutesExplanation = `Low certainty: minutes at ${Math.round(ratio * 100)}% of pre-injury — workload likely managed`;
      } else {
        minutesScore = 3; // Heavily restricted, very uncertain
        minutesExplanation = `Very uncertain: minutes at ${Math.round(ratio * 100)}% of pre-injury — heavy restriction`;
      }

      // Bonus: if gamesBack > 3 and minutes have been consistent, add stability points
      if (gamesBack >= 3 && ratio >= 0.8) {
        minutesScore = Math.min(25, minutesScore + 3);
      }
    } else {
      // No post-return minutes data
      minutesScore = 5;
      minutesExplanation = "No post-return minutes data yet — projecting from pre-injury levels";
    }
  }

  components.push({ name: "Minutes certainty", score: minutesScore, max: 25, explanation: minutesExplanation });

  // ── 3. Historical Fit (0–20) ──
  // How well does this player match the historical comparison group?
  let fitScore = 0;
  let fitExplanation = "No historical comparison available";

  if (curve && injuryType) {
    // Same injury type matched: +8
    fitScore += 8;

    // Return window alignment (game # within typical curve range): +4
    const gIdx = Math.min(Math.max(gamesBack - 1, 0), 9);
    if (gIdx < (curve.median_pct_recent?.length ?? 0)) {
      fitScore += 4;
    }

    // Stat-specific curve available (not just composite): +4
    if (statKey && curve.stat_median_pct?.[statKey]) {
      const statArr = curve.stat_median_pct[statKey] as (number | null)[];
      if (statArr?.[gIdx] != null) {
        fitScore += 4;
      }
    }

    // Position-specific curve: +4 (if curve.position is specific, not "all")
    if (curve.position && curve.position !== "" && curve.position !== "all") {
      fitScore += 4;
    }

    fitScore = Math.min(20, fitScore);
    const fitParts: string[] = [];
    if (fitScore >= 16) fitParts.push("strong fit");
    else if (fitScore >= 10) fitParts.push("moderate fit");
    else fitParts.push("partial fit");
    fitParts.push(`matched on ${injuryType.toLowerCase()}`);
    if (statKey && curve.stat_median_pct?.[statKey]) fitParts.push("stat-specific data");
    fitExplanation = fitParts.join(", ");
    fitExplanation = fitExplanation.charAt(0).toUpperCase() + fitExplanation.slice(1);
  }

  components.push({ name: "Historical fit", score: fitScore, max: 20, explanation: fitExplanation });

  // ── 4. Model Agreement (0–15) ──
  // How much do the historical and recent-form sub-models agree?
  let agreementScore = 0;
  let agreementExplanation = "Insufficient data for model comparison";

  if (ev) {
    const hist = ev.expectedHistorical;
    const recent = ev.expectedRecent;
    const combined = ev.expectedCombined;

    if (recent != null && combined > 0) {
      // How close are historical and recent projections?
      const divergence = Math.abs(hist - recent) / combined;
      if (divergence < 0.05) {
        agreementScore = 15; // Very close agreement
        agreementExplanation = "Historical and recent-form projections closely aligned";
      } else if (divergence < 0.12) {
        agreementScore = 11;
        agreementExplanation = "Historical and recent-form projections mostly aligned";
      } else if (divergence < 0.25) {
        agreementScore = 7;
        agreementExplanation = "Some divergence between historical and recent-form projections";
      } else {
        agreementScore = 3;
        agreementExplanation = "Significant divergence between historical and recent-form projections";
      }
    } else {
      // Only historical model available
      agreementScore = 6;
      agreementExplanation = "Only historical projection available — no recent form to cross-check";
    }
  }

  components.push({ name: "Model agreement", score: agreementScore, max: 15, explanation: agreementExplanation });

  // ── 5. Output Stability (0–10) ──
  // How sensitive is the signal to small changes in assumptions?
  let stabilityScore = 0;
  let stabilityExplanation = "Unable to assess stability";

  if (ev && props.propLine != null && props.propLine > 0) {
    const gap = Math.abs(ev.expectedCombined - props.propLine);
    const stddev = curve?.stddev_pct_recent?.[Math.min(Math.max(gamesBack - 1, 0), 9)];
    const estimatedStddev = stddev != null && preBaseline ? preBaseline * stddev : (preBaseline ?? props.propLine) * 0.25;

    if (estimatedStddev > 0) {
      // z-score of the gap: higher z = more stable (signal survives perturbation)
      const z = gap / estimatedStddev;
      if (z >= 1.0) {
        stabilityScore = 10;
        stabilityExplanation = "Signal is robust — holds under reasonable assumption changes";
      } else if (z >= 0.5) {
        stabilityScore = 7;
        stabilityExplanation = "Signal is moderately stable — sensitive to large assumption shifts";
      } else if (z >= 0.25) {
        stabilityScore = 4;
        stabilityExplanation = "Signal is fragile — small changes in inputs could shift direction";
      } else {
        stabilityScore = 1;
        stabilityExplanation = "Signal is very sensitive — close to the line with high variance";
      }
    }
  } else if (preBaseline != null && returnAvg != null && preBaseline > 0) {
    // No prop line, but can assess form stability
    const formGap = Math.abs(returnAvg - preBaseline) / preBaseline;
    stabilityScore = formGap > 0.15 ? 7 : formGap > 0.05 ? 4 : 2;
    stabilityExplanation = formGap > 0.15
      ? "Form divergence is clear and directionally stable"
      : "Form difference is modest — sensitivity is moderate";
  }

  components.push({ name: "Output stability", score: stabilityScore, max: 10, explanation: stabilityExplanation });

  // ── Total & Label ──
  const total = components.reduce((sum, c) => sum + c.score, 0);
  const label: "High" | "Medium" | "Low" = total >= 75 ? "High" : total >= 50 ? "Medium" : "Low";

  // ── Free summary (one line) ──
  // Find the strongest and weakest components to build a natural summary
  const sorted = [...components].sort((a, b) => (b.score / b.max) - (a.score / a.max));
  const strongest = sorted[0];
  const weakest = sorted[sorted.length - 1];
  const strongRatio = strongest.score / strongest.max;
  const weakRatio = weakest.score / weakest.max;

  let summary: string;
  if (label === "High") {
    summary = `${strongest.name.toLowerCase()} and ${sorted[1].name.toLowerCase()} are both strong`;
  } else if (label === "Low") {
    summary = weakRatio < 0.3
      ? `limited by ${weakest.name.toLowerCase()}`
      : `${weakest.name.toLowerCase()} and ${sorted[sorted.length - 2].name.toLowerCase()} are both uncertain`;
  } else {
    // Medium — highlight the tension
    if (strongRatio > 0.7 && weakRatio < 0.4) {
      summary = `good ${strongest.name.toLowerCase()}, but ${weakest.name.toLowerCase()} is uncertain`;
    } else {
      summary = `moderate support across most factors`;
    }
  }

  // ── Premium interpretation ──
  let interpretation: string;
  if (label === "High") {
    interpretation = `Confidence is supported by ${strongest.name.toLowerCase()} (${strongest.score}/${strongest.max}) and ${sorted[1].name.toLowerCase()} (${sorted[1].score}/${sorted[1].max}).`;
  } else if (label === "Low") {
    interpretation = `Confidence is reduced mainly by ${weakest.name.toLowerCase()} (${weakest.score}/${weakest.max}).`;
  } else {
    interpretation = `Confidence is limited by ${weakest.name.toLowerCase()} (${weakest.score}/${weakest.max}), supported by ${strongest.name.toLowerCase()} (${strongest.score}/${strongest.max}).`;
  }

  return { total, label, components, summary, interpretation };
}

function buildContextAdjustments(props: WhyThisSignalProps): SignalDriver[] {
  const { gamesBack, preMinutes, currentMinutes } = props;
  const items: SignalDriver[] = [];

  if (gamesBack <= 3 && preMinutes && currentMinutes && preMinutes > 0 && currentMinutes / preMinutes < 0.85) {
    items.push({
      label: "Team likely managing workload",
      sentiment: "negative",
      type: "context",
    });
  }

  if (gamesBack <= 2) {
    items.push({
      label: "Early return — higher variance expected",
      sentiment: "neutral",
      type: "context",
    });
  }

  return items;
}

// ══════════════════════════════════════════════════
// COMPONENTS
// ══════════════════════════════════════════════════

export function WhyThisSignal(props: WhyThisSignalProps) {
  const { isPremium = false, playerName, gamesBack, marketLabel } = props;

  const allDrivers = useMemo(() => buildAllDrivers(props), [props]);
  const freeDrivers = useMemo(() => selectFreeDrivers(allDrivers), [allDrivers]);
  const comparableCases = useMemo(() => buildComparableCases(props), [props]);
  const confidence = useMemo(() => computeConfidenceScore(props), [props]);
  const contextAdjustments = useMemo(() => buildContextAdjustments(props), [props]);

  if (freeDrivers.length === 0 && !isPremium) return null;

  return (
    <div className="rounded-xl bg-gradient-to-b from-white/[0.03] to-transparent border border-white/[0.06]">
      {/* FREE SECTION — always visible */}
      <FreeSection drivers={freeDrivers} confidence={confidence} />

      {/* PREMIUM SECTION — full or locked */}
      {isPremium ? (
        <PremiumSection
          allDrivers={allDrivers}
          comparableCases={comparableCases}
          confidence={confidence}
          contextAdjustments={contextAdjustments}
        />
      ) : (
        <LockedPremiumSection
          allDrivers={allDrivers}
          playerName={playerName}
          gamesBack={gamesBack}
          marketLabel={marketLabel}
        />
      )}
    </div>
  );
}

// ── Free Section ──

function FreeSection({ drivers, confidence }: { drivers: ScoredDriver[]; confidence: ConfidenceScore }) {
  const badgeColor = confidence.label === "High"
    ? "bg-green-500/15 text-green-400/80 border-green-500/20"
    : confidence.label === "Medium"
    ? "bg-amber-500/15 text-amber-400/80 border-amber-500/20"
    : "bg-white/5 text-white/40 border-white/10";

  return (
    <div className="px-3.5 pt-3 pb-2.5">
      <p className="text-[10px] font-bold text-white/50 uppercase tracking-wider mb-2.5">
        Why this signal
      </p>
      <div className="flex flex-col gap-1.5">
        {drivers.map((d, i) => (
          <div key={i} className="flex items-start gap-2">
            <SentimentDot sentiment={d.sentiment} />
            <p className="text-[11px] text-white/60 leading-snug">{d.label}</p>
          </div>
        ))}
      </div>
      {/* Confidence label + one-liner */}
      <div className="mt-2.5 pt-2 border-t border-white/[0.04] flex items-center gap-2">
        <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[9px] font-semibold ${badgeColor}`}>
          {confidence.label}
        </span>
        <p className="text-[10px] text-white/35 leading-snug">{confidence.summary}</p>
      </div>
    </div>
  );
}

// ── Unlocked Premium Section ──
// Expands the SAME drivers with precise numbers + adds comparable cases, confidence, context

function ConfidenceBar({ component }: { component: ConfidenceComponent }) {
  const pct = Math.round((component.score / component.max) * 100);
  const barColor = pct >= 70 ? "bg-green-400/60" : pct >= 40 ? "bg-amber-400/60" : "bg-red-400/50";

  return (
    <div className="mb-2 last:mb-0">
      <div className="flex items-baseline justify-between mb-1">
        <p className="text-[10px] text-white/40">{component.name}</p>
        <p className="text-[10px] text-white/30 tabular-nums">{component.score}/{component.max}</p>
      </div>
      <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
        <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <p className="text-[9px] text-white/25 mt-0.5 leading-snug">{component.explanation}</p>
    </div>
  );
}

function PremiumSection({ allDrivers, comparableCases, confidence, contextAdjustments }: {
  allDrivers: ScoredDriver[];
  comparableCases: ComparableCase[];
  confidence: ConfidenceScore;
  contextAdjustments: SignalDriver[];
}) {
  const premiumDrivers = allDrivers.slice(0, 6);
  const badgeLevel = confidence.label === "High" ? "strong" : confidence.label === "Medium" ? "moderate" : "weak";

  return (
    <div className="border-t border-white/[0.06]">
      <div className="px-3.5 pt-3 pb-3.5">
        <p className="text-[10px] font-bold text-purple-400/70 uppercase tracking-wider mb-3">
          Full model breakdown
        </p>

        {/* A. Key Drivers — expanded with precise numbers */}
        <div className="mb-3.5">
          <p className="text-[9px] text-white/30 uppercase tracking-wider mb-2 font-semibold">Key Drivers</p>
          <div className="flex flex-col gap-1.5">
            {premiumDrivers.map((d, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="text-[9px] text-white/20 tabular-nums min-w-[14px] text-right shrink-0 mt-px font-medium">{i + 1}.</span>
                <SentimentDot sentiment={d.sentiment} />
                <p className="text-[11px] text-white/55 leading-snug">{d.premiumLabel}</p>
              </div>
            ))}
          </div>
        </div>

        {/* B. Comparable Cases */}
        {comparableCases.length > 0 && (
          <div className="mb-3.5">
            <p className="text-[9px] text-white/30 uppercase tracking-wider mb-2 font-semibold">Comparable Cases</p>
            <div className="rounded-lg bg-white/[0.02] border border-white/5 px-3 py-2.5">
              {comparableCases.map((c, i) => (
                <div key={i} className={`flex items-baseline justify-between gap-3 ${i > 0 ? "mt-1.5 pt-1.5 border-t border-white/[0.04]" : ""}`}>
                  <p className="text-[10px] text-white/30">{c.label}</p>
                  <p className="text-[10px] text-white/55 font-medium text-right">{c.value}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* C. Confidence Breakdown — 5-component bars */}
        <div className="mb-3.5">
          <div className="flex items-center gap-2 mb-2.5">
            <p className="text-[9px] text-white/30 uppercase tracking-wider font-semibold">Confidence</p>
            <ConfidenceBadge level={badgeLevel} />
            <span className="text-[9px] text-white/20 tabular-nums">{confidence.total}/100</span>
          </div>
          <div className="rounded-lg bg-white/[0.02] border border-white/5 px-3 py-2.5">
            {confidence.components.map((comp, i) => (
              <ConfidenceBar key={i} component={comp} />
            ))}
          </div>
          <p className="text-[10px] text-white/35 mt-2 leading-snug">{confidence.interpretation}</p>
        </div>

        {/* D. Context Adjustments */}
        {contextAdjustments.length > 0 && (
          <div>
            <p className="text-[9px] text-white/30 uppercase tracking-wider mb-2 font-semibold">Context</p>
            <div className="flex flex-wrap gap-1.5">
              {contextAdjustments.map((c, i) => (
                <span key={i} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] border ${
                  c.sentiment === "positive" ? "bg-green-500/[0.06] text-green-400/60 border-green-500/10" :
                  c.sentiment === "negative" ? "bg-red-500/[0.06] text-red-400/60 border-red-500/10" :
                  "bg-white/[0.03] text-white/35 border-white/5"
                }`}>
                  <SentimentDot sentiment={c.sentiment} />
                  {c.label}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Locked Premium Section ──

function LockedPremiumSection({ allDrivers, playerName, gamesBack, marketLabel }: {
  allDrivers: ScoredDriver[];
  playerName: string;
  gamesBack: number;
  marketLabel: string;
}) {
  const [hovered, setHovered] = useState(false);
  const waitlist = useWaitlistModal();
  const lockTracked = useState(false);

  if (!lockTracked[0]) {
    lockTracked[1](true);
    trackPremiumLockSeen("props", "why_this_signal", playerName);
  }

  const handleHover = useCallback(() => {
    setHovered(true);
    trackPremiumContentHover({
      page: "props",
      section: "why_this_signal_full",
      player_name: playerName,
      stat_type: marketLabel,
      games_since_return: gamesBack,
    });
  }, [playerName, marketLabel, gamesBack]);

  const handleClick = useCallback(() => {
    trackPremiumContentClick({
      page: "props",
      section: "why_this_signal_full",
      player_name: playerName,
      stat_type: marketLabel,
      games_since_return: gamesBack,
    });
    waitlist.openModal("why_this_signal", "props");
  }, [playerName, marketLabel, gamesBack, waitlist]);

  // Show first 2 premium drivers visible (with premiumLabel), rest blurred
  const visibleDrivers = allDrivers.slice(0, 2);
  const blurredCount = Math.max(0, Math.min(allDrivers.length, 6) - 2);

  return (
    <div className="border-t border-white/[0.06]">
      <div
        className="px-3.5 pt-3 pb-3 cursor-pointer group"
        onMouseEnter={handleHover}
        onMouseLeave={() => setHovered(false)}
        onClick={handleClick}
      >
        <p className="text-[10px] font-bold text-purple-400/50 uppercase tracking-wider mb-2.5">
          Full model breakdown
        </p>

        {/* Visible preview — first 2 drivers with premium labels */}
        <div className="flex flex-col gap-1.5 mb-2">
          {visibleDrivers.map((d, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="text-[9px] text-white/20 tabular-nums min-w-[14px] text-right shrink-0 mt-px font-medium">{i + 1}.</span>
              <SentimentDot sentiment={d.sentiment} />
              <p className="text-[11px] text-white/45 leading-snug">{d.premiumLabel}</p>
            </div>
          ))}
        </div>

        {/* Blurred placeholder lines */}
        <div className="relative">
          <div className="blur-[4px] select-none pointer-events-none opacity-40">
            <div className="flex flex-col gap-1.5">
              {Array.from({ length: Math.min(blurredCount + 2, 4) }).map((_, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="text-[9px] text-white/20 tabular-nums min-w-[14px] text-right shrink-0 mt-px">{i + 3}.</span>
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-white/20 shrink-0 mt-[5px]" />
                  <div className={`h-3 rounded bg-white/10 ${i % 2 === 0 ? "w-3/4" : "w-2/3"}`} />
                </div>
              ))}
            </div>
            <div className="mt-3 pt-2 border-t border-white/5">
              <div className="h-3 w-1/3 rounded bg-white/10 mb-2" />
              <div className="h-8 rounded bg-white/5" />
            </div>
            <div className="mt-2 pt-2 border-t border-white/5">
              <div className="h-3 w-1/4 rounded bg-white/10 mb-2" />
              <div className="flex gap-2">
                <div className="h-5 w-20 rounded bg-white/5" />
                <div className="h-5 w-24 rounded bg-white/5" />
              </div>
            </div>
          </div>

          {/* Lock overlay */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className={`flex items-center gap-2 px-3.5 py-2 rounded-lg transition-all ${
              hovered
                ? "bg-purple-500/15 border border-purple-500/25"
                : "bg-white/[0.04] border border-white/[0.08]"
            }`}>
              <span className="text-[10px] text-white/25">🔒</span>
              <span className={`text-[10px] transition-colors ${hovered ? "text-purple-300/70" : "text-white/30"}`}>
                Full driver stack, comparable cases, and confidence details
              </span>
            </div>
          </div>
        </div>

        {/* Subtle CTA */}
        <div className="flex items-center justify-center gap-2 mt-3 pt-2.5 border-t border-white/[0.04]">
          <button
            onClick={(e) => {
              e.stopPropagation();
              trackPremiumWaitlistClick("props", "why_this_signal_cta");
              waitlist.openModal("why_this_signal_cta", "props");
            }}
            className="text-[10px] text-purple-400/40 hover:text-purple-400/70 transition-colors"
          >
            Unlock full driver breakdown, comparable cases, and confidence details
          </button>
        </div>
      </div>

      <WaitlistModal
        open={waitlist.open}
        onClose={waitlist.closeModal}
        source={waitlist.source}
        page={waitlist.page}
      />
    </div>
  );
}

export default WhyThisSignal;
