import { Link } from "react-router-dom";

interface EmptyStateAction {
  label: string;
  to: string;
}

interface EmptyStateProps {
  icon?: string;
  title: string;
  description?: string;
  action?: EmptyStateAction;
}

export function EmptyState({ icon = "📭", title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-10 px-6 text-center gap-3">
      <span className="text-3xl opacity-50" aria-hidden="true">
        {icon}
      </span>
      <p className="text-sm font-semibold text-white/50">{title}</p>
      {description && (
        <p className="text-xs text-white/30 max-w-xs leading-relaxed">{description}</p>
      )}
      {action && (
        <Link
          to={action.to}
          className="mt-1 text-xs font-semibold text-[#1C7CFF] hover:text-[#1C7CFF]/70 transition-colors"
        >
          {action.label} →
        </Link>
      )}
    </div>
  );
}
