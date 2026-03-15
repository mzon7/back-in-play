/**
 * Lightweight embed of RecoveryStatsPage for the homepage tab.
 * Shows recovery stats in severity-grouped view without page chrome.
 */
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useRecoveryStats } from "../features/historical-injury-data-system/lib/queries";
import type { RecoveryStat } from "../features/historical-injury-data-system/lib/types";
import {
  LEAGUE_LABELS,
  INJURY_SEVERITY,
} from "../features/historical-injury-data-system/lib/types";

const SEVERITY_ORDER = ["critical", "major", "moderate", "minor"] as const;
const SEVERITY_LABEL: Record<string, string> = {
  critical: "Critical", major: "Major", moderate: "Moderate", minor: "Minor",
};

function SeveritySection({ tier, stats, showLeague }: { tier: string; stats: RecoveryStat[]; showLeague: boolean }) {
  const label = SEVERITY_LABEL[tier] ?? tier;
  const color = { critical: "#FF4D4D", major: "#FF8C00", moderate: "#1C7CFF", minor: "#3DFF8F" }[tier] ?? "#1C7CFF";
  const sorted = [...stats].sort((a, b) => (b.median_recovery_days ?? 0) - (a.median_recovery_days ?? 0));
  const maxDays = Math.max(...sorted.map((s) => s.median_recovery_days ?? 0), 1);

  return (
    <section className="mb-6">
      <div className="flex items-center gap-3 mb-2">
        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
        <h3 className="text-sm font-bold uppercase tracking-widest text-white/70">{label}</h3>
        <div className="flex-1 h-px bg-white/10" />
        <span className="text-xs text-white/30">{stats.length} types</span>
      </div>
      <div className="space-y-1.5">
        {sorted.map((stat) => {
          const pct = maxDays > 0 ? ((stat.median_recovery_days ?? 0) / maxDays) * 100 : 0;
          return (
            <Link
              key={stat.stat_id}
              to={`/injuries/${stat.injury_type_slug}`}
              className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-white/[0.04] transition-colors group"
            >
              <span className="text-sm text-white/80 w-36 sm:w-48 shrink-0 truncate group-hover:text-white">
                {stat.injury_type}
                {showLeague && (
                  <span className="text-[10px] text-white/30 ml-1">({LEAGUE_LABELS[stat.league_slug] ?? stat.league_slug})</span>
                )}
              </span>
              <div className="flex-1 h-5 bg-white/5 rounded-full overflow-hidden relative">
                <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(pct, 2)}%`, backgroundColor: `${color}88` }} />
                <span className="absolute inset-y-0 right-2 flex items-center text-[10px] text-white/40">{stat.sample_size} cases</span>
              </div>
              <span className="text-sm font-semibold tabular-nums w-12 text-right" style={{ color }}>
                {stat.median_recovery_days != null ? `${Math.round(stat.median_recovery_days)}d` : "—"}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

export default function RecoveryStatsEmbed({ leagueSlug }: { leagueSlug?: string }) {
  const { data: stats = [], isLoading } = useRecoveryStats(leagueSlug);

  const filtered = useMemo(() =>
    stats.filter((s) => s.sample_size >= 30 && s.injury_type_slug !== "other" && s.injury_type_slug !== "unknown"),
    [stats]
  );

  const severityGroups = useMemo(() => {
    const groups: Record<string, RecoveryStat[]> = {};
    for (const stat of filtered) {
      const sev = INJURY_SEVERITY[stat.injury_type] ?? "moderate";
      if (!groups[sev]) groups[sev] = [];
      groups[sev].push(stat);
    }
    return groups;
  }, [filtered]);

  const showLeague = !leagueSlug;
  const totalCases = filtered.reduce((sum, s) => sum + s.sample_size, 0);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3, 4, 5].map((i) => <div key={i} className="h-12 rounded-lg bg-white/10 animate-pulse" />)}
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-8 text-center">
        <p className="text-white/50">No recovery stats available{leagueSlug ? ` for ${LEAGUE_LABELS[leagueSlug]}` : ""}.</p>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-white/40">
          {filtered.length} injury types · {totalCases.toLocaleString()} cases
        </p>
        <Link to="/recovery-stats" className="text-xs text-[#1C7CFF] hover:text-[#1C7CFF]/80">
          Full stats &rarr;
        </Link>
      </div>
      {SEVERITY_ORDER.map((tier) =>
        severityGroups[tier]?.length ? (
          <SeveritySection key={tier} tier={tier} stats={severityGroups[tier]} showLeague={showLeague} />
        ) : null
      )}
    </>
  );
}
