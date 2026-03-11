import { useParams, Link } from "react-router-dom";
import { usePlayerPage, type PlayerPageData, type PlayerInjury } from "../../hooks/usePlayerPage";
import { SEO, playerJsonLd } from "../../components/seo/SEO";
import { StatusBadge } from "../../components/StatusBadge";

const LEAGUE_LABELS: Record<string, string> = {
  nba: "NBA", nfl: "NFL", mlb: "MLB", nhl: "NHL", "premier-league": "EPL",
};
const LEAGUE_FULL: Record<string, string> = {
  nba: "NBA", nfl: "NFL", mlb: "MLB", nhl: "NHL", "premier-league": "Premier League",
};

function daysAgo(d: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000));
}

function formatDate(d: string): string {
  return new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatDateLong(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function teamSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function lastName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1];
}

function buildSeoBlurb(player: PlayerPageData, injury: PlayerInjury | undefined, league: string): string {
  const name = player.player_name;
  const last = lastName(name);
  const team = player.team_name;

  if (!injury) {
    return `${name} of the ${team} is not currently listed on the injury report. This page tracks ${last}'s latest injury status, recovery timeline, and full injury history with the ${team} (${league}).`;
  }

  const status = injury.status.replace(/_/g, " ");
  const injType = injury.injury_type.toLowerCase();
  const dateStr = formatDate(injury.date_injured);

  if (injury.status === "returned" || injury.status === "active") {
    const recov = injury.recovery_days
      ? ` ${last} was sidelined for ${injury.recovery_days} days before returning.`
      : "";
    const missed = injury.games_missed && injury.games_missed > 0
      ? ` The injury caused ${last} to miss ${injury.games_missed} game${injury.games_missed > 1 ? "s" : ""}.`
      : "";
    return `${name} of the ${team} is currently listed as ${status} after recovering from a ${injType} injury suffered on ${dateStr}.${recov}${missed} This page tracks ${last}'s latest injury status, recovery timeline, and injury history with the ${team} (${league}).`;
  }

  const returnInfo = injury.expected_return
    ? ` The expected return date is ${injury.expected_return}.`
    : " No official return date has been announced.";
  const daysOut = daysAgo(injury.date_injured);
  const missed = injury.games_missed && injury.games_missed > 0
    ? ` ${last} has missed ${injury.games_missed} game${injury.games_missed > 1 ? "s" : ""} so far.`
    : "";
  return `${name} of the ${team} is currently listed as ${status} due to a ${injType} injury suffered on ${dateStr}. ${last} has been out for ${daysOut} day${daysOut !== 1 ? "s" : ""}.${missed}${returnInfo} This page tracks the latest injury updates, recovery timeline, and injury history for ${name} (${league}).`;
}

export default function PlayerInjuryPage() {
  const { playerSlug } = useParams<{ playerSlug: string }>();
  const { data: player, isLoading } = usePlayerPage(playerSlug ?? "");

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#0a0f1a] flex items-center justify-center">
        <div className="animate-pulse text-white/40 text-sm">Loading player...</div>
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
  const pageTitle = `${player.player_name} Injury Update (${year}) - Status & Return Date`;
  const pageDesc = currentInjury
    ? `${player.player_name} injury status: ${currentInjury.status.toUpperCase()}. ${currentInjury.injury_type}. ${player.team_name} (${leagueLabel}). Expected return: ${currentInjury.expected_return ?? "TBD"}.`
    : `${player.player_name} injury history and status updates. ${player.team_name} (${leagueLabel}).`;

  const now = new Date().toISOString();
  const jsonLd = playerJsonLd({
    name: player.player_name,
    team: player.team_name,
    league: leagueLabel,
    status: currentInjury?.status ?? "active",
    injury: currentInjury?.injury_type ?? "None",
    dateModified: now,
    url: `https://backinplay.app/player/${player.slug}`,
  });

  // Build injury timeline from all injuries (most recent first → reverse for chronological)
  const timeline: { date: string; label: string }[] = [];
  for (const inj of [...player.injuries].reverse()) {
    timeline.push({ date: inj.date_injured, label: `${inj.injury_type}${inj.side ? ` (${inj.side})` : ""}` });
    if (inj.return_date) timeline.push({ date: inj.return_date, label: "Returned" });
  }

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white">
      <SEO title={pageTitle} description={pageDesc} path={`/player/${player.slug}`} type="article" dateModified={now} jsonLd={jsonLd} />

      {/* Breadcrumb */}
      <nav className="px-4 py-3 text-xs text-white/40 max-w-3xl mx-auto">
        <Link to="/" className="hover:text-white/60">Home</Link>
        {" / "}
        <Link to={`/${player.league_slug}-injuries`} className="hover:text-white/60">{leagueLabel} Injuries</Link>
        {" / "}
        <Link to={`/${player.league_slug}/${teamSlug(player.team_name)}-injuries`} className="hover:text-white/60">{player.team_name}</Link>
        {" / "}
        <span className="text-white/60">{player.player_name}</span>
      </nav>

      <div className="max-w-3xl mx-auto px-4 pb-12">
        {/* Last Updated (freshness signal) */}
        <p className="text-[11px] text-white/30 mb-3">
          Last updated: {formatDateLong(new Date())}
        </p>

        {/* Player Header */}
        <div className="flex items-start gap-4 mb-4">
          {player.headshot_url ? (
            <img src={player.headshot_url} alt={player.player_name} className="w-20 h-20 rounded-xl object-cover bg-white/5" />
          ) : (
            <div className="w-20 h-20 rounded-xl bg-white/5 flex items-center justify-center text-2xl text-white/20">
              {player.player_name[0]}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold leading-tight">{player.player_name} Injury Status</h1>
            <div className="flex flex-wrap items-center gap-2 mt-1 text-sm text-white/50">
              <span>{player.position}</span>
              <span>-</span>
              <Link to={`/${player.league_slug}/${teamSlug(player.team_name)}-injuries`} className="text-cyan-400 hover:underline">{player.team_name}</Link>
              <span>-</span>
              <Link to={`/${player.league_slug}-injuries`} className="text-cyan-400 hover:underline">{leagueLabel}</Link>
            </div>
            <div className="flex items-center gap-2 mt-2">
              {player.is_star && <span className="text-[10px] bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded-full font-bold">STAR</span>}
              {player.is_starter && !player.is_star && <span className="text-[10px] bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded-full font-bold">STARTER</span>}
              {player.league_rank && <span className="text-[10px] text-white/30">Rank #{player.league_rank}</span>}
            </div>
          </div>
        </div>

        {/* Unique SEO paragraph — natural language for Google indexing */}
        <p className="text-sm text-white/40 mb-6 leading-relaxed">
          {buildSeoBlurb(player, currentInjury, leagueLabel)}
        </p>

        {/* Is [Player] Playing Tonight? — always show, huge search query */}
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
                {!currentInjury.expected_return && (
                  <div className="flex gap-2">
                    <dt className="text-white/30">Out since:</dt>
                    <dd>{formatDate(currentInjury.date_injured)}</dd>
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

        {/* Current Status Card */}
        {currentInjury && (
          <div className="bg-white/5 border border-white/10 rounded-xl p-5 mb-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold">Current Status</h2>
              <StatusBadge status={currentInjury.status} />
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-white/40 text-xs">Injury</dt>
                <dd className="font-medium">{currentInjury.injury_type}{currentInjury.side ? ` (${currentInjury.side})` : ""}</dd>
              </div>
              <div>
                <dt className="text-white/40 text-xs">Date Injured</dt>
                <dd>{formatDate(currentInjury.date_injured)}</dd>
              </div>
              {currentInjury.expected_return && (
                <div>
                  <dt className="text-white/40 text-xs">Expected Return</dt>
                  <dd className="text-cyan-400">{currentInjury.expected_return}</dd>
                </div>
              )}
              {currentInjury.return_date && (
                <div>
                  <dt className="text-white/40 text-xs">Actual Return</dt>
                  <dd className="text-green-400">{formatDate(currentInjury.return_date)}</dd>
                </div>
              )}
              {currentInjury.games_missed != null && currentInjury.games_missed > 0 && (
                <div>
                  <dt className="text-white/40 text-xs">Games Missed</dt>
                  <dd className="text-red-400">{currentInjury.games_missed}</dd>
                </div>
              )}
              {currentInjury.recovery_days != null && currentInjury.recovery_days > 0 ? (
                <div>
                  <dt className="text-white/40 text-xs">Total Recovery</dt>
                  <dd>{currentInjury.recovery_days} days</dd>
                </div>
              ) : (
                <div>
                  <dt className="text-white/40 text-xs">Days Out</dt>
                  <dd>{daysAgo(currentInjury.date_injured)}</dd>
                </div>
              )}
            </dl>
            {currentInjury.injury_description && (
              <p className="mt-3 text-sm text-white/50">{currentInjury.injury_description}</p>
            )}
            {currentInjury.long_comment && (
              <p className="mt-2 text-sm text-white/40 italic">{currentInjury.long_comment}</p>
            )}
          </div>
        )}

        {/* Injury Timeline — readable chronological format */}
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

        {/* Latest Updates (Status Changes) */}
        {player.statusChanges.length > 0 && (
          <div className="mb-6">
            <h2 className="text-lg font-semibold mb-3">Latest Updates</h2>
            <div className="space-y-2">
              {player.statusChanges.map((sc) => (
                <div key={sc.id} className="flex items-start gap-3 text-sm">
                  <span className="text-white/30 text-xs whitespace-nowrap mt-0.5">
                    {formatDate(sc.changed_at.slice(0, 10))}
                  </span>
                  <div>
                    <span className="text-white/70">{sc.summary}</span>
                    {sc.old_status && sc.new_status && (
                      <span className="text-white/30 text-xs ml-2">
                        ({sc.old_status} &rarr; {sc.new_status})
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Injury History */}
        {player.injuries.length > 1 && (
          <div className="mb-6">
            <h2 className="text-lg font-semibold mb-3">Injury History</h2>
            <div className="space-y-3">
              {player.injuries.map((inj) => (
                <div key={inj.injury_id} className="bg-white/5 border border-white/10 rounded-lg p-3 flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{inj.injury_type}</span>
                      <StatusBadge status={inj.status} />
                    </div>
                    <div className="text-xs text-white/40 mt-1">
                      {formatDate(inj.date_injured)}
                      {inj.return_date && ` — ${formatDate(inj.return_date)}`}
                      {inj.games_missed != null && inj.games_missed > 0 && ` (${inj.games_missed} games missed)`}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Related Players — internal linking for SEO */}
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
            <Link to={`/${player.league_slug}/${teamSlug(player.team_name)}-injuries`} className="block text-cyan-400 hover:underline">
              All {player.team_name} injuries
            </Link>
            <Link to={`/${player.league_slug}-injuries`} className="block text-cyan-400 hover:underline">
              All {leagueFull} injuries
            </Link>
            <Link to={`/${player.slug}-return-date`} className="block text-cyan-400 hover:underline">
              {player.player_name} return date
            </Link>
            <Link to="/" className="block text-cyan-400 hover:underline">
              Back to all injury updates
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
