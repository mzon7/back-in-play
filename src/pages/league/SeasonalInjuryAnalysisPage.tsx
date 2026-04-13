import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { SiteHeader } from "../../components/SiteHeader";
import { SEO } from "../../components/seo/SEO";
import { useQuery } from "@tanstack/react-query";
import { supabase, dbTable } from "../../lib/supabase";

const LEAGUE_LABELS: Record<string, string> = {
  nba: "NBA", nfl: "NFL", mlb: "MLB", nhl: "NHL", "premier-league": "EPL",
};

/** Season date ranges: [startMonth, startDay, endMonth, endDay] */
const SEASON_RANGES: Record<string, [number, number, number, number]> = {
  nba: [10, 1, 6, 30],
  nhl: [10, 1, 6, 30],
  nfl: [9, 1, 2, 28],
  mlb: [3, 1, 10, 31],
  "premier-league": [8, 1, 5, 31],
};

function getSeasonDates(league: string, year: number): [string, string] {
  const range = SEASON_RANGES[league] ?? [1, 1, 12, 31];
  const [sm, sd, em, ed] = range;
  // For leagues that span calendar years (NBA, NHL, NFL, EPL), start is year-1
  const startYear = sm > em ? year - 1 : year;
  const start = `${startYear}-${String(sm).padStart(2, "0")}-${String(sd).padStart(2, "0")}`;
  const end = `${year}-${String(em).padStart(2, "0")}-${String(ed).padStart(2, "0")}`;
  return [start, end];
}

interface ReturnCase {
  injury_type: string;
  injury_type_slug: string;
  date_injured: string;
  return_date: string | null;
  recovery_days: number | null;
}

function useSeasonCases(leagueSlug: string, seasonStart: string, seasonEnd: string) {
  return useQuery<ReturnCase[]>({
    queryKey: ["season-cases", leagueSlug, seasonStart, seasonEnd],
    queryFn: async () => {
      const { data, error } = await supabase
        .from(dbTable("injury_return_cases"))
        .select("injury_type,injury_type_slug,date_injured,return_date,recovery_days")
        .eq("league_slug", leagueSlug)
        .gte("date_injured", seasonStart)
        .lte("date_injured", seasonEnd)
        .order("date_injured", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as ReturnCase[];
    },
    staleTime: 10 * 60 * 1000,
  });
}

export default function SeasonalInjuryAnalysisPage() {
  const { leagueSlug = "", teamSlug = "" } = useParams<{ leagueSlug: string; teamSlug: string }>();
  const yearMatch = teamSlug.match(/^(\d{4})-season-injuries$/);
  const year = yearMatch ? parseInt(yearMatch[1]) : new Date().getFullYear();
  const leagueLabel = LEAGUE_LABELS[leagueSlug] ?? leagueSlug.toUpperCase();

  const [seasonStart, seasonEnd] = getSeasonDates(leagueSlug, year);
  const { data: cases, isLoading } = useSeasonCases(leagueSlug, seasonStart, seasonEnd);

  const stats = useMemo(() => {
    if (!cases) return null;
    const total = cases.length;
    const returned = cases.filter(c => c.return_date != null).length;
    const sameSeasonReturns = cases.filter(c => c.return_date != null && c.return_date <= seasonEnd).length;

    // Group by injury type
    const byType = new Map<string, { slug: string; count: number; totalDays: number; daysCount: number; sameCount: number }>();
    for (const c of cases) {
      const key = c.injury_type_slug;
      const entry = byType.get(key) ?? { slug: key, count: 0, totalDays: 0, daysCount: 0, sameCount: 0 };
      entry.count++;
      if (c.recovery_days != null) { entry.totalDays += c.recovery_days; entry.daysCount++; }
      if (c.return_date && c.return_date <= seasonEnd) entry.sameCount++;
      byType.set(key, entry);
    }

    const types = Array.from(byType.entries())
      .map(([, v]) => {
        const match = cases.find(c => c.injury_type_slug === v.slug);
        return { ...v, name: match?.injury_type ?? v.slug, pctOfTotal: (v.count / total) * 100, avgDays: v.daysCount > 0 ? v.totalDays / v.daysCount : null, samePct: v.count > 0 ? (v.sameCount / v.count) * 100 : 0 };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    return { total, returned, sameSeasonReturns, returnPct: total > 0 ? (returned / total) * 100 : 0, samePct: returned > 0 ? (sameSeasonReturns / returned) * 100 : 0, types };
  }, [cases, seasonEnd]);

  const pageTitle = `${leagueLabel} ${year} Season Injury Analysis`;
  const pagePath = `/${leagueSlug}/${year}-season-injuries`;

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white">
      <SEO title={pageTitle} description={`${leagueLabel} ${year} season injury breakdown: total injuries, recovery timelines, and same-season return rates by injury type.`} path={pagePath} type="article" />
      <SiteHeader />
      <nav className="px-4 py-3 text-sm text-white/45 max-w-3xl mx-auto">
        <Link to="/" className="hover:text-white/60">Home</Link>{" / "}
        <Link to={`/${leagueSlug}-injuries`} className="hover:text-white/60">{leagueLabel}</Link>{" / "}
        <span className="text-white/60">{year} Season</span>
      </nav>
      <div className="max-w-3xl mx-auto px-4 pb-12">
        <h1 className="text-2xl font-bold mb-1">{leagueLabel} {year} Season Injuries</h1>
        <p className="text-sm text-white/40 mb-6">Season: {seasonStart} to {seasonEnd}</p>

        {isLoading ? (
          <div className="animate-pulse text-white/40 text-sm py-8 text-center">Loading season data...</div>
        ) : !stats || stats.total === 0 ? (
          <div className="bg-white/5 border border-white/10 rounded-xl p-6 text-center">
            <p className="text-white/40">No injury data available for this season.</p>
          </div>
        ) : (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
              <div className="bg-white/5 border border-white/10 rounded-lg p-3">
                <div className="text-[10px] text-white/40 uppercase">Total Injuries</div>
                <div className="text-lg font-semibold mt-1">{stats.total}</div>
              </div>
              <div className="bg-white/5 border border-white/10 rounded-lg p-3">
                <div className="text-[10px] text-white/40 uppercase">Returned</div>
                <div className="text-lg font-semibold mt-1">{stats.returned}</div>
              </div>
              <div className="bg-white/5 border border-white/10 rounded-lg p-3">
                <div className="text-[10px] text-white/40 uppercase">Same-Season Return</div>
                <div className="text-lg font-semibold mt-1">{Math.round(stats.samePct)}%</div>
              </div>
              <div className="bg-white/5 border border-white/10 rounded-lg p-3">
                <div className="text-[10px] text-white/40 uppercase">Injury Types</div>
                <div className="text-lg font-semibold mt-1">{stats.types.length}</div>
              </div>
            </div>

            {/* Injury type breakdown */}
            <h2 className="text-lg font-semibold mb-3">Top Injury Types</h2>
            <div className="space-y-2 mb-8">
              {stats.types.map(t => (
                <Link key={t.slug} to={`/${leagueSlug}/${t.slug}-recovery`}
                  className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-lg p-3 hover:bg-white/10 transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm">{t.name}</div>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-white/50">
                      <span>{t.count} cases ({Math.round(t.pctOfTotal)}%)</span>
                      {t.avgDays != null && <span>{Math.round(t.avgDays)}d avg recovery</span>}
                    </div>
                  </div>
                  <div className="text-right shrink-0 text-xs">
                    <div className="text-white/60">{Math.round(t.samePct)}%</div>
                    <div className="text-[10px] text-white/30">same szn</div>
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}

        {/* Other seasons + related */}
        <div className="border-t border-white/10 pt-8 space-y-2 text-sm">
          <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wide mb-3">Other Seasons</h3>
          {[year - 2, year - 1, year + 1].filter(y => y >= 2020 && y <= 2026).map(y => (
            <Link key={y} to={`/${leagueSlug}/${y}-season-injuries`} className="block text-cyan-400 hover:underline">
              {leagueLabel} {y} Season
            </Link>
          ))}
          <div className="mt-4 pt-4 border-t border-white/10">
            <Link to={`/${leagueSlug}-injuries`} className="block text-cyan-400 hover:underline">{leagueLabel} current injuries</Link>
            <Link to={`/${leagueSlug}/recovery-stats`} className="block text-cyan-400 hover:underline mt-2">{leagueLabel} recovery stats</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
