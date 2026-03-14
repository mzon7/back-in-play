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
