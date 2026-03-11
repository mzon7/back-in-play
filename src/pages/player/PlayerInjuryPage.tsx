import { useParams, Link } from "react-router-dom";
import { usePlayerPage } from "../../hooks/usePlayerPage";
import { SEO, playerJsonLd } from "../../components/seo/SEO";
import { StatusBadge } from "../../components/StatusBadge";

const LEAGUE_LABELS: Record<string, string> = {
  nba: "NBA", nfl: "NFL", mlb: "MLB", nhl: "NHL", "premier-league": "EPL",
};

function daysAgo(d: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000));
}

function formatDate(d: string): string {
  return new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function teamSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
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
  const pageTitle = `${player.player_name} Injury Update (${new Date().getFullYear()}) - Status & Return Date`;
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
        {/* Player Header */}
        <div className="flex items-start gap-4 mb-6">
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
              {currentInjury.games_missed != null && currentInjury.games_missed > 0 && (
                <div>
                  <dt className="text-white/40 text-xs">Games Missed</dt>
                  <dd className="text-red-400">{currentInjury.games_missed}</dd>
                </div>
              )}
              <div>
                <dt className="text-white/40 text-xs">Days Since Injury</dt>
                <dd>{daysAgo(currentInjury.date_injured)}</dd>
              </div>
              {currentInjury.recovery_days != null && (
                <div>
                  <dt className="text-white/40 text-xs">Recovery Days</dt>
                  <dd>{currentInjury.recovery_days}</dd>
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

        {/* Is [Player] Playing Tonight? */}
        {currentInjury && currentInjury.status !== "returned" && currentInjury.status !== "active" && (
          <div className="bg-white/5 border border-white/10 rounded-xl p-5 mb-6">
            <h2 className="text-lg font-semibold mb-2">Is {player.player_name} Playing Tonight?</h2>
            <div className="flex items-center gap-3">
              <StatusBadge status={currentInjury.status} />
              <span className="text-sm text-white/60">
                {currentInjury.expected_return
                  ? `Expected return: ${currentInjury.expected_return}`
                  : `Out since ${formatDate(currentInjury.date_injured)} — no return date announced`}
              </span>
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

        {/* Internal Links */}
        <div className="border-t border-white/10 pt-6 space-y-2 text-sm">
          <h3 className="text-white/40 text-xs uppercase tracking-wide mb-2">Related</h3>
          <Link to={`/${player.league_slug}/${teamSlug(player.team_name)}-injuries`} className="block text-cyan-400 hover:underline">
            See all {player.team_name} injuries
          </Link>
          <Link to={`/${player.league_slug}-injuries`} className="block text-cyan-400 hover:underline">
            See all {leagueLabel} injuries
          </Link>
          <Link to="/" className="block text-cyan-400 hover:underline">
            Back to all injury updates
          </Link>
        </div>

        {/* Last updated timestamp */}
        <p className="mt-6 text-[10px] text-white/20">
          Last updated: {new Date().toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}
        </p>
      </div>
    </div>
  );
}
