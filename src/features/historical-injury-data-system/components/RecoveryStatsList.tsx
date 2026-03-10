import { useMemo } from "react";
import type { RecoveryStat } from "../lib/types";
import { RecoveryStatsPanel } from "./RecoveryStatsPanel";

interface RecoveryStatsListProps {
  stats: RecoveryStat[];
  isLoading: boolean;
  leagueFilter: string;
}

/**
 * Grid list of RecoveryStatsPanel cards, grouped or flat depending on filter.
 */
export function RecoveryStatsList({ stats, isLoading, leagueFilter }: RecoveryStatsListProps) {
  const maxScale = useMemo(
    () => Math.max(...stats.map((s) => s.median_recovery_days ?? 0), 1),
    [stats]
  );

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="h-44 rounded-xl bg-white/5 animate-pulse"
            data-testid="stat-skeleton"
          />
        ))}
      </div>
    );
  }

  if (stats.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-white/40">
        <div className="text-4xl mb-3">📊</div>
        <div className="text-sm font-medium">No recovery stats yet</div>
        <div className="text-xs mt-1">Historical data hasn't been computed for this league.</div>
      </div>
    );
  }

  // When filtering by specific league, show flat grid
  if (leagueFilter !== "all") {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {stats.map((stat) => (
          <RecoveryStatsPanel key={stat.stat_id} stat={stat} maxScale={maxScale} />
        ))}
      </div>
    );
  }

  // Group by league for "all" view
  const grouped = groupByLeague(stats);

  return (
    <div className="space-y-10">
      {grouped.map(({ league_name, league_slug, items }) => (
        <section key={league_slug}>
          <div className="flex items-center gap-3 mb-4">
            <h2 className="text-sm font-bold text-white/80 uppercase tracking-widest">
              {league_name}
            </h2>
            <div className="flex-1 h-px bg-white/10" />
            <span className="text-xs text-white/30">{items.length} injury types</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {items.map((stat) => (
              <RecoveryStatsPanel key={stat.stat_id} stat={stat} maxScale={maxScale} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function groupByLeague(stats: RecoveryStat[]) {
  const map = new Map<string, { league_name: string; league_slug: string; items: RecoveryStat[] }>();
  for (const stat of stats) {
    if (!map.has(stat.league_slug)) {
      map.set(stat.league_slug, {
        league_name: stat.league_name,
        league_slug: stat.league_slug,
        items: [],
      });
    }
    map.get(stat.league_slug)!.items.push(stat);
  }
  return Array.from(map.values());
}
