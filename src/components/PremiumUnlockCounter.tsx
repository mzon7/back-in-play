import { useAuth } from "@mzon7/zon-incubator-sdk/auth";
import { usePremiumUnlocks } from "../lib/premiumUnlocks";

/**
 * Small badge showing remaining premium unlocks.
 *
 * Shows: "2 of 3 premium unlocks left today" (auth)
 *    or: "1 of 2 free unlocks remaining" (anon)
 */
export function PremiumUnlockCounter({ className = "" }: { className?: string }) {
  const { user } = useAuth();
  const isAuth = !!user;
  const { getSummary } = usePremiumUnlocks();

  const summary = getSummary();

  // Don't show if no unlocks used yet
  if (summary.used === 0) return null;

  const color = summary.remaining === 0
    ? "text-red-400/60 border-red-500/15 bg-red-500/[0.06]"
    : summary.remaining <= 1
    ? "text-amber-400/60 border-amber-500/15 bg-amber-500/[0.06]"
    : "text-purple-400/60 border-purple-500/15 bg-purple-500/[0.06]";

  return (
    <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[10px] ${color} ${className}`}>
      <span className="text-[9px]">✦</span>
      {summary.remaining > 0 ? (
        <span>
          {summary.remaining} of {summary.limit} {isAuth ? "premium unlocks left today" : "free unlocks remaining"}
        </span>
      ) : (
        <span>
          {isAuth
            ? "Premium unlocks reset tomorrow"
            : "Create a free account for 3 daily unlocks"
          }
        </span>
      )}
    </div>
  );
}
