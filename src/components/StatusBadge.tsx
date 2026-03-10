export type InjuryStatus =
  | "out"
  | "doubtful"
  | "questionable"
  | "probable"
  | "returned";

const STATUS_CONFIG: Record<InjuryStatus, { label: string; classes: string }> = {
  out:          { label: "OUT",          classes: "bg-red-500/20 text-red-400 border-red-500/30" },
  doubtful:     { label: "DOUBTFUL",     classes: "bg-orange-500/20 text-orange-400 border-orange-500/30" },
  questionable: { label: "QUESTIONABLE", classes: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" },
  probable:     { label: "PROBABLE",     classes: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
  returned:     { label: "RETURNED",     classes: "bg-green-500/20 text-green-400 border-green-500/30" },
};

export function StatusBadge({ status }: { status: InjuryStatus }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.out;
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wide border ${cfg.classes}`}
    >
      {cfg.label}
    </span>
  );
}
