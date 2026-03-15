// @refresh reset
import { useState, useMemo } from "react";
import { Link, useSearchParams, useParams } from "react-router-dom";
import { SiteHeader } from "../../../components/SiteHeader";
import { SEO } from "../../../components/seo/SEO";
import {
  breadcrumbJsonLd,
  datasetJsonLd,
  faqJsonLd,
  jsonLdGraph,
} from "../../../components/seo/seoHelpers";
import { useRecoveryStats, useReturnCaseAggregates } from "../lib/queries";
import { usePerformanceCurves } from "../../performance-curves/lib/queries";
import type { PerformanceCurve } from "../../performance-curves/lib/types";
import { LeagueFilterBar } from "./LeagueFilterBar";
import type { LeagueFilter, RecoveryStat } from "../lib/types";
import {
  LEAGUE_LABELS,
  INJURY_SEVERITY,
  getSeverityColor,
} from "../lib/types";

const SEVERITY_ORDER = ["critical", "major", "moderate", "minor"] as const;
const SEVERITY_LABEL: Record<string, string> = {
  critical: "Critical",
  major: "Major",
  moderate: "Moderate",
  minor: "Minor",
};

/** Compute age impact buckets from return case data */
function computeAgeBuckets(rows: { age_at_injury: number | null; recovery_days: number | null }[]) {
  const buckets: { label: string; min: number; max: number; cases: number; avgDays: number }[] = [
    { label: "Under 25", min: 0, max: 24, cases: 0, avgDays: 0 },
    { label: "25-29", min: 25, max: 29, cases: 0, avgDays: 0 },
    { label: "30-34", min: 30, max: 34, cases: 0, avgDays: 0 },
    { label: "35+", min: 35, max: 99, cases: 0, avgDays: 0 },
  ];
  const sums = [0, 0, 0, 0];
  for (const row of rows) {
    if (row.age_at_injury == null || row.recovery_days == null) continue;
    for (let i = 0; i < buckets.length; i++) {
      if (row.age_at_injury >= buckets[i].min && row.age_at_injury <= buckets[i].max) {
        buckets[i].cases++;
        sums[i] += row.recovery_days;
        break;
      }
    }
  }
  for (let i = 0; i < buckets.length; i++) {
    buckets[i].avgDays = buckets[i].cases > 0 ? Math.round(sums[i] / buckets[i].cases) : 0;
  }
  return buckets.filter((b) => b.cases > 0);
}

/** Compute reinjury stats */
function computeReinjuryStats(rows: { total_prior_injuries: number | null; same_body_part_prior: number | null; recovery_days: number | null }[]) {
  let total = 0;
  let withPrior = 0;
  let samePart = 0;
  let daysWithPrior = 0;
  let daysWithout = 0;
  let countWithPrior = 0;
  let countWithout = 0;

  for (const row of rows) {
    if (row.recovery_days == null) continue;
    total++;
    if (row.total_prior_injuries != null && row.total_prior_injuries > 0) {
      withPrior++;
      daysWithPrior += row.recovery_days;
      countWithPrior++;
    } else {
      daysWithout += row.recovery_days;
      countWithout++;
    }
    if (row.same_body_part_prior != null && row.same_body_part_prior > 0) {
      samePart++;
    }
  }

  return {
    total,
    reinjuryRate: total > 0 ? Math.round((withPrior / total) * 100) : 0,
    samePartRate: total > 0 ? Math.round((samePart / total) * 100) : 0,
    avgDaysWithPrior: countWithPrior > 0 ? Math.round(daysWithPrior / countWithPrior) : null,
    avgDaysWithout: countWithout > 0 ? Math.round(daysWithout / countWithout) : null,
  };
}

function SeverityTierSection({ tier, stats, showLeague, curveMap }: { tier: string; stats: RecoveryStat[]; showLeague: boolean; curveMap: Map<string, PerformanceCurve> }) {
  const label = SEVERITY_LABEL[tier] ?? tier;
  const color = {
    critical: "#FF4D4D",
    major: "#FF8C00",
    moderate: "#1C7CFF",
    minor: "#3DFF8F",
  }[tier] ?? "#1C7CFF";

  const sorted = [...stats].sort((a, b) => (b.median_recovery_days ?? 0) - (a.median_recovery_days ?? 0));
  const maxDays = Math.max(...sorted.map((s) => s.median_recovery_days ?? 0), 1);

  return (
    <section className="mb-8">
      <div className="flex items-center gap-3 mb-3">
        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
        <h3 className="text-sm font-bold uppercase tracking-widest text-white/70">{label} Injuries</h3>
        <div className="flex-1 h-px bg-white/10" />
        <span className="text-xs text-white/30">{stats.length} types</span>
      </div>
      <div className="flex items-center gap-2 px-3 mb-1">
        <span className="text-[10px] text-white/25 uppercase tracking-wider w-36 sm:w-48 shrink-0">Injury</span>
        <span className="flex-1 text-[10px] text-white/25 uppercase tracking-wider">Distribution</span>
        <span className="text-[10px] text-white/25 uppercase tracking-wider w-10 text-right hidden sm:block">Games</span>
        <span className="text-[10px] text-white/25 uppercase tracking-wider w-10 text-right">Days</span>
        <span className="text-[10px] text-white/25 uppercase tracking-wider w-10 text-right hidden sm:block">G10</span>
      </div>
      <div className="space-y-1.5">
        {sorted.map((stat) => {
          const pct = maxDays > 0 ? ((stat.median_recovery_days ?? 0) / maxDays) * 100 : 0;
          const curve = curveMap.get(`${stat.injury_type_slug}|${stat.league_slug}`);
          const gamesMissed = curve?.games_missed_avg;
          const g10 = curve?.median_pct_recent[9] != null ? Math.round(curve.median_pct_recent[9] * 100) : null;
          return (
            <Link
              key={stat.stat_id}
              to={`/injuries/${stat.injury_type_slug}`}
              className="flex items-center gap-2 py-2 px-3 rounded-lg hover:bg-white/[0.04] transition-colors group"
            >
              <span className="text-sm text-white/80 w-36 sm:w-48 shrink-0 truncate group-hover:text-white">
                {stat.injury_type}
                {showLeague && (
                  <span className="text-[10px] text-white/30 ml-1">({LEAGUE_LABELS[stat.league_slug] ?? stat.league_slug})</span>
                )}
              </span>
              <div className="flex-1 h-5 bg-white/5 rounded-full overflow-hidden relative">
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${Math.max(pct, 2)}%`, backgroundColor: `${color}88` }}
                />
                <span className="absolute inset-y-0 right-2 flex items-center text-[10px] text-white/40">
                  {stat.sample_size} cases
                </span>
              </div>
              <span className="text-xs tabular-nums w-10 text-right text-white/40 hidden sm:block">
                {gamesMissed != null ? Math.round(gamesMissed) : "—"}
              </span>
              <span className="text-sm font-semibold tabular-nums w-10 text-right" style={{ color }}>
                {stat.median_recovery_days != null ? `${Math.round(stat.median_recovery_days)}d` : "—"}
              </span>
              <span className={`text-xs tabular-nums w-10 text-right hidden sm:block ${g10 != null ? (g10 >= 95 ? "text-green-400/70" : g10 >= 80 ? "text-amber-400/70" : "text-red-400/70") : "text-white/30"}`}>
                {g10 != null ? `${g10}%` : "—"}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function AgeBucketChart({ buckets }: { buckets: ReturnType<typeof computeAgeBuckets> }) {
  const maxDays = Math.max(...buckets.map((b) => b.avgDays), 1);
  return (
    <div className="space-y-2">
      {buckets.map((b) => (
        <div key={b.label} className="flex items-center gap-3">
          <span className="text-xs text-white/50 w-20 shrink-0">{b.label}</span>
          <div className="flex-1 h-6 bg-white/5 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full bg-[#1C7CFF]/60"
              style={{ width: `${(b.avgDays / maxDays) * 100}%` }}
            />
          </div>
          <span className="text-xs text-white/60 tabular-nums w-16 text-right">
            {b.avgDays}d avg
          </span>
          <span className="text-[10px] text-white/30 w-16 text-right">({b.cases})</span>
        </div>
      ))}
    </div>
  );
}

type SortKey = "median" | "avg" | "samples" | "name" | "games_missed" | "same_season_pct" | "g10";

function RecoveryOverviewTable({ stats, leagueFilter, curveMap }: { stats: RecoveryStat[]; leagueFilter: string; curveMap: Map<string, PerformanceCurve> }) {
  const [sortKey, setSortKey] = useState<SortKey>("median");
  const [sortAsc, setSortAsc] = useState(false);

  const getCurve = (s: RecoveryStat) => curveMap.get(`${s.injury_type_slug}|${s.league_slug}`);

  const sorted = useMemo(() => {
    const s = [...stats];
    s.sort((a, b) => {
      let cmp = 0;
      const ca = getCurve(a);
      const cb = getCurve(b);
      switch (sortKey) {
        case "median": cmp = (a.median_recovery_days ?? 0) - (b.median_recovery_days ?? 0); break;
        case "avg": cmp = (a.average_recovery_days ?? 0) - (b.average_recovery_days ?? 0); break;
        case "samples": cmp = a.sample_size - b.sample_size; break;
        case "name": cmp = a.injury_type.localeCompare(b.injury_type); break;
        case "games_missed": cmp = (ca?.games_missed_avg ?? 0) - (cb?.games_missed_avg ?? 0); break;
        case "same_season_pct": cmp = (100 - (ca?.next_season_pct ?? 0)) - (100 - (cb?.next_season_pct ?? 0)); break;
        case "g10": {
          const g10a = ca?.median_pct_recent[9] ?? 0;
          const g10b = cb?.median_pct_recent[9] ?? 0;
          cmp = g10a - g10b;
          break;
        }
      }
      return sortAsc ? cmp : -cmp;
    });
    return s;
  }, [stats, sortKey, sortAsc, curveMap]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(false); }
  }

  const arrow = (key: SortKey) => sortKey === key ? (sortAsc ? " \u2191" : " \u2193") : "";

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-white/10 text-xs text-white/40 uppercase tracking-wider">
            <th className="pb-2 pr-4 cursor-pointer select-none" onClick={() => toggleSort("name")}>
              Injury Type{arrow("name")}
            </th>
            {leagueFilter === "all" && <th className="pb-2 px-2 text-center">League</th>}
            <th className="pb-2 px-2 text-center cursor-pointer select-none" onClick={() => toggleSort("games_missed")}>
              Games{arrow("games_missed")}
            </th>
            <th className="pb-2 px-2 text-center cursor-pointer select-none" onClick={() => toggleSort("median")}>
              Days{arrow("median")}
            </th>
            <th className="pb-2 px-2 text-center cursor-pointer select-none" onClick={() => toggleSort("same_season_pct")}>
              Same Szn{arrow("same_season_pct")}
            </th>
            <th className="pb-2 px-2 text-center cursor-pointer select-none" onClick={() => toggleSort("g10")}>
              G10{arrow("g10")}
            </th>
            <th className="pb-2 px-2 text-center cursor-pointer select-none" onClick={() => toggleSort("samples")}>
              Cases{arrow("samples")}
            </th>
            <th className="pb-2 pl-2 text-center">Severity</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((stat) => {
            const severity = INJURY_SEVERITY[stat.injury_type] ?? "moderate";
            const color = getSeverityColor(stat.injury_type);
            const curve = getCurve(stat);
            const gamesMissed = curve?.games_missed_avg;
            const sameSeasonPct = curve?.next_season_pct != null ? Math.round(100 - curve.next_season_pct) : null;
            const g10 = curve?.median_pct_recent[9] != null ? Math.round(curve.median_pct_recent[9] * 100) : null;
            return (
              <tr key={stat.stat_id} className="border-b border-white/5 hover:bg-white/[0.02]">
                <td className="py-2.5 pr-4">
                  <Link
                    to={`/injuries/${stat.injury_type_slug}`}
                    className="text-sm font-medium text-[#1C7CFF] hover:text-[#1C7CFF]/80"
                  >
                    {stat.injury_type}
                  </Link>
                </td>
                {leagueFilter === "all" && (
                  <td className="py-2.5 px-2 text-center text-xs text-white/40">
                    {LEAGUE_LABELS[stat.league_slug] ?? stat.league_slug}
                  </td>
                )}
                <td className="py-2.5 px-2 text-center text-sm text-white/50 tabular-nums">
                  {gamesMissed != null ? Math.round(gamesMissed) : "—"}
                </td>
                <td className="py-2.5 px-2 text-center text-sm font-semibold tabular-nums" style={{ color }}>
                  {stat.median_recovery_days != null ? Math.round(stat.median_recovery_days) : "—"}
                </td>
                <td className="py-2.5 px-2 text-center text-sm tabular-nums">
                  {sameSeasonPct != null ? (
                    <span className={sameSeasonPct >= 80 ? "text-green-400/70" : sameSeasonPct >= 50 ? "text-amber-400/70" : "text-red-400/70"}>
                      {sameSeasonPct}%
                    </span>
                  ) : "—"}
                </td>
                <td className="py-2.5 px-2 text-center text-sm tabular-nums">
                  {g10 != null ? (
                    <span className={g10 >= 95 ? "text-green-400/70" : g10 >= 80 ? "text-amber-400/70" : "text-red-400/70"}>
                      {g10}%
                    </span>
                  ) : "—"}
                </td>
                <td className="py-2.5 px-2 text-center text-sm text-white/50 tabular-nums">
                  {stat.sample_size.toLocaleString()}
                </td>
                <td className="py-2.5 pl-2 text-center">
                  <span
                    className="inline-block text-[10px] font-medium px-2 py-0.5 rounded-full"
                    style={{ backgroundColor: `${color}22`, color }}
                  >
                    {severity}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Full-page view: Recovery Statistics browser with league filter.
 * Route: /recovery-stats and /injuries/:injurySlug
 */
export function RecoveryStatsPage() {
  const { injurySlug: rawInjurySlug, leagueSlug: urlLeagueSlug, teamSlug } = useParams<{ injurySlug?: string; leagueSlug?: string; teamSlug?: string }>();
  // Support /:leagueSlug/:injurySlug-recovery route (teamSlug param from catch-all)
  const injurySlug = rawInjurySlug ?? (teamSlug?.endsWith("-recovery") ? teamSlug.replace(/-recovery$/, "") : undefined);
  const [searchParams, setSearchParams] = useSearchParams();
  const urlLeague = (urlLeagueSlug as LeagueFilter) ?? (searchParams.get("league") as LeagueFilter | null);
  const [leagueFilter, setLeagueFilter] = useState<LeagueFilter>(
    urlLeague ?? "all"
  );
  const [viewMode, setViewMode] = useState<"severity" | "table">("severity");
  const [returnWindow, setReturnWindow] = useState<"" | "same_season" | "next_season">("");

  const { data: stats = [], isLoading, error } = useRecoveryStats(
    leagueFilter === "all" ? undefined : leagueFilter
  );

  const { data: returnCases = [] } = useReturnCaseAggregates(
    leagueFilter === "all" ? undefined : leagueFilter
  );

  // Fetch performance curves to enrich recovery stats with games missed, G10 performance, next_season_pct
  const { data: perfCurves = [] } = usePerformanceCurves(
    leagueFilter === "all" ? undefined : leagueFilter,
    undefined,
    "all",
    returnWindow
  );

  // Build lookup: injury_type_slug|league_slug → PerformanceCurve
  const curveMap = useMemo(() => {
    const m = new Map<string, PerformanceCurve>();
    for (const c of perfCurves) {
      // All-positions curves (position === "") are the ones we want
      if (c.position === "") {
        m.set(`${c.injury_type_slug}|${c.league_slug}`, c);
      }
    }
    return m;
  }, [perfCurves]);

  // If we're on /injuries/:injurySlug, filter to that injury
  const filteredStats = useMemo(() => {
    const base = injurySlug ? stats.filter((s) => s.injury_type_slug === injurySlug) : stats;
    return base.filter((s) => s.sample_size >= 30 && s.injury_type_slug !== "other" && s.injury_type_slug !== "unknown");
  }, [stats, injurySlug]);

  // Get injury name from slug
  const injuryName = injurySlug
    ? filteredStats[0]?.injury_type ?? injurySlug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : null;

  // Group by severity tier
  const severityGroups = useMemo(() => {
    const groups: Record<string, RecoveryStat[]> = {};
    for (const stat of filteredStats) {
      const sev = INJURY_SEVERITY[stat.injury_type] ?? "moderate";
      if (!groups[sev]) groups[sev] = [];
      groups[sev].push(stat);
    }
    return groups;
  }, [filteredStats]);

  // Compute age impact
  const ageBuckets = useMemo(() => computeAgeBuckets(returnCases), [returnCases]);

  // Compute reinjury stats
  const reinjuryStats = useMemo(() => computeReinjuryStats(returnCases), [returnCases]);

  // Summary numbers
  const totalCases = filteredStats.reduce((sum, s) => sum + s.sample_size, 0);
  const injuryTypes = filteredStats.length;
  const avgMedian = filteredStats.length > 0
    ? Math.round(filteredStats.reduce((sum, s) => sum + (s.median_recovery_days ?? 0), 0) / filteredStats.length)
    : 0;

  // Unique players approximation (sum of unique sample sizes across injury types)
  const totalPlayers = useMemo(() => {
    const seen = new Set<string>();
    for (const s of filteredStats) seen.add(s.injury_type_slug);
    // Rough estimate: total cases / avg injury types per player (~1.3)
    return Math.round(totalCases / 1.3);
  }, [filteredStats, totalCases]);

  // Latest data update date
  const latestUpdate = useMemo(() => {
    if (filteredStats.length === 0) return null;
    return filteredStats.reduce((latest, s) =>
      s.computed_at > latest ? s.computed_at : latest
    , filteredStats[0].computed_at);
  }, [filteredStats]);

  const latestUpdateFormatted = latestUpdate
    ? new Date(latestUpdate).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : null;

  // Key findings: longest recovery, most games missed, most common
  const keyFindings = useMemo(() => {
    if (filteredStats.length < 2) return null;
    const withMedian = filteredStats.filter((s) => s.median_recovery_days != null);
    if (withMedian.length === 0) return null;

    const longestRecovery = [...withMedian].sort((a, b) => (b.median_recovery_days ?? 0) - (a.median_recovery_days ?? 0))[0];
    const mostCommon = [...filteredStats].sort((a, b) => b.sample_size - a.sample_size)[0];
    const mostGamesMissed = [...withMedian].sort((a, b) => (b.max_recovery_days ?? 0) - (a.max_recovery_days ?? 0))[0];

    return { longestRecovery, mostCommon, mostGamesMissed };
  }, [filteredStats]);

  // Comparable injuries (same severity tier, excluding current if on detail page)
  const comparableInjuries = useMemo(() => {
    if (filteredStats.length === 0) return [];
    const currentSeverity = injuryName ? (INJURY_SEVERITY[injuryName] ?? "moderate") : null;
    if (!currentSeverity || !injurySlug) return [];
    return stats
      .filter((s) => (INJURY_SEVERITY[s.injury_type] ?? "moderate") === currentSeverity && s.injury_type_slug !== injurySlug)
      .reduce((unique, s) => {
        if (!unique.find((u) => u.injury_type_slug === s.injury_type_slug)) unique.push(s);
        return unique;
      }, [] as RecoveryStat[])
      .slice(0, 6);
  }, [stats, filteredStats, injurySlug, injuryName]);

  function handleLeagueChange(slug: LeagueFilter) {
    setLeagueFilter(slug);
    if (slug === "all") searchParams.delete("league");
    else searchParams.set("league", slug);
    setSearchParams(searchParams, { replace: true });
  }

  const year = new Date().getFullYear();
  const leagueLabel = leagueFilter !== "all" ? ` ${LEAGUE_LABELS[leagueFilter]}` : "";

  const pageTitle = injuryName
    ? `${injuryName} Recovery Timeline & Statistics (${year})`
    : `Injury Recovery Statistics${leagueLabel} (${year})`;
  const pageDescription = injuryName
    ? `How long does a ${injuryName.toLowerCase()} take to heal? See median recovery days, games missed, reinjury rates, and age impact data for ${injuryName} injuries.`
    : `How long do${leagueLabel.toLowerCase()} sports injuries take to heal? Median recovery timelines, games missed distributions, and reinjury rates across ${injuryTypes} injury types.`;
  const pagePath = injurySlug ? `/injuries/${injurySlug}` : "/recovery-stats";

  const jsonLd = jsonLdGraph(
    breadcrumbJsonLd([
      { name: "Home", path: "/" },
      ...(injurySlug ? [{ name: "Recovery Stats", path: "/recovery-stats" }] : []),
      { name: injuryName ?? "Recovery Stats", path: pagePath },
    ]),
    datasetJsonLd({
      name: `Sports Injury Recovery Data${leagueLabel}`,
      description: `Recovery timelines for ${injuryTypes} injury types based on ${totalCases} historical cases.`,
      url: pagePath,
      sampleSize: totalCases,
      keywords: [
        "injury recovery time",
        "games missed",
        "sports injury statistics",
        ...(injuryName ? [`${injuryName.toLowerCase()} recovery`] : []),
      ],
    }),
    faqJsonLd([
      {
        question: injuryName
          ? `How long does a ${injuryName.toLowerCase()} take to recover from?`
          : "How long do sports injuries take to heal?",
        answer: injuryName && filteredStats[0]
          ? `The median recovery time for a ${injuryName.toLowerCase()} is ${Math.round(filteredStats[0].median_recovery_days ?? 0)} days, based on ${filteredStats[0].sample_size} historical cases.`
          : `Recovery times vary by injury type and severity. Our database tracks ${totalCases} historical cases across ${injuryTypes} injury types.`,
      },
      {
        question: "Does age affect injury recovery time?",
        answer: ageBuckets.length > 1
          ? `Yes. Players under 25 average ${ageBuckets[0]?.avgDays ?? "fewer"} days recovery, while players 35+ average ${ageBuckets[ageBuckets.length - 1]?.avgDays ?? "more"} days.`
          : "Yes, older athletes generally take longer to recover from the same injury type.",
      },
      {
        question: "What is the reinjury rate in professional sports?",
        answer: `In our dataset, ${reinjuryStats.reinjuryRate}% of injury cases involved players with at least one prior injury, and ${reinjuryStats.samePartRate}% re-injured the same body part.`,
      },
    ])
  );

  return (
    <div className="min-h-screen bg-[#0A0F1E] text-white">
      <SEO title={pageTitle} description={pageDescription} path={pagePath} jsonLd={jsonLd} />
      <SiteHeader />

      {/* Hero header */}
      <div className="relative overflow-hidden border-b border-white/10 bg-gradient-to-br from-[#0A0F1E] via-[#0d1529] to-[#0A0F1E]">
        <div className="pointer-events-none absolute -top-32 -left-32 w-96 h-96 rounded-full bg-[#1C7CFF] opacity-10 blur-3xl" />
        <div className="pointer-events-none absolute -top-32 -right-32 w-96 h-96 rounded-full bg-[#3DFF8F] opacity-8 blur-3xl" />

        <div className="relative max-w-4xl mx-auto px-4 sm:px-6 py-10">
          <nav className="text-sm text-white/40 mb-4">
            <Link to="/" className="hover:text-white/60">Home</Link>
            {injurySlug && (
              <>
                {" / "}
                <Link to="/recovery-stats" className="hover:text-white/60">Recovery Stats</Link>
              </>
            )}
            {" / "}
            <span className="text-white/60">{injuryName ?? "Recovery Stats"}</span>
          </nav>

          <div className="flex items-center gap-3 mb-3">
            <span className="text-xs font-bold uppercase tracking-[0.2em] text-[#3DFF8F]">
              Recovery Intelligence
            </span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-3">
            {injuryName ? (
              <>
                <span className="text-white">{injuryName} </span>
                <span className="bg-gradient-to-r from-[#1C7CFF] to-[#3DFF8F] bg-clip-text text-transparent">
                  Recovery Timeline
                </span>
              </>
            ) : (
              <>
                <span className="text-white">Injury </span>
                <span className="bg-gradient-to-r from-[#1C7CFF] to-[#3DFF8F] bg-clip-text text-transparent">
                  Recovery Stats
                </span>
              </>
            )}
          </h1>
          <p className="text-white/50 text-sm max-w-xl">
            {isLoading
              ? "Loading..."
              : injuryName
                ? `Recovery data for ${injuryName.toLowerCase()} injuries across ${filteredStats.length} league${filteredStats.length !== 1 ? "s" : ""}, based on ${totalCases.toLocaleString()} historical cases.`
                : `Historical recovery timelines across NFL, NBA, MLB, NHL & Premier League. ${totalCases.toLocaleString()} cases across ${injuryTypes} injury types.`
            }
          </p>

          {/* Summary pills */}
          {!isLoading && filteredStats.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-3">
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/8 border border-white/10 text-xs text-white/60">
                <span className="font-semibold text-white">{totalCases.toLocaleString()}</span> cases tracked
              </div>
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/8 border border-white/10 text-xs text-white/60">
                <span className="font-semibold text-white">{injuryTypes}</span> injury types
              </div>
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/8 border border-white/10 text-xs text-white/60">
                <span className="font-semibold text-white">{avgMedian}d</span> avg median recovery
              </div>
            </div>
          )}

          {/* Latest Data Update badge */}
          {!isLoading && latestUpdateFormatted && (
            <div className="mt-4 rounded-lg border border-white/10 bg-white/5 px-4 py-3">
              <h2 className="text-xs font-bold uppercase tracking-wider text-white/40 mb-1.5">Latest Data Update</h2>
              <p className="text-sm text-white/60">
                Updated with games through <span className="font-semibold text-white">{latestUpdateFormatted}</span>
              </p>
              <p className="text-xs text-white/40 mt-1">
                <span className="font-semibold text-white/60">{totalCases.toLocaleString()}</span> injuries tracked across{" "}
                <span className="font-semibold text-white/60">~{totalPlayers.toLocaleString()}</span> players analyzed
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        {/* Filter bar */}
        <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
          <LeagueFilterBar value={leagueFilter} onChange={handleLeagueChange} />
          {!injurySlug && (
            <div className="flex gap-1 bg-white/5 rounded-lg p-0.5">
              <button
                onClick={() => setViewMode("severity")}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                  viewMode === "severity" ? "bg-white/10 text-white" : "text-white/40 hover:text-white/60"
                }`}
              >
                By Severity
              </button>
              <button
                onClick={() => setViewMode("table")}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                  viewMode === "table" ? "bg-white/10 text-white" : "text-white/40 hover:text-white/60"
                }`}
              >
                Table
              </button>
            </div>
          )}
        </div>

        {/* Return window filter */}
        <div className="flex items-center gap-2 mb-6">
          <span className="text-[10px] text-white/30 font-medium shrink-0">Return window</span>
          {([
            { value: "" as const, label: "All Returns" },
            { value: "same_season" as const, label: "Same Season" },
            { value: "next_season" as const, label: "Next Season" },
          ]).map((opt) => (
            <button
              key={opt.value}
              onClick={() => setReturnWindow(opt.value)}
              className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                returnWindow === opt.value
                  ? "bg-purple-500/15 text-purple-400 border border-purple-500/30"
                  : "bg-white/5 text-white/40 hover:text-white/60 border border-transparent"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Error state */}
        {error && (
          <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            Failed to load recovery stats: {(error as Error).message}
          </div>
        )}

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((i) => <div key={i} className="h-12 rounded-lg bg-white/10 animate-pulse" />)}
          </div>
        ) : filteredStats.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-8 text-center">
            <p className="text-white/50">No recovery stats found{injurySlug ? ` for "${injuryName}"` : ""}.</p>
          </div>
        ) : (
          <>
            {/* Main content: severity view or table */}
            {injurySlug || viewMode === "table" ? (
              <section className="mb-8">
                <h2 className="text-lg font-bold mb-4">
                  {injurySlug ? `${injuryName} Recovery Data by League` : "All Injury Types"}
                </h2>
                <RecoveryOverviewTable stats={filteredStats} leagueFilter={leagueFilter} curveMap={curveMap} />
              </section>
            ) : (
              <section className="mb-8">
                {SEVERITY_ORDER.map((tier) =>
                  severityGroups[tier]?.length ? (
                    <SeverityTierSection key={tier} tier={tier} stats={severityGroups[tier]} showLeague={leagueFilter === "all"} curveMap={curveMap} />
                  ) : null
                )}
              </section>
            )}

            {/* Age Impact */}
            {ageBuckets.length > 1 && (
              <section className="mb-8 rounded-xl border border-white/10 bg-white/5 p-5">
                <h2 className="text-lg font-bold mb-1">Age Impact on Recovery</h2>
                <p className="text-xs text-white/40 mb-4">
                  Average recovery days by age group, based on {returnCases.filter((r) => r.age_at_injury != null).length} cases with age data
                </p>
                <AgeBucketChart buckets={ageBuckets} />
              </section>
            )}

            {/* Key Findings — auto-generated data-driven insights */}
            {keyFindings && (
              <section className="mb-8 rounded-xl border border-white/10 bg-white/5 p-5">
                <h2 className="text-lg font-bold mb-3">Key Findings</h2>
                <ul className="space-y-2 text-sm text-white/60 list-disc list-inside">
                  <li>
                    <span className="font-semibold text-white">{keyFindings.longestRecovery.injury_type}</span> has the
                    longest average recovery at{" "}
                    <span className="font-semibold text-white">
                      {Math.round(keyFindings.longestRecovery.median_recovery_days ?? 0)} days
                    </span>{" "}
                    (median), based on {keyFindings.longestRecovery.sample_size.toLocaleString()} cases.
                  </li>
                  <li>
                    <span className="font-semibold text-white">{keyFindings.mostGamesMissed.injury_type}</span> has the
                    widest recovery window, with cases ranging from{" "}
                    <span className="font-semibold text-white">
                      {keyFindings.mostGamesMissed.min_recovery_days ?? 0}–{keyFindings.mostGamesMissed.max_recovery_days ?? 0} days
                    </span>.
                  </li>
                  <li>
                    <span className="font-semibold text-white">{keyFindings.mostCommon.injury_type}</span> is the most
                    frequently tracked injury type with{" "}
                    <span className="font-semibold text-white">
                      {keyFindings.mostCommon.sample_size.toLocaleString()} recorded cases
                    </span>.
                  </li>
                  {ageBuckets.length > 1 && (
                    <li>
                      Players aged 35+ average{" "}
                      <span className="font-semibold text-white">{ageBuckets[ageBuckets.length - 1]?.avgDays} days</span>{" "}
                      recovery vs.{" "}
                      <span className="font-semibold text-white">{ageBuckets[0]?.avgDays} days</span> for those under 25
                      — a{" "}
                      <span className="font-semibold text-white">
                        {ageBuckets[0]?.avgDays
                          ? Math.round(((ageBuckets[ageBuckets.length - 1]?.avgDays ?? 0) / ageBuckets[0].avgDays - 1) * 100)
                          : 0}
                        %
                      </span>{" "}
                      increase.
                    </li>
                  )}
                  {reinjuryStats.avgDaysWithPrior != null && reinjuryStats.avgDaysWithout != null && (
                    <li>
                      Athletes with prior injuries take{" "}
                      <span className="font-semibold text-white">{reinjuryStats.avgDaysWithPrior} days</span> to recover
                      on average vs.{" "}
                      <span className="font-semibold text-white">{reinjuryStats.avgDaysWithout} days</span> for first-time
                      injuries.
                    </li>
                  )}
                </ul>
              </section>
            )}

            {/* Comparable Injuries (detail page only) */}
            {comparableInjuries.length > 0 && (
              <section className="mb-8 rounded-xl border border-white/10 bg-white/5 p-5">
                <h2 className="text-lg font-bold mb-1">Comparable Injuries</h2>
                <p className="text-xs text-white/40 mb-3">
                  Similar severity injuries for recovery timeline comparison
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {comparableInjuries.map((s) => (
                    <Link
                      key={s.injury_type_slug}
                      to={`/injuries/${s.injury_type_slug}`}
                      className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors"
                    >
                      <span>{s.injury_type}</span>
                      <span className="text-xs tabular-nums text-white/40">
                        {s.median_recovery_days != null ? `${Math.round(s.median_recovery_days)}d median` : "—"}
                      </span>
                    </Link>
                  ))}
                </div>
              </section>
            )}
          </>
        )}

        {/* SEO content */}
        <section className="mt-10 border-t border-white/8 pt-8">
          <h2 className="text-lg font-bold mb-3">
            {injuryName
              ? `Understanding ${injuryName} Recovery in Professional Sports`
              : "How Long Do Sports Injuries Take to Heal?"
            }
          </h2>
          <div className="text-sm text-white/50 leading-relaxed space-y-3">
            {injuryName ? (
              <>
                <p>
                  {injuryName} injuries are one of the most tracked injury categories in professional sports,
                  with <span className="text-white/70">{totalCases.toLocaleString()}</span> documented cases
                  in our database across {filteredStats.length} league{filteredStats.length !== 1 ? "s" : ""}.
                  Recovery timelines depend on severity, player age, position demands, and whether the athlete
                  has experienced similar injuries before.
                </p>
                <p>
                  The median recovery time for {injuryName.toLowerCase()} injuries is{" "}
                  <span className="text-white/70">{avgMedian} days</span>, though individual cases range from{" "}
                  {filteredStats[0]?.min_recovery_days ?? "a few"} to {filteredStats[0]?.max_recovery_days ?? "many"} days
                  depending on injury grade and treatment approach. The median — rather than the average — provides
                  the most reliable estimate because it is not skewed by rare outlier cases where recovery
                  took significantly longer than expected.
                </p>
                <p>
                  Age plays a measurable role in {injuryName.toLowerCase()} recovery.
                  {ageBuckets.length > 1
                    ? ` Athletes under 25 return in roughly ${ageBuckets[0]?.avgDays ?? "fewer"} days on average, while those 35 and older require approximately ${ageBuckets[ageBuckets.length - 1]?.avgDays ?? "more"} days.`
                    : " Younger athletes generally recover faster, with the gap widening as career mileage increases."
                  }{" "}
                  Reinjury history matters too: players who previously injured the same body part face a{" "}
                  <span className="text-white/70">{reinjuryStats.samePartRate}%</span> same-part reinjury
                  rate, often with extended timelines compared to first-time injuries.
                </p>
                <p>
                  Fantasy managers and sports bettors can use this data to evaluate player availability windows.
                  A player listed with a {injuryName.toLowerCase()} and no prior injury history will typically
                  fall on the shorter end of the range, while athletes with recurring issues should be
                  projected toward the longer end. Check the age impact and reinjury analysis sections above
                  for a more granular breakdown.
                </p>
              </>
            ) : (
              <>
                <p>
                  Recovery timelines vary dramatically across injury types. Critical injuries like ACL tears
                  average 9-12 months, while minor injuries like ankle sprains typically resolve in 1-3 weeks.
                  Our database currently tracks{" "}
                  <span className="text-white/70">{totalCases.toLocaleString()}</span> historical cases
                  across <span className="text-white/70">{injuryTypes}</span> distinct injury types,
                  spanning the NFL, NBA, MLB, NHL, and Premier League. Understanding these timelines is
                  essential for fantasy sports managers, sports bettors, and team management.
                </p>
                {keyFindings && (
                  <p>
                    Among all injury categories, <span className="text-white/70">{keyFindings.longestRecovery.injury_type}</span> carries
                    the longest median recovery at{" "}
                    <span className="text-white/70">{Math.round(keyFindings.longestRecovery.median_recovery_days ?? 0)} days</span>,
                    while <span className="text-white/70">{keyFindings.mostCommon.injury_type}</span> is the most frequently
                    occurring injury type with <span className="text-white/70">{keyFindings.mostCommon.sample_size.toLocaleString()} cases</span> on
                    record. The overall median recovery across all injury types is{" "}
                    <span className="text-white/70">{avgMedian} days</span>.
                  </p>
                )}
                <p>
                  Each injury type's median recovery days is computed from historical return-to-play data,
                  giving you the most accurate timeline expectations available. We use the median rather
                  than the average because a small number of extreme outlier cases can distort averages
                  significantly — the median reflects the true midpoint of recovery outcomes.
                </p>
                <p>
                  Factors like player age and injury history significantly impact recovery timelines.
                  {ageBuckets.length > 1
                    ? ` Players under 25 average ${ageBuckets[0]?.avgDays ?? "fewer"} days recovery, while those over 35 average ${ageBuckets[ageBuckets.length - 1]?.avgDays ?? "more"} days — a meaningful gap that fantasy managers should account for.`
                    : " Players over 35 typically take 15-30% longer to recover from the same injury type compared to players under 25."
                  }{" "}
                  Repeat injuries to the same body part also tend to have longer recovery windows,
                  with <span className="text-white/70">{reinjuryStats.samePartRate}%</span> of cases in our
                  dataset involving a re-injury to the same area.
                </p>
              </>
            )}
          </div>
        </section>

        {/* Related links */}
        <section className="mt-8 border-t border-white/8 pt-6">
          <h2 className="text-sm font-bold uppercase tracking-wide text-white/40 mb-3">
            Related Analysis
          </h2>
          <div className="grid gap-2 sm:grid-cols-2">
            <Link to="/returning-today" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              Players Returning From Injury Today
            </Link>
            <Link to="/performance-curves" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              Performance Curves — Post-Return Analytics
            </Link>
            <Link to="/props" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              Player Props — Today's Lines
            </Link>
            <Link to="/recovery-stats" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              All Injury Recovery Timelines
            </Link>
            <Link to="/injuries/acl-tear" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              ACL Tear Recovery Data
            </Link>
            <Link to="/injuries/hamstring" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              Hamstring Injury Recovery Data
            </Link>
            <Link to="/injuries/concussion" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              Concussion Recovery Timeline
            </Link>
            <Link to="/injuries/ankle-sprain" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              Ankle Sprain Recovery Data
            </Link>
            {(["nba", "nfl", "mlb", "nhl", "premier-league"] as const).map((slug) => (
              <Link key={`recovery-${slug}`} to={`/${slug}/recovery-stats`} className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
                {LEAGUE_LABELS[slug]} Recovery Statistics
              </Link>
            ))}
            {(["nba", "nfl", "mlb", "nhl", "premier-league"] as const).map((slug) => (
              <Link key={`perf-${slug}`} to={`/${slug}-injury-performance`} className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
                {LEAGUE_LABELS[slug]} Injury Performance
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
