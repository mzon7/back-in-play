import { useParams, Link } from "react-router-dom";
import { usePlayerPage } from "../../hooks/usePlayerPage";
import { SEO } from "../../components/seo/SEO";
import { StatusBadge } from "../../components/StatusBadge";

const LEAGUE_LABELS: Record<string, string> = {
  nba: "NBA", nfl: "NFL", mlb: "MLB", nhl: "NHL", "premier-league": "EPL",
};

function formatDate(d: string): string {
  return new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function daysAgo(d: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000));
}

function teamSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
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
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
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
              <div>
                <dt className="text-white/40 text-xs">Days Out</dt>
                <dd>{daysAgo(currentInjury.date_injured)}</dd>
              </div>
              {currentInjury.games_missed != null && currentInjury.games_missed > 0 && (
                <div>
                  <dt className="text-white/40 text-xs">Games Missed</dt>
                  <dd className="text-red-400">{currentInjury.games_missed}</dd>
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
            <div className="flex items-center gap-3">
              <StatusBadge status={currentInjury.status} />
              <span className="text-sm text-white/60">
                {currentInjury.expected_return
                  ? `Expected return: ${currentInjury.expected_return}`
                  : `Out since ${formatDate(currentInjury.date_injured)} — no return date announced`}
              </span>
            </div>
          ) : (
            <p className="text-green-400 text-sm">
              {player.player_name} is not currently listed on the injury report and is expected to be available.
            </p>
          )}
        </div>

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

        {/* Internal Links */}
        <div className="border-t border-white/10 pt-6 space-y-2 text-sm">
          <Link to={`/player/${player.slug}`} className="block text-cyan-400 hover:underline">
            Full injury history for {player.player_name}
          </Link>
          <Link to={`/${player.league_slug}/${teamSlug(player.team_name)}-injuries`} className="block text-cyan-400 hover:underline">
            {player.team_name} injury report
          </Link>
          <Link to={`/${player.league_slug}-injuries`} className="block text-cyan-400 hover:underline">
            All {leagueLabel} injuries
          </Link>
        </div>

        <p className="mt-6 text-[10px] text-white/20">
          Last updated: {new Date().toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}
        </p>
      </div>
    </div>
  );
}
