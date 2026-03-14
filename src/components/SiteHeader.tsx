import { Link } from "react-router-dom";

const LEAGUE_ORDER = ["nba", "nfl", "mlb", "nhl", "premier-league"];
const LEAGUE_LABELS: Record<string, string> = {
  nba: "NBA", nfl: "NFL", mlb: "MLB", nhl: "NHL", "premier-league": "EPL",
};

interface SiteHeaderProps {
  activeTab?: string | null;
  onTabChange?: (tab: string) => void;
  showTabs?: boolean;
}

export function SiteHeader({ activeTab, onTabChange, showTabs = false }: SiteHeaderProps) {
  const allTabs: { key: string; label: string }[] = [
    { key: "top", label: "Top Players" },
    ...LEAGUE_ORDER.map((s) => ({ key: s, label: LEAGUE_LABELS[s] ?? s.toUpperCase() })),
  ];

  return (
    <>
    <nav className="sticky top-0 z-50 border-b border-white/10 bg-[#0A0E1A]/90 backdrop-blur-md">
      <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
        <Link to="/" className="flex items-center gap-2 shrink-0">
          <span className="text-xl font-black tracking-tight">
            <span className="text-[#1C7CFF]">BACK</span>
            <span className="text-white/50 mx-1">IN</span>
            <span className="text-[#3DFF8F]">PLAY</span>
          </span>
          <span className="text-[9px] font-semibold tracking-wide rounded-full px-2 py-0.5 bg-[#1C7CFF]/10 text-[#1C7CFF]/60 border border-[#1C7CFF]/15">Early Access</span>
        </Link>

        <div className="flex items-center gap-1 sm:gap-3 text-sm font-medium">
          <Link to="/" className="px-2 py-1 text-[#1C7CFF] shrink-0">Home</Link>
          {(typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")) && (
            <Link to="/recovery-stats" className="px-2 py-1 text-white/60 hover:text-white transition-colors shrink-0">Recovery Stats</Link>
          )}
          <Link to="/props" className="px-2 py-1 text-white/60 hover:text-white transition-colors shrink-0">Props</Link>
          <Link to="/performance-curves" className="px-2 py-1 text-white/60 hover:text-white transition-colors shrink-0">Performance Curves</Link>
          <Link to="/tracked-players" className="px-2 py-1 text-white/60 hover:text-white transition-colors shrink-0" title="Tracked Players">&#9733;</Link>
          {(typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")) && (
            <Link to="/returning-today" className="px-2 py-1 text-white/60 hover:text-white transition-colors shrink-0">Returning Today</Link>
          )}
        </div>
      </div>

      {showTabs && onTabChange && (
        <div className="max-w-5xl mx-auto px-4">
          <div className="flex border-b border-white/5">
            {allTabs.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => onTabChange(key)}
                className={`px-4 py-2.5 text-sm font-semibold transition-colors relative whitespace-nowrap ${
                  activeTab === key
                    ? "text-white"
                    : "text-white/45 hover:text-white/70"
                }`}
              >
                {key === "top" && "\uD83D\uDC51 "}
                {label}
                {activeTab === key && (
                  <span className={`absolute bottom-0 left-0 right-0 h-[2px] rounded-full ${
                    key === "top" ? "bg-amber-400" : "bg-[#1C7CFF]"
                  }`} />
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </nav>
    <div className="border-b border-white/5 bg-[#0A0E1A]/80">
      <div className="max-w-5xl mx-auto px-4 py-1.5 flex items-center justify-between gap-4">
        <p className="text-[11px] text-white/40 leading-relaxed">
          🚀 Early Access — Back In Play is the first public version of a sports injury recovery analytics platform. New data and models are added weekly.
        </p>
        <a href="mailto:feedback@backinplay.ai" className="text-[11px] text-white/30 hover:text-white/50 transition-colors whitespace-nowrap shrink-0">
          Send feedback
        </a>
      </div>
    </div>
    </>
  );
}
