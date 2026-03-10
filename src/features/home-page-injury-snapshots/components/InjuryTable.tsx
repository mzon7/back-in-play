import { Link } from "react-router-dom";
import type { InjuryWithPlayer } from "../lib/types";
import { StatusBadge } from "./StatusBadge";

function formatDate(dateStr: string | null | undefined) {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

interface InjuryTableProps {
  rows: InjuryWithPlayer[];
  isLoading: boolean;
  emptyMessage?: string;
}

function SkeletonRow() {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 py-3 px-4 border-b border-white/5 animate-pulse">
      <div className="h-4 bg-white/10 rounded w-32 sm:w-40" />
      <div className="h-3 bg-white/10 rounded w-20 sm:w-24" />
      <div className="h-3 bg-white/10 rounded w-24 sm:w-32 sm:ml-auto" />
      <div className="h-5 bg-white/10 rounded-full w-16" />
    </div>
  );
}

export function InjuryTable({ rows, isLoading, emptyMessage = "No injuries to display." }: InjuryTableProps) {
  if (isLoading) {
    return (
      <div className="divide-y divide-white/5">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonRow key={i} />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-white/40 italic">{emptyMessage}</div>
    );
  }

  return (
    <div className="divide-y divide-white/5">
      {rows.map((row) => {
        const player = row.back_in_play_players;
        const team = player?.back_in_play_teams;
        const league = team?.back_in_play_leagues;

        // Abbreviate team name to 3 chars
        const teamAbbr = team?.team_name?.slice(0, 3).toUpperCase() ?? "—";
        const leagueLabel = league?.slug?.toUpperCase() ?? "";

        return (
          <div
            key={row.injury_id}
            className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 py-3 px-4 hover:bg-white/3 transition-colors"
          >
            {/* Line 1: player + team/league */}
            <div className="flex items-center gap-2 min-w-0">
              <Link
                to={`/player/${player?.slug ?? ""}`}
                className="font-semibold text-white hover:text-[#1C7CFF] transition-colors truncate text-sm"
              >
                {player?.player_name ?? "—"}
              </Link>
              <span className="text-white/40 text-xs shrink-0">
                {teamAbbr}
                {leagueLabel ? ` · ${leagueLabel}` : ""}
                {player?.position ? ` · ${player.position}` : ""}
              </span>
            </div>

            {/* Line 2 (sm: inline): injury + dates + badge */}
            <div className="flex items-center gap-3 sm:ml-auto flex-wrap">
              <Link
                to={`/injury-type/${row.injury_type_slug}`}
                className="text-xs text-[#3DFF8F] hover:text-[#3DFF8F]/70 transition-colors font-medium"
              >
                {row.injury_type}
              </Link>
              <span className="text-white/30 text-xs">
                {formatDate(row.date_injured)}
              </span>
              {row.expected_return_date && (
                <span className="text-white/40 text-xs">
                  Ret: <span className="text-white/70">{formatDate(row.expected_return_date)}</span>
                </span>
              )}
              <StatusBadge status={row.status} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
