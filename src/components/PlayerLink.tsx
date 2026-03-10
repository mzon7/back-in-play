import { Link } from "react-router-dom";

interface Player {
  slug: string;
  player_name: string;
  position?: string | null;
}

interface PlayerLinkProps {
  player: Player;
  /** Show position label after name, e.g. "John Doe · WR" */
  showPosition?: boolean;
  className?: string;
}

export function PlayerLink({ player, showPosition = false, className }: PlayerLinkProps) {
  return (
    <Link
      to={`/player/${player.slug}`}
      className={
        className ??
        "font-semibold text-white hover:text-[#1C7CFF] transition-colors truncate text-sm"
      }
    >
      {player.player_name}
      {showPosition && player.position && (
        <span className="ml-1 font-normal text-white/40">· {player.position}</span>
      )}
    </Link>
  );
}
