/**
 * Premium unlock system — soft paywall for beta.
 *
 * Anonymous users: 2 free unlocks total (localStorage).
 * Authenticated users: 3 unlocks per day (Supabase DB, keyed per user).
 *
 * Daily reset: UTC midnight (consistent for all users, not gameable via TZ change).
 *
 * Each unlock is keyed by a unique content ID (e.g. "player-123-pts")
 * so the same content stays unlocked across page navigations.
 */

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { useAuth } from "@mzon7/zon-incubator-sdk/auth";
import { supabase } from "./supabase";

const ANON_KEY = "bip_premium_unlocks";
const ANON_LIMIT = 2;
const AUTH_DAILY_LIMIT = 3;
const TABLE = "back_in_play_premium_unlocks";

// ── Helpers ──

/** Today's date in UTC as YYYY-MM-DD */
function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Anonymous (localStorage) ──

interface AnonState {
  unlocked: string[];
}

function loadAnon(): AnonState {
  try {
    const raw = localStorage.getItem(ANON_KEY);
    if (!raw) return { unlocked: [] };
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.unlocked)) return { unlocked: [] };
    return { unlocked: parsed.unlocked.filter((x: unknown) => typeof x === "string") };
  } catch {
    return { unlocked: [] };
  }
}

function saveAnon(state: AnonState) {
  localStorage.setItem(ANON_KEY, JSON.stringify(state));
}

// ── Public types ──

export interface UnlockStatus {
  isUnlocked: boolean;
  remaining: number;
  limit: number;
  used: number;
  requiresSignup: boolean;
}

export interface UnlockSummary {
  remaining: number;
  limit: number;
  used: number;
  requiresSignup: boolean;
}

// ── Context (manages auth unlocks from DB) ──

interface PremiumUnlocksContextValue {
  /** Set of content IDs unlocked today (auth) or ever (anon) */
  unlockedIds: Set<string>;
  /** Number of auth unlocks used today */
  authUsed: number;
  /** Whether DB data has loaded */
  loaded: boolean;
  /** Try to unlock a content ID. Returns true on success. */
  tryUnlock: (contentId: string) => Promise<boolean>;
  /** Check status for a specific content ID */
  getStatus: (contentId: string) => UnlockStatus;
  /** Global summary */
  getSummary: () => UnlockSummary;
}

const PremiumUnlocksContext = createContext<PremiumUnlocksContextValue | null>(null);

export function PremiumUnlocksProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const isAuth = !!user;

  // Auth unlocks from DB (today only)
  const [authUnlocked, setAuthUnlocked] = useState<Set<string>>(new Set());
  const [dbLoaded, setDbLoaded] = useState(false);

  // Anon unlocks from localStorage
  const [anonUnlocked, setAnonUnlocked] = useState<Set<string>>(() => new Set(loadAnon().unlocked));

  // Load auth unlocks from DB when user logs in
  useEffect(() => {
    if (authLoading) return;

    if (!user) {
      setAuthUnlocked(new Set());
      setDbLoaded(true);
      return;
    }

    let cancelled = false;
    setDbLoaded(false);

    supabase
      .from(TABLE)
      .select("content_id")
      .eq("user_id", user.id)
      .eq("unlock_date", todayUTC())
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          // Table might not exist yet — fall back gracefully
          console.warn("[premiumUnlocks] DB load error:", error.message);
          setDbLoaded(true);
          return;
        }
        setAuthUnlocked(new Set((data ?? []).map((r) => r.content_id)));
        setDbLoaded(true);
      });

    return () => { cancelled = true; };
  }, [user, authLoading]);

  // Merge anon + auth unlocks into a single set
  const unlockedIds = new Set([...anonUnlocked, ...authUnlocked]);

  const getStatus = useCallback((contentId: string): UnlockStatus => {
    if (isAuth) {
      const isUnlocked = unlockedIds.has(contentId);
      const used = authUnlocked.size;
      const remaining = Math.max(0, AUTH_DAILY_LIMIT - used);
      return { isUnlocked, remaining, limit: AUTH_DAILY_LIMIT, used, requiresSignup: false };
    }
    const isUnlocked = anonUnlocked.has(contentId);
    const used = anonUnlocked.size;
    const remaining = Math.max(0, ANON_LIMIT - used);
    return { isUnlocked, remaining, limit: ANON_LIMIT, used, requiresSignup: used >= ANON_LIMIT && !isUnlocked };
  }, [isAuth, unlockedIds, authUnlocked, anonUnlocked]);

  const getSummary = useCallback((): UnlockSummary => {
    if (isAuth) {
      const used = authUnlocked.size;
      return { remaining: Math.max(0, AUTH_DAILY_LIMIT - used), limit: AUTH_DAILY_LIMIT, used, requiresSignup: false };
    }
    const used = anonUnlocked.size;
    return { remaining: Math.max(0, ANON_LIMIT - used), limit: ANON_LIMIT, used, requiresSignup: used >= ANON_LIMIT };
  }, [isAuth, authUnlocked, anonUnlocked]);

  const tryUnlock = useCallback(async (contentId: string): Promise<boolean> => {
    if (isAuth && user) {
      // Already unlocked (auth or anon carry-over)?
      if (authUnlocked.has(contentId) || anonUnlocked.has(contentId)) return true;
      if (authUnlocked.size >= AUTH_DAILY_LIMIT) return false;

      // Optimistic update
      setAuthUnlocked((prev) => new Set([...prev, contentId]));

      // Write to DB
      const { error } = await supabase.from(TABLE).insert({
        user_id: user.id,
        content_id: contentId,
        unlock_date: todayUTC(),
      });

      if (error) {
        // Duplicate (already unlocked) is fine
        if (error.code !== "23505") {
          console.warn("[premiumUnlocks] DB write error:", error.message);
          // Revert optimistic update
          setAuthUnlocked((prev) => {
            const next = new Set(prev);
            next.delete(contentId);
            return next;
          });
          return false;
        }
      }
      return true;
    }

    // Anonymous
    if (anonUnlocked.has(contentId)) return true;
    if (anonUnlocked.size >= ANON_LIMIT) return false;

    const newAnon = { unlocked: [...anonUnlocked, contentId] };
    saveAnon(newAnon);
    setAnonUnlocked(new Set(newAnon.unlocked));
    return true;
  }, [isAuth, user, authUnlocked, anonUnlocked]);

  const value: PremiumUnlocksContextValue = {
    unlockedIds,
    authUsed: authUnlocked.size,
    loaded: dbLoaded && !authLoading,
    tryUnlock,
    getStatus,
    getSummary,
  };

  return (
    <PremiumUnlocksContext.Provider value={value}>
      {children}
    </PremiumUnlocksContext.Provider>
  );
}

export function usePremiumUnlocks(): PremiumUnlocksContextValue {
  const ctx = useContext(PremiumUnlocksContext);
  if (!ctx) throw new Error("usePremiumUnlocks must be used inside PremiumUnlocksProvider");
  return ctx;
}
