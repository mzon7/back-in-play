import type { ReactNode } from "react";
import { Link } from "react-router-dom";

interface SectionCardProps {
  title: string;
  icon: string;
  viewAllTo?: string;
  children: ReactNode;
}

export function SectionCard({ title, icon, viewAllTo, children }: SectionCardProps) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-sm overflow-hidden shadow-xl shadow-black/20">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-white/3">
        <div className="flex items-center gap-2">
          <span className="text-lg">{icon}</span>
          <h2 className="font-bold text-sm uppercase tracking-widest text-white/90">{title}</h2>
        </div>
        {viewAllTo && (
          <Link
            to={viewAllTo}
            className="text-xs font-semibold text-[#1C7CFF] hover:text-[#1C7CFF]/70 transition-colors"
          >
            View all →
          </Link>
        )}
      </div>

      {/* Content */}
      <div>{children}</div>
    </div>
  );
}
