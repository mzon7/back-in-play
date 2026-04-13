import { useParams, Link } from "react-router-dom";
import { SiteHeader } from "../../components/SiteHeader";
import { SEO } from "../../components/seo/SEO";
import {
  breadcrumbJsonLd,
  datasetJsonLd,
  jsonLdGraph,
} from "../../components/seo/seoHelpers";
import { usePerformanceCurves, usePositionsWithCurves } from "../../features/performance-curves/lib/queries";
import { PerformanceCurveChart } from "../../features/performance-curves/components/PerformanceCurveChart";
import type { PerformanceCurve } from "../../features/performance-curves/lib/types";

const LEAGUE_FULL: Record<string, string> = {
  nba: "NBA",
  nfl: "NFL",
  mlb: "MLB",
  nhl: "NHL",
  "premier-league": "Premier League",
};

const LEAGUE_SPORT: Record<string, string> = {
  nba: "basketball",
  nfl: "football",
  mlb: "baseball",
  nhl: "hockey",
  "premier-league": "football (soccer)",
};

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function InjuryTypeRow({ curve }: { curve: PerformanceCurve }) {
  const median10 = curve.median_pct_recent[9];
  const median1 = curve.median_pct_recent[0];

  return (
    <tr className="border-b border-white/5 hover:bg-white/[0.02]">
      <td className="py-3 pr-4">
        <Link
          to={`/injuries/${slugify(curve.injury_type)}`}
          className="text-sm font-medium text-[#1C7CFF] hover:text-[#1C7CFF]/80"
        >
          {curve.injury_type}
        </Link>
      </td>
      <td className="py-3 px-3 text-center text-sm text-white/50">
        {curve.sample_size.toLocaleString()}
      </td>
      <td className="py-3 px-3 text-center text-sm text-white/50">
        {curve.recovery_days_avg != null ? `${Math.round(curve.recovery_days_avg)}d` : "—"}
      </td>
      <td className="py-3 px-3 text-center text-sm text-white/50">
        {curve.games_missed_avg ?? "—"}
      </td>
      <td className="py-3 px-3 text-center text-sm">
        <span className={median1 != null ? (median1 >= 1.0 ? "text-green-400" : "text-amber-400") : "text-white/30"}>
          {median1 != null ? `${Math.round(median1 * 100)}%` : "—"}
        </span>
      </td>
      <td className="py-3 pl-3 text-center text-sm">
        <span className={median10 != null ? (median10 >= 1.0 ? "text-green-400" : "text-amber-400") : "text-white/30"}>
          {median10 != null ? `${Math.round(median10 * 100)}%` : "—"}
        </span>
      </td>
    </tr>
  );
}

export default function LeagueInjuryPerformancePage() {
  const { slug } = useParams<{ slug: string }>();
  const leagueSlug = slug?.replace("-injury-performance", "") ?? "";
  const label = LEAGUE_FULL[leagueSlug] ?? leagueSlug.toUpperCase();
  const sport = LEAGUE_SPORT[leagueSlug] ?? "sports";
  const year = new Date().getFullYear();

  const { data: curves = [], isLoading } = usePerformanceCurves(leagueSlug, undefined, "all");
  const { data: positions = [] } = usePositionsWithCurves(leagueSlug);

  // All-positions curves only, exclude "other"
  const allPosCurves = curves.filter((c) => !c.position && c.injury_type_slug !== "other" && c.injury_type_slug !== "unknown");
  const totalCases = allPosCurves.reduce((sum, c) => sum + c.sample_size, 0);

  // Top curves by sample size
  const topCurves = [...allPosCurves].sort((a, b) => b.sample_size - a.sample_size);

  // Compute league-wide average recovery %
  const medians10 = allPosCurves.map((c) => c.median_pct_recent[9]).filter((v): v is number => v != null);
  const avgRecovery = medians10.length > 0 ? Math.round((medians10.reduce((a, b) => a + b, 0) / medians10.length) * 100) : null;

  const title = `${label} Injury Performance Analysis (${year})`;
  const description = `How do ${label} players perform after returning from injury? Analyze recovery curves, stat changes, and minute drops across ${allPosCurves.length} injury types based on ${totalCases.toLocaleString()} historical cases.`;

  const jsonLd = jsonLdGraph(
    breadcrumbJsonLd([
      { name: "Home", path: "/" },
      { name: `${label} Injuries`, path: `/${leagueSlug}-injuries` },
      { name: "Injury Performance", path: `/${leagueSlug}-injury-performance` },
    ]),
    datasetJsonLd({
      name: `${label} Post-Injury Performance Data`,
      description: `Recovery performance curves for ${label} players returning from injury. ${totalCases} historical cases across ${allPosCurves.length} injury types.`,
      url: `/${leagueSlug}-injury-performance`,
      sampleSize: totalCases,
      keywords: [
        `${label} injury recovery`,
        `${label} player performance after injury`,
        `${sport} injury statistics`,
        "return to play performance",
      ],
    })
  );

  return (
    <div className="min-h-screen bg-[#0A0F1E] text-white">
      <SEO title={title} description={description} path={`/${leagueSlug}-injury-performance`} jsonLd={jsonLd} />
      <SiteHeader />

      {/* Hero */}
      <div className="relative overflow-hidden border-b border-white/10 bg-gradient-to-br from-[#0A0F1E] via-[#0d1529] to-[#0A0F1E]">
        <div className="pointer-events-none absolute -top-32 -left-32 w-96 h-96 rounded-full bg-[#1C7CFF] opacity-10 blur-3xl" />
        <div className="relative max-w-4xl mx-auto px-4 sm:px-6 py-10">
          <nav className="text-sm text-white/40 mb-4">
            <Link to="/" className="hover:text-white/60">Home</Link>
            {" / "}
            <Link to={`/${leagueSlug}-injuries`} className="hover:text-white/60">{label} Injuries</Link>
            {" / "}
            <span className="text-white/60">Injury Performance</span>
          </nav>

          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-3">
            {label} Player Performance After Injury
          </h1>
          <p className="text-white/50 text-sm max-w-2xl">
            {isLoading ? "Loading..." : (
              <>
                Analysis of how {label} players perform in their first 10 games back from injury,
                based on {totalCases.toLocaleString()} historical injury return cases across {allPosCurves.length} injury types.
                {avgRecovery != null && (
                  <> On average, {label} players recover to <strong className="text-white/70">{avgRecovery}%</strong> of
                  pre-injury performance by game 10.</>
                )}
              </>
            )}
          </p>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        {/* Injury type table */}
        <section>
          <h2 className="text-xl font-bold mb-4">Recovery Curves by Injury Type</h2>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => <div key={i} className="h-12 rounded bg-white/10 animate-pulse" />)}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-white/10 text-xs text-white/40 uppercase tracking-wider">
                    <th className="pb-2 pr-4">Injury</th>
                    <th className="pb-2 px-3 text-center">Cases</th>
                    <th className="pb-2 px-3 text-center">Avg Recovery</th>
                    <th className="pb-2 px-3 text-center">Games Missed</th>
                    <th className="pb-2 px-3 text-center">Game 1</th>
                    <th className="pb-2 pl-3 text-center">Game 10</th>
                  </tr>
                </thead>
                <tbody>
                  {topCurves.map((curve) => (
                    <InjuryTypeRow key={curve.curve_id} curve={curve} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Top curve chart */}
        {topCurves[0] && (
          <section className="mt-10">
            <h2 className="text-xl font-bold mb-2">
              Most Common: {topCurves[0].injury_type} Injuries ({topCurves[0].sample_size} cases)
            </h2>
            <p className="text-xs text-white/40 mb-4">
              Performance as % of pre-injury baseline over first 10 games back
            </p>
            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <PerformanceCurveChart curve={topCurves[0]} height={300} />
            </div>
          </section>
        )}

        {/* Position breakdown */}
        {positions.length > 0 && (
          <section className="mt-10">
            <h2 className="text-xl font-bold mb-4">Performance by Position</h2>
            <p className="text-sm text-white/40 mb-4">
              Injury recovery varies by position. See how different {label} positions recover from common injuries.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {positions.map((pos) => (
                <Link
                  key={pos}
                  to={`/performance-curves?league=${leagueSlug}&position=${pos}`}
                  className="rounded-lg border border-white/10 bg-white/5 p-3 text-center hover:bg-white/[0.08] transition-colors"
                >
                  <span className="text-sm font-medium text-white">{pos}</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* SEO content block */}
        <section className="mt-10 border-t border-white/8 pt-8">
          <h2 className="text-lg font-bold mb-3">
            How {label} Injuries Affect Player Performance
          </h2>
          <div className="text-sm text-white/50 leading-relaxed space-y-3">
            <p>
              Understanding how {label} players perform after returning from injury is critical for
              fantasy {sport} managers, sports bettors, and team analysts. Our analysis tracks the
              performance trajectory of {label} players in their first 10 games back from injury,
              comparing post-return stats against their pre-injury baseline.
            </p>
            <p>
              The data shows that most {label} players experience a measurable performance dip in their
              first game back, with gradual improvement over the following games. The severity and duration
              of this dip varies significantly by injury type — soft tissue injuries like hamstrings and
              calves typically show faster recovery curves than structural injuries like ACL tears or
              fractures.
            </p>
            <p>
              Each performance curve is computed from historical game log data sourced from official
              statistical databases. We compare each player's post-return composite score (a weighted
              combination of key stats) against their 5-game pre-injury average to calculate the
              percentage of baseline performance achieved in each game after return.
            </p>
          </div>
        </section>

        {/* Related links */}
        <section className="mt-8 border-t border-white/8 pt-6">
          <h2 className="text-sm font-bold uppercase tracking-wide text-white/40 mb-3">
            Related Injury Analysis
          </h2>
          <div className="grid gap-2 sm:grid-cols-2">
            <Link to={`/${leagueSlug}-injuries`} className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              {label} Injury Report — Current Injuries
            </Link>
            <Link to="/performance-curves" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              All Leagues — Performance Curves
            </Link>
            <Link to="/recovery-stats" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              Recovery Statistics — All Leagues
            </Link>
            {Object.entries(LEAGUE_FULL)
              .filter(([s]) => s !== leagueSlug)
              .map(([s, l]) => (
                <Link key={s} to={`/${s}-injury-performance`} className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
                  {l} Injury Performance
                </Link>
              ))}
          </div>
        </section>
      </div>
    </div>
  );
}
