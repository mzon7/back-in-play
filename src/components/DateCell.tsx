interface DateCellProps {
  value: string | null | undefined;
  /** Label prepended before the date, e.g. "Ret:" */
  label?: string;
  className?: string;
}

function formatDate(dateStr: string): string {
  // Parse as UTC to avoid timezone-shift off-by-one
  const [year, month, day] = dateStr.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function DateCell({ value, label, className }: DateCellProps) {
  const display = value ? formatDate(value) : "TBD";
  const muted = !value;

  return (
    <span className={className ?? "text-xs"}>
      {label && <span className="text-white/40">{label} </span>}
      <span className={muted ? "text-white/30 italic" : "text-white/70"}>{display}</span>
    </span>
  );
}
