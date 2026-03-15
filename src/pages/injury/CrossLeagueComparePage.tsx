import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { SiteHeader } from "../../components/SiteHeader";
import { SEO } from "../../components/seo/SEO";
import { breadcrumbJsonLd, jsonLdGraph } from "../../components/seo/seoHelpers";
import { useRecoveryStats } from "../../features/historical-injury-data-system/lib/queries";
import { usePerformanceCurves } from "../../features/performance-curves/lib/queries";
import type { RecoveryStat } from "../../features/historical-injury-data-system/lib/types";
import type { PerformanceCurve } from "../../features/performance-curves/lib/types";

const LEAGUE_ORDER = ["nba", "nfl", "mlb", "nhl", "premier-league"] as const;
const LEAGUE_LABELS: Record<string, string> = {
  nba: "NBA", nfl: "NFL", mlb: "MLB", nhl: "NHL", "premier-league": "EPL",
};

function slugToTitle(slug: string) {
  return slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

interface LeagueRow {
  league: string;
  leagueSlug: string;
  sampleSize: number;
  medianDays: number | null;
  avgGamesMissed: number | null;
  g10Pct: number | null;
}

export default function CrossLeagueComparePage() {
  const { injurySlug } = useParams<{ injurySlug: string }>();
  const { data: allStats, isLoading: statsLoading } = useRecoveryStats();
  const { data: allCurves, isLoading: curvesLoading } = usePerformanceCurves(undefined, injurySlug);

  const injuryName = useMemo(() => {
    if (!allStats) return slugToTitle(injurySlug ?? "");
    const match = allStats.find(s => s.injury_type_slug === injurySlug);
    return match?.injury_type ?? slugToTitle(injurySlug ?? "");
  }, [allStats, injurySlug]);

  const rows = useMemo<LeagueRow[]>(() => {
    if (!allStats) return [];
    const statsByLeague = new Map<string, RecoveryStat>();
    for (const s of allStats) {
      if (s.injury_type_slug === injurySlug) statsByLeague.set(s.league_slug, s);
    }
    const curvesByLeague = new Map<string, PerformanceCurve>();
    if (allCurves) {
      for (const c of allCurves) {
        if (c.injury_type_slug === injurySlug && c.position === "") curvesByLeague.set(c.league_slug, c);
      }
    }
    return LEAGUE_ORDER
      .filter(slug => statsByLeague.has(slug))
      .map(slug => {
        const stat = statsByLeague.get(slug)!;
        const curve = curvesByLeague.get(slug);
        const g10 = curve?.median_pct_recent?.[9] ?? null;
        return {
          league: LEAGUE_LABELS[slug],
          leagueSlug: slug,
          sampleSize: stat.sample_size,
          medianDays: stat.median_recovery_days,
          avgGamesMissed: curve?.games_missed_avg ?? null,
          g10Pct: g10 != null ? Math.round(g10 * 100) : null,
        };
      });
  }, [allStats, allCurves, injurySlug]);

  const isLoading = statsLoading || curvesLoading;
  const path = `/injuries/${injurySlug}/compare`;
  const title = `${injuryName} Recovery: Cross-League Comparison`;
  const description = `Compare ${injuryName.toLowerCase()} recovery times across NBA, NFL, MLB, NHL, and EPL. Median recovery days, games missed, and post-return performance by league.`;

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white">
      <SiteHeader />
      <SEO
        title={title}
        description={description}
        path={path}
        jsonLd={jsonLdGraph(
          breadcrumbJsonLd([
            { name: "Home", path: "/" },
            { name: "Injuries", path: "/recovery-stats" },
            { name: injuryName, path: `/injuries/${injurySlug}` },
            { name: "Cross-League Compare", path },
          ]),
        )}
      />

      <main className="max-w-4xl mx-auto px-4 py-6">
        <nav className="text-xs text-white/50 mb-4 flex flex-wrap gap-1">
          <Link to="/" className="hover:text-white/80">Home</Link>
          <span>/</span>
          <Link to="/recovery-stats" className="hover:text-white/80">Injuries</Link>
          <span>/</span>
          <Link to={`/injuries/${injurySlug}`} className="hover:text-white/80">{injuryName}</Link>
          <span>/</span>
          <span className="text-white/70">Cross-League Compare</span>
        </nav>

        <h1 className="text-2xl sm:text-3xl font-bold mb-2">{injuryName}: Cross-League Comparison</h1>
        <p className="text-white/60 text-sm mb-6">
          How does a {injuryName.toLowerCase()} injury affect players across different leagues?
        </p>

        {isLoading ? (
          <div className="animate-pulse text-white/40 text-sm py-12 text-center">Loading comparison data...</div>
        ) : rows.length === 0 ? (
          <p className="text-white/50 py-12 text-center">No cross-league data available for this injury type.</p>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden sm:block overflow-x-auto mb-8">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-white/10 text-white/60 text-left">
                    <th className="py-3 pr-4">League</th>
                    <th className="py-3 pr-4 text-right">Sample Size</th>
                    <th className="py-3 pr-4 text-right">Median Recovery (days)</th>
                    <th className="py-3 pr-4 text-right">Avg Games Missed</th>
                    <th className="py-3 text-right">G10 Performance</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.leagueSlug} className="border-b border-white/5 hover:bg-white/5">
                      <td className="py-3 pr-4 font-medium">
                        <Link to={`/${r.leagueSlug}/recovery-stats`} className="text-blue-400 hover:text-blue-300">
                          {r.league}
                        </Link>
                      </td>
                      <td className="py-3 pr-4 text-right text-white/70">{r.sampleSize}</td>
                      <td className="py-3 pr-4 text-right font-mono">{r.medianDays != null ? Math.round(r.medianDays) : "—"}</td>
                      <td className="py-3 pr-4 text-right font-mono">{r.avgGamesMissed != null ? Math.round(r.avgGamesMissed) : "—"}</td>
                      <td className="py-3 text-right font-mono">
                        {r.g10Pct != null ? (
                          <span className={r.g10Pct >= 95 ? "text-green-400" : r.g10Pct >= 85 ? "text-yellow-400" : "text-red-400"}>
                            {r.g10Pct}%
                          </span>
                        ) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="sm:hidden space-y-3 mb-8">
              {rows.map(r => (
                <div key={r.leagueSlug} className="bg-white/5 rounded-lg p-4">
                  <Link to={`/${r.leagueSlug}/recovery-stats`} className="text-blue-400 font-semibold text-lg">
                    {r.league}
                  </Link>
                  <div className="grid grid-cols-2 gap-2 mt-3 text-sm">
                    <div>
                      <div className="text-white/50 text-xs">Sample Size</div>
                      <div className="font-mono">{r.sampleSize}</div>
                    </div>
                    <div>
                      <div className="text-white/50 text-xs">Median Recovery</div>
                      <div className="font-mono">{r.medianDays != null ? `${Math.round(r.medianDays)} days` : "—"}</div>
                    </div>
                    <div>
                      <div className="text-white/50 text-xs">Avg Games Missed</div>
                      <div className="font-mono">{r.avgGamesMissed != null ? Math.round(r.avgGamesMissed) : "—"}</div>
                    </div>
                    <div>
                      <div className="text-white/50 text-xs">G10 Performance</div>
                      <div className="font-mono">
                        {r.g10Pct != null ? (
                          <span className={r.g10Pct >= 95 ? "text-green-400" : r.g10Pct >= 85 ? "text-yellow-400" : "text-red-400"}>
                            {r.g10Pct}%
                          </span>
                        ) : "—"}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <h2 className="text-lg font-semibold mb-3">League-Specific Recovery Pages</h2>
            <ul className="space-y-2 text-sm">
              {rows.map(r => (
                <li key={r.leagueSlug}>
                  <Link to={`/${r.leagueSlug}/${injurySlug}-recovery`} className="text-blue-400 hover:text-blue-300">
                    {injuryName} Recovery in the {r.league}
                  </Link>
                </li>
              ))}
            </ul>

            <div className="mt-6 pt-4 border-t border-white/10">
              <Link to={`/injuries/${injurySlug}`} className="text-blue-400 hover:text-blue-300 text-sm">
                &larr; {injuryName} Overview
              </Link>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
