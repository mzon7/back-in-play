import { useParams, Link } from "react-router-dom";
import { SiteHeader } from "../../components/SiteHeader";
import { SEO } from "../../components/seo/SEO";
import {
  breadcrumbJsonLd,
  datasetJsonLd,
  jsonLdGraph,
} from "../../components/seo/seoHelpers";
import { usePerformanceCurves } from "../../features/performance-curves/lib/queries";
import { useRecoveryStats } from "../../features/historical-injury-data-system/lib/queries";

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

const SEO_BLURBS: Record<string, string> = {
  nba: `The NBA season demands elite athleticism across 82 regular-season games, making injury management a critical factor in team success. NBA injuries range from acute traumatic events like ACL tears and ankle sprains to chronic overuse conditions such as patellar tendinopathy and plantar fasciitis. Our NBA injury analysis tracks how players recover from each injury type, measuring statistical output in their first 10 games back against pre-injury baselines. The fast-paced, high-impact nature of basketball means that lower-body injuries — particularly knee and ankle injuries — tend to have the longest recovery curves. Guards and wings who rely on explosiveness often show steeper initial performance drops compared to centers. Fantasy basketball managers and sports bettors can use this data to make informed decisions about when a returning player will regain full productivity. We also track minutes restrictions, which are commonly applied in the NBA's load-management era, and analyze how restricted minutes correlate with per-minute efficiency. Whether you're evaluating a trade target coming off injury or setting your daily fantasy lineup, our NBA injury analytics provide the evidence-based insights you need.`,
  nfl: `NFL injuries carry enormous stakes given the sport's 17-game regular season — each missed game represents roughly 6% of a player's season. Football's violent collisions produce a unique injury profile heavy on concussions, soft-tissue tears, and joint damage. Our NFL injury analysis examines return-to-play timelines and post-injury performance across all position groups. Skill position players like wide receivers and running backs face different recovery challenges than linemen, and our data reflects these positional differences. ACL tears remain among the most impactful NFL injuries, often requiring 9-12 months of rehabilitation and frequently resulting in measurable performance declines in the first season back. Hamstring and ankle injuries, while shorter in duration, can linger and cause re-aggravation. We track historical recovery data to show not just when players return, but how they perform upon return. This analysis is invaluable for fantasy football draft strategy, in-season waiver decisions, and prop betting markets. Our NFL dataset includes severity tiers, games-missed distributions, and game-by-game performance curves so you can project a returning player's output with confidence.`,
  mlb: `Baseball's 162-game season creates a unique injury landscape where pitcher arm injuries and positional player soft-tissue strains dominate the injury report. Our MLB injury analysis tracks Tommy John surgery recovery timelines, rotator cuff strain impacts, oblique injuries that plague hitters, and hamstring strains common among base-runners. Pitchers face the most scrutinized return-to-play process in professional sports — velocity tracking, pitch count limits, and minor league rehab assignments all factor into readiness. Our data captures how pitchers perform statistically after returning from IL stints, measuring ERA, strikeout rates, and velocity against pre-injury levels. For position players, we analyze batting average, power metrics, and stolen base rates in the games following their return. The MLB's injured list structure (10-day, 15-day, 60-day) provides natural severity tiers that our analysis leverages. Fantasy baseball managers can use our recovery curves to time pickups from the waiver wire and project production for returning players throughout the long season.`,
  nhl: `Hockey's physical nature produces a wide spectrum of injuries from high-speed collisions, blocked shots, and the grueling 82-game schedule. Our NHL injury analysis covers upper-body and lower-body injuries (the NHL's traditional reporting categories), concussions, and the hand and wrist injuries common to the sport. NHL players often play through injuries that would sideline athletes in other sports, making the distinction between "day-to-day" and "injured reserve" particularly meaningful. Our data tracks how skaters and goalies perform in their first games back, measuring key metrics like points, shots on goal, save percentage, and ice time against pre-injury baselines. Concussion recovery in hockey receives special attention given the sport's history and evolving protocols. We analyze how long players miss after concussions and whether repeated concussions correlate with longer recovery windows. For fantasy hockey managers and bettors, understanding post-injury production curves helps identify buy-low opportunities and avoid premature roster activations.`,
  "premier-league": `The Premier League's congested fixture schedule — with league, cup, and European competitions — creates significant injury risk for footballers. Our Premier League injury analysis tracks hamstring strains, ACL tears, ankle ligament damage, and the muscle injuries that dominate the sport. Football demands explosive sprinting, rapid deceleration, and constant directional changes, making lower-limb soft-tissue injuries the most common category. Our data shows how players perform in matches after returning from injury, measuring minutes played, goals, assists, and key passes against pre-injury form. The Premier League's lack of a formal injured list means our analysis relies on match availability data and official club communications. We track how managers handle returning players — often through substitute appearances before full starts — and how this graduated return affects statistical output. For Fantasy Premier League (FPL) managers and football bettors, our recovery data helps answer the crucial question: when will a returning player regain match fitness and full productivity? Understanding typical recovery curves by injury type gives you an edge in transfers and captain selection.`,
};

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export default function LeagueInjuryAnalysisPage() {
  const { slug } = useParams<{ slug: string }>();
  const leagueSlug = slug?.replace("-injury-analysis", "") ?? "";
  const label = LEAGUE_FULL[leagueSlug] ?? leagueSlug.toUpperCase();
  const sport = LEAGUE_SPORT[leagueSlug] ?? "sports";
  const year = new Date().getFullYear();

  const { data: curves = [], isLoading: curvesLoading } = usePerformanceCurves(leagueSlug, undefined, "all");
  const { data: recoveryStats = [], isLoading: statsLoading } = useRecoveryStats(leagueSlug);

  const isLoading = curvesLoading || statsLoading;

  // All-positions curves, exclude "other"
  const allPosCurves = curves.filter((c) => !c.position && c.injury_type_slug !== "other" && c.injury_type_slug !== "unknown");
  const totalCases = allPosCurves.reduce((sum, c) => sum + c.sample_size, 0);
  const totalInjuryTypes = allPosCurves.length;

  // Average recovery days across recovery stats
  const avgRecoveryDays =
    recoveryStats.length > 0
      ? Math.round(
          recoveryStats.reduce((sum, s) => sum + (s.median_recovery_days ?? 0), 0) /
            recoveryStats.filter((s) => s.median_recovery_days != null).length
        )
      : null;

  // Top 3 most impactful injuries (lowest game-10 median = biggest performance hit)
  const mostImpactful = [...allPosCurves]
    .filter((c) => c.median_pct_recent[9] != null)
    .sort((a, b) => (a.median_pct_recent[9] ?? 1) - (b.median_pct_recent[9] ?? 1))
    .slice(0, 3);

  // Severity tier summary from recovery stats
  const severityTiers: Record<string, { count: number; avgDays: number }> = {};
  for (const s of recoveryStats) {
    const days = s.median_recovery_days ?? 0;
    const tier = days >= 90 ? "Critical" : days >= 30 ? "Major" : days >= 14 ? "Moderate" : "Minor";
    if (!severityTiers[tier]) severityTiers[tier] = { count: 0, avgDays: 0 };
    severityTiers[tier].count++;
    severityTiers[tier].avgDays += days;
  }
  for (const tier of Object.values(severityTiers)) {
    tier.avgDays = Math.round(tier.avgDays / tier.count);
  }

  const seoTitle = `${label} Injury Analysis - Recovery & Performance (${year})`;
  const seoDesc = `Comprehensive ${label} injury analysis: recovery timelines, performance after injury, minutes restrictions, and return-to-play data. ${totalCases.toLocaleString()} cases analyzed.`;

  const jsonLd = jsonLdGraph(
    breadcrumbJsonLd([
      { name: "Home", path: "/" },
      { name: `${label} Injuries`, path: `/${leagueSlug}-injuries` },
      { name: "Injury Analysis", path: `/${leagueSlug}-injury-analysis` },
    ]),
    datasetJsonLd({
      name: `${label} Injury Analysis Dataset`,
      description: `Comprehensive injury analysis data for ${label}: ${totalCases} historical cases across ${totalInjuryTypes} injury types with recovery timelines and performance impact.`,
      url: `/${leagueSlug}-injury-analysis`,
      sampleSize: totalCases,
      keywords: [
        `${label} injury analysis`,
        `${label} injury recovery`,
        `${sport} injury data`,
        `${label} return to play`,
        `${label} injury statistics`,
      ],
    })
  );

  return (
    <div className="min-h-screen bg-[#0A0F1E] text-white">
      <SEO title={seoTitle} description={seoDesc} path={`/${leagueSlug}-injury-analysis`} jsonLd={jsonLd} />
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
            <span className="text-white/60">Injury Analysis</span>
          </nav>

          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-3">
            {label} Injury Analysis Hub ({year})
          </h1>
          <p className="text-white/50 text-sm max-w-2xl">
            {isLoading
              ? "Loading..."
              : `Comprehensive ${label} injury analytics covering ${totalInjuryTypes} injury types, ${totalCases.toLocaleString()} historical cases, and real-time return-to-play tracking.`}
          </p>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-10">
        {/* Quick Stats Row */}
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Injury Types", value: totalInjuryTypes },
            { label: "Total Cases", value: totalCases.toLocaleString() },
            { label: "Avg Recovery", value: avgRecoveryDays != null ? `${avgRecoveryDays}d` : "—" },
            { label: "Severity Tiers", value: Object.keys(severityTiers).length },
          ].map((stat) => (
            <div
              key={stat.label}
              className="rounded-xl border border-white/10 bg-white/5 p-4 text-center"
            >
              <div className="text-2xl font-bold text-[#1C7CFF]">
                {isLoading ? "—" : stat.value}
              </div>
              <div className="text-xs text-white/40 mt-1">{stat.label}</div>
            </div>
          ))}
        </section>

        {/* Injury Type Analysis */}
        <section>
          <h2 className="text-xl font-bold mb-2">Injury Type Analysis</h2>
          <p className="text-sm text-white/40 mb-4">
            Explore detailed recovery data for each {label} injury type.
          </p>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-16 rounded bg-white/10 animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {[...allPosCurves]
                .sort((a, b) => b.sample_size - a.sample_size)
                .map((curve) => (
                  <Link
                    key={curve.curve_id}
                    to={`/injuries/${slugify(curve.injury_type)}`}
                    className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 p-3 hover:bg-white/[0.08] transition-colors"
                  >
                    <span className="text-sm font-medium text-[#1C7CFF]">
                      {curve.injury_type}
                    </span>
                    <span className="flex gap-3 text-xs text-white/40">
                      <span>{curve.sample_size} cases</span>
                      <span>
                        {curve.recovery_days_avg != null
                          ? `${Math.round(curve.recovery_days_avg)}d avg`
                          : ""}
                      </span>
                    </span>
                  </Link>
                ))}
            </div>
          )}
        </section>

        {/* Performance After Injury */}
        <section>
          <h2 className="text-xl font-bold mb-2">Performance After Injury</h2>
          <p className="text-sm text-white/40 mb-3">
            How {label} players perform in their first 10 games back from injury.
          </p>
          {mostImpactful.length > 0 && (
            <div className="space-y-2 mb-4">
              <p className="text-xs text-white/30 uppercase tracking-wide">Most impactful injuries</p>
              {mostImpactful.map((c) => (
                <div
                  key={c.curve_id}
                  className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 p-3 text-sm"
                >
                  <span className="text-white/70">{c.injury_type}</span>
                  <span className="text-amber-400">
                    {Math.round((c.median_pct_recent[9] ?? 0) * 100)}% by game 10
                  </span>
                </div>
              ))}
            </div>
          )}
          <Link
            to={`/${leagueSlug}-injury-performance`}
            className="inline-block text-sm text-[#1C7CFF] hover:text-[#1C7CFF]/80 font-medium"
          >
            View full {label} performance curves &rarr;
          </Link>
        </section>

        {/* Recovery Statistics */}
        <section>
          <h2 className="text-xl font-bold mb-2">Recovery Statistics</h2>
          <p className="text-sm text-white/40 mb-3">
            Median recovery timelines by severity tier for {label} injuries.
          </p>
          {Object.keys(severityTiers).length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
              {Object.entries(severityTiers)
                .sort((a, b) => b[1].avgDays - a[1].avgDays)
                .map(([tier, data]) => (
                  <div
                    key={tier}
                    className="rounded-lg border border-white/10 bg-white/5 p-3 text-center"
                  >
                    <div className="text-xs text-white/40 mb-1">{tier}</div>
                    <div className="text-lg font-bold text-white/80">{data.avgDays}d</div>
                    <div className="text-xs text-white/30">{data.count} types</div>
                  </div>
                ))}
            </div>
          )}
          <Link
            to="/recovery-stats"
            className="inline-block text-sm text-[#1C7CFF] hover:text-[#1C7CFF]/80 font-medium"
          >
            View all recovery statistics &rarr;
          </Link>
        </section>

        {/* Players Returning */}
        <section>
          <h2 className="text-xl font-bold mb-2">Players Returning Today</h2>
          <p className="text-sm text-white/40 mb-3">
            See which {label} players are expected to return from injury today based on recovery timelines.
          </p>
          <Link
            to={`/${leagueSlug}/returning-today`}
            className="inline-block text-sm text-[#1C7CFF] hover:text-[#1C7CFF]/80 font-medium"
          >
            View {label} players returning today &rarr;
          </Link>
        </section>

        {/* Minutes Restriction Analysis */}
        <section>
          <h2 className="text-xl font-bold mb-2">Minutes Restriction Analysis</h2>
          <p className="text-sm text-white/40 mb-3">
            Analyze how {label} players are managed on minutes restrictions after returning from injury and
            how it affects their per-minute production.
          </p>
          <Link
            to={`/${leagueSlug}/minutes-restriction-after-injury`}
            className="inline-block text-sm text-[#1C7CFF] hover:text-[#1C7CFF]/80 font-medium"
          >
            View {label} minutes restriction data &rarr;
          </Link>
        </section>

        {/* Related Leagues */}
        <section>
          <h2 className="text-sm font-bold uppercase tracking-wide text-white/40 mb-3">
            Other League Analysis
          </h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {Object.entries(LEAGUE_FULL)
              .filter(([s]) => s !== leagueSlug)
              .map(([s, l]) => (
                <Link
                  key={s}
                  to={`/${s}-injury-analysis`}
                  className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors"
                >
                  {l} Injury Analysis Hub
                </Link>
              ))}
          </div>
        </section>

        {/* SEO Text Block */}
        <section className="border-t border-white/8 pt-8">
          <h2 className="text-lg font-bold mb-3">
            {label} Injury Analytics — What Makes It Unique
          </h2>
          <div className="text-sm text-white/50 leading-relaxed space-y-3">
            {(SEO_BLURBS[leagueSlug] ?? SEO_BLURBS.nba).split(". ").reduce<string[][]>(
              (acc, sentence, i) => {
                const pIdx = Math.floor(i / 4);
                if (!acc[pIdx]) acc[pIdx] = [];
                acc[pIdx].push(sentence);
                return acc;
              },
              []
            ).map((group, i) => (
              <p key={i}>{group.join(". ")}{group[group.length - 1]?.endsWith(".") ? "" : "."}</p>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
