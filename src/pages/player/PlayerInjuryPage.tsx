// @refresh reset
import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { isTrackedPlayer, addTrackedPlayer, removeTrackedPlayer } from "../../lib/trackedPlayers";
import { SiteHeader } from "../../components/SiteHeader";
import { usePlayerPage, type PlayerPageData, type PlayerInjury } from "../../hooks/usePlayerPage";
import { useInjuryImpact } from "../../hooks/useInjuryImpact";
import { usePerformanceCurve, usePlayerReturnCase } from "../../features/performance-curves/lib/queries";
import { PerformanceCurveChart } from "../../features/performance-curves/components/PerformanceCurveChart";
import { SEO } from "../../components/seo/SEO";
import { playerJsonLd } from "../../components/seo/seoHelpers";
import { PlayerAvatar } from "../../components/PlayerAvatar";
import { StatusBadge } from "../../components/StatusBadge";
import { useSinglePlayerProps, type PropRow } from "../../hooks/useInjuries";

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

/** Display "unspecified" instead of "other" for injury types */
function displayInjuryType(type: string): string {
  return type.toLowerCase() === "other" ? "Unspecified" : type;
}

function teamSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Group injuries into season buckets. NBA/NHL/NFL span two calendar years. */
function getSeasonLabel(dateStr: string, leagueSlug: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const month = d.getMonth(); // 0-indexed
  const year = d.getFullYear();
  if (leagueSlug === "mlb") return `${year} Season`;
  // For NBA/NHL/NFL/EPL — if month >= August, it's the start of year/year+1 season
  if (month >= 7) return `${year}–${String(year + 1).slice(2)} Season`;
  return `${year - 1}–${String(year).slice(2)} Season`;
}

function groupInjuriesBySeason(injuries: PlayerInjury[], leagueSlug: string) {
  const groups: { season: string; injuries: PlayerInjury[] }[] = [];
  const map = new Map<string, PlayerInjury[]>();
  for (const inj of injuries) {
    const season = getSeasonLabel(inj.date_injured, leagueSlug);
    if (!map.has(season)) map.set(season, []);
    map.get(season)!.push(inj);
  }
  for (const [season, injs] of map) {
    groups.push({ season, injuries: injs });
  }
  return groups;
}

function formatDateShort(d: string): string {
  return new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function InjuryCard({ inj }: { inj: PlayerInjury }) {
  const injLabel = displayInjuryType(inj.injury_type).toUpperCase() + (inj.side ? ` (${inj.side})` : "");
  const dateRange = inj.return_date
    ? `${formatDateShort(inj.date_injured)} → ${formatDateShort(inj.return_date)}`
    : `${formatDateShort(inj.date_injured)} → present`;
  const year = inj.date_injured.slice(0, 4);

  return (
    <div className="bg-white/5 border border-white/10 rounded-lg px-4 py-3 flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-semibold">{injLabel}</span>
          <StatusBadge status={inj.status} />
        </div>
        <p className="text-xs text-white/45">{dateRange}, {year}</p>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-xs text-white/40">
          {inj.recovery_days != null && inj.recovery_days > 0 && inj.recovery_days < 730 && (
            <span>{inj.recovery_days}d recovery</span>
          )}
          {inj.games_missed != null && inj.games_missed > 0 && (
            <span className="text-red-400/70">{inj.games_missed} games missed</span>
          )}
        </div>
      </div>
    </div>
  );
}

function SeasonGroup({ season, injuries, defaultOpen }: { season: string; injuries: PlayerInjury[]; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const totalMissed = injuries.reduce((sum, i) => sum + (i.games_missed ?? 0), 0);

  return (
    <div className="border border-white/10 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 bg-white/5 hover:bg-white/8 transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <span className={`text-xs transition-transform ${open ? "rotate-90" : ""}`}>&#9654;</span>
          <span className="text-sm font-semibold">{season}</span>
          <span className="text-xs text-white/40">{injuries.length} {injuries.length === 1 ? "injury" : "injuries"}</span>
        </div>
        {totalMissed > 0 && (
          <span className="text-xs text-red-400/70">{totalMissed} games missed</span>
        )}
      </button>
      {open && (
        <div className="p-3 space-y-2">
          {injuries.map((inj) => (
            <InjuryCard key={inj.injury_id} inj={inj} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Rough season windows — returns true if the league is likely in-season right now */
function isSeasonActive(leagueSlug: string): boolean {
  const m = new Date().getMonth(); // 0-indexed
  switch (leagueSlug) {
    case "nba": case "nhl": return m >= 9 || m <= 5; // Oct–Jun
    case "nfl": return m >= 8 || m <= 1; // Sep–Feb
    case "mlb": return m >= 2 && m <= 9; // Mar–Oct
    case "premier-league": return m >= 7 || m <= 4; // Aug–May
    default: return true;
  }
}

function getMostCommonInjury(injuries: PlayerInjury[]): string | null {
  if (!injuries.length) return null;
  const counts = new Map<string, number>();
  for (const inj of injuries) {
    const key = inj.injury_type.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) { best = key; bestCount = count; }
  }
  return bestCount > 0 ? best : null;
}

function buildSeoBlurb(
  player: PlayerPageData,
  injury: PlayerInjury | undefined,
  _league: string,
): string {
  const name = player.player_name;
  const team = player.team_name;

  if (!injury) {
    return `${name} is not currently listed on the ${team} injury report. This page tracks injury history, return timelines, and post-injury performance data.`;
  }

  const status = injury.status.replace(/_/g, " ");
  const rawType = injury.injury_type.toLowerCase();
  const injType = rawType === "other" ? "unspecified" : rawType;

  if (injury.status === "returned" || injury.status === "active") {
    return `${name} has returned to action for the ${team} after a ${injType} injury. This page tracks injury status, recovery timeline, and performance after returning.`;
  }

  const dateStr = formatDate(injury.date_injured);
  return `${name} is currently listed as ${status} for the ${team} after suffering a ${injType} on ${dateStr}. This page tracks injury status, expected return timeline, and post-injury performance.`;
}

const MARKET_LABELS: Record<string, string> = {
  player_points: "PTS", player_rebounds: "REB", player_assists: "AST",
  player_threes: "3PT", player_points_rebounds_assists: "PRA",
  player_pass_yds: "Pass Yds", player_rush_yds: "Rush Yds",
  player_reception_yds: "Rec Yds", player_receptions: "Rec",
  player_goals: "Goals", player_shots_on_goal: "SOG",
  player_shots: "Shots", player_shots_on_target: "SOT",
  batter_hits: "Hits", batter_total_bases: "TB", batter_rbis: "RBI",
};

function PlayerPropsCard({ props, playerName: _playerName }: { props: PropRow[]; playerName: string }) {
  if (!props.length) return null;
  const priority = ["player_points", "player_goals", "batter_hits", "player_pass_yds", "player_rush_yds"];
  const sorted = [...props].sort((a, b) => {
    const ai = priority.indexOf(a.market);
    const bi = priority.indexOf(b.market);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  return (
    <div className="bg-emerald-500/5 border border-emerald-400/15 rounded-xl p-5 mb-6">
      <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
        <span className="text-emerald-400">Player Props</span>
        <span className="text-xs text-white/30 font-normal">Today's lines</span>
      </h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {sorted.map((p) => (
          <div key={p.id} className="bg-white/5 rounded-lg px-3 py-2.5">
            <p className="text-xs text-emerald-400/70 font-medium mb-1">
              {MARKET_LABELS[p.market] ?? p.market}
            </p>
            <p className="text-lg font-bold text-white">{p.line}</p>
            <div className="flex gap-3 mt-1 text-xs">
              {p.over_price && (
                <span className="text-green-400/80">O {p.over_price}</span>
              )}
              {p.under_price && (
                <span className="text-red-400/80">U {p.under_price}</span>
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-white/25 mt-3">Source: {sorted[0]?.source ?? "draftkings"}</p>
    </div>
  );
}

export default function PlayerInjuryPage() {
  const { playerSlug } = useParams<{ playerSlug: string }>();
  const { data: player, isLoading } = usePlayerPage(playerSlug ?? "");

  // All hooks must be called before any early return to avoid React error #310
  // Current injury = most recent ACTIVE injury (not returned/season_ending/back_in_play)
  // Falls back to most recent injury overall if all are resolved
  const activeInjury = player?.injuries.find(i =>
    i.status !== "returned" && i.status !== "season_ending" && i.status !== "back_in_play" && i.status !== "active"
  );
  const currentInjury = activeInjury ?? player?.injuries[0];
  const { data: impactPlayers } = useInjuryImpact(player ?? null);
  const injuryTypeSlug = currentInjury?.injury_type?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ?? "";
  const { data: perfCurve } = usePerformanceCurve(player?.league_slug ?? "", injuryTypeSlug);
  const { data: returnCase } = usePlayerReturnCase(currentInjury?.injury_id ?? "");
  const { data: playerProps } = useSinglePlayerProps(player?.player_id);

  // Track Player state
  const [tracked, setTracked] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (playerSlug) setTracked(isTrackedPlayer(playerSlug));
  }, [playerSlug]);

  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 2000);
      return () => clearTimeout(t);
    }
  }, [toast]);

  function handleToggleTrack() {
    if (!playerSlug) return;
    if (tracked) {
      removeTrackedPlayer(playerSlug);
      setTracked(false);
      setToast(`Removed ${player?.player_name ?? "player"} from tracked players`);
    } else {
      addTrackedPlayer(playerSlug);
      setTracked(true);
      setToast(`Tracking ${player?.player_name ?? "player"}`);
    }
  }

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

  const leagueLabel = LEAGUE_LABELS[player.league_slug] ?? player.league_name;
  const leagueFull = LEAGUE_FULL[player.league_slug] ?? leagueLabel;
  const pageTitle = `${player.player_name} Injury History & Performance After Injury (${leagueLabel})`;
  const returnDisplay = currentInjury?.return_date
    ? `Returned: ${formatDate(currentInjury.return_date)}`
    : currentInjury?.expected_return
    ? new Date(currentInjury.expected_return) < new Date()
      ? `Expected return: ${formatDate(currentInjury.expected_return)} (overdue)`
      : `Expected return: ${formatDate(currentInjury.expected_return)}`
    : "Return date: TBD";
  const pageDesc = currentInjury
    ? `${player.player_name} injury status: ${currentInjury.status.toUpperCase().replace(/_/g, " ")}. ${displayInjuryType(currentInjury.injury_type)}. ${player.team_name} (${leagueLabel}). ${returnDisplay}.`
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

  // Group injuries by season for compact display
  const seasonGroups = groupInjuriesBySeason(player.injuries, player.league_slug);
  const totalInjuries = player.injuries.length;
  const gamesMissedValues = player.injuries.map(i => i.games_missed).filter((v): v is number => v != null && v > 0);
  const totalGamesMissed = gamesMissedValues.reduce((sum, v) => sum + v, 0);
  const hasGamesMissed = gamesMissedValues.length > 0;
  const recoveries = player.injuries.filter(i => i.recovery_days && i.recovery_days > 0 && i.recovery_days < 365);
  const medianRecovery = recoveries.length > 0
    ? Math.round(recoveries.map(i => i.recovery_days!).sort((a, b) => a - b)[Math.floor(recoveries.length / 2)])
    : null;
  const mostCommonInjury = getMostCommonInjury(player.injuries);

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white">
      <SEO title={pageTitle} description={pageDesc} path={`/player/${player.slug}`} type="article" dateModified={now} jsonLd={jsonLd} />
      <SiteHeader />

      {/* Breadcrumb */}
      <nav className="px-4 py-3 text-sm text-white/45 max-w-3xl mx-auto">
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
        <p className="text-xs text-white/40 mb-3">
          Updated with games through {formatDateLong(new Date())}
        </p>

        {/* Player Header */}
        <div className="flex items-start gap-4 mb-4">
          <PlayerAvatar src={player.headshot_url} name={player.player_name} size={80} />
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
              <button
                onClick={handleToggleTrack}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  tracked
                    ? "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                    : "bg-white/5 text-white/50 border border-white/10 hover:bg-white/10"
                }`}
              >
                {tracked ? "\u2713 Tracking" : "\u2B50 Track Player"}
              </button>
            </div>
            <p className="text-[11px] text-white/30 mt-1.5">Save this player for quick access to injury updates and return analysis.</p>
          </div>
        </div>

        {/* SEO summary */}
        <p className="text-sm text-white/50 mb-4 leading-relaxed">
          {buildSeoBlurb(player, currentInjury, leagueLabel)}
        </p>

        {/* Return Date — prominent link, high-value for SEO */}
        <Link
          to={`/${player.slug}-return-date`}
          className="flex items-center justify-between bg-cyan-500/10 border border-cyan-400/20 rounded-xl px-5 py-3.5 mb-6 hover:bg-cyan-500/15 transition-colors group"
        >
          <div>
            <p className="text-sm font-semibold text-cyan-400">{player.player_name} Return Date</p>
            <p className="text-xs text-white/45 mt-0.5">
              {currentInjury?.expected_return
                ? new Date(currentInjury.expected_return) < new Date() && !currentInjury.return_date
                  ? `Expected ${formatDate(currentInjury.expected_return)} (overdue)`
                  : `Expected: ${formatDate(currentInjury.expected_return)}`
                : "View return timeline"}
            </p>
          </div>
          <span className="text-cyan-400 text-lg group-hover:translate-x-0.5 transition-transform">&rarr;</span>
        </Link>

        {/* Is [Player] Playing Tonight? — season-aware */}
        <div className="bg-white/5 border border-white/10 rounded-xl p-5 mb-6">
          <h2 className="text-lg font-semibold mb-2">
            {isSeasonActive(player.league_slug)
              ? `Is ${player.player_name} Playing Tonight?`
              : `${player.player_name} Availability Status`}
          </h2>
          {currentInjury && currentInjury.status !== "returned" && currentInjury.status !== "active" ? (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <StatusBadge status={currentInjury.status} />
                <span className="text-sm text-white/60 capitalize">{currentInjury.status.replace(/_/g, " ")}</span>
              </div>
              <dl className="text-sm space-y-1 text-white/50">
                <div className="flex gap-2">
                  <dt className="text-white/40">Last injury:</dt>
                  <dd>{currentInjury.injury_type}</dd>
                </div>
                {currentInjury.expected_return && (
                  <div className="flex gap-2">
                    <dt className="text-white/40">Expected return:</dt>
                    <dd className="text-cyan-400">{formatDate(currentInjury.expected_return)}</dd>
                  </div>
                )}
                {!currentInjury.expected_return && (
                  <div className="flex gap-2">
                    <dt className="text-white/40">Out since:</dt>
                    <dd>{formatDate(currentInjury.date_injured)}</dd>
                  </div>
                )}
              </dl>
            </div>
          ) : (
            <p className="text-green-400 text-sm">
              {isSeasonActive(player.league_slug)
                ? `${player.player_name} is not currently listed on the injury report and is expected to be available.`
                : `${player.player_name} is not currently listed on the injury report. The ${leagueLabel} season is currently in the offseason.`}
            </p>
          )}
        </div>

        {/* Player Props */}
        {playerProps && playerProps.length > 0 && (
          <PlayerPropsCard props={playerProps} playerName={player.player_name} />
        )}

        {/* Current Status Card */}
        {currentInjury && (
          <div className="bg-white/5 border border-white/10 rounded-xl p-5 mb-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold">Current Status</h2>
              <StatusBadge status={currentInjury.status} />
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-white/50 text-xs">Injury</dt>
                <dd className="font-medium">{displayInjuryType(currentInjury.injury_type)}{currentInjury.side ? ` (${currentInjury.side})` : ""}</dd>
              </div>
              <div>
                <dt className="text-white/50 text-xs">Date Injured</dt>
                <dd>{formatDate(currentInjury.date_injured)}</dd>
              </div>
              {currentInjury.expected_return && (
                <div>
                  <dt className="text-white/50 text-xs">Expected Return</dt>
                  <dd className={new Date(currentInjury.expected_return) < new Date() && !currentInjury.return_date ? "text-amber-400" : "text-cyan-400"}>
                    {formatDate(currentInjury.expected_return)}
                    {new Date(currentInjury.expected_return) < new Date() && !currentInjury.return_date && (
                      <span className="text-[10px] text-amber-400/70 ml-1.5">(overdue)</span>
                    )}
                  </dd>
                </div>
              )}
              {currentInjury.return_date && (
                <div>
                  <dt className="text-white/50 text-xs">Actual Return</dt>
                  <dd className="text-green-400">{formatDate(currentInjury.return_date)}</dd>
                </div>
              )}
              {currentInjury.games_missed != null && currentInjury.games_missed > 0 && (
                <div>
                  <dt className="text-white/50 text-xs">Games Missed</dt>
                  <dd className="text-red-400">{currentInjury.games_missed}</dd>
                </div>
              )}
              {currentInjury.recovery_days != null && currentInjury.recovery_days > 0 && currentInjury.recovery_days < 730 ? (
                <div>
                  <dt className="text-white/50 text-xs">Total Recovery</dt>
                  <dd>{currentInjury.recovery_days} days</dd>
                </div>
              ) : (
                <div>
                  <dt className="text-white/50 text-xs">Days Out</dt>
                  <dd>{daysAgo(currentInjury.date_injured)}</dd>
                </div>
              )}
            </dl>
            {currentInjury.injury_description && (
              <p className="mt-3 text-sm text-white/50 line-clamp-3">{currentInjury.injury_description}</p>
            )}
          </div>
        )}

        {/* Key Findings */}
        {player.injuries.length > 0 && (
          <div className="bg-indigo-500/5 border border-indigo-400/15 rounded-xl p-5 mb-6">
            <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
              <span className="text-indigo-400">Key Findings</span>
              <span className="text-xs text-white/30 font-normal">Auto-generated from player data</span>
            </h2>
            <ul className="space-y-2 text-sm text-white/60">
              <li className="flex items-start gap-2">
                <span className="text-indigo-400 mt-0.5 shrink-0">&#8226;</span>
                <span>{player.player_name} has sustained <strong className="text-white/80">{totalInjuries}</strong> recorded {totalInjuries === 1 ? "injury" : "injuries"}{hasGamesMissed ? <>, missing a total of <strong className="text-white/80">{totalGamesMissed}</strong> {totalGamesMissed === 1 ? "game" : "games"}</> : ""}.</span>
              </li>
              {mostCommonInjury && (
                <li className="flex items-start gap-2">
                  <span className="text-indigo-400 mt-0.5 shrink-0">&#8226;</span>
                  <span>Most common injury type: <strong className="text-white/80 capitalize">{mostCommonInjury}</strong>.</span>
                </li>
              )}
              {medianRecovery && (
                <li className="flex items-start gap-2">
                  <span className="text-indigo-400 mt-0.5 shrink-0">&#8226;</span>
                  <span>Median recovery time: <strong className="text-white/80">{medianRecovery} days</strong> across {recoveries.length} {recoveries.length === 1 ? "recovery" : "recoveries"}.</span>
                </li>
              )}
              {perfCurve && perfCurve.median_pct_recent && perfCurve.median_pct_recent.length >= 10 && (
                <li className="flex items-start gap-2">
                  <span className="text-indigo-400 mt-0.5 shrink-0">&#8226;</span>
                  <span>Expected performance after {perfCurve.injury_type}: Game 1 back at <strong className="text-white/80">{Math.round(perfCurve.median_pct_recent[0] * 100)}%</strong> of baseline, Game 10 at <strong className="text-white/80">{Math.round(perfCurve.median_pct_recent[9] * 100)}%</strong> (based on {perfCurve.sample_size} historical cases).</span>
                </li>
              )}
              {perfCurve && perfCurve.median_pct_recent && perfCurve.median_pct_recent.length > 0 && perfCurve.median_pct_recent.length < 10 && (
                <li className="flex items-start gap-2">
                  <span className="text-indigo-400 mt-0.5 shrink-0">&#8226;</span>
                  <span>Expected Game 1 performance after {perfCurve.injury_type}: <strong className="text-white/80">{Math.round(perfCurve.median_pct_recent[0] * 100)}%</strong> of baseline ({perfCurve.sample_size} historical cases).</span>
                </li>
              )}
              {returnCase && returnCase.rest_of_season_avg != null && (
                <li className="flex items-start gap-2">
                  <span className="text-indigo-400 mt-0.5 shrink-0">&#8226;</span>
                  <span>{player.player_name}'s rest-of-season performance after return: <strong className={returnCase.rest_of_season_avg >= 100 ? "text-green-400" : "text-orange-400"}>{Math.round(returnCase.rest_of_season_avg)}%</strong> of baseline on average — {returnCase.rest_of_season_avg >= 100 ? "above" : "below"} the typical recovery curve.</span>
                </li>
              )}
            </ul>
          </div>
        )}

        {/* Days Since Injury */}
        {currentInjury && (
          <div className="flex items-stretch gap-3 mb-6">
            {currentInjury.return_date && new Date(currentInjury.return_date).getFullYear() < new Date().getFullYear() + 2 ? (
              <>
                <div className="flex-1 bg-white/5 border border-white/10 rounded-xl p-4 text-center">
                  <p className="text-xs text-white/40 mb-1">Injured</p>
                  <p className="text-sm font-semibold">{formatDate(currentInjury.date_injured)}</p>
                </div>
                <div className="flex-1 bg-green-500/10 border border-green-400/20 rounded-xl p-4 text-center">
                  <p className="text-xs text-green-400/60 mb-1">Returned</p>
                  <p className="text-sm font-semibold text-green-400">{formatDate(currentInjury.return_date)}</p>
                </div>
                {(() => {
                  const days = currentInjury.recovery_days ?? Math.max(0, Math.floor((new Date(currentInjury.return_date!).getTime() - new Date(currentInjury.date_injured).getTime()) / 86400000));
                  return days > 0 && days < 730 ? (
                    <div className="flex-1 bg-white/5 border border-white/10 rounded-xl p-4 text-center">
                      <p className="text-xs text-white/40 mb-1">Total Recovery</p>
                      <p className="text-lg font-bold text-white">
                        {days} <span className="text-sm font-normal text-white/50">days</span>
                      </p>
                    </div>
                  ) : null;
                })()}
              </>
            ) : currentInjury.status !== "returned" && currentInjury.status !== "active" ? (
              <>
                <div className="flex-1 bg-white/5 border border-white/10 rounded-xl p-4 text-center">
                  <p className="text-xs text-white/40 mb-1">Injured</p>
                  <p className="text-sm font-semibold">{formatDate(currentInjury.date_injured)}</p>
                </div>
                <div className="flex-1 bg-orange-500/10 border border-orange-400/20 rounded-xl p-4 text-center">
                  <p className="text-xs text-orange-400/60 mb-1">Days Since Injury</p>
                  <p className="text-lg font-bold text-orange-400">
                    {daysAgo(currentInjury.date_injured)} <span className="text-sm font-normal text-orange-400/60">days</span>
                  </p>
                </div>
                {currentInjury.games_missed != null && currentInjury.games_missed > 0 && (
                  <div className="flex-1 bg-white/5 border border-white/10 rounded-xl p-4 text-center">
                    <p className="text-xs text-white/40 mb-1">Games Missed</p>
                    <p className="text-lg font-bold text-red-400">{currentInjury.games_missed}</p>
                  </div>
                )}
              </>
            ) : null}
          </div>
        )}

        {/* Injury Impact */}
        {impactPlayers && impactPlayers.length > 0 && currentInjury && (
          <div className="bg-amber-500/5 border border-amber-400/15 rounded-xl p-5 mb-6">
            <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
              <span className="text-amber-400">Injury Impact</span>
            </h2>
            <p className="text-sm text-white/50 mb-3">
              If {player.player_name} misses time:
            </p>
            <div className="space-y-2">
              {impactPlayers.map((ip) => (
                <Link
                  key={ip.slug}
                  to={`/player/${ip.slug}`}
                  className="flex items-center gap-3 bg-white/5 rounded-lg px-4 py-2.5 hover:bg-white/10 transition-colors group"
                >
                  <span className="text-green-400 text-base font-bold shrink-0">&uarr;</span>
                  <span className="text-sm font-medium text-white group-hover:text-cyan-400 transition-colors">{ip.player_name}</span>
                  <span className="text-xs text-white/40">{ip.opportunity}</span>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Recovery Performance Curve */}
        {perfCurve && (
          <div className="bg-white/5 border border-white/10 rounded-xl p-5 mb-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold">Recovery Curve: {perfCurve.injury_type}</h2>
              <Link to="/performance-curves" className="text-xs text-cyan-400 hover:underline">View all curves</Link>
            </div>
            <p className="text-xs text-white/40 mb-3">
              Average performance in first 10 games back ({perfCurve.sample_size} historical cases)
              {returnCase ? " — green line shows this player" : ""}
            </p>
            <PerformanceCurveChart curve={perfCurve} playerCase={returnCase} height={220} />
          </div>
        )}

        {/* Injury History — grouped by season */}
        {player.injuries.length > 0 && (
          <div className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Injury History</h2>
              {/* Summary stats */}
              <div className="flex gap-4 text-xs text-white/40">
                <span>{totalInjuries} {totalInjuries === 1 ? "injury" : "injuries"}</span>
                {totalGamesMissed > 0 && <span className="text-red-400/60">{totalGamesMissed} games missed</span>}
                {medianRecovery && <span>{medianRecovery}d median recovery</span>}
              </div>
            </div>
            <div className="space-y-3">
              {seasonGroups.map((group, i) => (
                <SeasonGroup
                  key={group.season}
                  season={group.season}
                  injuries={group.injuries}
                  defaultOpen={i === 0}
                />
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

        {/* Similar Injuries in League */}
        {currentInjury && injuryTypeSlug && (
          <div className="bg-white/5 border border-white/10 rounded-xl p-5 mb-8">
            <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wide mb-3">
              Similar Injuries in the {leagueFull}
            </h3>
            <p className="text-sm text-white/50 mb-3">
              See how other {leagueLabel} players have recovered from {currentInjury.injury_type.toLowerCase()} injuries, including average recovery time and post-injury performance data.
            </p>
            <div className="flex flex-wrap gap-2">
              <Link
                to={`/${player.league_slug}/${injuryTypeSlug}-injury-performance`}
                className="inline-flex items-center gap-2 bg-cyan-500/10 border border-cyan-400/20 rounded-lg px-4 py-2.5 hover:bg-cyan-500/15 transition-colors text-sm text-cyan-400"
              >
                {currentInjury.injury_type} performance in {leagueLabel} &rarr;
              </Link>
              <Link
                to={`/injuries/${injuryTypeSlug}`}
                className="inline-flex items-center gap-2 bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 hover:bg-white/10 transition-colors text-sm text-white/60"
              >
                All {currentInjury.injury_type.toLowerCase()} recovery stats &rarr;
              </Link>
            </div>
          </div>
        )}

        {/* Related Links */}
        <div className="border-t border-white/10 pt-8 mb-8">
          <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wide mb-4">Related Links</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Link to={`/${player.league_slug}/${teamSlug(player.team_name)}-injuries`}
              className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-lg px-4 py-3 hover:bg-white/10 transition-colors text-sm">
              <span className="text-white/60">{player.team_name} injury report</span>
            </Link>
            <Link to={`/${player.league_slug}-injuries`}
              className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-lg px-4 py-3 hover:bg-white/10 transition-colors text-sm">
              <span className="text-white/60">{leagueFull} injury report</span>
            </Link>
            <Link to={`/${player.slug}-return-date`}
              className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-lg px-4 py-3 hover:bg-white/10 transition-colors text-sm">
              <span className="text-white/60">{player.player_name} return date</span>
            </Link>
            <Link to={`/${player.league_slug}-injury-performance`}
              className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-lg px-4 py-3 hover:bg-white/10 transition-colors text-sm">
              <span className="text-white/60">{leagueLabel} injury performance analysis</span>
            </Link>
            {currentInjury && (
              <Link to={`/injuries/${injuryTypeSlug}`}
                className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-lg px-4 py-3 hover:bg-white/10 transition-colors text-sm">
                <span className="text-white/60">{currentInjury.injury_type} recovery statistics</span>
              </Link>
            )}
            <Link to="/performance-curves"
              className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-lg px-4 py-3 hover:bg-white/10 transition-colors text-sm">
              <span className="text-white/60">All performance curves</span>
            </Link>
            <Link to="/recovery-stats"
              className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-lg px-4 py-3 hover:bg-white/10 transition-colors text-sm">
              <span className="text-white/60">Recovery statistics</span>
            </Link>
            <Link to={`/${player.league_slug}/returning-today`}
              className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-lg px-4 py-3 hover:bg-white/10 transition-colors text-sm">
              <span className="text-white/60">{leagueLabel} players returning today</span>
            </Link>
            <Link to={`/${player.league_slug}-injury-report`}
              className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-lg px-4 py-3 hover:bg-white/10 transition-colors text-sm">
              <span className="text-white/60">{leagueLabel} injury report today</span>
            </Link>
          </div>
        </div>

        {/* Related Players */}
        {player.injuredTeammates.length > 0 && (
          <div className="mb-8">
            <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wide mb-4">
              Related {player.team_name} Injury Updates
            </h3>
            <div className="flex flex-wrap gap-2">
              {player.injuredTeammates.map((t) => (
                <Link
                  key={t.slug}
                  to={`/player/${t.slug}`}
                  className="px-3 py-1.5 rounded-full border border-white/10 text-xs text-cyan-400 hover:bg-white/5 transition-colors"
                >
                  {t.player_name} <span className="text-white/30">{t.position}</span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Toast notification */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-white/10 backdrop-blur-md border border-white/20 text-white text-sm px-4 py-2.5 rounded-xl shadow-lg animate-[fadeIn_0.2s_ease-out]">
          {toast}
        </div>
      )}
    </div>
  );
}
