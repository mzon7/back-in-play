import { Link, useParams } from "react-router-dom";
import { SiteHeader } from "../../components/SiteHeader";
import { SEO } from "../../components/seo/SEO";
import {
  breadcrumbJsonLd,
  datasetJsonLd,
  jsonLdGraph,
} from "../../components/seo/seoHelpers";
import { PerformanceCurveChart } from "../../features/performance-curves/components/PerformanceCurveChart";
import { usePerformanceCurves } from "../../features/performance-curves/lib/queries";
import { STAT_LABELS, LEAGUE_STATS } from "../../features/performance-curves/lib/types";
import type { PerformanceCurve } from "../../features/performance-curves/lib/types";
import { useQuery } from "@tanstack/react-query";
import { supabase, dbTable } from "../../lib/supabase";

const LEAGUE_LABELS: Record<string, string> = {
  nba: "NBA",
  nfl: "NFL",
  mlb: "MLB",
  nhl: "NHL",
  "premier-league": "EPL",
};

const LEAGUE_SPORT: Record<string, string> = {
  nba: "basketball",
  nfl: "football",
  mlb: "baseball",
  nhl: "hockey",
  "premier-league": "football (soccer)",
};

const COMMON_INJURY_TYPES = [
  "hamstring",
  "knee",
  "ankle",
  "concussion",
  "shoulder",
  "groin",
  "calf",
  "back",
  "hip",
  "wrist",
  "quadriceps",
  "foot",
];

function titleCase(slug: string) {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Fetch position-specific curves for a given league + injury type */
function usePositionCurves(leagueSlug: string, injuryTypeSlug: string) {
  return useQuery<PerformanceCurve[]>({
    queryKey: ["position-curves", leagueSlug, injuryTypeSlug],
    queryFn: async () => {
      const { data, error } = await supabase
        .from(dbTable("performance_curves"))
        .select("*")
        .eq("league_slug", leagueSlug)
        .eq("injury_type_slug", injuryTypeSlug)
        .neq("position", "")
        .gte("sample_size", 3)
        .order("sample_size", { ascending: false });

      if (error) throw new Error(error.message);
      return (data ?? []) as PerformanceCurve[];
    },
    staleTime: 10 * 60 * 1000,
  });
}

function StatCard({
  statKey,
  values,
}: {
  statKey: string;
  values: (number | null)[];
}) {
  const label = STAT_LABELS[statKey] ?? statKey;
  const game1 = values[0];
  const game10 = values[9];

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
      <h4 className="text-sm font-semibold text-white/70 mb-2">{label}</h4>
      <div className="flex justify-between text-sm">
        <div>
          <span className="text-white/40 text-xs">Game 1</span>
          <p
            className={
              game1 != null
                ? game1 >= 1.0
                  ? "text-green-400 font-bold"
                  : "text-amber-400 font-bold"
                : "text-white/30"
            }
          >
            {game1 != null ? `${Math.round(game1 * 100)}%` : "—"}
          </p>
        </div>
        <div className="text-right">
          <span className="text-white/40 text-xs">Game 10</span>
          <p
            className={
              game10 != null
                ? game10 >= 1.0
                  ? "text-green-400 font-bold"
                  : "text-amber-400 font-bold"
                : "text-white/30"
            }
          >
            {game10 != null ? `${Math.round(game10 * 100)}%` : "—"}
          </p>
        </div>
      </div>
      {game1 != null && game10 != null && (
        <p className="text-xs text-white/30 mt-1">
          {game10 > game1
            ? `+${Math.round((game10 - game1) * 100)}pp improvement`
            : game10 < game1
            ? `${Math.round((game10 - game1) * 100)}pp decline`
            : "No change"}
        </p>
      )}
    </div>
  );
}

function seoTextBlock(
  injuryLabel: string,
  leagueLabel: string,
  sport: string,
  curve: PerformanceCurve | null
) {
  const median1 =
    curve?.median_pct_recent[0] != null
      ? Math.round(curve.median_pct_recent[0] * 100)
      : null;
  const median10 =
    curve?.median_pct_recent[9] != null
      ? Math.round(curve.median_pct_recent[9] * 100)
      : null;
  const gamesMissed =
    curve?.games_missed_avg != null ? Math.round(curve.games_missed_avg) : null;
  const recoveryDays =
    curve?.recovery_days_avg != null
      ? Math.round(curve.recovery_days_avg)
      : null;

  return (
    <div className="text-sm text-white/50 leading-relaxed space-y-3">
      <p>
        {injuryLabel} injuries are among the most closely tracked injuries in
        the {leagueLabel}, and understanding their impact on player performance
        is essential for fantasy {sport} managers, sports bettors, and team
        analysts. When a {leagueLabel} player returns from a {injuryLabel.toLowerCase()}{" "}
        injury, the key question is: how quickly do they return to their
        pre-injury production levels?
      </p>
      <p>
        Our analysis of historical {leagueLabel}{" "}
        {injuryLabel.toLowerCase()} injury return cases reveals that{" "}
        {median1 != null ? (
          <>
            players typically perform at{" "}
            <strong className="text-white/70">{median1}%</strong> of their
            pre-injury baseline in their first game back
          </>
        ) : (
          "performance in the first game back varies significantly"
        )}
        {median10 != null && (
          <>
            , recovering to{" "}
            <strong className="text-white/70">{median10}%</strong> by game 10
          </>
        )}
        .{" "}
        {gamesMissed != null &&
          `Players miss an average of ${gamesMissed} games due to this injury type. `}
        {recoveryDays != null &&
          `The average recovery timeline spans approximately ${recoveryDays} days from injury to return. `}
        These figures are computed from real game log data and represent median
        values, meaning half of returning players perform above these
        benchmarks.
      </p>
      <p>
        The performance curve methodology compares each player's post-return
        composite score — a weighted combination of key {sport} statistics — against
        their 5-game pre-injury average. This approach controls for
        individual player ability and provides a true measure of how much
        the {injuryLabel.toLowerCase()} injury affects on-court production in the {leagueLabel}.
        Factors such as position, age, injury severity, and minutes
        restrictions all contribute to the variation seen in recovery
        trajectories.
      </p>
    </div>
  );
}

export default function LeagueInjuryTypePerformancePage() {
  const {
    leagueSlug = "",
    injuryPerf = "",
    position,
  } = useParams<{
    leagueSlug: string;
    injuryPerf: string;
    position?: string;
  }>();

  const injuryTypeSlug = injuryPerf.replace("-injury-performance", "");
  const injuryLabel = titleCase(injuryTypeSlug);
  const leagueLabel = LEAGUE_LABELS[leagueSlug] ?? leagueSlug.toUpperCase();
  const sport = LEAGUE_SPORT[leagueSlug] ?? "sports";
  const year = new Date().getFullYear();
  const positionDisplay = position ? position.toUpperCase() : null;

  // Fetch all-positions curve (or position-specific if set)
  const { data: curves = [], isLoading } = usePerformanceCurves(
    leagueSlug,
    injuryTypeSlug,
    position ?? "all"
  );
  const curve = curves[0] ?? null;

  // Fetch position-specific curves for breakdown (only when viewing all positions)
  const { data: positionCurves = [] } = usePositionCurves(
    leagueSlug,
    injuryTypeSlug
  );

  // Per-stat breakdowns
  const leagueStats = LEAGUE_STATS[leagueSlug] ?? [];
  const statMedian = curve?.stat_median_pct ?? {};
  const availableStats = leagueStats.filter(
    (s) => statMedian[s] && statMedian[s].length > 0
  );

  // Minutes data
  const hasMinutes =
    curve?.avg_minutes_pct && curve.avg_minutes_pct.some((v) => v != null);

  // Build SEO metadata
  const median1 =
    curve?.median_pct_recent[0] != null
      ? Math.round(curve.median_pct_recent[0] * 100)
      : null;
  const median10 =
    curve?.median_pct_recent[9] != null
      ? Math.round(curve.median_pct_recent[9] * 100)
      : null;

  const pagePath = position
    ? `/${leagueSlug}/${injuryTypeSlug}-injury-performance/${position}`
    : `/${leagueSlug}/${injuryTypeSlug}-injury-performance`;

  const titleStr = positionDisplay
    ? `${injuryLabel} Injury Performance — ${leagueLabel} ${positionDisplay} (${year})`
    : `${injuryLabel} Injury Performance — ${leagueLabel} (${year})`;

  const descriptionStr = (() => {
    let desc = `How do ${leagueLabel} players perform after ${injuryLabel.toLowerCase()} injuries?`;
    if (median1 != null)
      desc += ` Game 1: ${median1}% of baseline.`;
    if (median10 != null)
      desc += ` Game 10: ${median10}%.`;
    if (curve?.sample_size)
      desc += ` Based on ${curve.sample_size} historical cases.`;
    return desc;
  })();

  const jsonLd = jsonLdGraph(
    breadcrumbJsonLd([
      { name: "Home", path: "/" },
      { name: `${leagueLabel} Injuries`, path: `/${leagueSlug}-injuries` },
      {
        name: injuryLabel,
        path: `/injuries/${injuryTypeSlug}`,
      },
      { name: "Performance Analysis", path: pagePath },
    ]),
    datasetJsonLd({
      name: `${leagueLabel} ${injuryLabel} Injury Performance Data`,
      description: `Recovery performance curves for ${leagueLabel} players returning from ${injuryLabel.toLowerCase()} injuries. ${curve?.sample_size ?? 0} historical cases analyzed.`,
      url: pagePath,
      sampleSize: curve?.sample_size ?? 0,
      keywords: [
        `${injuryLabel.toLowerCase()} injury ${leagueLabel}`,
        `${leagueLabel} ${injuryLabel.toLowerCase()} recovery`,
        `${sport} injury performance`,
        "return to play data",
        "post-injury stats",
      ],
    })
  );

  // Related injury types for links
  const otherInjuries = COMMON_INJURY_TYPES.filter(
    (t) => t !== injuryTypeSlug
  ).slice(0, 4);

  return (
    <div className="min-h-screen bg-[#0A0F1E] text-white">
      <SEO
        title={titleStr}
        description={descriptionStr}
        path={pagePath}
        jsonLd={jsonLd}
      />
      <SiteHeader />

      {/* Hero */}
      <div className="relative overflow-hidden border-b border-white/10 bg-gradient-to-br from-[#0A0F1E] via-[#0d1529] to-[#0A0F1E]">
        <div className="pointer-events-none absolute -top-32 -left-32 w-96 h-96 rounded-full bg-[#1C7CFF] opacity-10 blur-3xl" />
        <div className="relative max-w-4xl mx-auto px-4 sm:px-6 py-10">
          {/* Breadcrumb */}
          <nav className="text-sm text-white/40 mb-4">
            <Link to="/" className="hover:text-white/60">
              Home
            </Link>
            {" / "}
            <Link
              to={`/${leagueSlug}-injuries`}
              className="hover:text-white/60"
            >
              {leagueLabel} Injuries
            </Link>
            {" / "}
            <Link
              to={`/injuries/${injuryTypeSlug}`}
              className="hover:text-white/60"
            >
              {injuryLabel}
            </Link>
            {" / "}
            {position ? (
              <>
                <Link to={`/${leagueSlug}/${injuryTypeSlug}-injury-performance`} className="hover:text-white/60">
                  Performance Analysis
                </Link>
                {" / "}
                <span className="text-white/60">{positionDisplay}</span>
              </>
            ) : (
              <span className="text-white/60">Performance Analysis</span>
            )}
          </nav>

          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-3">
            {injuryLabel} Injury Performance in the {leagueLabel}
            {positionDisplay && ` — ${positionDisplay}`} ({year})
          </h1>
          <p className="text-white/50 text-sm max-w-2xl">
            {isLoading
              ? "Loading performance data..."
              : curve
              ? `Analysis of ${curve.sample_size.toLocaleString()} ${leagueLabel} ${injuryLabel.toLowerCase()} injury return cases. Players perform at ${median1 ?? "—"}% of baseline in game 1, recovering to ${median10 ?? "—"}% by game 10.`
              : `No performance data available for ${leagueLabel} ${injuryLabel.toLowerCase()} injuries${positionDisplay ? ` at the ${positionDisplay} position` : ""}.`}
          </p>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        {isLoading && (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-16 rounded-xl bg-white/10 animate-pulse"
              />
            ))}
          </div>
        )}

        {/* Performance Curve Chart */}
        {curve && (
          <section>
            <h2 className="text-xl font-bold mb-2">
              {injuryLabel} Recovery Curve
              {positionDisplay && ` — ${positionDisplay}`}
            </h2>
            <p className="text-xs text-white/40 mb-4">
              Performance as % of pre-injury baseline over first 10 games back
              ({curve.sample_size.toLocaleString()} cases)
            </p>
            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <PerformanceCurveChart curve={curve} height={300} />
            </div>
          </section>
        )}

        {/* Stat Breakdown */}
        {curve && availableStats.length > 0 && (
          <section className="mt-10">
            <h2 className="text-xl font-bold mb-2">
              Stat-by-Stat Breakdown
            </h2>
            <p className="text-xs text-white/40 mb-4">
              How individual stats are affected by{" "}
              {injuryLabel.toLowerCase()} injuries in the {leagueLabel}
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {availableStats.map((statKey) => (
                <StatCard
                  key={statKey}
                  statKey={statKey}
                  values={statMedian[statKey]}
                />
              ))}
            </div>
          </section>
        )}

        {/* Minutes Impact */}
        {curve && hasMinutes && (
          <section className="mt-10">
            <h2 className="text-xl font-bold mb-2">Minutes Impact</h2>
            <p className="text-xs text-white/40 mb-4">
              Playing time as % of pre-injury average over first 10 games
              back
            </p>
            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="grid grid-cols-5 sm:grid-cols-10 gap-2">
                {curve.avg_minutes_pct.slice(0, 10).map((val, i) => (
                  <div key={i} className="text-center">
                    <div className="text-xs text-white/30 mb-1">G{i + 1}</div>
                    <div
                      className="mx-auto rounded-md bg-[#1C7CFF]/20"
                      style={{
                        height: `${Math.max((val ?? 0) * 60, 8)}px`,
                        width: "100%",
                        maxWidth: "36px",
                        backgroundColor:
                          val != null && val >= 1.0
                            ? "rgba(74,222,128,0.3)"
                            : "rgba(28,124,255,0.3)",
                      }}
                    />
                    <div
                      className={`text-xs mt-1 font-medium ${
                        val != null && val >= 1.0
                          ? "text-green-400"
                          : "text-[#1C7CFF]"
                      }`}
                    >
                      {val != null ? `${Math.round(val * 100)}%` : "—"}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Recovery Info */}
        {curve &&
          (curve.games_missed_avg != null ||
            curve.recovery_days_avg != null) && (
            <section className="mt-10">
              <h2 className="text-xl font-bold mb-4">Recovery Timeline</h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {curve.games_missed_avg != null && (
                  <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-center">
                    <p className="text-2xl font-bold text-[#1C7CFF]">
                      {Math.round(curve.games_missed_avg)}
                    </p>
                    <p className="text-xs text-white/40 mt-1">
                      Avg Games Missed
                    </p>
                  </div>
                )}
                {curve.recovery_days_avg != null && (
                  <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-center">
                    <p className="text-2xl font-bold text-[#1C7CFF]">
                      {Math.round(curve.recovery_days_avg)}
                    </p>
                    <p className="text-xs text-white/40 mt-1">
                      Avg Recovery Days
                    </p>
                  </div>
                )}
                {curve.games_to_full != null && (
                  <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-center">
                    <p className="text-2xl font-bold text-green-400">
                      {curve.games_to_full}
                    </p>
                    <p className="text-xs text-white/40 mt-1">
                      Games to Full Recovery
                    </p>
                  </div>
                )}
                <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-center">
                  <p className="text-2xl font-bold text-white/70">
                    {curve.sample_size.toLocaleString()}
                  </p>
                  <p className="text-xs text-white/40 mt-1">
                    Historical Cases
                  </p>
                </div>
              </div>
            </section>
          )}

        {/* Position Breakdown */}
        {!position && positionCurves.length > 0 && (
          <section className="mt-10">
            <h2 className="text-xl font-bold mb-2">
              {injuryLabel} Recovery by Position
            </h2>
            <p className="text-xs text-white/40 mb-4">
              How {injuryLabel.toLowerCase()} injury recovery varies across{" "}
              {leagueLabel} positions
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {positionCurves.map((pc) => {
                const m10 =
                  pc.median_pct_recent[9] != null
                    ? Math.round(pc.median_pct_recent[9] * 100)
                    : null;
                return (
                  <Link
                    key={pc.position}
                    to={`/${leagueSlug}/${injuryTypeSlug}-injury-performance/${pc.position.toLowerCase()}`}
                    className="rounded-lg border border-white/10 bg-white/5 p-3 hover:bg-white/[0.08] transition-colors"
                  >
                    <span className="text-sm font-medium text-white block">
                      {pc.position}
                    </span>
                    <span className="text-xs text-white/40">
                      {pc.sample_size} cases
                      {m10 != null && (
                        <span
                          className={
                            m10 >= 100 ? " text-green-400" : " text-amber-400"
                          }
                        >
                          {" "}
                          &middot; G10: {m10}%
                        </span>
                      )}
                    </span>
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        {/* Related Links */}
        <section className="mt-10 border-t border-white/8 pt-6">
          <h2 className="text-sm font-bold uppercase tracking-wide text-white/40 mb-3">
            Related Injury Analysis
          </h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {otherInjuries.map((slug) => (
              <Link
                key={slug}
                to={`/${leagueSlug}/${slug}-injury-performance`}
                className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors"
              >
                {titleCase(slug)} Injuries in {leagueLabel}
              </Link>
            ))}
            <Link
              to={`/${leagueSlug}-injuries`}
              className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors"
            >
              {leagueLabel} Injury Report Hub
            </Link>
            <Link
              to={`/${leagueSlug}-injury-performance`}
              className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors"
            >
              All {leagueLabel} Injury Performance Curves
            </Link>
            <Link
              to="/recovery-stats"
              className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors"
            >
              Recovery Statistics — All Leagues
            </Link>
            <Link
              to="/performance-curves"
              className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors"
            >
              Performance Curves — All Leagues
            </Link>
            <Link
              to="/"
              className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors"
            >
              Players Returning Today
            </Link>
            {Object.entries(LEAGUE_LABELS)
              .filter(([s]) => s !== leagueSlug)
              .slice(0, 2)
              .map(([s, l]) => (
                <Link
                  key={s}
                  to={`/${s}/${injuryTypeSlug}-injury-performance`}
                  className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors"
                >
                  {titleCase(injuryTypeSlug)} Injuries in {l}
                </Link>
              ))}
          </div>
        </section>

        {/* SEO Text Block */}
        <section className="mt-8 border-t border-white/8 pt-8">
          <h2 className="text-lg font-bold mb-3">
            How {injuryLabel} Injuries Affect {leagueLabel} Player Performance
          </h2>
          {seoTextBlock(injuryLabel, leagueLabel, sport, curve)}
        </section>
      </div>
    </div>
  );
}
