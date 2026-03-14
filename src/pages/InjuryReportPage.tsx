import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { SiteHeader } from "../components/SiteHeader";
import { SEO } from "../components/seo/SEO";
import { breadcrumbJsonLd, faqJsonLd, jsonLdGraph } from "../components/seo/seoHelpers";
import { PlayerAvatar } from "../components/PlayerAvatar";
import { StatusBadge } from "../components/StatusBadge";
import { supabase, dbTable } from "../lib/supabase";
import { leagueColor } from "../lib/leagueColors";

const LEAGUE_LABELS: Record<string, string> = { nba: "NBA", nfl: "NFL", mlb: "MLB", nhl: "NHL", "premier-league": "EPL" };
const LEAGUE_FULL: Record<string, string> = { nba: "National Basketball Association", nfl: "National Football League", mlb: "Major League Baseball", nhl: "National Hockey League", "premier-league": "English Premier League" };
const LEAGUE_SPORT: Record<string, string> = { nba: "basketball", nfl: "football", mlb: "baseball", nhl: "hockey", "premier-league": "football (soccer)" };

const OUT_STATUSES = ["out", "ir", "il-10", "il-15", "il-60", "il-7", "injured_reserve", "suspended"];
const QUESTIONABLE_STATUSES = ["questionable", "doubtful", "day-to-day", "day_to_day", "probable", "game_time_decision"];

function formatDate(d: string): string {
  return new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function formatDateLong(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}
function daysAgo(d: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000));
}
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export default function InjuryReportPage() {
  const { slug } = useParams<{ slug: string }>();
  const parts = (slug ?? "").match(/^(.+?)-injury-report(?:-(.+))?$/);
  const leagueSlug = parts?.[1] ?? "";

  const leagueLabel = LEAGUE_LABELS[leagueSlug] ?? leagueSlug.toUpperCase();
  const leagueFull = LEAGUE_FULL[leagueSlug] ?? leagueLabel;
  const leagueSport = LEAGUE_SPORT[leagueSlug] ?? "sports";
  const accent = leagueColor(leagueSlug);
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const todayFormatted = formatDateLong(today);

  const playersTable = dbTable("players");
  const teamsTable = dbTable("teams");

  const { data, isLoading } = useQuery({
    queryKey: ["injury-report", leagueSlug],
    queryFn: async () => {
      const { data: league } = await supabase
        .from(dbTable("leagues"))
        .select("league_id")
        .eq("slug", leagueSlug)
        .single();
      if (!league) return { injuries: [], returning: [] };

      const { data: injuries } = await supabase
        .from(dbTable("injuries"))
        .select(
          "injury_id, injury_type, injury_type_slug, status, date_injured, return_date, expected_return, expected_return_date, games_missed, recovery_days, side, " +
          playersTable + "!inner(player_id, player_name, slug, position, headshot_url, is_star, is_starter, team_id, " +
          teamsTable + "!inner(team_name))"
        )
        .eq(playersTable + ".league_id", league.league_id)
        .neq("status", "returned")
        .order("date_injured", { ascending: false })
        .limit(500);

      const { data: returning } = await supabase
        .from(dbTable("injuries"))
        .select(
          "injury_id, injury_type, status, date_injured, return_date, games_missed, recovery_days, " +
          playersTable + "!inner(player_id, player_name, slug, position, headshot_url, team_id, " +
          teamsTable + "!inner(team_name))"
        )
        .eq(playersTable + ".league_id", league.league_id)
        .eq("status", "returned")
        .gte("return_date", todayStr)
        .order("return_date", { ascending: true })
        .limit(50);

      return { injuries: injuries ?? [], returning: returning ?? [] };
    },
    staleTime: 5 * 60 * 1000,
  });

  const injuries = data?.injuries ?? [];
  const returning = data?.returning ?? [];

  // Helper to get nested player data (Supabase joins)
  const getPlayer = (inj: any) => inj[playersTable] ?? inj.players ?? inj;
  const getTeam = (player: any) => player[teamsTable] ?? player.teams ?? {};

  // Categorize injuries
  const majorInjuries = useMemo(() => {
    return injuries
      .filter((inj: any) => OUT_STATUSES.includes(inj.status))
      .sort((a: any, b: any) => {
        const pA = getPlayer(a);
        const pB = getPlayer(b);
        if (pA.is_star !== pB.is_star) return pA.is_star ? -1 : 1;
        if (pA.is_starter !== pB.is_starter) return pA.is_starter ? -1 : 1;
        return new Date(b.date_injured).getTime() - new Date(a.date_injured).getTime();
      });
  }, [injuries]);

  const questionableInjuries = useMemo(() => {
    return injuries
      .filter((inj: any) => QUESTIONABLE_STATUSES.includes(inj.status))
      .sort((a: any, b: any) => {
        const pA = getPlayer(a);
        const pB = getPlayer(b);
        if (pA.is_star !== pB.is_star) return pA.is_star ? -1 : 1;
        return new Date(b.date_injured).getTime() - new Date(a.date_injured).getTime();
      });
  }, [injuries]);

  // Analytics computations
  const analytics = useMemo(() => {
    if (injuries.length === 0) return null;

    // Most common injury type
    const typeCounts: Record<string, number> = {};
    const posCounts: Record<string, number> = {};
    const teamCounts: Record<string, number> = {};
    let totalDaysOut = 0;
    let daysCount = 0;

    for (const inj of injuries as any[]) {
      const p = getPlayer(inj);
      const t = getTeam(p);
      typeCounts[inj.injury_type] = (typeCounts[inj.injury_type] || 0) + 1;
      if (p.position) posCounts[p.position] = (posCounts[p.position] || 0) + 1;
      if (t.team_name) teamCounts[t.team_name] = (teamCounts[t.team_name] || 0) + 1;
      const days = inj.recovery_days ?? daysAgo(inj.date_injured);
      if (days > 0) { totalDaysOut += days; daysCount++; }
    }

    const sortedTypes = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
    const sortedPositions = Object.entries(posCounts).sort((a, b) => b[1] - a[1]);
    const sortedTeams = Object.entries(teamCounts).sort((a, b) => b[1] - a[1]);

    return {
      totalInjured: injuries.length,
      totalQuestionable: questionableInjuries.length,
      totalOut: majorInjuries.length,
      totalReturning: returning.length,
      mostCommonInjury: sortedTypes[0] ?? ["Unknown", 0],
      topInjuries: sortedTypes.slice(0, 5),
      mostAffectedPosition: sortedPositions[0] ?? ["Unknown", 0],
      topPositions: sortedPositions.slice(0, 4),
      mostInjuredTeam: sortedTeams[0] ?? ["Unknown", 0],
      topTeams: sortedTeams.slice(0, 3),
      avgDaysOut: daysCount > 0 ? Math.round(totalDaysOut / daysCount) : 0,
    };
  }, [injuries, majorInjuries, questionableInjuries, returning]);

  // Star players for FAQ
  const starPlayersOut = useMemo(() => {
    return majorInjuries
      .filter((inj: any) => getPlayer(inj).is_star)
      .slice(0, 5);
  }, [majorInjuries]);

  // FAQ data
  const faqItems = useMemo(() => {
    const items: { question: string; answer: string }[] = [];

    const topNames = majorInjuries.slice(0, 5).map((inj: any) => {
      const p = getPlayer(inj);
      return `${p.player_name} (${inj.injury_type}, ${inj.status.toUpperCase()})`;
    });

    items.push({
      question: `Who is injured in the ${leagueLabel} today?`,
      answer: injuries.length > 0
        ? `The ${leagueLabel} currently has ${injuries.length} players on the injury report. Key injuries include: ${topNames.join(", ")}. Check this page for the complete and updated list.`
        : `No ${leagueLabel} injuries are currently being tracked. Check back during the regular season for daily updates.`,
    });

    if (starPlayersOut.length > 0) {
      const starPlayer = starPlayersOut[0] as any;
      const sp = getPlayer(starPlayer);
      items.push({
        question: `When will ${sp.player_name} return?`,
        answer: starPlayer.expected_return
          ? `${sp.player_name} is expected to return ${starPlayer.expected_return}. He has been out since ${formatDate(starPlayer.date_injured)} with ${starPlayer.injury_type.toLowerCase()}${starPlayer.games_missed ? `, missing ${starPlayer.games_missed} games` : ""}.`
          : `${sp.player_name} has been out since ${formatDate(starPlayer.date_injured)} with ${starPlayer.injury_type.toLowerCase()}. No official return date has been announced yet.`,
      });
    }

    items.push({
      question: `How many ${leagueLabel} players are currently injured?`,
      answer: `As of ${todayFormatted}, ${injuries.length} ${leagueLabel} players are currently on the injury report. ${majorInjuries.length} are listed as out or on injured reserve, and ${questionableInjuries.length} are questionable or day-to-day.`,
    });

    return items;
  }, [injuries, majorInjuries, questionableInjuries, starPlayersOut, leagueLabel, todayFormatted]);

  // SEO
  const seoTitle = `${leagueLabel} Injury Report Today (${today.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })})`;
  const seoDesc = `${leagueLabel} injury report for ${todayFormatted}. ${injuries.length} players injured, ${questionableInjuries.length} questionable. Latest ${leagueLabel} injury updates, return dates, and performance analysis.`;
  const path = `/${leagueSlug}-injury-report`;

  const jsonLd = jsonLdGraph(
    breadcrumbJsonLd([
      { name: "Home", path: "/" },
      { name: `${leagueLabel} Injuries`, path: `/${leagueSlug}-injuries` },
      { name: "Injury Report Today", path },
    ]),
    faqJsonLd(faqItems)
  );

  function InjuryCard({ inj, compact = false }: { inj: any; compact?: boolean }) {
    const p = getPlayer(inj);
    const t = getTeam(p);
    const days = inj.recovery_days ?? daysAgo(inj.date_injured);
    const playerSlug = p.slug ?? slugify(p.player_name);

    return (
      <div className={`rounded-xl border border-white/10 ${compact ? "bg-white/[0.03]" : "bg-white/5"} p-4 hover:bg-white/[0.06] transition-colors`}>
        <div className="flex items-start gap-3">
          <PlayerAvatar src={p.headshot_url} name={p.player_name} size={48} className="rounded-full" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Link
                to={`/player/${playerSlug}`}
                className="text-sm font-semibold text-white hover:text-[#1C7CFF] transition-colors"
              >
                {p.player_name}
              </Link>
              <StatusBadge status={inj.status} />
              {p.is_star && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 font-bold">STAR</span>
              )}
              {p.is_starter && !p.is_star && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 font-bold">STARTER</span>
              )}
            </div>

            <div className="flex items-center gap-2 mt-0.5 text-xs text-white/40">
              {p.position && <span>{p.position}</span>}
              {p.position && <span>·</span>}
              <span>{t.team_name}</span>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span className="text-white/50">
                <span className="text-white/30">Injury:</span>{" "}
                <Link
                  to={`/${leagueSlug}/${inj.injury_type_slug ?? slugify(inj.injury_type)}-injury-performance`}
                  className="hover:text-[#1C7CFF] transition-colors"
                >
                  {inj.injury_type}{inj.side ? ` (${inj.side})` : ""}
                </Link>
              </span>
              <span className="text-white/50">
                <span className="text-white/30">Since:</span> {formatDate(inj.date_injured)}
              </span>
              <span className="text-white/50">
                <span className="text-white/30">Days out:</span> {days}
              </span>
              {inj.games_missed != null && inj.games_missed > 0 && (
                <span className="text-white/50">
                  <span className="text-white/30">Games missed:</span> {inj.games_missed}
                </span>
              )}
              {inj.expected_return && (
                <span className="text-amber-400/80">
                  <span className="text-white/30">Return:</span> {inj.expected_return}
                </span>
              )}
              {inj.expected_return_date && !inj.expected_return && (
                <span className="text-amber-400/80">
                  <span className="text-white/30">ETA:</span> {formatDate(inj.expected_return_date)}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  function ReturningCard({ inj }: { inj: any }) {
    const p = getPlayer(inj);
    const t = getTeam(p);
    const playerSlug = p.slug ?? slugify(p.player_name);
    const injSlug = slugify(inj.injury_type);

    return (
      <div className="rounded-xl border border-green-500/20 bg-green-500/5 p-4 hover:bg-green-500/[0.08] transition-colors">
        <div className="flex items-start gap-3">
          <PlayerAvatar src={p.headshot_url} name={p.player_name} size={44} className="rounded-full" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Link
                to={`/player/${playerSlug}`}
                className="text-sm font-semibold text-white hover:text-[#1C7CFF] transition-colors"
              >
                {p.player_name}
              </Link>
              <StatusBadge status="returned" />
            </div>
            <div className="text-xs text-white/40 mt-0.5">{t.team_name}</div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span className="text-white/50">
                <span className="text-white/30">Recovered from:</span> {inj.injury_type}
              </span>
              {inj.games_missed != null && inj.games_missed > 0 && (
                <span className="text-white/50">
                  <span className="text-white/30">Missed:</span> {inj.games_missed} games
                </span>
              )}
              {inj.recovery_days != null && (
                <span className="text-white/50">
                  <span className="text-white/30">Recovery:</span> {inj.recovery_days} days
                </span>
              )}
              <Link
                to={`/${leagueSlug}/${injSlug}-injury-performance`}
                className="text-[#1C7CFF] hover:underline"
              >
                View performance curve
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0A0F1E] text-white">
      <SEO
        title={seoTitle}
        description={seoDesc}
        path={path}
        jsonLd={jsonLd}
        dateModified={new Date().toISOString()}
      />
      <SiteHeader />

      {/* Hero */}
      <div className="relative overflow-hidden border-b border-white/10 bg-gradient-to-br from-[#0A0F1E] via-[#0d1529] to-[#0A0F1E]">
        <div
          className="pointer-events-none absolute -top-32 -left-32 w-96 h-96 rounded-full opacity-10 blur-3xl"
          style={{ backgroundColor: accent }}
        />
        <div className="relative max-w-4xl mx-auto px-4 sm:px-6 py-10">
          {/* Breadcrumb */}
          <nav className="text-sm text-white/40 mb-4">
            <Link to="/" className="hover:text-white/60">Home</Link>
            {" / "}
            <Link to={`/${leagueSlug}-injuries`} className="hover:text-white/60">{leagueLabel} Injuries</Link>
            {" / "}
            <span className="text-white/60">Injury Report Today</span>
          </nav>

          <div className="flex items-center gap-3 mb-3">
            <span
              className="w-2.5 h-2.5 rounded-full"
              style={{ backgroundColor: accent }}
            />
            <span className="text-xs font-bold uppercase tracking-[0.2em]" style={{ color: accent }}>
              {leagueLabel} Injury Report
            </span>
          </div>

          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-3">
            <span className="text-white">{leagueLabel} Injury Report Today </span>
            <span className="bg-gradient-to-r from-[#3DFF8F] to-[#1C7CFF] bg-clip-text text-transparent">
              — {todayFormatted}
            </span>
          </h1>

          {!isLoading && analytics && (
            <p className="text-white/50 text-sm max-w-2xl mb-4">
              {analytics.totalInjured} players currently injured, {analytics.totalQuestionable} questionable,{" "}
              {analytics.totalReturning} returning this week.
            </p>
          )}

          <div className="flex flex-wrap gap-3 mt-2">
            {!isLoading && (
              <>
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-white/60">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                  Updated {todayFormatted}
                </span>
                <span className="inline-flex items-center px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-white/60">
                  {injuries.length} total injuries tracked
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-24 rounded-xl bg-white/10 animate-pulse" />
            ))}
          </div>
        ) : (
          <>
            {/* ===== MAJOR INJURIES ===== */}
            {majorInjuries.length > 0 && (
              <section className="mb-10">
                <h2 className="text-xl font-bold mb-1 flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
                  Major Injuries — Out / Injured Reserve ({majorInjuries.length})
                </h2>
                <p className="text-xs text-white/30 mb-4">
                  Players confirmed out or placed on injured reserve. Sorted by star status and recency.
                </p>
                <div className="space-y-3">
                  {majorInjuries.map((inj: any) => (
                    <InjuryCard key={inj.injury_id} inj={inj} />
                  ))}
                </div>
              </section>
            )}

            {/* ===== QUESTIONABLE / DAY-TO-DAY ===== */}
            {questionableInjuries.length > 0 && (
              <section className="mb-10">
                <h2 className="text-xl font-bold mb-1 flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
                  Questionable / Day-to-Day ({questionableInjuries.length})
                </h2>
                <p className="text-xs text-white/30 mb-4">
                  Players with uncertain availability. Game-time decisions and day-to-day designations.
                </p>
                <div className="space-y-3">
                  {questionableInjuries.map((inj: any) => (
                    <InjuryCard key={inj.injury_id} inj={inj} compact />
                  ))}
                </div>
              </section>
            )}

            {/* ===== PLAYERS RETURNING ===== */}
            {returning.length > 0 && (
              <section className="mb-10">
                <h2 className="text-xl font-bold mb-1 flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-green-400" />
                  Players Returning This Week ({returning.length})
                </h2>
                <p className="text-xs text-white/30 mb-4">
                  Recently returned or expected back this week. Performance curves show historical return-from-injury trends.
                </p>
                <div className="space-y-3">
                  {returning.map((inj: any) => (
                    <ReturningCard key={inj.injury_id} inj={inj} />
                  ))}
                </div>
              </section>
            )}

            {/* ===== EMPTY STATE ===== */}
            {injuries.length === 0 && returning.length === 0 && (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-8 text-center mb-10">
                <p className="text-white/50">No {leagueLabel} injuries currently being tracked.</p>
                <p className="text-xs text-white/30 mt-2">Check back during the season for daily injury report updates.</p>
              </div>
            )}

            {/* ===== KEY FINDINGS ===== */}
            {analytics && analytics.totalInjured > 0 && (
              <section className="mb-10 rounded-xl border border-white/10 bg-white/[0.03] p-6">
                <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
                  Key Findings
                </h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="rounded-lg bg-white/5 p-4 border border-white/5">
                    <p className="text-[10px] uppercase tracking-wider text-white/30 mb-1">Most Common Injury</p>
                    <p className="text-base font-semibold text-white">
                      {analytics.mostCommonInjury[0]}
                    </p>
                    <p className="text-xs text-white/40">{analytics.mostCommonInjury[1]} active cases</p>
                  </div>
                  <div className="rounded-lg bg-white/5 p-4 border border-white/5">
                    <p className="text-[10px] uppercase tracking-wider text-white/30 mb-1">Most Affected Position</p>
                    <p className="text-base font-semibold text-white">
                      {analytics.mostAffectedPosition[0]}
                    </p>
                    <p className="text-xs text-white/40">
                      {analytics.mostAffectedPosition[1]} players ({Math.round((Number(analytics.mostAffectedPosition[1]) / analytics.totalInjured) * 100)}% of injuries)
                    </p>
                  </div>
                  <div className="rounded-lg bg-white/5 p-4 border border-white/5">
                    <p className="text-[10px] uppercase tracking-wider text-white/30 mb-1">Most Affected Team</p>
                    <p className="text-base font-semibold text-white">
                      {analytics.mostInjuredTeam[0]}
                    </p>
                    <p className="text-xs text-white/40">{analytics.mostInjuredTeam[1]} players out</p>
                  </div>
                  <div className="rounded-lg bg-white/5 p-4 border border-white/5">
                    <p className="text-[10px] uppercase tracking-wider text-white/30 mb-1">Average Time Out</p>
                    <p className="text-base font-semibold text-white">
                      {analytics.avgDaysOut} days
                    </p>
                    <p className="text-xs text-white/40">Across {analytics.totalInjured} current injuries</p>
                  </div>
                </div>

                {analytics.topInjuries.length > 1 && (
                  <div className="mt-4">
                    <p className="text-[10px] uppercase tracking-wider text-white/30 mb-2">Top Injury Types</p>
                    <div className="flex flex-wrap gap-2">
                      {analytics.topInjuries.map(([type, count]) => (
                        <Link
                          key={type}
                          to={`/${leagueSlug}/${slugify(type)}-injury-performance`}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/5 border border-white/10 text-xs text-white/60 hover:text-white hover:bg-white/10 transition-colors"
                        >
                          {type} <span className="text-white/30">({count})</span>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            )}

            {/* ===== INJURY ANALYTICS (PROSE) ===== */}
            <section className="mb-10 border-t border-white/8 pt-8">
              <h2 className="text-lg font-bold mb-4">
                {leagueLabel} Injury Analysis — {todayFormatted}
              </h2>
              <div className="text-sm text-white/50 leading-relaxed space-y-3">
                {analytics && analytics.totalInjured > 0 ? (
                  <>
                    <p>
                      The {leagueFull} currently has {analytics.totalInjured} players sidelined across
                      all teams. {analytics.totalOut} players are confirmed out or on injured reserve,
                      while {analytics.totalQuestionable} carry questionable, doubtful, or day-to-day
                      designations heading into today's games. The most common injury
                      is {(analytics.mostCommonInjury[0] as string).toLowerCase()} with{" "}
                      {analytics.mostCommonInjury[1]} active cases, followed by{" "}
                      {analytics.topInjuries.length > 1 ? `${(analytics.topInjuries[1][0] as string).toLowerCase()} (${analytics.topInjuries[1][1]} cases)` : "other soft tissue injuries"}.
                    </p>
                    <p>
                      Position-wise, {analytics.mostAffectedPosition[0]}s account for{" "}
                      {Math.round((Number(analytics.mostAffectedPosition[1]) / analytics.totalInjured) * 100)}%
                      of all current {leagueLabel} injuries. The {analytics.mostInjuredTeam[0]} lead the
                      league with {analytics.mostInjuredTeam[1]} players currently on the injury report,
                      which could significantly impact their lineup and rotation over the coming weeks.
                      On average, currently injured players have been sidelined for {analytics.avgDaysOut} days.
                    </p>
                    <p>
                      Based on historical performance data from Back In Play's database of over 50,000 injury
                      return cases, players returning from{" "}
                      {(analytics.mostCommonInjury[0] as string).toLowerCase()} injuries typically perform at
                      80-90% of their pre-injury baseline in their first game back. This drop-off is important
                      for fantasy {leagueSport} managers setting lineups and bettors evaluating player props.
                      Minutes restrictions are common in the first 1-3 games after return, particularly for
                      players who missed more than 10 games.
                    </p>
                    <p>
                      For the latest return timelines and projected performance levels, explore
                      our <Link to={`/${leagueSlug}-injury-performance`} className="text-[#1C7CFF] hover:underline">
                      {leagueLabel} injury performance curves</Link>,{" "}
                      <Link to="/recovery-stats" className="text-[#1C7CFF] hover:underline">recovery statistics</Link>,
                      and <Link to={`/${leagueSlug}/minutes-restriction-after-injury`} className="text-[#1C7CFF] hover:underline">
                      minutes restriction data</Link>. Fantasy and DFS players should also check{" "}
                      <Link to="/props" className="text-[#1C7CFF] hover:underline">today's player props</Link> for
                      adjusted lines on recently returned athletes.
                    </p>
                  </>
                ) : (
                  <>
                    <p>
                      The {leagueFull} injury report is currently empty, which typically occurs during
                      the offseason or between game days. During the regular season, this page is updated
                      daily with comprehensive injury data for all {leagueLabel} teams, including injury type,
                      status designations, expected return dates, and games missed.
                    </p>
                    <p>
                      Back In Play tracks every {leagueLabel} injury and matches it against our database
                      of over 50,000 historical injury return cases to project how returning players
                      will perform. Our performance curves show the typical recovery trajectory for
                      each injury type, helping fantasy managers and bettors make informed decisions
                      on player props, lineup construction, and trade evaluations.
                    </p>
                  </>
                )}
              </div>
            </section>

            {/* ===== FAQ ===== */}
            <section className="mb-10 border-t border-white/8 pt-8">
              <h2 className="text-lg font-bold mb-4">
                Frequently Asked Questions
              </h2>
              <div className="space-y-4">
                {faqItems.map((item, i) => (
                  <details key={i} className="group rounded-xl border border-white/10 bg-white/[0.03]">
                    <summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-white/80 hover:text-white transition-colors list-none flex items-center justify-between">
                      {item.question}
                      <span className="text-white/20 group-open:rotate-45 transition-transform text-lg">+</span>
                    </summary>
                    <div className="px-5 pb-4 text-sm text-white/50 leading-relaxed">
                      {item.answer}
                    </div>
                  </details>
                ))}
              </div>
            </section>

            {/* ===== RELATED LINKS ===== */}
            <section className="mb-10 border-t border-white/8 pt-8">
              <h2 className="text-sm font-bold uppercase tracking-wide text-white/40 mb-4">
                Related {leagueLabel} Pages
              </h2>
              <div className="grid gap-2 sm:grid-cols-2">
                <Link to={`/${leagueSlug}-injury-performance`} className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
                  {leagueLabel} Injury Performance Curves
                </Link>
                <Link to={`/${leagueSlug}-injury-analysis`} className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
                  {leagueLabel} Injury Analysis
                </Link>
                <Link to={`/${leagueSlug}/returning-today`} className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
                  {leagueLabel} Players Returning Today
                </Link>
                <Link to={`/${leagueSlug}/minutes-restriction-after-injury`} className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
                  {leagueLabel} Minutes Restriction After Injury
                </Link>
                <Link to={`/${leagueSlug}/players-returning-from-injury-this-week`} className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
                  {leagueLabel} Players Returning This Week
                </Link>
                <Link to="/performance-curves" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
                  Performance Curves — All Leagues
                </Link>
                <Link to="/recovery-stats" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
                  Recovery Statistics
                </Link>
                <Link to="/props" className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
                  Player Props — Today's Lines
                </Link>
                {/* Top affected teams */}
                {analytics?.topTeams.map(([team]) => (
                  <Link
                    key={team}
                    to={`/${leagueSlug}/team/${slugify(team as string)}`}
                    className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors"
                  >
                    {team} Injury Report
                  </Link>
                ))}
              </div>
            </section>

            {/* ===== CROSS-LEAGUE LINKS ===== */}
            <section className="mb-10 border-t border-white/8 pt-8">
              <h2 className="text-sm font-bold uppercase tracking-wide text-white/40 mb-4">
                Other League Injury Reports
              </h2>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {Object.entries(LEAGUE_LABELS)
                  .filter(([slug]) => slug !== leagueSlug)
                  .map(([slug, label]) => (
                    <Link
                      key={slug}
                      to={`/${slug}-injury-report`}
                      className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors flex items-center gap-2"
                    >
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: leagueColor(slug) }} />
                      {label} Injury Report Today
                    </Link>
                  ))}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
