import { useState, useEffect, useRef, useCallback } from "react";
import {
  trackPremiumContentHover,
  trackPremiumContentClick,
  trackPremiumLockSeen,
  trackPremiumWaitlistClick,
} from "../lib/analytics";
import { WaitlistModal, useWaitlistModal } from "./WaitlistModal";

/**
 * Inline blurred insight with lock indicator.
 * Blurs the last ~40% of text content to tease premium depth.
 * Tracks hover/click interactions for premium engagement analytics.
 */
export function BlurredInsight({
  text,
  className = "",
  section = "model_insight",
  page = "props",
  playerName,
  statType,
  gamesBack,
}: {
  text: string;
  className?: string;
  section?: string;
  page?: string;
  playerName?: string;
  statType?: string;
  gamesBack?: number;
}) {
  const [showTooltip, setShowTooltip] = useState(false);
  const hoverDebounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lockTracked = useRef(false);

  // Track lock icon visibility once per mount
  useEffect(() => {
    if (lockTracked.current || !text || text.length < 30) return;
    lockTracked.current = true;
    trackPremiumLockSeen(page, section, playerName);
  }, [page, section, playerName, text]);

  const handleHover = useCallback(() => {
    setShowTooltip(true);
    // Debounce: only fire after 500ms of continuous hover
    clearTimeout(hoverDebounce.current);
    hoverDebounce.current = setTimeout(() => {
      trackPremiumContentHover({
        page,
        section,
        player_name: playerName,
        stat_type: statType,
        games_since_return: gamesBack,
      });
    }, 500);
  }, [page, section, playerName, statType, gamesBack]);

  const handleLeave = useCallback(() => {
    setShowTooltip(false);
    clearTimeout(hoverDebounce.current);
  }, []);

  const handleClick = useCallback(() => {
    setShowTooltip((v) => !v);
    trackPremiumContentClick({
      page,
      section,
      player_name: playerName,
      stat_type: statType,
      games_since_return: gamesBack,
    });
  }, [page, section, playerName, statType, gamesBack]);

  if (!text || text.length < 30) return <span className={className}>{text}</span>;

  const cutoff = Math.floor(text.length * 0.6);
  const visible = text.slice(0, cutoff);
  const blurred = text.slice(cutoff);

  return (
    <span
      className={`relative inline ${className}`}
      onMouseEnter={handleHover}
      onMouseLeave={handleLeave}
      onClick={handleClick}
    >
      {visible}
      <span className="select-none blur-[3px] opacity-60">{blurred}</span>
      <span className="text-[9px] text-white/25 ml-1 select-none cursor-default">🔒</span>
      {showTooltip && (
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-50 whitespace-nowrap rounded-lg bg-[#1a1f2e] border border-white/10 px-3 py-1.5 text-[10px] text-white/60 shadow-lg pointer-events-none">
          Full model breakdowns available in premium
        </span>
      )}
    </span>
  );
}

/**
 * Small inline "early access" CTA for bottom of sections.
 * Tracks waitlist clicks.
 */
export function EarlyAccessCTA({
  className = "",
  page = "unknown",
  location = "section_footer",
}: {
  className?: string;
  page?: string;
  location?: string;
}) {
  const waitlist = useWaitlistModal();
  return (
    <>
    <div className={`flex items-center justify-center gap-2 py-3 ${className}`}>
      <span className="text-[10px] text-white/20">🔒</span>
      <span className="text-[10px] text-white/25">
        Deeper model insights and advanced breakdowns coming soon
      </span>
      <span className="text-[10px] text-white/15">·</span>
      <button
        onClick={() => {
          trackPremiumWaitlistClick(page, location);
          waitlist.openModal(location, page);
        }}
        className="text-[10px] text-blue-400/50 hover:text-blue-400/80 transition-colors"
      >
        Get early access
      </button>
    </div>
    <WaitlistModal open={waitlist.open} onClose={waitlist.closeModal} source={waitlist.source} page={waitlist.page} />
    </>
  );
}
