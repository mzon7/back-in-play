import { useState, useCallback, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@mzon7/zon-incubator-sdk/auth";
import { usePremiumUnlocks } from "../lib/premiumUnlocks";
import { trackPremiumContentClick, trackPremiumUnlock, trackPremiumSignupPrompt, trackPremiumLimitHit, trackSignupCtaClick, trackSignupModalDismiss } from "../lib/analytics";

/**
 * PremiumGate — wraps a premium value with blur + unlock button.
 *
 * When locked: shows blurred placeholder (same dimensions).
 * When unlocked: shows real content with no layout shift.
 *
 * Does NOT wrap entire cards — only individual premium values
 * (edge %, model projection, gap, recommendation, etc.)
 */
export function PremiumGate({
  contentId,
  children,
  placeholder,
  section = "premium_value",
  playerName,
  className = "",
  inline = false,
}: {
  contentId: string;
  children: ReactNode;
  placeholder?: ReactNode;
  section?: string;
  playerName?: string;
  className?: string;
  inline?: boolean;
}) {
  const { user } = useAuth();
  const isAuth = !!user;
  const { getStatus, tryUnlock, getSummary } = usePremiumUnlocks();

  const status = getStatus(contentId);
  const [showSignupPrompt, setShowSignupPrompt] = useState(false);
  const [showLimitMsg, setShowLimitMsg] = useState(false);

  const handleUnlock = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();

    trackPremiumContentClick({
      page: "props",
      section,
      player_name: playerName,
    });

    const current = getStatus(contentId);

    if (current.requiresSignup) {
      trackPremiumLimitHit({ page: "props", is_authenticated: isAuth, unlocks_used: getSummary().used });
      trackPremiumSignupPrompt("props", section);
      setShowSignupPrompt(true);
      return;
    }

    // Auth user out of daily unlocks
    if (isAuth && current.remaining <= 0 && !current.isUnlocked) {
      trackPremiumLimitHit({ page: "props", is_authenticated: isAuth, unlocks_used: getSummary().used });
      setShowLimitMsg(true);
      setTimeout(() => setShowLimitMsg(false), 3000);
      return;
    }

    const success = await tryUnlock(contentId);
    if (success) {
      const summary = getSummary();
      trackPremiumUnlock({
        page: "props",
        section,
        content_id: contentId,
        player_name: playerName,
        unlock_number: summary.used,
        is_authenticated: isAuth,
      });
    }
  }, [contentId, isAuth, section, playerName, getStatus, tryUnlock, getSummary]);

  if (status.isUnlocked) {
    return <>{children}</>;
  }

  const Tag = inline ? "span" : "div";

  return (
    <Tag className={`relative group cursor-pointer ${className}`} onClick={handleUnlock}>
      {/* Blurred placeholder — preserves layout */}
      <Tag className={`${inline ? "inline-flex" : "flex"} items-center select-none`}>
        <Tag className="blur-[6px] opacity-40 pointer-events-none">
          {placeholder ?? children}
        </Tag>
      </Tag>

      {/* Lock overlay — always visible on mobile, hover-reveal on desktop */}
      <Tag className={`absolute inset-0 ${inline ? "inline-flex" : "flex"} items-center justify-center`}>
        <span className="flex items-center gap-1 text-[9px] text-white/40 group-hover:text-purple-300/70 transition-colors whitespace-nowrap">
          <span className="text-[8px]">🔒</span>
          <span className="inline sm:hidden">Unlock</span>
          <span className="hidden sm:group-hover:inline">Unlock</span>
        </span>
      </Tag>

      {/* Daily limit reached toast (authenticated users) */}
      {showLimitMsg && (
        <div className="absolute -top-8 left-1/2 -translate-x-1/2 z-50 whitespace-nowrap rounded-lg bg-[#0D1224] border border-purple-500/20 px-3 py-1.5 shadow-lg">
          <p className="text-[10px] text-purple-300/80 font-medium">Premium unlocks refresh tomorrow</p>
        </div>
      )}

      {/* Signup prompt modal (anonymous users) */}
      {showSignupPrompt && (
        <SignupPromptInline onClose={() => setShowSignupPrompt(false)} />
      )}
    </Tag>
  );
}

/**
 * Signup prompt — fixed overlay modal.
 * Appears when anon user exhausts 2 free unlocks.
 * Clicking outside the box dismisses it.
 */
function SignupPromptInline({ onClose }: { onClose: () => void }) {
  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation(); // prevent bubbling to PremiumGate's handleUnlock
    trackSignupModalDismiss("props");
    onClose();
  };
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm px-4" onClick={handleDismiss}>
      <div
        className="w-full max-w-xs rounded-xl border border-purple-500/20 bg-[#0D1224] p-5 shadow-[0_8px_32px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-2">
          <div>
            <p className="text-[13px] font-semibold text-white">Free during beta</p>
            <p className="text-[11px] text-white/35 mt-1">
              Create a free account to continue unlocking premium insights
            </p>
          </div>
          <button onClick={handleDismiss} className="text-white/25 hover:text-white/50 text-sm leading-none ml-2 shrink-0">&times;</button>
        </div>
        <div className="flex gap-2 mt-4">
          <Link
            to={`/signup?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`}
            onClick={() => trackSignupCtaClick("props", "premium_gate_modal")}
            className="flex-1 rounded-lg bg-purple-500/20 border border-purple-500/25 px-3 py-2 text-[11px] font-medium text-purple-300/80 hover:bg-purple-500/30 hover:text-purple-200 transition-colors text-center"
          >
            Create Free Account
          </Link>
          <Link
            to={`/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`}
            className="rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-[11px] text-white/40 hover:text-white/60 transition-colors text-center"
          >
            Sign in
          </Link>
        </div>
        <p className="text-[9px] text-white/15 mt-3 text-center">3 premium unlocks per day with a free account</p>
      </div>
    </div>
  );
}
