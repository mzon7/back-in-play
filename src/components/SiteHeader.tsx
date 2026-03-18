import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "@mzon7/zon-incubator-sdk/auth";
import { usePremiumBannerTracking, trackPremiumBannerClick, trackNavClick } from "../lib/analytics";
import { WaitlistModal, useWaitlistModal } from "./WaitlistModal";

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
  const [menuOpen, setMenuOpen] = useState(false);
  const { user, signOut } = useAuth();
  const waitlist = useWaitlistModal();
  const location = useLocation();
  const currentPage = location.pathname === "/" ? "homepage" : location.pathname.replace(/^\//, "");
  usePremiumBannerTracking(currentPage);
  const allTabs: { key: string; label: string }[] = [
    { key: "top", label: "Top Players" },
    ...LEAGUE_ORDER.map((s) => ({ key: s, label: LEAGUE_LABELS[s] ?? s.toUpperCase() })),
  ];

  return (
    <>
    <nav className="sticky top-0 z-50 border-b border-white/10 bg-[#0A0E1A]/90 backdrop-blur-md">
      <div className="max-w-5xl lg:max-w-[1400px] mx-auto px-4 lg:px-10 py-4 flex items-center justify-between gap-4">
        <Link to="/" className="flex items-center gap-2 shrink-0">
          <span className="text-xl font-black tracking-tight">
            <span className="text-[#1C7CFF]">BACK</span>
            <span className="text-white/50 mx-1">IN</span>
            <span className="text-[#3DFF8F]">PLAY</span>
          </span>
          <span className="text-[9px] font-semibold tracking-wide rounded-full px-2 py-0.5 bg-[#1C7CFF]/10 text-[#1C7CFF]/60 border border-[#1C7CFF]/15">Early Access</span>
        </Link>

        {/* Desktop nav — ordered by value: Props emphasized */}
        <div className="hidden md:flex items-center gap-1 sm:gap-3 text-sm font-medium">
          <Link to="/" onClick={() => trackNavClick("/", "header")} className={`px-2 py-1 shrink-0 ${currentPage === "homepage" ? "text-[#1C7CFF]" : "text-white/60 hover:text-white transition-colors"}`}>Home</Link>
          <Link to="/props" onClick={() => trackNavClick("/props", "header")} className={`px-2 py-1 shrink-0 flex items-center gap-1 ${currentPage === "props" ? "text-[#3DFF8F]" : "text-[#3DFF8F]/70 hover:text-[#3DFF8F] transition-colors"}`}>
            <span>Props</span>
            <span className="text-[8px] font-bold uppercase tracking-wider bg-[#3DFF8F]/15 text-[#3DFF8F]/80 px-1.5 py-0.5 rounded-full border border-[#3DFF8F]/20">Signals</span>
          </Link>
          <Link to="/returning-today" onClick={() => trackNavClick("/returning-today", "header")} className={`px-2 py-1 shrink-0 ${currentPage === "returning-today" ? "text-white" : "text-white/50 hover:text-white/70 transition-colors"}`}>Returning Today</Link>
          <Link to="/recovery-stats" onClick={() => trackNavClick("/recovery-stats", "header")} className={`px-2 py-1 shrink-0 ${currentPage === "recovery-stats" ? "text-white" : "text-white/50 hover:text-white/70 transition-colors"}`}>Recovery Stats</Link>
          <Link to="/performance-curves" onClick={() => trackNavClick("/performance-curves", "header")} className={`px-2 py-1 shrink-0 ${currentPage === "performance-curves" ? "text-white" : "text-white/50 hover:text-white/70 transition-colors"}`}>Curves</Link>
          <Link to="/tracked-players" onClick={() => trackNavClick("/tracked-players", "header")} className={`px-2 py-1 shrink-0 ${currentPage === "tracked-players" ? "text-white" : "text-white/50 hover:text-white/70 transition-colors"}`} title="Tracked Players">&#9733;</Link>
          <span className="w-px h-5 bg-white/10 mx-1" />
          {user ? (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-white/40 truncate max-w-[120px]">{user.email}</span>
              <button
                onClick={() => signOut()}
                className="text-[11px] text-white/30 hover:text-white/60 transition-colors"
              >
                Sign out
              </button>
            </div>
          ) : (
            <Link
              to="/login"
              onClick={() => trackNavClick("/login", "header")}
              className="text-[12px] font-medium text-purple-300/70 hover:text-purple-300 transition-colors whitespace-nowrap"
            >
              Sign in
            </Link>
          )}
        </div>

        {/* Mobile hamburger */}
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className="md:hidden flex flex-col gap-1 p-2 -mr-2"
          aria-label="Menu"
        >
          <span className={`block w-5 h-0.5 bg-white/60 transition-transform ${menuOpen ? "rotate-45 translate-y-1.5" : ""}`} />
          <span className={`block w-5 h-0.5 bg-white/60 transition-opacity ${menuOpen ? "opacity-0" : ""}`} />
          <span className={`block w-5 h-0.5 bg-white/60 transition-transform ${menuOpen ? "-rotate-45 -translate-y-1.5" : ""}`} />
        </button>
      </div>

      {/* Mobile dropdown menu */}
      {menuOpen && (
        <div className="md:hidden border-t border-white/10 bg-[#0A0E1A]/95 backdrop-blur-md">
          <div className="flex flex-col px-4 py-2 text-sm font-medium">
            <Link to="/" onClick={() => { setMenuOpen(false); trackNavClick("/", "mobile_menu"); }} className="py-2.5 text-[#1C7CFF]">Home</Link>
            <Link to="/props" onClick={() => { setMenuOpen(false); trackNavClick("/props", "mobile_menu"); }} className="py-2.5 text-[#3DFF8F]/80 flex items-center gap-2">Props <span className="text-[8px] font-bold uppercase bg-[#3DFF8F]/15 text-[#3DFF8F]/70 px-1.5 py-0.5 rounded-full">Signals</span></Link>
            <Link to="/returning-today" onClick={() => { setMenuOpen(false); trackNavClick("/returning-today", "mobile_menu"); }} className="py-2.5 text-white/60">Returning Today</Link>
            <Link to="/recovery-stats" onClick={() => { setMenuOpen(false); trackNavClick("/recovery-stats", "mobile_menu"); }} className="py-2.5 text-white/60">Recovery Stats</Link>
            <Link to="/performance-curves" onClick={() => { setMenuOpen(false); trackNavClick("/performance-curves", "mobile_menu"); }} className="py-2.5 text-white/60">Performance Curves</Link>
            <Link to="/tracked-players" onClick={() => { setMenuOpen(false); trackNavClick("/tracked-players", "mobile_menu"); }} className="py-2.5 text-white/60">Tracked Players</Link>
            <div className="border-t border-white/10 mt-1 pt-1">
              {user ? (
                <div className="py-2.5 flex items-center justify-between">
                  <span className="text-[11px] text-white/40 truncate">{user.email}</span>
                  <button onClick={() => { signOut(); setMenuOpen(false); }} className="text-[11px] text-white/30 hover:text-white/60">Sign out</button>
                </div>
              ) : (
                <Link to="/login" onClick={() => { setMenuOpen(false); trackNavClick("/login", "mobile_menu"); }} className="py-2.5 text-purple-300/70 block">Sign in</Link>
              )}
            </div>
          </div>
        </div>
      )}

      {showTabs && onTabChange && (
        <div className="max-w-5xl lg:max-w-[1400px] mx-auto px-4 lg:px-10">
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
    <div className="border-b border-white/5 bg-gradient-to-r from-[#0A0E1A]/80 to-[#0D1224]/80">
      <div className="max-w-5xl lg:max-w-[1400px] mx-auto px-4 lg:px-10 py-1.5 flex items-center justify-between gap-4">
        <p className="text-[11px] text-white/40 leading-relaxed">
          <span className="text-purple-400/60">Premium</span> — Deeper model insights, advanced filters, and full player breakdowns coming soon
        </p>
        <button
          onClick={() => { trackPremiumBannerClick(currentPage); waitlist.openModal("premium_banner", currentPage); }}
          className="text-[10px] text-purple-400/40 hover:text-purple-400/70 transition-colors whitespace-nowrap shrink-0 border border-purple-400/15 rounded-full px-2.5 py-0.5"
        >
          Get early access
        </button>
      </div>
    </div>
    <WaitlistModal open={waitlist.open} onClose={waitlist.closeModal} source={waitlist.source} page={waitlist.page} />
    </>
  );
}
