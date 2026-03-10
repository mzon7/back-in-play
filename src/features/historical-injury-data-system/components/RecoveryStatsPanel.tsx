import { getSeverityColor, INJURY_SEVERITY, type RecoveryStat } from "../lib/types";
import { RecoveryBar } from "./RecoveryBar";

interface RecoveryStatsPanelProps {
  stat: RecoveryStat;
  maxScale?: number;
}

/**
 * Card panel showing full recovery statistics for a single injury type + league.
 */
export function RecoveryStatsPanel({ stat, maxScale = 365 }: RecoveryStatsPanelProps) {
  const severity = INJURY_SEVERITY[stat.injury_type] ?? "moderate";
  const color = getSeverityColor(stat.injury_type);
  const severityLabel = severity.charAt(0).toUpperCase() + severity.slice(1);

  return (
    <div
      className="rounded-xl border bg-white/5 p-5 hover:bg-white/8 transition-colors"
      style={{ borderColor: `${color}33` }}
      data-testid="recovery-stats-panel"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="font-semibold text-white text-sm leading-tight">
            {stat.injury_type}
          </h3>
          <span
            className="inline-block mt-1 text-xs font-medium px-2 py-0.5 rounded-full"
            style={{ backgroundColor: `${color}22`, color }}
          >
            {severityLabel}
          </span>
        </div>
        <div className="text-right shrink-0">
          <div className="text-2xl font-bold tabular-nums" style={{ color }}>
            {stat.median_recovery_days != null ? Math.round(stat.median_recovery_days) : "—"}
          </div>
          <div className="text-[10px] text-white/40 uppercase tracking-wide">
            median days
          </div>
        </div>
      </div>

      {/* Recovery bar */}
      <RecoveryBar
        injuryType={stat.injury_type}
        medianDays={stat.median_recovery_days}
        maxScale={maxScale}
      />

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-2 mt-4">
        <StatCell
          label="Avg"
          value={stat.average_recovery_days != null ? Math.round(stat.average_recovery_days) : null}
          unit="d"
        />
        <StatCell
          label="Min"
          value={stat.min_recovery_days}
          unit="d"
        />
        <StatCell
          label="Max"
          value={stat.max_recovery_days}
          unit="d"
        />
      </div>

      {/* Sample size */}
      <div className="mt-3 text-[11px] text-white/30 text-right">
        {stat.sample_size} {stat.sample_size === 1 ? "record" : "records"}
      </div>
    </div>
  );
}

function StatCell({
  label,
  value,
  unit,
}: {
  label: string;
  value: number | null;
  unit: string;
}) {
  return (
    <div className="text-center bg-white/5 rounded-lg py-2">
      <div className="text-xs text-white/40 uppercase tracking-wide mb-0.5">{label}</div>
      <div className="text-sm font-semibold text-white tabular-nums">
        {value != null ? `${value}${unit}` : "—"}
      </div>
    </div>
  );
}
