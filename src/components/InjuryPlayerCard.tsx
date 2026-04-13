import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { StatusBadge } from "./StatusBadge";
import { PlayerAvatar } from "./PlayerAvatar";
import { leagueColor } from "../lib/leagueColors";
import { trackPlayerCardClick } from "../lib/analytics";
import { isTrackedPlayer, toggleTrackedPlayer } from "../lib/trackedPlayers";

const LEAGUE_LABELS: Record<string, string> = {
  nba: "NBA",
  nfl: "NFL",
  mlb: "MLB",
  nhl: "NHL",
  "premier-league": "EPL",
};

const LEAGUE_DOT: Record<string, string> = {
  nba: "bg-orange-400",
  nfl: "bg-green-500",
  mlb: "bg-red-500",
  nhl: "bg-blue-400",
  "premier-league": "bg-purple-400",
};

/** Status -> subtle border color for injury cards */
export const STATUS_BORDER_COLOR: Record<string, string> = {
  out:          "rgba(239,68,68,0.25)",
  ir:           "rgba(239,68,68,0.25)",
  "il-10":      "rgba(239,68,68,0.25)",
  "il-15":      "rgba(239,68,68,0.25)",
  "il-60":      "rgba(239,68,68,0.25)",
  doubtful:     "rgba(249,115,22,0.25)",
  questionable: "rgba(234,179,8,0.25)",
  "day-to-day": "rgba(245,158,11,0.25)",
  probable:     "rgba(59,130,246,0.25)",
  active:       "rgba(34,197,94,0.25)",
  returned:     "rgba(34,197,94,0.25)",
  active_today: "rgba(249,115,22,0.25)",
  reduced_load: "rgba(245,158,11,0.25)",
  back_in_play: "rgba(6,182,212,0.25)",
  suspended:    "rgba(168,85,247,0.25)",
};

export function injuryCardBorder(status: string | null | undefined): string {
  if (!status) return "rgba(255,255,255,0.1)";
  const key = status.toLowerCase().replace(/-/g, "_");
  return STATUS_BORDER_COLOR[key] ?? STATUS_BORDER_COLOR[status] ?? "rgba(255,255,255,0.1)";
}

function daysAgo(dateStr: string | null | undefined): number {
  if (!dateStr) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000));
}

export interface InjuryPlayerCardProps {
  player_name: string;
  player_slug?: string;
  position?: string;
  team_name?: string;
  league_slug?: string;
  league_name?: string;
  headshot_url?: string | null;
  status?: string;
  injury_type?: string;
  injury_description?: string | null;
  date_injured?: string | null;
  expected_return?: string | null;
  return_date?: string | null;
  is_star?: boolean;
  is_starter?: boolean;
  side?: string | null;
  long_comment?: string | null;
  source?: string | null;
  games_missed?: number | null;
  game_minutes?: number | null;
  pre_injury_avg_minutes?: number | null;
  rank?: number | null;

  /** Show league dot + label */
  showLeague?: boolean;
  /** Wrap the card body in a Link to /player/{slug}. Default true. */
  linkToPlayer?: boolean;
  /** Extra content rendered below the main card info */
  children?: ReactNode;
  /** Optional className on the outer wrapper */
  className?: string;
  /** Avatar size in px. Default 44. */
  avatarSize?: number;
}

export function InjuryPlayerCard({
  player_name,
  player_slug,
  position,
  team_name,
  league_slug,
  league_name,
  headshot_url,
  status,
  injury_type,
  injury_description,
  date_injured,
  expected_return,
  return_date,
  is_star,
  is_starter,
  side,
  long_comment,
  source,
  games_missed,
  game_minutes,
  pre_injury_avg_minutes,
  rank,
  showLeague,
  linkToPlayer = true,
  children,
  className,
  avatarSize = 44,
}: InjuryPlayerCardProps) {
  const days = daysAgo(date_injured);
  const slug =
    player_slug ||
    player_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const playerUrl = `/player/${slug}`;
  const borderColor = injuryCardBorder(status);
  const accentColor = borderColor.replace(/[\d.]+\)$/, "0.6)");
  const lColor = league_slug ? leagueColor(league_slug) : undefined;

  const [tracked, setTracked] = useState(() => isTrackedPlayer(slug));
  const [trackToast, setTrackToast] = useState<string | null>(null);

  function handleTrackClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const nowTracked = toggleTrackedPlayer(slug);
    setTracked(nowTracked);
    setTrackToast(nowTracked ? `Tracking ${player_name}` : `Removed ${player_name} from tracked players`);
    setTimeout(() => setTrackToast(null), 2000);
  }

  const cardBody = (
    <div className="p-4 relative">
      {/* Left status accent */}
      <div
        className="absolute left-0 top-2 bottom-2 w-[2px] rounded-full"
        style={{ backgroundColor: accentColor }}
      />
      <div className="flex items-start gap-3">
        <PlayerAvatar
          src={headshot_url}
          name={player_name}
          size={avatarSize}
          className="rounded-full"
        />

        <div className="min-w-0 flex-1 leading-relaxed">
          {/* Row 1: name, badges, status */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <button
                onClick={handleTrackClick}
                title={tracked ? "Tracking player" : "Track player"}
                className="shrink-0 p-0.5 rounded transition-colors hover:bg-white/10 flex items-center gap-1"
              >
                {tracked
                  ? <><span className="text-amber-400 text-sm">&#9733;</span><span className="hidden sm:inline text-[10px] text-amber-400/70">Tracking</span></>
                  : <span className="text-white/25 text-sm hover:text-white/50">&#9734;</span>
                }
              </button>
              <span className="text-[15px] font-semibold text-white truncate">
                {player_name}
              </span>
              {is_star && (
                <span className="shrink-0 text-[11px]" title="Star player">
                  {"\u2B50"}
                </span>
              )}
              {is_starter && !is_star && (
                <span
                  className="shrink-0 text-[10px] font-bold text-emerald-400 border border-emerald-400/40 rounded px-1"
                  title="Starter"
                >
                  S
                </span>
              )}
              {position && (
                <span className="text-xs text-white/50 shrink-0">{position}</span>
              )}
              {rank != null && rank <= 50 && (
                <span className="text-xs text-amber-400/80 shrink-0">#{rank}</span>
              )}
            </div>
            <StatusBadge status={status ?? "out"} />
          </div>

          {/* Row 2: team + league */}
          <div className="flex items-center gap-2 mt-1">
            {team_name && team_name !== "Unknown" && (
              <p className="text-sm text-white/50 truncate">{team_name}</p>
            )}
            {showLeague && league_slug && (
              <span className="flex items-center gap-1 text-xs text-white/40">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${LEAGUE_DOT[league_slug] ?? "bg-white/30"}`}
                  style={!LEAGUE_DOT[league_slug] && lColor ? { backgroundColor: lColor } : undefined}
                />
                {LEAGUE_LABELS[league_slug] ?? league_name}
              </span>
            )}
          </div>

          {/* Games missed & days since injury */}
          <div className="flex items-center gap-3 mt-1.5 text-xs">
            {days > 0 && (
              <span className="text-white/45">
                {days === 1 ? "1 day" : `${days} days`} since injury
              </span>
            )}
            {games_missed != null && games_missed > 0 && (
              <span className="text-red-400/70 font-medium">
                {games_missed} game{games_missed !== 1 ? "s" : ""} missed
              </span>
            )}
          </div>

          {/* Minutes bar (for reduced_load / back_in_play / active_today) */}
          {game_minutes != null && game_minutes > 0 && (
            <div className="mt-2">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-white/70 font-medium">{game_minutes} min</span>
                {pre_injury_avg_minutes != null && pre_injury_avg_minutes > 0 && (
                  <>
                    <span className="text-white/40">
                      / {pre_injury_avg_minutes} usual
                    </span>
                    <span
                      className={`text-xs font-bold ${
                        game_minutes / pre_injury_avg_minutes >= 0.8
                          ? "text-cyan-400"
                          : "text-amber-400"
                      }`}
                    >
                      {Math.round(
                        (game_minutes / pre_injury_avg_minutes) * 100
                      )}
                      %
                    </span>
                  </>
                )}
              </div>
              {pre_injury_avg_minutes != null && pre_injury_avg_minutes > 0 && (
                <div className="mt-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      game_minutes / pre_injury_avg_minutes >= 0.8
                        ? "bg-cyan-400"
                        : "bg-amber-400"
                    }`}
                    style={{
                      width: `${Math.min(
                        100,
                        (game_minutes / pre_injury_avg_minutes) * 100
                      )}%`,
                    }}
                  />
                </div>
              )}
            </div>
          )}

          {/* Injury details */}
          <div className="mt-2 space-y-0.5">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-white/70 font-medium">
                {injury_type?.toLowerCase() === "other" ? "Unspecified" : injury_type}
              </span>
              {side && <span className="text-white/40">({side})</span>}
            </div>
            {injury_description && (
              <p className="text-xs text-white/45 line-clamp-2 leading-relaxed">
                {injury_description}
              </p>
            )}
            {expected_return && (
              <p
                className={`text-xs ${
                  new Date(expected_return) < new Date() && !return_date
                    ? "text-amber-400/70"
                    : "text-cyan-300/70"
                }`}
              >
                Est. return: {expected_return}
                {new Date(expected_return) < new Date() && !return_date && (
                  <span className="ml-1 text-amber-400/60">(overdue)</span>
                )}
              </p>
            )}
            {long_comment && (
              <p className="text-xs text-white/40 line-clamp-2 italic leading-relaxed">
                {long_comment}
              </p>
            )}
          </div>

          {/* Meta */}
          <div className="mt-2 flex items-center gap-3 text-xs text-white/35">
            {date_injured && <span>{date_injured}</span>}
            {source && <span>{source}</span>}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div
      className={`rounded-xl bg-white/5 transition-colors hover:bg-white/[0.07] overflow-hidden ${className ?? ""}`}
      style={{ border: `1px solid ${borderColor}` }}
    >
      {linkToPlayer ? (
        <Link to={playerUrl} className="block" onClick={(e) => trackPlayerCardClick(e, slug, league_slug)}>
          {cardBody}
        </Link>
      ) : (
        cardBody
      )}
      {children}
      {trackToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-white/10 backdrop-blur-md border border-white/20 text-white text-sm px-4 py-2.5 rounded-xl shadow-lg animate-[fadeIn_0.2s_ease-out]">
          {trackToast}
        </div>
      )}
    </div>
  );
}
