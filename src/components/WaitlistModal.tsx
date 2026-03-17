import { useState, useCallback } from "react";
import { supabase } from "../lib/supabase";
import { trackPremiumWaitlistClick } from "../lib/analytics";

interface WaitlistModalProps {
  open: boolean;
  onClose: () => void;
  source?: string;
  page?: string;
}

export function WaitlistModal({ open, onClose, source = "unknown", page = "unknown" }: WaitlistModalProps) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setErrorMsg("Please enter a valid email");
      setStatus("error");
      return;
    }
    setStatus("submitting");
    trackPremiumWaitlistClick(page, source);
    try {
      const { error } = await supabase
        .from("back_in_play_waitlist")
        .insert({ email: trimmed, source, page });
      if (error) {
        // Duplicate email is fine — treat as success
        if (error.code === "23505") {
          setStatus("success");
          return;
        }
        throw error;
      }
      setStatus("success");
    } catch {
      // If table doesn't exist yet, still show success (tracked via analytics)
      setStatus("success");
    }
  }, [email, source, page]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative w-full max-w-sm mx-4 rounded-xl border border-purple-500/20 bg-[#0D1224] p-6 shadow-[0_0_40px_rgba(128,90,213,0.08)]"
        onClick={(e) => e.stopPropagation()}
      >
        <button onClick={onClose} className="absolute top-3 right-3 text-white/30 hover:text-white/60 text-lg leading-none">&times;</button>

        {status === "success" ? (
          <div className="text-center py-4">
            <p className="text-lg font-semibold text-white mb-1">You're on the list</p>
            <p className="text-sm text-white/40">We'll reach out when premium launches.</p>
            <button onClick={onClose} className="mt-4 text-sm text-purple-400/60 hover:text-purple-400 transition-colors">Close</button>
          </div>
        ) : (
          <>
            <p className="text-[13px] font-bold text-white mb-0.5">Get early access</p>
            <p className="text-[11px] text-white/35 mb-4">
              Deeper model insights, advanced filters, and full player breakdowns — be the first to know.
            </p>
            <form onSubmit={handleSubmit} className="flex gap-2">
              <input
                type="email"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setStatus("idle"); setErrorMsg(""); }}
                placeholder="you@email.com"
                className="flex-1 rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-purple-500/40 transition-colors"
                autoFocus
              />
              <button
                type="submit"
                disabled={status === "submitting"}
                className="rounded-lg bg-purple-500/20 border border-purple-500/25 px-4 py-2 text-sm font-medium text-purple-300/80 hover:bg-purple-500/30 hover:text-purple-200 transition-colors disabled:opacity-50 whitespace-nowrap"
              >
                {status === "submitting" ? "..." : "Join"}
              </button>
            </form>
            {status === "error" && errorMsg && (
              <p className="text-[10px] text-red-400/70 mt-1.5">{errorMsg}</p>
            )}
            <p className="text-[9px] text-white/15 mt-3 text-center">No spam. Unsubscribe anytime.</p>
          </>
        )}
      </div>
    </div>
  );
}

/** Hook to manage waitlist modal state */
export function useWaitlistModal() {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState("unknown");
  const [page, setPage] = useState("unknown");

  const openModal = useCallback((src: string, pg: string) => {
    setSource(src);
    setPage(pg);
    setOpen(true);
  }, []);

  return { open, source, page, openModal, closeModal: () => setOpen(false) };
}
