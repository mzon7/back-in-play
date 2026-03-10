import { LEAGUE_LABELS, type LeagueFilter } from "../lib/types";

interface LeagueFilterBarProps {
  value: LeagueFilter;
  onChange: (v: LeagueFilter) => void;
}

const LEAGUES: LeagueFilter[] = ["all", "nfl", "nba", "mlb", "nhl", "premier-league"];

export function LeagueFilterBar({ value, onChange }: LeagueFilterBarProps) {
  return (
    <div
      className="flex flex-wrap gap-2"
      role="tablist"
      aria-label="Filter by league"
    >
      {LEAGUES.map((slug) => {
        const active = value === slug;
        return (
          <button
            key={slug}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(slug)}
            className={[
              "px-3 py-1.5 rounded-full text-xs font-semibold transition-all duration-200",
              active
                ? "bg-[#1C7CFF] text-white shadow-[0_0_12px_#1C7CFF66]"
                : "bg-white/8 text-white/60 hover:bg-white/12 hover:text-white",
            ].join(" ")}
          >
            {LEAGUE_LABELS[slug]}
          </button>
        );
      })}
    </div>
  );
}
