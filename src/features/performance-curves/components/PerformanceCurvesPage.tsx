import { useState } from "react";
import { Link } from "react-router-dom";
import { SiteHeader } from "../../../components/SiteHeader";
import { SEO } from "../../../components/seo/SEO";
import { usePerformanceCurves } from "../lib/queries";
import { PerformanceCurveChart } from "./PerformanceCurveChart";
import type { PerformanceCurve, LeagueFilter } from "../lib/types";
import { LEAGUE_LABELS } from "../lib/types";

const LEAGUE_ORDER: LeagueFilter[] = ["all", "nba", "nfl", "mlb", "nhl", "premier-league"];

function CurveCard({ curve }: { curve: PerformanceCurve }) {
  const [expanded, setExpanded] = useState(false);

  const median10 = curve.median_pct_recent[9];
  const reachedFull = median10 != null && median10 >= 1.0;
  const leagueLabel = LEAGUE_LABELS[curve.league_slug] ?? curve.league_slug.toUpperCase();

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-5 py-4 flex items-center gap-3 hover:bg-white/[0.03] transition-colors"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-sm text-white truncate">{curve.injury_type}</h3>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/10 text-white/40 shrink-0">{leagueLabel}</span>
          </div>
          <div className="flex items-center gap-4 mt-1 text-xs text-white/40">
            <span>{curve.sample_size} cases</span>
            {curve.games_missed_avg != null && <span>{curve.games_missed_avg} avg games missed</span>}
            {curve.recovery_days_avg != null && <span>{Math.round(curve.recovery_days_avg)} avg recovery days</span>}
          </div>
        </div>

        {/* Quick stat */}
        <div className="text-right shrink-0">
          {median10 != null ? (
            <div className={`text-lg font-bold ${reachedFull ? "text-green-400" : "text-amber-400"}`}>
              {Math.round(median10 * 100)}%
            </div>
          ) : (
            <div className="text-lg font-bold text-white/20">—</div>
          )}
          <div className="text-[10px] text-white/30">by game 10</div>
        </div>

        <span className="text-white/30 text-sm ml-2 transition-transform" style={{ transform: expanded ? "rotate(0)" : "rotate(-90deg)" }}>
          &#9660;
        </span>
      </button>

      {expanded && (
        <div className="px-5 pb-5 border-t border-white/5">
          <div className="mt-4">
            <PerformanceCurveChart curve={curve} />
          </div>

          {/* Key stats */}
          <div className="grid grid-cols-3 gap-3 mt-4">
            <div className="bg-white/5 rounded-lg p-3 text-center">
              <p className="text-xs text-white/40 mb-1">Game 1 Back</p>
              <p className="text-sm font-bold text-white">
                {curve.median_pct_recent[0] != null ? `${Math.round(curve.median_pct_recent[0] * 100)}%` : "—"}
              </p>
            </div>
            <div className="bg-white/5 rounded-lg p-3 text-center">
              <p className="text-xs text-white/40 mb-1">Game 5 Back</p>
              <p className="text-sm font-bold text-white">
                {curve.median_pct_recent[4] != null ? `${Math.round(curve.median_pct_recent[4] * 100)}%` : "—"}
              </p>
            </div>
            <div className="bg-white/5 rounded-lg p-3 text-center">
              <p className="text-xs text-white/40 mb-1">Rest of Season</p>
              <p className="text-sm font-bold text-white">
                {curve.rest_of_season_pct_recent != null ? `${Math.round(curve.rest_of_season_pct_recent * 100)}%` : "—"}
              </p>
            </div>
          </div>

          {curve.games_to_full != null && (
            <p className="text-xs text-white/40 mt-3 text-center">
              Estimated {Math.round(curve.games_to_full)} games to reach pre-injury performance
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function PerformanceCurvesPage() {
  const [league, setLeague] = useState<LeagueFilter>("all");
  const { data: curves = [], isLoading } = usePerformanceCurves(league === "all" ? undefined : league);

  const year = new Date().getFullYear();

  return (
    <div className="min-h-screen bg-[#0A0F1E] text-white">
      <SEO
        title={`Post-Injury Performance Curves (${year}) - Recovery Analytics`}
        description="How do players perform after returning from injury? Explore recovery performance curves across NFL, NBA, MLB, NHL, and EPL."
        path="/performance-curves"
      />
      <SiteHeader />

      {/* Hero */}
      <div className="relative overflow-hidden border-b border-white/10 bg-gradient-to-br from-[#0A0F1E] via-[#0d1529] to-[#0A0F1E]">
        <div className="pointer-events-none absolute -top-32 -left-32 w-96 h-96 rounded-full bg-[#1C7CFF] opacity-10 blur-3xl" />
        <div className="pointer-events-none absolute -top-32 -right-32 w-96 h-96 rounded-full bg-[#3DFF8F] opacity-8 blur-3xl" />

        <div className="relative max-w-4xl mx-auto px-4 sm:px-6 py-10">
          {/* Breadcrumb */}
          <nav className="text-sm text-white/40 mb-4">
            <Link to="/" className="hover:text-white/60">Home</Link>
            {" / "}
            <span className="text-white/60">Performance Curves</span>
          </nav>

          <div className="flex items-center gap-3 mb-3">
            <span className="text-2xl">📈</span>
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
            Curves show percentage of pre-injury baseline performance.
          </p>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        {/* League filter */}
        <div className="flex gap-1.5 overflow-x-auto pb-4 mb-6">
          {LEAGUE_ORDER.map((slug) => (
            <button
              key={slug}
              onClick={() => setLeague(slug)}
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

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-4 text-xs text-white/40 mb-6 pb-4 border-b border-white/8">
          <span className="flex items-center gap-1.5">
            <span className="w-4 h-0.5 bg-[#1C7CFF] rounded" /> Median recovery curve
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-4 h-3 bg-[#1C7CFF]/15 rounded" /> 25th–75th percentile
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-4 h-0.5 border-b border-dashed border-white/25" /> Average
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-4 h-0.5 border-b border-dashed border-[#3DFF8F]/40" /> 100% baseline
          </span>
        </div>

        {/* Curves list */}
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-20 rounded-xl bg-white/10 animate-pulse" />
            ))}
          </div>
        ) : curves.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-8 text-center">
            <p className="text-white/50">No performance curve data available yet.</p>
            <p className="text-xs text-white/30 mt-2">
              Curves are computed from historical game log data. The pipeline runs daily.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {curves.map((curve) => (
              <CurveCard key={curve.curve_id} curve={curve} />
            ))}
          </div>
        )}

        {/* Methodology note */}
        <div className="mt-10 border-t border-white/8 pt-6">
          <h3 className="text-xs font-bold uppercase tracking-wide text-white/40 mb-2">Methodology</h3>
          <p className="text-xs text-white/30 leading-relaxed">
            Performance curves compare each player's post-return game performance against their
            pre-injury 5-game average (recent baseline). Data sourced from Basketball-Reference,
            Pro-Football-Reference, Hockey-Reference, Baseball-Reference, and FBref. Only injury
            cases with 3+ pre-injury games and a verified return are included. Minimum 3 cases per
            curve. Updated daily.
          </p>
        </div>
      </div>
    </div>
  );
}
