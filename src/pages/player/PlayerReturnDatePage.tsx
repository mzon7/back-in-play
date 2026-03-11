import { useParams, Link } from "react-router-dom";
import { usePlayerPage, type PlayerPageData, type PlayerInjury } from "../../hooks/usePlayerPage";
import { SEO } from "../../components/seo/SEO";
import { StatusBadge } from "../../components/StatusBadge";

const LEAGUE_LABELS: Record<string, string> = {
  nba: "NBA", nfl: "NFL", mlb: "MLB", nhl: "NHL", "premier-league": "EPL",
};
const LEAGUE_FULL: Record<string, string> = {
  nba: "NBA", nfl: "NFL", mlb: "MLB", nhl: "NHL", "premier-league": "Premier League",
};

function formatDate(d: string): string {
  return new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatDateLong(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function daysAgo(d: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000));
}

function teamSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function lastName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1];
}

function buildReturnBlurb(player: PlayerPageData, injury: PlayerInjury | undefined, league: string): string {
  const name = player.player_name;
  const last = lastName(name);
  const team = player.team_name;

  if (!injury) {
    return `${name} of the ${team} is not currently on the injury report. When will ${name} return? There is no current injury to recover from. This page tracks ${last}'s return timeline, expected return dates, and injury history with the ${team} (${league}).`;
  }

  const injType = injury.injury_type.toLowerCase();
  const dateStr = formatDate(injury.date_injured);

  if (injury.status === "returned" || injury.status === "active") {
    const returnStr = injury.return_date ? ` and returned on ${formatDate(injury.return_date)}` : "";
    const recov = injury.recovery_days
      ? ` Total recovery time was ${injury.recovery_days} days.`
      : "";
    return `When will ${name} return? ${last} has already returned to play for the ${team}. ${name} suffered a ${injType} injury on ${dateStr}${returnStr}.${recov} This page tracks ${last}'s return date, recovery timeline, and injury history (${league}).`;
  }

  const daysOut = daysAgo(injury.date_injured);
  const returnInfo = injury.expected_return
    ? ` The expected return date is ${injury.expected_return}.`
    : ` No official return date has been announced yet.`;
  const missed = injury.games_missed && injury.games_missed > 0
    ? ` ${last} has missed ${injury.games_missed} game${injury.games_missed > 1 ? "s" : ""} so far.`
    : "";
  return `When will ${name} return? ${name} of the ${team} has been out for ${daysOut} day${daysOut !== 1 ? "s" : ""} with a ${injType} injury suffered on ${dateStr}.${missed}${returnInfo} This page tracks the latest return date updates and recovery timeline for ${name} (${league}).`;
}

export default function PlayerReturnDatePage() {
  const { slug: rawSlug } = useParams<{ slug: string }>();
  // URL: /nick-chubb-return-date → strip "-return-date"
  const playerSlug = (rawSlug ?? "").replace(/-return-date$/, "");
  const { data: player, isLoading } = usePlayerPage(playerSlug);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#0a0f1a] flex items-center justify-center">
        <div className="animate-pulse text-white/40 text-sm">Loading...</div>
      </div>
    );
  }

  if (!player) {
    return (
      <div className="min-h-screen bg-[#0a0f1a] flex flex-col items-center justify-center gap-4">
        <p className="text-white/60">Player not found</p>
        <Link to="/" className="text-cyan-400 hover:underline text-sm">Back to Home</Link>
      </div>
    );
  }

  const currentInjury = player.injuries[0];
  const leagueLabel = LEAGUE_LABELS[player.league_slug] ?? player.league_name;
  const leagueFull = LEAGUE_FULL[player.league_slug] ?? leagueLabel;
  const year = new Date().getFullYear();
  const now = new Date().toISOString();

  const returnText = currentInjury?.expected_return ?? "No return date announced";
  const pageTitle = `${player.player_name} Return Date (${year}) - Latest Injury Update`;
  const pageDesc = `When will ${player.player_name} return? ${currentInjury ? `Current status: ${currentInjury.status.toUpperCase()}. ${currentInjury.injury_type}. Expected return: ${returnText}.` : "No current injury."} ${player.team_name} (${leagueLabel}).`;
  const path = `/${playerSlug}-return-date`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `${player.player_name} Return Date`,
    description: pageDesc,
    url: `https://backinplay.app${path}`,
    dateModified: now,
    about: {
      "@type": "Person",
      name: player.player_name,
      memberOf: { "@type": "SportsTeam", name: player.team_name },
    },
  };

  // Build injury timeline
  const timeline: { date: string; label: string }[] = [];
  for (const inj of [...player.injuries].reverse()) {
    timeline.push({ date: inj.date_injured, label: `${inj.injury_type}${inj.side ? ` (${inj.side})` : ""}` });
    if (inj.return_date) timeline.push({ date: inj.return_date, label: "Returned" });
  }

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white">
      <SEO title={pageTitle} description={pageDesc} path={path} type="article" dateModified={now} jsonLd={jsonLd} />

      {/* Breadcrumb */}
      <nav className="px-4 py-3 text-xs text-white/40 max-w-3xl mx-auto">
        <Link to="/" className="hover:text-white/60">Home</Link>
        {" / "}
        <Link to={`/${player.league_slug}-injuries`} className="hover:text-white/60">{leagueLabel} Injuries</Link>
        {" / "}
        <Link to={`/player/${player.slug}`} className="hover:text-white/60">{player.player_name}</Link>
        {" / "}
        <span className="text-white/60">Return Date</span>
      </nav>

      <div className="max-w-3xl mx-auto px-4 pb-12">
        {/* Last Updated (freshness signal) */}
        <p className="text-[11px] text-white/30 mb-3">
          Last updated: {formatDateLong(new Date())}
        </p>

        {/* Header */}
        <div className="flex items-start gap-4 mb-4">
          {player.headshot_url ? (
            <img src={player.headshot_url} alt={player.player_name} className="w-20 h-20 rounded-xl object-cover bg-white/5" />
          ) : (
            <div className="w-20 h-20 rounded-xl bg-white/5 flex items-center justify-center text-2xl text-white/20">
              {player.player_name[0]}
            </div>
          )}
          <div>
            <h1 className="text-2xl font-bold leading-tight">{player.player_name} Return Date</h1>
            <div className="flex items-center gap-2 mt-1 text-sm text-white/50">
              <span>{player.position}</span>
              <span>-</span>
              <Link to={`/${player.league_slug}/${teamSlug(player.team_name)}-injuries`} className="text-cyan-400 hover:underline">{player.team_name}</Link>
              <span>-</span>
              <span>{leagueLabel}</span>
            </div>
          </div>
        </div>

        {/* Unique SEO paragraph — natural language for Google indexing */}
        <p className="text-sm text-white/40 mb-6 leading-relaxed">
          {buildReturnBlurb(player, currentInjury, leagueLabel)}
        </p>

        {/* Return Date Card */}
        {currentInjury ? (
          <div className="bg-white/5 border border-white/10 rounded-xl p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Expected Return</h2>
              <StatusBadge status={currentInjury.status} />
            </div>
            <div className="text-3xl font-bold text-cyan-400 mb-4">
              {currentInjury.expected_return ?? "TBD"}
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-white/40 text-xs">Injury</dt>
                <dd className="font-medium">{currentInjury.injury_type}{currentInjury.side ? ` (${currentInjury.side})` : ""}</dd>
              </div>
              <div>
                <dt className="text-white/40 text-xs">Current Status</dt>
                <dd className="font-medium capitalize">{currentInjury.status.replace(/_/g, " ")}</dd>
              </div>
              <div>
                <dt className="text-white/40 text-xs">Date Injured</dt>
                <dd>{formatDate(currentInjury.date_injured)}</dd>
              </div>
              {currentInjury.return_date ? (
                <div>
                  <dt className="text-white/40 text-xs">Actual Return</dt>
                  <dd className="text-green-400">{formatDate(currentInjury.return_date)}</dd>
                </div>
              ) : (
                <div>
                  <dt className="text-white/40 text-xs">Days Out</dt>
                  <dd>{daysAgo(currentInjury.date_injured)}</dd>
                </div>
              )}
              {currentInjury.games_missed != null && currentInjury.games_missed > 0 && (
                <div>
                  <dt className="text-white/40 text-xs">Games Missed</dt>
                  <dd className="text-red-400">{currentInjury.games_missed}</dd>
                </div>
              )}
              {currentInjury.recovery_days != null && currentInjury.recovery_days > 0 && (
                <div>
                  <dt className="text-white/40 text-xs">Total Recovery</dt>
                  <dd>{currentInjury.recovery_days} days</dd>
                </div>
              )}
              {!currentInjury.recovery_days && !currentInjury.return_date && (
                <div>
                  <dt className="text-white/40 text-xs">Time Out So Far</dt>
                  <dd>{daysAgo(currentInjury.date_injured)} days</dd>
                </div>
              )}
            </dl>
          </div>
        ) : (
          <div className="bg-white/5 border border-white/10 rounded-xl p-6 mb-6 text-center">
            <p className="text-green-400 font-semibold text-lg mb-1">No Current Injury</p>
            <p className="text-white/40 text-sm">{player.player_name} is not currently on the injury report.</p>
          </div>
        )}

        {/* Is [Player] Playing Tonight? */}
        <div className="bg-white/5 border border-white/10 rounded-xl p-5 mb-6">
          <h2 className="text-lg font-semibold mb-2">Is {player.player_name} Playing Tonight?</h2>
          {currentInjury && currentInjury.status !== "returned" && currentInjury.status !== "active" ? (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <StatusBadge status={currentInjury.status} />
                <span className="text-sm text-white/60 capitalize">{currentInjury.status.replace(/_/g, " ")}</span>
              </div>
              <dl className="text-sm space-y-1 text-white/50">
                <div className="flex gap-2">
                  <dt className="text-white/30">Last injury:</dt>
                  <dd>{currentInjury.injury_type}</dd>
                </div>
                {currentInjury.expected_return && (
                  <div className="flex gap-2">
                    <dt className="text-white/30">Expected return:</dt>
                    <dd className="text-cyan-400">{currentInjury.expected_return}</dd>
                  </div>
                )}
              </dl>
            </div>
          ) : (
            <p className="text-green-400 text-sm">
              {player.player_name} is not currently listed on the injury report and is expected to be available.
            </p>
          )}
        </div>

        {/* Injury Timeline */}
        {timeline.length > 1 && (
          <div className="mb-6">
            <h2 className="text-lg font-semibold mb-3">Injury Timeline</h2>
            <div className="border-l-2 border-white/10 pl-4 space-y-3">
              {timeline.map((entry, i) => (
                <div key={i} className="relative">
                  <div className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white/20 bg-[#0a0f1a]" />
                  <p className="text-xs text-white/30">{formatDate(entry.date)}</p>
                  <p className="text-sm text-white/70">
                    {entry.label === "Returned" ? (
                      <span className="text-green-400">{entry.label}</span>
                    ) : entry.label}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Latest Updates */}
        {player.statusChanges.length > 0 && (
          <div className="mb-6">
            <h2 className="text-lg font-semibold mb-3">Latest Updates</h2>
            <div className="space-y-2">
              {player.statusChanges.slice(0, 10).map((sc) => (
                <div key={sc.id} className="flex items-start gap-3 text-sm">
                  <span className="text-white/30 text-xs whitespace-nowrap mt-0.5">
                    {formatDate(sc.changed_at.slice(0, 10))}
                  </span>
                  <span className="text-white/70">{sc.summary}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Related Players */}
        <div className="border-t border-white/10 pt-6 mb-6">
          <h3 className="text-white/40 text-xs uppercase tracking-wide mb-3">Related Players</h3>
          <div className="space-y-2 text-sm">
            {player.injuredTeammates.length > 0 && (
              <div>
                <p className="text-white/30 text-xs mb-1.5">Other {player.team_name} players</p>
                <div className="flex flex-wrap gap-1.5">
                  {player.injuredTeammates.map((t) => (
                    <Link
                      key={t.slug}
                      to={`/player/${t.slug}`}
                      className="px-2.5 py-1 rounded-full border border-white/10 text-[11px] text-cyan-400 hover:bg-white/5 transition-colors"
                    >
                      {t.player_name} <span className="text-white/25">{t.position}</span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
            <Link to={`/player/${player.slug}`} className="block text-cyan-400 hover:underline">
              Full injury history for {player.player_name}
            </Link>
            <Link to={`/${player.league_slug}/${teamSlug(player.team_name)}-injuries`} className="block text-cyan-400 hover:underline">
              {player.team_name} injury report
            </Link>
            <Link to={`/${player.league_slug}-injuries`} className="block text-cyan-400 hover:underline">
              All {leagueFull} injuries
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
