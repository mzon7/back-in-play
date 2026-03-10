import { formatDateUTC } from "../lib/dates";

interface DateCellProps {
  value: string | null | undefined;
  /** Label prepended before the date, e.g. "Ret:" */
  label?: string;
  className?: string;
}

export function DateCell({ value, label, className }: DateCellProps) {
  // Null/undefined → "TBD". Dates parsed as UTC calendar dates to avoid
  // timezone-driven off-by-one display errors (see src/lib/dates.ts).
  const display = value ? formatDateUTC(value) : "TBD";
  const muted = !value;

  return (
    <span className={className ?? "text-xs"}>
      {label && <span className="text-white/40">{label} </span>}
      <span className={muted ? "text-white/30 italic" : "text-white/70"}>{display}</span>
    </span>
  );
}
