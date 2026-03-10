import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useRecoveryStats } from "../lib/queries";
import { LeagueFilterBar } from "./LeagueFilterBar";
import { RecoveryStatsList } from "./RecoveryStatsList";
import type { LeagueFilter } from "../lib/types";

/**
 * Full-page view: Recovery Statistics browser with league filter.
 * Route: /recovery-stats
 */
export function RecoveryStatsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlLeague = searchParams.get("league") as LeagueFilter | null;
  const [leagueFilter, setLeagueFilter] = useState<LeagueFilter>(
    urlLeague ?? "all"
  );

  const { data: stats = [], isLoading, error } = useRecoveryStats(
    leagueFilter === "all" ? undefined : leagueFilter
  );

  function handleLeagueChange(slug: LeagueFilter) {
    setLeagueFilter(slug);
    if (slug === "all") {
      searchParams.delete("league");
    } else {
      searchParams.set("league", slug);
    }
    setSearchParams(searchParams, { replace: true });
  }

  return (
    <div className="min-h-screen bg-[#0A0F1E] text-white">
      {/* Hero header */}
      <div className="relative overflow-hidden border-b border-white/10 bg-gradient-to-br from-[#0A0F1E] via-[#0d1529] to-[#0A0F1E]">
        {/* Glow blobs */}
        <div className="pointer-events-none absolute -top-32 -left-32 w-96 h-96 rounded-full bg-[#1C7CFF] opacity-10 blur-3xl" />
        <div className="pointer-events-none absolute -top-32 -right-32 w-96 h-96 rounded-full bg-[#3DFF8F] opacity-8 blur-3xl" />

        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <div className="flex items-center gap-3 mb-3">
            <span className="text-2xl">📊</span>
            <span className="text-xs font-bold uppercase tracking-[0.2em] text-[#3DFF8F]">
              Recovery Intelligence
            </span>
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight mb-3">
            <span className="text-white">Injury </span>
            <span className="bg-gradient-to-r from-[#1C7CFF] to-[#3DFF8F] bg-clip-text text-transparent">
              Recovery Stats
            </span>
          </h1>
          <p className="text-white/50 text-sm max-w-xl">
            Historical recovery timelines across NFL, NBA, MLB, NHL & Premier League.
            Median recovery days power our return-date prediction model.
          </p>

          {/* Data freshness pill */}
          {!isLoading && stats.length > 0 && (
            <div className="mt-4 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/8 border border-white/10 text-xs text-white/60">
              <span className="w-1.5 h-1.5 rounded-full bg-[#3DFF8F] animate-pulse" />
              {stats.length} injury type × league combinations
            </div>
          )}
        </div>
      </div>

      {/* Main content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Filter bar */}
        <div className="mb-8">
          <LeagueFilterBar value={leagueFilter} onChange={handleLeagueChange} />
        </div>

        {/* Error state */}
        {error && (
          <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            Failed to load recovery stats: {(error as Error).message}
          </div>
        )}

        {/* Stats list */}
        <RecoveryStatsList
          stats={stats}
          isLoading={isLoading}
          leagueFilter={leagueFilter}
        />
      </div>
    </div>
  );
}
