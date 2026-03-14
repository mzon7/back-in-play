import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { SiteHeader } from "../../../components/SiteHeader";
import { SEO } from "../../../components/seo/SEO";
import { breadcrumbJsonLd, datasetJsonLd, faqJsonLd, jsonLdGraph } from "../../../components/seo/seoHelpers";
import { usePerformanceCurves, usePositionsWithCurves } from "../lib/queries";
import { PerformanceCurveChart } from "./PerformanceCurveChart";
import type { PerformanceCurve, LeagueFilter } from "../lib/types";
import { LEAGUE_LABELS, STAT_LABELS, LEAGUE_STATS } from "../lib/types";
import { trackCurveExpand, trackStatDrillDown, trackLeagueFilter } from "../../../lib/analytics";

const LEAGUE_ORDER: LeagueFilter[] = ["all", "nba", "nfl", "mlb", "nhl", "premier-league"];

function StatDrillDown({ curve }: { curve: PerformanceCurve }) {
  const [selectedStat, setSelectedStat] = useState<string | null>(null);
  const stats = LEAGUE_STATS[curve.league_slug] ?? [];
  const availableStats = stats.filter(
    (s) => curve.stat_avg_pct?.[s]?.some((v) => v != null)
  );

  if (availableStats.length === 0) return null;

  return (
    <div className="mt-4">
      <p className="text-[11px] text-white/40 font-medium uppercase tracking-wide mb-2">Per-Stat Breakdown</p>
      <div className="flex flex-wrap gap-1 mb-3">
        {availableStats.map((stat) => {
          const avg10 = curve.stat_avg_pct?.[stat]?.[9];
          const pctColor = avg10 != null
            ? avg10 >= 1.0 ? "text-green-400" : avg10 >= 0.8 ? "text-amber-400" : "text-red-400"
            : "text-white/30";
          return (
            <button
              key={stat}
              onClick={() => { setSelectedStat(selectedStat === stat ? null : stat); if (selectedStat !== stat) trackStatDrillDown(stat, curve.injury_type_slug); }}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                selectedStat === stat
                  ? "bg-[#1C7CFF]/20 text-[#1C7CFF] border border-[#1C7CFF]/30"
                  : "bg-white/5 text-white/50 hover:text-white/70 border border-transparent"
              }`}
            >
              {STAT_LABELS[stat] ?? stat}
              {avg10 != null && (
                <span className={`ml-1 ${pctColor}`}>{Math.round(avg10 * 100)}%</span>
              )}
            </button>
          );
        })}
      </div>

      {selectedStat && curve.stat_avg_pct?.[selectedStat] && (
        <div className="bg-white/[0.03] rounded-lg p-3 border border-white/5">
          <p className="text-xs text-white/50 mb-2">
            {STAT_LABELS[selectedStat]} — % of pre-injury average over 10 games
            <span className="text-white/25 ml-2">(n={curve.sample_size} total cases — actual count for this stat may be lower as not all positions track it)</span>
          </p>
          <div className="grid grid-cols-10 gap-1">
            {(curve.stat_avg_pct[selectedStat] ?? []).map((val, i) => {
              const pct = val != null ? Math.round(val * 100) : null;
              const color = pct == null ? "text-white/20"
                : pct >= 100 ? "text-green-400"
                : pct >= 80 ? "text-amber-400"
                : "text-red-400";
              return (
                <div key={i} className="text-center">
                  <p className="text-[9px] text-white/30">G{i + 1}</p>
                  <p className={`text-xs font-bold ${color}`}>{pct != null ? `${pct}%` : "—"}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function CurveCard({ curve }: { curve: PerformanceCurve }) {
  const [expanded, setExpanded] = useState(false);

  const median10 = curve.median_pct_recent[9];
  const reachedFull = median10 != null && median10 >= 1.0;
  const leagueLabel = LEAGUE_LABELS[curve.league_slug] ?? curve.league_slug.toUpperCase();

  // Compute overall stat change % (average of all per-stat game-10 values)
  const stats = LEAGUE_STATS[curve.league_slug] ?? [];
  const statG10Values = stats
    .map((s) => curve.stat_avg_pct?.[s]?.[9])
    .filter((v): v is number => v != null);
  const overallStatChange = statG10Values.length > 0
    ? Math.round((statG10Values.reduce((a, b) => a + b, 0) / statG10Values.length) * 100)
    : null;

  const minuteG10 = curve.avg_minutes_pct[9];
  const minuteChange = minuteG10 != null ? Math.round(minuteG10 * 100) : null;

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 overflow-hidden">
      <button
        onClick={() => { if (!expanded) trackCurveExpand(curve.injury_type_slug, curve.league_slug); setExpanded(!expanded); }}
        className="w-full text-left px-5 py-4 flex items-center gap-3 hover:bg-white/[0.03] transition-colors"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-sm text-white truncate">{curve.injury_type}</h3>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/10 text-white/40 shrink-0">{leagueLabel}</span>
            {curve.position && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400/60 shrink-0">{curve.position}</span>
            )}
            {curve.sample_size < 10 && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400/80 shrink-0" title="Small sample size — interpret with caution">Low n</span>
            )}
          </div>
          <div className="flex items-center gap-4 mt-1 text-xs text-white/40">
            <span className="font-medium">{curve.sample_size} cases</span>
            {curve.games_missed_avg != null && <span>{curve.games_missed_avg} avg games missed</span>}
            {curve.recovery_days_avg != null && <span>{Math.round(curve.recovery_days_avg)}d avg recovery</span>}
          </div>
          {/* Overall stat + minute change summary */}
          <div className="flex items-center gap-3 mt-1 text-[11px]">
            {overallStatChange != null && (
              <span className={overallStatChange >= 100 ? "text-green-400/70" : "text-amber-400/70"}>
                Stats: {overallStatChange}% by G10
              </span>
            )}
            {minuteChange != null && (
              <span className={minuteChange >= 95 ? "text-green-400/70" : "text-amber-400/70"}>
                Minutes: {minuteChange}%
              </span>
            )}
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
              {curve.stderr_pct_recent[0] != null && (
                <p className="text-[10px] text-white/25">±{Math.round(curve.stderr_pct_recent[0] * 100)}%</p>
              )}
            </div>
            <div className="bg-white/5 rounded-lg p-3 text-center">
              <p className="text-xs text-white/40 mb-1">Game 5 Back</p>
              <p className="text-sm font-bold text-white">
                {curve.median_pct_recent[4] != null ? `${Math.round(curve.median_pct_recent[4] * 100)}%` : "—"}
              </p>
              {curve.stderr_pct_recent[4] != null && (
                <p className="text-[10px] text-white/25">±{Math.round(curve.stderr_pct_recent[4] * 100)}%</p>
              )}
            </div>
            <div className="bg-white/5 rounded-lg p-3 text-center">
              <p className="text-xs text-white/40 mb-1">Rest of Season</p>
              <p className="text-sm font-bold text-white">
                {curve.rest_of_season_pct_recent != null ? `${Math.round(curve.rest_of_season_pct_recent * 100)}%` : "—"}
              </p>
              {curve.rest_of_season_sample != null && (
                <p className="text-[10px] text-white/25">n={curve.rest_of_season_sample}</p>
              )}
            </div>
          </div>

          {curve.games_to_full != null && (
            <p className="text-xs text-white/40 mt-3 text-center">
              Estimated {Math.round(curve.games_to_full)} games to reach pre-injury performance
            </p>
          )}

          {/* Per-stat drill-down */}
          <StatDrillDown curve={curve} />
        </div>
      )}
    </div>
  );
}

export default function PerformanceCurvesPage() {
  const [league, setLeague] = useState<LeagueFilter>("all");
  const [position, setPosition] = useState<string>("all");
  const { data: curves = [], isLoading } = usePerformanceCurves(
    league === "all" ? undefined : league,
    undefined,
    position
  );
  const { data: positions = [] } = usePositionsWithCurves(league === "all" ? undefined : league);

  // Filter out "other" category which is unclear
  const filteredCurves = useMemo(
    () => curves.filter((c) => c.injury_type_slug !== "other"),
    [curves]
  );

  const totalCases = filteredCurves.reduce((sum, c) => sum + c.sample_size, 0);
  const year = new Date().getFullYear();

  // Reliable curves = sample_size >= 10
  const reliableCurves = useMemo(
    () => filteredCurves.filter((c) => c.sample_size >= 10),
    [filteredCurves]
  );

  // Top 5 most impactful injuries (lowest game-1 median)
  const mostImpactful = useMemo(() => {
    return [...reliableCurves]
      .filter((c) => c.median_pct_recent[0] != null)
      .sort((a, b) => (a.median_pct_recent[0] ?? 1) - (b.median_pct_recent[0] ?? 1))
      .slice(0, 5);
  }, [reliableCurves]);

  // Latest computed_at date across all curves
  const latestComputedAt = useMemo(() => {
    if (filteredCurves.length === 0) return null;
    return filteredCurves.reduce((latest, c) =>
      c.computed_at > latest ? c.computed_at : latest, filteredCurves[0].computed_at
    );
  }, [filteredCurves]);

  // Key findings from reliable curves only
  const keyFindings = useMemo(() => {
    if (reliableCurves.length === 0) return null;
    const withG1 = reliableCurves.filter((c) => c.median_pct_recent[0] != null);
    const withG10 = reliableCurves.filter((c) => c.median_pct_recent[9] != null);
    const withMinutes = reliableCurves.filter((c) => c.avg_minutes_pct[0] != null);

    const worstG1 = withG1.length > 0
      ? withG1.reduce((worst, c) => (c.median_pct_recent[0]! < worst.median_pct_recent[0]!) ? c : worst)
      : null;
    const bestG10 = withG10.length > 0
      ? withG10.reduce((best, c) => (c.median_pct_recent[9]! > best.median_pct_recent[9]!) ? c : best)
      : null;
    const avgMinutesDrop = withMinutes.length > 0
      ? Math.round((1 - withMinutes.reduce((sum, c) => sum + c.avg_minutes_pct[0]!, 0) / withMinutes.length) * 100)
      : null;

    return { worstG1, bestG10, avgMinutesDrop };
  }, [reliableCurves]);

  // Group injuries by body region for "Comparable Injuries"
  const injuryGroups = useMemo(() => {
    const lowerBody = ["ankle", "knee", "acl", "hamstring", "quad", "calf", "groin", "hip", "foot", "achilles", "shin", "leg", "mcl", "meniscus", "plantar"];
    const upperBody = ["shoulder", "elbow", "wrist", "hand", "finger", "thumb", "arm", "rotator"];
    const headNeck = ["concussion", "head", "neck", "jaw", "face", "eye"];
    const softTissue = ["hamstring", "calf", "groin", "quad", "oblique", "abdominal", "muscle"];

    const categorize = (slug: string) => {
      const s = slug.toLowerCase();
      if (headNeck.some((k) => s.includes(k))) return "Head & Neck";
      if (softTissue.some((k) => s.includes(k))) return "Soft Tissue / Muscle";
      if (lowerBody.some((k) => s.includes(k))) return "Lower Body";
      if (upperBody.some((k) => s.includes(k))) return "Upper Body";
      return "Other";
    };

    const groups: Record<string, PerformanceCurve[]> = {};
    for (const c of filteredCurves) {
      const cat = categorize(c.injury_type_slug);
      if (cat === "Other") continue;
      (groups[cat] ??= []).push(c);
    }
    return groups;
  }, [filteredCurves]);

  const [showMethodology, setShowMethodology] = useState(false);

  return (
    <div className="min-h-screen bg-[#0A0F1E] text-white">
      <SEO
        title={`Post-Injury Performance Curves (${year}) - Recovery Analytics`}
        description={`How do players perform after returning from injury? Explore recovery curves across NFL, NBA, MLB, NHL, and EPL. ${totalCases.toLocaleString()} injury cases analyzed.`}
        path="/performance-curves"
        jsonLd={jsonLdGraph(
          breadcrumbJsonLd([
            { name: "Home", path: "/" },
            { name: "Performance Curves", path: "/performance-curves" },
          ]),
          datasetJsonLd({
            name: "Post-Injury Player Performance Data",
            description: `Recovery performance curves for professional athletes returning from injury. ${totalCases.toLocaleString()} cases across NBA, NFL, MLB, NHL, and EPL.`,
            url: "/performance-curves",
            sampleSize: totalCases,
            keywords: ["injury recovery", "player performance after injury", "return to play", "sports analytics"],
          }),
          faqJsonLd([
            {
              question: "How do players perform after returning from injury?",
              answer: "Most players return to 85-95% of pre-injury performance in their first game back, with gradual improvement over the following 10 games. Recovery rates vary significantly by injury type and sport.",
            },
            {
              question: "How long does it take to return to full performance after injury?",
              answer: "On average, players reach pre-injury performance levels within 5-10 games of returning. Soft tissue injuries like hamstrings recover faster than structural injuries like ACL tears.",
            },
            {
              question: "What sports injuries have the biggest performance impact?",
              answer: "ACL tears, Achilles injuries, and concussions typically show the largest performance drops upon return. Soft tissue injuries like hamstrings, calves, and groin strains generally have shorter recovery curves.",
            },
          ])
        )}
      />
      <SiteHeader />

      {/* Hero */}
      <div className="relative overflow-hidden border-b border-white/10 bg-gradient-to-br from-[#0A0F1E] via-[#0d1529] to-[#0A0F1E]">
        <div className="pointer-events-none absolute -top-32 -left-32 w-96 h-96 rounded-full bg-[#1C7CFF] opacity-10 blur-3xl" />
        <div className="pointer-events-none absolute -top-32 -right-32 w-96 h-96 rounded-full bg-[#3DFF8F] opacity-8 blur-3xl" />

        <div className="relative max-w-4xl mx-auto px-4 sm:px-6 py-10">
          <nav className="text-sm text-white/40 mb-4">
            <Link to="/" className="hover:text-white/60">Home</Link>
            {" / "}
            <span className="text-white/60">Performance Curves</span>
          </nav>

          <div className="flex items-center gap-3 mb-3">
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
            Curves show percentage of pre-injury baseline performance. Click any curve for per-stat breakdowns.
          </p>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">

        {/* Latest Data Update */}
        {!isLoading && latestComputedAt && (
          <section className="mb-6 rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <h2 className="text-xs font-bold uppercase tracking-wider text-white/40 mb-2">Latest Data Update</h2>
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-lg font-bold text-white">{new Date(latestComputedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</p>
                <p className="text-[10px] text-white/30">Updated with games through</p>
              </div>
              <div>
                <p className="text-lg font-bold text-white">{totalCases.toLocaleString()}</p>
                <p className="text-[10px] text-white/30">Total injury returns tracked</p>
              </div>
              <div>
                <p className="text-lg font-bold text-white">{filteredCurves.length}</p>
                <p className="text-[10px] text-white/30">Injury types analyzed</p>
              </div>
            </div>
          </section>
        )}

        {/* Key Findings (local only until audited) */}
        {typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") && !isLoading && keyFindings && (
          <section className="mb-6 rounded-xl border border-[#1C7CFF]/20 bg-gradient-to-br from-[#1C7CFF]/5 to-transparent p-5">
            <h2 className="text-sm font-bold uppercase tracking-wider text-[#1C7CFF] mb-3">Key Findings</h2>
            <ul className="space-y-2 text-sm text-white/60 leading-relaxed">
              {keyFindings.worstG1 && (
                <li>
                  <span className="text-white/80 font-medium">{LEAGUE_LABELS[keyFindings.worstG1.league_slug]} {keyFindings.worstG1.injury_type}</span> injuries show the largest game-1 performance drop at{" "}
                  <span className="text-red-400 font-bold">{Math.round((1 - keyFindings.worstG1.median_pct_recent[0]!) * 100)}%</span> below baseline
                  {" "}(n={keyFindings.worstG1.sample_size} cases).
                </li>
              )}
              {keyFindings.bestG10 && (
                <li>
                  <span className="text-white/80 font-medium">{LEAGUE_LABELS[keyFindings.bestG10.league_slug]} {keyFindings.bestG10.injury_type}</span> injuries recover fastest, reaching{" "}
                  <span className="text-green-400 font-bold">{Math.round(keyFindings.bestG10.median_pct_recent[9]! * 100)}%</span> of baseline by game 10
                  {" "}(n={keyFindings.bestG10.sample_size} cases).
                </li>
              )}
              {keyFindings.avgMinutesDrop != null && keyFindings.avgMinutesDrop > 0 && (
                <li>
                  Players average a <span className="text-amber-400 font-bold">{keyFindings.avgMinutesDrop}%</span> minutes reduction in their first game back across {reliableCurves.filter((c) => c.avg_minutes_pct[0] != null).length} injury types analyzed.
                </li>
              )}
              {reliableCurves.length > 0 && (
                <li>
                  Across {reliableCurves.length} injury types with 10+ cases, the average game-1 performance is{" "}
                  <span className="text-white font-bold">
                    {Math.round(
                      (reliableCurves.filter((c) => c.median_pct_recent[0] != null).reduce((s, c) => s + c.median_pct_recent[0]!, 0) /
                        reliableCurves.filter((c) => c.median_pct_recent[0] != null).length) * 100
                    )}%
                  </span>{" "}
                  of pre-injury baseline.
                </li>
              )}
            </ul>
            <p className="text-[10px] text-white/25 mt-3">Findings exclude injury types with fewer than 10 historical cases.</p>
          </section>
        )}

        {/* League filter */}
        <div className="flex gap-1.5 overflow-x-auto pb-4 mb-4">
          {LEAGUE_ORDER.map((slug) => (
            <button
              key={slug}
              onClick={() => { setLeague(slug); setPosition("all"); trackLeagueFilter(slug, "performance_curves"); }}
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

        {/* Position filter */}
        {positions.length > 0 && (
          <div className="flex gap-1 overflow-x-auto pb-3 mb-4">
            <button
              onClick={() => setPosition("all")}
              className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                position === "all" ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/30" : "bg-white/5 text-white/40 hover:text-white/60 border border-transparent"
              }`}
            >
              All Positions
            </button>
            {positions.map((pos) => (
              <button
                key={pos}
                onClick={() => setPosition(pos)}
                className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  position === pos ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/30" : "bg-white/5 text-white/40 hover:text-white/60 border border-transparent"
                }`}
              >
                {pos}
              </button>
            ))}
          </div>
        )}

        {/* Most Performance Impacting Injuries (local only until audited) */}
        {typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") && !isLoading && mostImpactful.length > 0 && (
          <section className="mb-8 rounded-xl border border-red-500/20 bg-gradient-to-br from-red-500/5 to-transparent p-5">
            <h2 className="text-sm font-bold uppercase tracking-wider text-red-400 mb-3 flex items-center gap-2">
              <span className="text-base">&#x1F525;</span> Most Performance Impacting Injuries
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
              {mostImpactful.map((curve) => {
                const g1 = curve.median_pct_recent[0] != null ? Math.round(curve.median_pct_recent[0] * 100) : null;
                const g10 = curve.median_pct_recent[9] != null ? Math.round(curve.median_pct_recent[9] * 100) : null;
                const leagueLabel = LEAGUE_LABELS[curve.league_slug] ?? "";
                return (
                  <div key={curve.curve_id} className="bg-white/[0.04] rounded-lg p-3 text-center border border-white/5">
                    <p className="text-[10px] text-white/30 uppercase">{leagueLabel}</p>
                    <p className="text-sm font-semibold text-white mt-1 truncate">{curve.injury_type}</p>
                    <p className="text-2xl font-black text-red-400 mt-1">{g1 != null ? `${g1}%` : "—"}</p>
                    <p className="text-[10px] text-white/30">Game 1 back</p>
                    {g10 != null && (
                      <p className="text-[10px] mt-1">
                        <span className={g10 >= 95 ? "text-green-400/60" : "text-amber-400/60"}>
                          {g10}% by G10
                        </span>
                      </p>
                    )}
                    <p className="text-[9px] text-white/20 mt-1">{curve.sample_size} cases</p>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Legend + summary + info button */}
        <div className="flex flex-wrap items-center justify-between gap-4 text-xs text-white/40 mb-6 pb-4 border-b border-white/8">
          <div className="flex flex-wrap items-center gap-4">
            <span className="flex items-center gap-1.5">
              <span className="w-4 h-0.5 bg-[#1C7CFF] rounded" /> Median
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-4 h-3 bg-[#1C7CFF]/15 rounded" /> 25th–75th pctl
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-4 h-0.5 border-b border-dashed border-white/25" /> Average
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-4 h-0.5 border-b border-dashed border-[#3DFF8F]/40" /> Baseline
            </span>
            <button
              onClick={() => setShowMethodology(!showMethodology)}
              className="ml-2 w-5 h-5 rounded-full border border-white/20 text-[10px] text-white/40 hover:text-white/60 hover:border-white/40 transition-colors flex items-center justify-center"
              title="How is this calculated?"
            >
              i
            </button>
          </div>
          {!isLoading && filteredCurves.length > 0 && (
            <span className="text-white/30">
              {filteredCurves.length} injury types · {totalCases.toLocaleString()} return cases
            </span>
          )}
        </div>

        {/* Methodology panel (toggled by info button) */}
        {showMethodology && (
          <div className="mb-6 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-xs text-white/50 leading-relaxed space-y-2">
            <p className="font-semibold text-white/70 text-sm">How Performance Curves Are Calculated</p>
            <p>
              Each curve compares a player's post-return game performance against their <strong className="text-white/70">10-game pre-injury baseline</strong>.
              A value of 100% means the player performed at their pre-injury level.
            </p>
            <p>
              <strong className="text-white/70">Outlier protection:</strong> Individual game ratios are capped at 300% to prevent
              bench players or low-minute games from inflating averages. Averages use a trimmed mean (top/bottom 5% excluded).
            </p>
            <p>
              <strong className="text-white/70">Minimum thresholds:</strong> Players must have at least 5 pre-injury games for inclusion.
              Each curve requires at least 3 historical cases. Data sourced from Basketball-Reference, Pro-Football-Reference,
              Hockey-Reference, Baseball-Reference, and FBref. Updated daily.
            </p>
          </div>
        )}

        {/* Curves list */}
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-20 rounded-xl bg-white/10 animate-pulse" />
            ))}
          </div>
        ) : filteredCurves.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-8 text-center">
            <p className="text-white/50">No performance curve data available{position !== "all" ? ` for ${position}` : ""}.</p>
            <p className="text-xs text-white/30 mt-2">
              {position !== "all" ? "Try selecting 'All Positions'." : "Curves are computed from historical game log data. The pipeline runs daily."}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredCurves.map((curve) => (
              <CurveCard key={curve.curve_id} curve={curve} />
            ))}
          </div>
        )}

        {/* Comparable Injuries by Body Region */}
        {!isLoading && Object.keys(injuryGroups).length > 0 && (
          <section className="mt-10 border-t border-white/8 pt-6">
            <h2 className="text-lg font-bold mb-1">Comparable Injuries by Body Region</h2>
            <p className="text-xs text-white/40 mb-4">Injuries grouped by anatomical similarity to help compare recovery timelines within the same category.</p>
            <div className="space-y-4">
              {Object.entries(injuryGroups).sort(([, a], [, b]) => b.length - a.length).map(([group, groupCurves]) => {
                const sorted = [...groupCurves].sort((a, b) => (a.median_pct_recent[0] ?? 1) - (b.median_pct_recent[0] ?? 1));
                const reliableInGroup = sorted.filter((c) => c.sample_size >= 10);
                const avgG1 = reliableInGroup.length > 0
                  ? Math.round((reliableInGroup.filter((c) => c.median_pct_recent[0] != null).reduce((s, c) => s + c.median_pct_recent[0]!, 0) / reliableInGroup.filter((c) => c.median_pct_recent[0] != null).length) * 100)
                  : null;
                return (
                  <div key={group} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-semibold text-white/80">{group}</h3>
                      <span className="text-[10px] text-white/30">
                        {sorted.length} injury type{sorted.length !== 1 ? "s" : ""} · {sorted.reduce((s, c) => s + c.sample_size, 0).toLocaleString()} cases
                        {avgG1 != null && <> · Avg G1: {avgG1}%</>}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {sorted.map((c) => {
                        const g1 = c.median_pct_recent[0] != null ? Math.round(c.median_pct_recent[0] * 100) : null;
                        const color = g1 == null ? "text-white/30" : g1 >= 95 ? "text-green-400" : g1 >= 85 ? "text-amber-400" : "text-red-400";
                        return (
                          <span key={c.curve_id} className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-white/5 text-xs text-white/50 border border-white/5">
                            {c.injury_type}
                            <span className="text-[10px] text-white/25">({LEAGUE_LABELS[c.league_slug]})</span>
                            {g1 != null && <span className={`font-bold ${color}`}>{g1}%</span>}
                            {c.sample_size < 10 && <span className="text-[9px] text-amber-400/60">*</span>}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Methodology note */}
        <div className="mt-10 border-t border-white/8 pt-6">
          <h3 className="text-xs font-bold uppercase tracking-wide text-white/40 mb-2">Methodology</h3>
          <div className="text-xs text-white/30 leading-relaxed space-y-2">
            <p>
              Performance curves are generated by comparing each player's post-return game statistics against their
              pre-injury 10-game rolling average (the "recent baseline"). For each game after a player returns from
              the injured list, we compute the ratio of their actual performance to their baseline across multiple
              statistical categories — points, assists, rebounds, passing yards, goals, hits, and other sport-specific
              metrics depending on the league. This produces a per-game recovery percentage where 100% indicates
              the player has returned to their pre-injury production level.
            </p>
            <p>
              To ensure statistical reliability, individual game ratios are capped at 300% of baseline to prevent
              low-minute or bench players from distorting averages. We apply a trimmed mean (excluding the top and
              bottom 5% of values) when aggregating across all historical cases of a given injury type. Each curve
              requires a minimum of 3 historical return cases, and each individual case requires 5+ pre-injury games
              to establish a meaningful baseline. The current dataset encompasses {totalCases.toLocaleString()} verified
              return-from-injury cases across {filteredCurves.length} distinct injury types spanning the NBA, NFL, MLB,
              NHL, and English Premier League.
            </p>
            <p>
              Data is sourced from Basketball-Reference, Pro-Football-Reference, Hockey-Reference, Baseball-Reference,
              and FBref (for EPL). The pipeline runs daily, pulling new game logs, matching them against active injury
              reports, and recomputing curves when new return cases are detected. Injury classifications are standardized
              across leagues using a normalized taxonomy that maps league-specific injury descriptions to canonical types
              (e.g., "left ankle sprain," "rolled ankle," and "ankle injury" all map to "Ankle"). Position-specific curves
              are generated when sufficient data exists, as recovery patterns can differ by position — for example, a
              hamstring injury may impact a wide receiver's production differently than a quarterback's.
            </p>
            <p>
              Percentile bands (25th to 75th) are displayed on each chart to show the range of outcomes rather than just
              the central tendency. Standard error margins are calculated for each game point to indicate confidence
              in the median estimate. Curves with fewer than 10 cases are flagged with a "Low n" warning badge, as
              the smaller sample may not represent the true population recovery pattern.
            </p>
          </div>
        </div>

        {/* SEO content: Understanding recovery */}
        <section className="mt-8 border-t border-white/8 pt-6">
          <h2 className="text-lg font-bold mb-3">Understanding Post-Injury Performance Data</h2>
          <div className="text-sm text-white/50 leading-relaxed space-y-3">
            <p>
              When a professional athlete returns from injury, their performance rarely matches
              pre-injury levels immediately. Our recovery performance curves quantify this effect
              by tracking how players perform in their first 10 games back relative to their
              pre-injury baseline. This data is essential for fantasy sports managers making
              roster decisions, sports bettors evaluating player props, and analysts studying
              return-to-play trends.
            </p>
            <p>
              Each curve represents the median performance across all historical cases of that
              injury type, with percentile bands showing the range of outcomes. A value of 100%
              means a player is performing at their pre-injury level, while values below indicate
              a performance dip that is common during the initial return period.
            </p>
          </div>
        </section>

        {/* Internal links for SEO */}
        <section className="mt-8 border-t border-white/8 pt-6">
          <h2 className="text-sm font-bold uppercase tracking-wide text-white/40 mb-3">
            Explore More Injury & Recovery Data
          </h2>
          <div className="grid gap-2 sm:grid-cols-2">
            <Link to="/recovery-stats" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              Recovery Statistics — All Leagues
            </Link>
            <Link to="/returning-today" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              Players Returning from Injury Today
            </Link>
            <Link to="/minutes-restriction-after-injury" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              Minutes Restrictions After Injury
            </Link>
            <Link to="/players-returning-from-injury-this-week" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
              Players Returning from Injury This Week
            </Link>
            {(["nba", "nfl", "mlb", "nhl", "premier-league"] as const).map((slug) => (
              <Link
                key={`perf-${slug}`}
                to={`/${slug}-injury-performance`}
                className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors"
              >
                {LEAGUE_LABELS[slug]} Injury Performance Analysis
              </Link>
            ))}
            {(["nba", "nfl", "mlb", "nhl", "premier-league"] as const).map((slug) => (
              <Link
                key={`analysis-${slug}`}
                to={`/${slug}-injury-analysis`}
                className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors"
              >
                {LEAGUE_LABELS[slug]} Injury Analysis & Trends
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
