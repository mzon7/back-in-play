import type { InjuryWithPlayer } from "../lib/types";
import { StatusBadge } from "../../../components/StatusBadge";
import { PlayerLink } from "../../../components/PlayerLink";
import { InjuryTypeLink } from "../../../components/InjuryTypeLink";
import { DateCell } from "../../../components/DateCell";

export type InjuryTableVariant = "compact" | "full";

export interface InjuryTableProps {
  rows: InjuryWithPlayer[];
  isLoading: boolean;
  variant?: InjuryTableVariant;
  emptyMessage?: string;
}

function SkeletonRow({ variant }: { variant: InjuryTableVariant }) {
  return (
    <div
      className={`flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 border-b border-white/5 animate-pulse ${
        variant === "compact" ? "py-2 px-4" : "py-3 px-4"
      }`}
    >
      <div className="h-4 bg-white/10 rounded w-32 sm:w-40" />
      <div className="h-3 bg-white/10 rounded w-20 sm:w-24" />
      <div className="h-3 bg-white/10 rounded w-24 sm:w-32 sm:ml-auto" />
      <div className="h-5 bg-white/10 rounded-full w-16" />
    </div>
  );
}

function CompactRow({ row }: { row: InjuryWithPlayer }) {
  const player = row.back_in_play_players;
  const team = player?.back_in_play_teams;
  const league = team?.back_in_play_leagues;

  const teamAbbr = team?.team_name?.slice(0, 3).toUpperCase() ?? "—";
  const leagueLabel = league?.slug?.toUpperCase() ?? "";

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 py-2 px-4 hover:bg-white/[0.03] transition-colors">
      {/* Player + meta */}
      <div className="flex items-center gap-2 min-w-0">
        {player ? (
          <PlayerLink player={player} />
        ) : (
          <span className="text-sm text-white/40">—</span>
        )}
        <span className="text-white/40 text-xs shrink-0">
          {teamAbbr}
          {leagueLabel ? ` · ${leagueLabel}` : ""}
          {player?.position ? ` · ${player.position}` : ""}
        </span>
      </div>

      {/* Injury info */}
      <div className="flex items-center gap-3 sm:ml-auto flex-wrap">
        <InjuryTypeLink
          injury_type={row.injury_type}
          injury_type_slug={row.injury_type_slug}
        />
        <DateCell value={row.date_injured} />
        <DateCell value={row.expected_return_date} label="Ret:" />
        <StatusBadge status={row.status} />
      </div>
    </div>
  );
}

function FullRow({ row }: { row: InjuryWithPlayer }) {
  const player = row.back_in_play_players;
  const team = player?.back_in_play_teams;
  const league = team?.back_in_play_leagues;

  const teamAbbr = team?.team_name?.slice(0, 3).toUpperCase() ?? "—";
  const leagueLabel = league?.slug?.toUpperCase() ?? "";

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 py-3 px-4 hover:bg-white/[0.03] transition-colors">
      {/* Player + meta */}
      <div className="flex items-center gap-2 min-w-0">
        {player ? (
          <PlayerLink player={player} />
        ) : (
          <span className="text-sm text-white/40">—</span>
        )}
        <span className="text-white/40 text-xs shrink-0">
          {teamAbbr}
          {leagueLabel ? ` · ${leagueLabel}` : ""}
          {player?.position ? ` · ${player.position}` : ""}
        </span>
      </div>

      {/* Injury info */}
      <div className="flex items-center gap-3 sm:ml-auto flex-wrap">
        <InjuryTypeLink
          injury_type={row.injury_type}
          injury_type_slug={row.injury_type_slug}
        />
        {row.injury_description && (
          <span className="text-xs text-white/30 hidden md:inline truncate max-w-[180px]">
            {row.injury_description}
          </span>
        )}
        <DateCell value={row.date_injured} />
        {row.expected_recovery_range && (
          <span className="text-xs text-white/40 hidden sm:inline">
            {row.expected_recovery_range}
          </span>
        )}
        <DateCell value={row.expected_return_date} label="Ret:" />
        <StatusBadge status={row.status} />
      </div>
    </div>
  );
}

export function InjuryTable({
  rows,
  isLoading,
  variant = "compact",
  emptyMessage = "No injuries to display.",
}: InjuryTableProps) {
  if (isLoading) {
    return (
      <div className="divide-y divide-white/5">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonRow key={i} variant={variant} />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-white/40 italic">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="divide-y divide-white/5">
      {rows.map((row) =>
        variant === "compact" ? (
          <CompactRow key={row.injury_id} row={row} />
        ) : (
          <FullRow key={row.injury_id} row={row} />
        ),
      )}
    </div>
  );
}
