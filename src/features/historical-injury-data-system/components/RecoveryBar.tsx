import { getSeverityColor } from "../lib/types";

interface RecoveryBarProps {
  injuryType: string;
  medianDays: number | null;
  maxScale?: number;
}

/**
 * Visual bar showing median recovery duration relative to max scale.
 */
export function RecoveryBar({ injuryType, medianDays, maxScale = 365 }: RecoveryBarProps) {
  if (medianDays == null) return null;
  const pct = Math.min((medianDays / maxScale) * 100, 100);
  const color = getSeverityColor(injuryType);

  return (
    <div className="relative h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
      <div
        className="absolute inset-y-0 left-0 rounded-full transition-all duration-700"
        style={{ width: `${pct}%`, backgroundColor: color }}
      />
    </div>
  );
}
