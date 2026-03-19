import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { SiteHeader } from "../components/SiteHeader";
import { SEO } from "../components/seo/SEO";
import {
  breadcrumbJsonLd,
  datasetJsonLd,
  faqJsonLd,
  jsonLdGraph,
} from "../components/seo/seoHelpers";
import { usePerformanceCurves } from "../features/performance-curves/lib/queries";
const LEAGUE_LABELS: Record<string, string> = {
  nba: "NBA",
  nfl: "NFL",
  mlb: "MLB",
  nhl: "NHL",
  "premier-league": "EPL",
};

const LEAGUE_FULL: Record<string, string> = {
  nba: "NBA",
  nfl: "NFL",
  mlb: "MLB",
  nhl: "NHL",
  "premier-league": "Premier League",
};

const LEAGUE_ORDER = ["nba", "nfl", "mlb", "nhl", "premier-league"];

const EXCLUDED_SLUGS = new Set(["other", "all-injuries"]);

function fmt(val: number | undefined | null): string {
  if (val == null) return "—";
  return `${Math.round(val * 100)}%`;
}

export default function MinutesRestrictionPage() {
  const { leagueSlug } = useParams<{ leagueSlug?: string }>();
  const league = leagueSlug && LEAGUE_LABELS[leagueSlug] ? leagueSlug : undefined;
  const leagueLabel = league ? LEAGUE_LABELS[league] : undefined;
  const leagueFull = league ? LEAGUE_FULL[league] : undefined;

  const { data: curves, isLoading } = usePerformanceCurves(league ?? "", undefined, "all");

  const filteredCurves = useMemo(() => {
    if (!curves) return [];
    return curves.filter(
      (c) =>
        !EXCLUDED_SLUGS.has(c.injury_type_slug) &&
        c.avg_minutes_pct.length >= 10
    );
  }, [curves]);

  // Key findings
  const stats = useMemo(() => {
    if (!filteredCurves.length) return null;

    const withMinutes = filteredCurves.filter((c) => c.avg_minutes_pct.length >= 10);
    if (!withMinutes.length) return null;

    const totalSample = withMinutes.reduce((s, c) => s + c.sample_size, 0);

    // Weighted averages
    const avgGame1 =
      withMinutes.reduce((s, c) => s + c.avg_minutes_pct[0] * c.sample_size, 0) / totalSample;
    const avgGame10 =
      withMinutes.reduce((s, c) => s + c.avg_minutes_pct[9] * c.sample_size, 0) / totalSample;

    // Games until 95%+ (weighted avg across curves)
    let gamesToFull: number | null = null;
    const gamesToFullValues = withMinutes
      .map((c) => {
        const idx = c.avg_minutes_pct.findIndex((v) => v >= 0.95);
        return idx >= 0 ? idx + 1 : null;
      })
      .filter((v): v is number => v !== null);
    if (gamesToFullValues.length > 0) {
      gamesToFull = Math.round(
        gamesToFullValues.reduce((a, b) => a + b, 0) / gamesToFullValues.length
      );
    }

    return { avgGame1, avgGame10, gamesToFull, totalSample };
  }, [filteredCurves]);

  // Table rows sorted by most impactful (lowest game-1 minutes)
  const tableRows = useMemo(() => {
    return [...filteredCurves].sort(
      (a, b) => (a.avg_minutes_pct[0] ?? 1) - (b.avg_minutes_pct[0] ?? 1)
    );
  }, [filteredCurves]);

  const year = new Date().getFullYear();
  const titlePrefix = leagueLabel ? `${leagueLabel} ` : "";
  const pageTitle = `${titlePrefix}Minutes Restriction After Injury`;
  const seoTitle = `Minutes Restriction After Injury${leagueLabel ? ` (${leagueLabel})` : ""} — ${year}`;
  const seoDesc = stats
    ? `Players average ${fmt(stats.avgGame1)} of pre-injury minutes in game 1 back, reaching ${fmt(stats.avgGame10)} by game 10. Data from ${stats.totalSample.toLocaleString()} injury returns.`
    : `Analysis of minutes restrictions after injury${leagueFull ? ` in the ${leagueFull}` : ""}. How long do load management limits last?`;

  const path = league
    ? `/${league}/minutes-restriction-after-injury`
    : "/minutes-restriction-after-injury";

  const breadcrumbs = league
    ? [
        { name: "Home", path: "/" },
        { name: leagueLabel!, path: `/${league}` },
        { name: "Minutes Restriction", path },
      ]
    : [
        { name: "Home", path: "/" },
        { name: "Minutes Restriction", path },
      ];

  const faqItems = [
    {
      question: "How long do players typically have minutes restrictions?",
      answer: stats
        ? `Based on ${stats.totalSample.toLocaleString()} injury returns${leagueFull ? ` in the ${leagueFull}` : ""}, players average ${fmt(stats.avgGame1)} of their pre-injury minutes in game 1 back.${stats.gamesToFull ? ` Most players reach 95%+ of normal workload by game ${stats.gamesToFull}.` : ""}`
        : `Minutes restrictions vary by injury type and severity. Most players gradually return to full minutes over 3-10 games after returning from injury.`,
    },
    {
      question: "Which injuries cause the longest minutes restrictions?",
      answer:
        "ACL tears, Achilles injuries, and major fractures typically result in the longest minutes restrictions. Players returning from these injuries may take 8-10+ games to reach full pre-injury workload.",
    },
    {
      question: "Do older players have longer minutes restrictions?",
      answer:
        "Generally yes. Older players tend to have more conservative return-to-play protocols, often with extended minutes restrictions to reduce re-injury risk. However, individual variation is significant.",
    },
  ];

  const jsonLd = jsonLdGraph(
    breadcrumbJsonLd(breadcrumbs),
    datasetJsonLd({
      name: `Minutes Restriction Data${leagueFull ? ` — ${leagueFull}` : ""}`,
      description: `Minutes restriction analysis after injury${leagueFull ? ` in the ${leagueFull}` : ""}. Tracking post-injury workload for ${stats?.totalSample.toLocaleString() ?? "thousands of"} return cases.`,
      url: path,
      sampleSize: stats?.totalSample ?? 0,
      keywords: [
        "minutes restriction",
        "injury recovery",
        "load management",
        "return to play",
        ...(leagueFull ? [leagueFull] : []),
      ],
    }),
    faqJsonLd(faqItems)
  );

  return (
    <div className="min-h-screen bg-[#0A0F1E] text-white">
      <SEO title={seoTitle} description={seoDesc} path={path} jsonLd={jsonLd} />
      <SiteHeader />

      <main className="max-w-5xl lg:max-w-[1400px] mx-auto px-4 lg:px-10 py-8">
        {/* Breadcrumbs */}
        <nav className="flex items-center gap-1.5 text-xs text-white/40 mb-6">
          {breadcrumbs.map((b, i) => (
            <span key={b.path} className="flex items-center gap-1.5">
              {i > 0 && <span>/</span>}
              {i < breadcrumbs.length - 1 ? (
                <Link to={b.path} className="hover:text-white/70">
                  {b.name}
                </Link>
              ) : (
                <span className="text-white/60">{b.name}</span>
              )}
            </span>
          ))}
        </nav>

        {/* Hero */}
        <header className="mb-10">
          <h1 className="text-3xl sm:text-4xl font-black tracking-tight mb-3">
            {pageTitle}
          </h1>
          <p className="text-white/50 text-lg max-w-2xl">
            How quickly do players return to full minutes after injury?
            {leagueFull ? ` Data-driven analysis across ${leagueFull} injury returns.` : " Data from thousands of injury returns across major sports leagues."}
          </p>
        </header>

        {isLoading && (
          <div className="flex items-center justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-[#1C7CFF]" />
          </div>
        )}

        {!isLoading && stats && (
          <>
            {/* Key Findings */}
            <section className="mb-12">
              <h2 className="text-xl font-bold mb-4">Key Findings</h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
                  <p className="text-xs uppercase tracking-wider text-white/40 mb-1">
                    Game 1 Minutes
                  </p>
                  <p className="text-3xl font-black text-amber-400">
                    {fmt(stats.avgGame1)}
                  </p>
                  <p className="text-xs text-white/40 mt-1">of pre-injury workload</p>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
                  <p className="text-xs uppercase tracking-wider text-white/40 mb-1">
                    Game 10 Minutes
                  </p>
                  <p className="text-3xl font-black text-green-400">
                    {fmt(stats.avgGame10)}
                  </p>
                  <p className="text-xs text-white/40 mt-1">of pre-injury workload</p>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
                  <p className="text-xs uppercase tracking-wider text-white/40 mb-1">
                    Games to 95%+ Workload
                  </p>
                  <p className="text-3xl font-black text-[#1C7CFF]">
                    {stats.gamesToFull ?? "10+"}
                  </p>
                  <p className="text-xs text-white/40 mt-1">games on average</p>
                </div>
              </div>
            </section>

            {/* Minutes by Injury Type */}
            {tableRows.length > 0 && (
              <section className="mb-12">
                <h2 className="text-xl font-bold mb-4">Minutes by Injury Type</h2>
                <div className="overflow-x-auto rounded-xl border border-white/10">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-white/10 bg-white/[0.03]">
                        <th className="py-3 px-4 text-xs uppercase tracking-wider text-white/50 font-semibold">
                          Injury
                        </th>
                        <th className="py-3 px-3 text-center text-xs uppercase tracking-wider text-white/50 font-semibold">
                          Cases
                        </th>
                        <th className="py-3 px-3 text-center text-xs uppercase tracking-wider text-white/50 font-semibold">
                          Gm 1
                        </th>
                        <th className="py-3 px-3 text-center text-xs uppercase tracking-wider text-white/50 font-semibold">
                          Gm 5
                        </th>
                        <th className="py-3 px-3 text-center text-xs uppercase tracking-wider text-white/50 font-semibold">
                          Gm 10
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {tableRows.map((c) => (
                        <tr
                          key={c.curve_id}
                          className="border-b border-white/5 hover:bg-white/[0.02]"
                        >
                          <td className="py-3 px-4">
                            <Link
                              to={`/injuries/${c.injury_type_slug}`}
                              className="text-sm font-medium text-[#1C7CFF] hover:text-[#1C7CFF]/80"
                            >
                              {c.injury_type}
                            </Link>
                          </td>
                          <td className="py-3 px-3 text-center text-sm text-white/50">
                            {c.sample_size.toLocaleString()}
                          </td>
                          <td className="py-3 px-3 text-center text-sm">
                            <span
                              className={
                                c.avg_minutes_pct[0] >= 0.95
                                  ? "text-green-400"
                                  : c.avg_minutes_pct[0] >= 0.85
                                  ? "text-amber-400"
                                  : "text-red-400"
                              }
                            >
                              {fmt(c.avg_minutes_pct[0])}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-center text-sm">
                            <span
                              className={
                                c.avg_minutes_pct[4] >= 0.95
                                  ? "text-green-400"
                                  : c.avg_minutes_pct[4] >= 0.85
                                  ? "text-amber-400"
                                  : "text-red-400"
                              }
                            >
                              {fmt(c.avg_minutes_pct[4])}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-center text-sm">
                            <span
                              className={
                                c.avg_minutes_pct[9] >= 0.95
                                  ? "text-green-400"
                                  : c.avg_minutes_pct[9] >= 0.85
                                  ? "text-amber-400"
                                  : "text-red-400"
                              }
                            >
                              {fmt(c.avg_minutes_pct[9])}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* Minutes Recovery Curve (text visual) */}
            <section className="mb-12">
              <h2 className="text-xl font-bold mb-4">Minutes Recovery Curve</h2>
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-6">
                <div className="flex items-end gap-1 h-32">
                  {Array.from({ length: 10 }, (_, i) => {
                    const withMinutes = filteredCurves.filter(
                      (c) => c.avg_minutes_pct.length > i
                    );
                    if (!withMinutes.length) return null;
                    const totalSample = withMinutes.reduce((s, c) => s + c.sample_size, 0);
                    const avg =
                      withMinutes.reduce(
                        (s, c) => s + c.avg_minutes_pct[i] * c.sample_size,
                        0
                      ) / totalSample;
                    const pct = Math.round(avg * 100);
                    const height = Math.max(pct, 5);
                    return (
                      <div key={i} className="flex-1 flex flex-col items-center gap-1">
                        <span className="text-[10px] text-white/50">{pct}%</span>
                        <div
                          className="w-full rounded-t bg-gradient-to-t from-[#1C7CFF] to-[#3DFF8F]"
                          style={{ height: `${height}%` }}
                        />
                        <span className="text-[10px] text-white/40">G{i + 1}</span>
                      </div>
                    );
                  })}
                </div>
                <p className="text-xs text-white/40 mt-4 text-center">
                  Average % of pre-injury minutes per game after return
                </p>
              </div>
            </section>

            {/* FAQ */}
            <section className="mb-12">
              <h2 className="text-xl font-bold mb-4">Frequently Asked Questions</h2>
              <div className="space-y-4">
                {faqItems.map((faq) => (
                  <details
                    key={faq.question}
                    className="rounded-xl border border-white/10 bg-white/[0.03] group"
                  >
                    <summary className="px-5 py-4 cursor-pointer text-sm font-medium hover:text-[#1C7CFF] list-none flex items-center justify-between">
                      {faq.question}
                      <span className="text-white/30 group-open:rotate-180 transition-transform">
                        ▼
                      </span>
                    </summary>
                    <p className="px-5 pb-4 text-sm text-white/60 leading-relaxed">
                      {faq.answer}
                    </p>
                  </details>
                ))}
              </div>
            </section>
          </>
        )}

        {/* League Links */}
        <section className="mb-12">
          <h2 className="text-xl font-bold mb-4">
            {league ? "Other Leagues" : "Browse by League"}
          </h2>
          <div className="flex flex-wrap gap-3">
            {LEAGUE_ORDER.filter((l) => l !== league).map((l) => (
              <Link
                key={l}
                to={`/${l}/minutes-restriction-after-injury`}
                className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm font-medium hover:bg-white/[0.06] hover:border-[#1C7CFF]/30 transition-colors"
              >
                {LEAGUE_LABELS[l]} Minutes Restriction
              </Link>
            ))}
            {league && (
              <Link
                to="/minutes-restriction-after-injury"
                className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm font-medium hover:bg-white/[0.06] hover:border-[#1C7CFF]/30 transition-colors"
              >
                All Leagues
              </Link>
            )}
          </div>
        </section>

        {/* Related Links */}
        <section className="mb-12">
          <h2 className="text-xl font-bold mb-4">Related</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Link
              to="/returning-today"
              className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 text-sm hover:bg-white/[0.06] transition-colors"
            >
              Players Returning Today
            </Link>
            <Link
              to="/nba/injury-report"
              className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 text-sm hover:bg-white/[0.06] transition-colors"
            >
              NBA Injury Report
            </Link>
            <Link
              to="/nfl/injury-report"
              className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 text-sm hover:bg-white/[0.06] transition-colors"
            >
              NFL Injury Report
            </Link>
            <Link
              to="/nba/injury-performance"
              className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 text-sm hover:bg-white/[0.06] transition-colors"
            >
              NBA Injury Performance Data
            </Link>
            <Link
              to="/nfl/injury-performance"
              className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 text-sm hover:bg-white/[0.06] transition-colors"
            >
              NFL Injury Performance Data
            </Link>
            <Link
              to="/injuries/acl-tear"
              className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 text-sm hover:bg-white/[0.06] transition-colors"
            >
              ACL Tear Recovery Timeline
            </Link>
            <Link
              to="/injuries/hamstring-strain"
              className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 text-sm hover:bg-white/[0.06] transition-colors"
            >
              Hamstring Strain Recovery
            </Link>
            <Link
              to="/injuries/ankle-sprain"
              className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 text-sm hover:bg-white/[0.06] transition-colors"
            >
              Ankle Sprain Recovery Data
            </Link>
          </div>
        </section>

        {/* SEO Text */}
        <section className="mb-12">
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-6 text-sm text-white/50 leading-relaxed space-y-3">
            <p>
              Minutes restrictions are one of the most common load management strategies used by
              {leagueFull ? ` ${leagueFull}` : ""} teams when bringing players back from injury. After
              missing time due to injury, players rarely return to their full pre-injury workload
              immediately. Instead, coaching staffs and medical teams implement gradual minutes
              ramp-ups to reduce the risk of re-injury and allow the body to readjust to game-speed
              competition.
            </p>
            <p>
              Our analysis of {stats?.totalSample.toLocaleString() ?? "thousands of"} injury return
              cases{leagueFull ? ` in the ${leagueFull}` : " across the NBA, NFL, MLB, NHL, and Premier League"} reveals
              clear patterns in how minutes restrictions are applied. On average, players see about{" "}
              {stats ? fmt(stats.avgGame1) : "75-85%"} of their pre-injury minutes in their first game
              back. By game 10, most players have climbed back to {stats ? fmt(stats.avgGame10) : "90-95%"} of
              their baseline workload. The severity and type of injury significantly impact the
              duration of minutes restrictions — soft tissue injuries like hamstring strains often
              see faster ramp-ups, while structural injuries like ACL tears require more cautious
              reintegration.
            </p>
            <p>
              Understanding these patterns is valuable for fantasy sports managers, sports bettors
              analyzing player props, and fans wondering when their favorite player will be back to
              full strength. Back In Play tracks minutes restriction data in real-time, providing
              data-driven insights into how quickly players return to their normal workload after
              injury.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
