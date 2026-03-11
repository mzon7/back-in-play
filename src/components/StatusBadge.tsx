const STATUS_CONFIG: Record<string, { label: string; classes: string }> = {
  out:          { label: "OUT",          classes: "bg-red-500/20 text-red-400 border-red-500/30" },
  ir:           { label: "IR",           classes: "bg-red-500/20 text-red-400 border-red-500/30" },
  "il-10":      { label: "IL-10",        classes: "bg-red-500/20 text-red-400 border-red-500/30" },
  "il-15":      { label: "IL-15",        classes: "bg-red-500/20 text-red-400 border-red-500/30" },
  "il-60":      { label: "IL-60",        classes: "bg-red-500/20 text-red-400 border-red-500/30" },
  "il-7":       { label: "IL-7",         classes: "bg-red-500/20 text-red-400 border-red-500/30" },
  doubtful:     { label: "DOUBTFUL",     classes: "bg-orange-500/20 text-orange-400 border-orange-500/30" },
  questionable: { label: "QUESTIONABLE", classes: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" },
  "day-to-day": { label: "DAY-TO-DAY",  classes: "bg-amber-500/20 text-amber-400 border-amber-500/30" },
  probable:     { label: "PROBABLE",     classes: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
  active:       { label: "ACTIVE",       classes: "bg-green-500/20 text-green-400 border-green-500/30" },
  returned:     { label: "RETURNED",     classes: "bg-green-500/20 text-green-400 border-green-500/30" },
  active_today: { label: "PLAYING NOW",  classes: "bg-orange-500/20 text-orange-400 border-orange-500/30 animate-pulse" },
  reduced_load: { label: "REDUCED LOAD", classes: "bg-amber-500/20 text-amber-400 border-amber-500/30" },
  back_in_play: { label: "BACK IN PLAY", classes: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30" },
  suspended:    { label: "SUSPENDED",    classes: "bg-purple-500/20 text-purple-400 border-purple-500/30" },
};

export function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.out;
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wide border ${cfg.classes}`}
    >
      {cfg.label}
    </span>
  );
}
