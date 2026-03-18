import { track } from "@vercel/analytics";
import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

// ──────────────────────────────────────────────
// EVENT NAME REGISTRY — keep these stable forever.
// Renaming breaks Vercel Analytics historical data.
// ──────────────────────────────────────────────
const EVT = {
  NAVIGATE:                "navigate",
  HEADLINE_CARD_CLICK:     "headline_card_click",
  PLAYER_CARD_CLICK:       "player_card_click",
  PLAYER_PAGE_VIEW:        "player_page_view",
  PERFORMANCE_CURVES_OPEN: "performance_curves_open",
  PROPS_PAGE_OPEN:         "props_page_open",
  RECOVERY_STATS_OPEN:     "recovery_stats_open",
  RETURNING_TODAY_OPEN:    "returning_today_open",
  LEAGUE_FILTER:           "league_filter",
  CURVE_EXPAND:            "curve_expand",
  STAT_DRILLDOWN:          "stat_drilldown",
  PROP_LINE_CLICK:         "prop_line_click",
  // Premium / paywall tease events
  PREMIUM_BANNER_VIEW:     "premium_banner_view",
  PREMIUM_BANNER_CLICK:    "premium_banner_click",
  PREMIUM_CONTENT_HOVER:   "premium_content_hover",
  PREMIUM_CONTENT_CLICK:   "premium_content_click",
  PREMIUM_LOCK_SEEN:       "premium_lock_seen",
  PREMIUM_WAITLIST_CLICK:  "premium_waitlist_click",
  PREMIUM_UNLOCK:          "premium_unlock",
  PREMIUM_SIGNUP_PROMPT:   "premium_signup_prompt",
  PREMIUM_LIMIT_HIT:       "premium_limit_hit",
  PLAYER_ANALYSIS_VIEW:    "player_analysis_view",
  // Auth funnel
  LOGIN_SUCCESS:           "login_success",
  SIGNUP_SUCCESS:          "signup_success",
  SIGNUP_CTA_CLICK:        "signup_cta_click",
  SIGNUP_MODAL_DISMISS:    "signup_modal_dismiss",
  GOOGLE_OAUTH_CLICK:      "google_oauth_click",
  // Navigation
  NAV_CLICK:               "nav_click",
  // Props interactions
  FILTER_CHANGE:           "filter_change",
  TABLE_SORT:              "table_sort",
  OPPORTUNITY_ROW_CLICK:   "opportunity_row_click",
  DATE_FILTER_CHANGE:      "date_filter_change",
  // Visitor tracking
  VISITOR_FIRST_SEEN:      "visitor_first_seen",
  VISITOR_SESSION_START:    "visitor_session_start",
  VISITOR_RETURNING:        "visitor_returning",
  VISITOR_SAME_DAY_RETURN:  "visitor_same_day_return",
} as const;

/**
 * Track navigation transitions between pages.
 * Fires once per unique pathname change (guards against React strict-mode
 * double-mount and same-route navigations).
 */
export function usePageTracking() {
  const location = useLocation();
  const prevPath = useRef<string | null>(null);

  useEffect(() => {
    const path = location.pathname;

    // Guard: skip if same path (strict-mode remount or same-route nav)
    if (path === prevPath.current) return;

    // Navigation transition event
    track(EVT.NAVIGATE, {
      from: prevPath.current ?? "(direct)",
      to: path,
    });

    // Page-specific open events
    if (path === "/performance-curves") {
      track(EVT.PERFORMANCE_CURVES_OPEN);
    } else if (path === "/props") {
      track(EVT.PROPS_PAGE_OPEN);
    } else if (path === "/recovery-stats") {
      track(EVT.RECOVERY_STATS_OPEN);
    } else if (path === "/returning-today" || path.endsWith("/returning-today")) {
      track(EVT.RETURNING_TODAY_OPEN);
    } else if (path.startsWith("/player/") || path.startsWith("/injury/")) {
      const slug = path.split("/")[2] ?? "";
      track(EVT.PLAYER_PAGE_VIEW, { player_slug: slug });
    }

    prevPath.current = path;
  }, [location.pathname]);
}

/** Track headline card clicks on the homepage */
export function trackHeadlineClick(player: string, league: string, status: string) {
  track(EVT.HEADLINE_CARD_CLICK, { player, league, status });
}

/**
 * Track player card clicks (from InjuryPlayerCard).
 * Uses stopPropagation to prevent parent click handlers from double-firing.
 */
export function trackPlayerCardClick(e: React.MouseEvent, player: string, league?: string) {
  e.stopPropagation();
  track(EVT.PLAYER_CARD_CLICK, { player, league: league ?? "unknown" });
}

/** Track league filter selection */
export function trackLeagueFilter(league: string, page: string) {
  track(EVT.LEAGUE_FILTER, { league, page });
}

/** Track performance curve card expansion */
export function trackCurveExpand(injuryType: string, league: string) {
  track(EVT.CURVE_EXPAND, { injury_type: injuryType, league });
}

/** Track stat drill-down open */
export function trackStatDrillDown(stat: string, injuryType: string) {
  track(EVT.STAT_DRILLDOWN, { stat, injury_type: injuryType });
}

/** Track prop line click */
export function trackPropLineClick(player: string, stat: string) {
  track(EVT.PROP_LINE_CLICK, { player, stat });
}

// ──────────────────────────────────────────────
// PREMIUM ANALYTICS — paywall tease engagement
// ──────────────────────────────────────────────

/** Simple user segment: new vs returning */
function getUserSegment(): "new_user" | "returning_user" {
  const key = "bip_visited";
  if (typeof window === "undefined") return "new_user";
  const visited = localStorage.getItem(key);
  if (!visited) {
    localStorage.setItem(key, Date.now().toString());
    return "new_user";
  }
  return "returning_user";
}

// ──────────────────────────────────────────────
// VISITOR TRACKING — lightweight new/returning detection
// ──────────────────────────────────────────────

const VISITOR_STORAGE_KEY = "bip_visitor";

interface VisitorData {
  id: string;
  first_seen: string; // ISO date YYYY-MM-DD
  last_seen: string;  // ISO date YYYY-MM-DD
  last_session: string; // ISO date YYYY-MM-DD
}

function generateVisitorId(): string {
  return `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

function getOrCreateVisitor(): { visitor: VisitorData; isNew: boolean } {
  if (typeof window === "undefined") {
    return { visitor: { id: "ssr", first_seen: todayISO(), last_seen: todayISO(), last_session: todayISO() }, isNew: true };
  }
  const raw = localStorage.getItem(VISITOR_STORAGE_KEY);
  if (raw) {
    try {
      return { visitor: JSON.parse(raw) as VisitorData, isNew: false };
    } catch { /* corrupted — treat as new */ }
  }
  const visitor: VisitorData = {
    id: generateVisitorId(),
    first_seen: todayISO(),
    last_seen: todayISO(),
    last_session: todayISO(),
  };
  localStorage.setItem(VISITOR_STORAGE_KEY, JSON.stringify(visitor));
  return { visitor, isNew: true };
}

function updateVisitor(visitor: VisitorData): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(VISITOR_STORAGE_KEY, JSON.stringify(visitor));
}

/**
 * Hook: fires visitor tracking events once per app load.
 * Must be called inside a component (uses useEffect + useRef).
 */
export function useVisitorTracking() {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    const today = todayISO();
    const { visitor, isNew } = getOrCreateVisitor();
    const path = window.location.pathname;

    if (isNew) {
      // Brand new visitor
      track(EVT.VISITOR_FIRST_SEEN, {
        visitor_id: visitor.id,
        path,
        first_seen_date: today,
      });
      track(EVT.VISITOR_SESSION_START, {
        visitor_id: visitor.id,
        visitor_type: "new",
        path,
        first_seen_date: today,
      });
    } else {
      const lastSeen = visitor.last_seen;
      const daysSince = daysBetween(lastSeen, today);

      // Session start — always fire for returning visitors
      track(EVT.VISITOR_SESSION_START, {
        visitor_id: visitor.id,
        visitor_type: "returning",
        path,
        first_seen_date: visitor.first_seen,
        last_seen_date: lastSeen,
        days_since_last_seen: daysSince,
      });

      if (daysSince >= 1) {
        // Returning on a different day
        track(EVT.VISITOR_RETURNING, {
          visitor_id: visitor.id,
          path,
          first_seen_date: visitor.first_seen,
          last_seen_date: lastSeen,
          days_since_last_seen: daysSince,
        });
      } else if (today === lastSeen && visitor.last_session !== today) {
        // Same day, but new "session" (page was closed and reopened)
        track(EVT.VISITOR_SAME_DAY_RETURN, {
          visitor_id: visitor.id,
          path,
        });
      }

      // Update stored dates
      visitor.last_seen = today;
      visitor.last_session = today;
      updateVisitor(visitor);
    }
  }, []);
}

/** Track premium banner rendered (fire once per page load) */
export function trackPremiumBannerView(page: string) {
  track(EVT.PREMIUM_BANNER_VIEW, { page, user_segment: getUserSegment() });
}

/** Track premium banner CTA click */
export function trackPremiumBannerClick(page: string) {
  track(EVT.PREMIUM_BANNER_CLICK, { page, user_segment: getUserSegment() });
}

/** Track hover on blurred premium content (debounced externally) */
export function trackPremiumContentHover(props: {
  page: string;
  section: string;
  player_name?: string;
  stat_type?: string;
  games_since_return?: number;
}) {
  track(EVT.PREMIUM_CONTENT_HOVER, { ...props, user_segment: getUserSegment() });
}

/** Track click on blurred premium content */
export function trackPremiumContentClick(props: {
  page: string;
  section: string;
  player_name?: string;
  stat_type?: string;
  games_since_return?: number;
}) {
  track(EVT.PREMIUM_CONTENT_CLICK, { ...props, user_segment: getUserSegment() });
}

/** Track lock icon rendered (fire once per unique section per page load) */
export function trackPremiumLockSeen(page: string, section: string, player_name?: string) {
  track(EVT.PREMIUM_LOCK_SEEN, { page, section, player_name });
}

/** Track "Get early access" waitlist click */
export function trackPremiumWaitlistClick(page: string, location: string) {
  track(EVT.PREMIUM_WAITLIST_CLICK, { page, location, user_segment: getUserSegment() });
}

/** Track premium content unlock */
export function trackPremiumUnlock(props: {
  page: string;
  section: string;
  content_id: string;
  player_name?: string;
  unlock_number: number;
  is_authenticated: boolean;
}) {
  track(EVT.PREMIUM_UNLOCK, { ...props, user_segment: getUserSegment() });
}

/** Track signup prompt shown (triggered by hitting unlock limit) */
export function trackPremiumSignupPrompt(page: string, section: string) {
  track(EVT.PREMIUM_SIGNUP_PROMPT, { page, section, user_segment: getUserSegment() });
}

/** Track player analysis view (from table row click or card expansion) */
export function trackPlayerAnalysisView(props: {
  player_name: string;
  injury_type: string;
  games_since_return: number;
  stat_type?: string;
  edge_percent?: number;
  page_origin: string;
}) {
  track(EVT.PLAYER_ANALYSIS_VIEW, { ...props, user_segment: getUserSegment() });
}

/**
 * Hook: fires premium_banner_view once when the banner mounts.
 * Uses a ref to prevent duplicate fires from React strict mode.
 */
export function usePremiumBannerTracking(page: string) {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    trackPremiumBannerView(page);
  }, [page]);
}

// ──────────────────────────────────────────────
// PREMIUM LIMIT
// ──────────────────────────────────────────────

/** Track when user hits their daily unlock limit */
export function trackPremiumLimitHit(props: {
  page: string;
  is_authenticated: boolean;
  unlocks_used: number;
}) {
  track(EVT.PREMIUM_LIMIT_HIT, { ...props, user_segment: getUserSegment() });
}

// ──────────────────────────────────────────────
// AUTH FUNNEL
// ──────────────────────────────────────────────

/** Track successful login */
export function trackLoginSuccess(method: "email" | "google") {
  track(EVT.LOGIN_SUCCESS, { method, user_segment: getUserSegment() });
}

/** Track successful signup */
export function trackSignupSuccess(method: "email" | "google") {
  track(EVT.SIGNUP_SUCCESS, { method, user_segment: getUserSegment() });
}

/** Track click on "Create Free Account" CTA in signup prompt modal */
export function trackSignupCtaClick(page: string, source: string) {
  track(EVT.SIGNUP_CTA_CLICK, { page, source, user_segment: getUserSegment() });
}

/** Track dismissal of signup prompt without completing */
export function trackSignupModalDismiss(page: string) {
  track(EVT.SIGNUP_MODAL_DISMISS, { page, user_segment: getUserSegment() });
}

/** Track Google OAuth button click */
export function trackGoogleOAuthClick(page: "login" | "signup") {
  track(EVT.GOOGLE_OAUTH_CLICK, { page, user_segment: getUserSegment() });
}

// ──────────────────────────────────────────────
// NAVIGATION
// ──────────────────────────────────────────────

/** Track nav link click */
export function trackNavClick(destination: string, source: "header" | "mobile_tab" | "mobile_menu") {
  track(EVT.NAV_CLICK, { destination, source });
}

// ──────────────────────────────────────────────
// PROPS INTERACTIONS
// ──────────────────────────────────────────────

/** Track filter changes (stat, source, date) */
export function trackFilterChange(props: {
  filter_name: string;
  filter_value: string;
  page: string;
}) {
  track(EVT.FILTER_CHANGE, props);
}

/** Track sort changes */
export function trackTableSort(sort_field: string, page: string) {
  track(EVT.TABLE_SORT, { sort_field, page });
}

/** Track daily opportunity table row click */
export function trackOpportunityRowClick(props: {
  player_name: string;
  league: string;
  stat_type?: string;
  edge_percent?: number;
  rank: number;
}) {
  track(EVT.OPPORTUNITY_ROW_CLICK, { ...props, user_segment: getUserSegment() });
}

/** Track date filter change (today/tomorrow/all) */
export function trackDateFilterChange(value: string, page: string) {
  track(EVT.DATE_FILTER_CHANGE, { value, page });
}
