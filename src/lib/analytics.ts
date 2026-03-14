import { track } from "@vercel/analytics";
import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

/**
 * Track navigation transitions between pages.
 * Fires a "navigate" event with { from, to } on every route change.
 * Also fires page-specific events (performance_curves_open, props_page_open, etc.)
 */
export function usePageTracking() {
  const location = useLocation();
  const prevPath = useRef<string | null>(null);

  useEffect(() => {
    const path = location.pathname;

    // Navigation transition event
    track("navigate", {
      from: prevPath.current ?? "(direct)",
      to: path,
    });

    // Page-specific open events
    if (path === "/performance-curves") {
      track("performance_curves_open");
    } else if (path === "/props") {
      track("props_page_open");
    } else if (path === "/recovery-stats") {
      track("recovery_stats_open");
    } else if (path === "/returning-today" || path.endsWith("/returning-today")) {
      track("returning_today_open");
    } else if (path.startsWith("/player/") || path.startsWith("/injury/")) {
      const slug = path.split("/")[2] ?? "";
      track("player_page_view", { player_slug: slug });
    }

    prevPath.current = path;
  }, [location.pathname]);
}

/** Track headline card clicks on the homepage */
export function trackHeadlineClick(player: string, league: string, status: string) {
  track("headline_card_click", { player, league, status });
}

/** Track player card clicks (from InjuryPlayerCard) */
export function trackPlayerCardClick(player: string, league?: string) {
  track("player_card_click", { player, league: league ?? "unknown" });
}

/** Track league filter selection */
export function trackLeagueFilter(league: string, page: string) {
  track("league_filter", { league, page });
}

/** Track performance curve card expansion */
export function trackCurveExpand(injuryType: string, league: string) {
  track("curve_expand", { injury_type: injuryType, league });
}

/** Track stat drill-down open */
export function trackStatDrillDown(stat: string, injuryType: string) {
  track("stat_drilldown", { stat, injury_type: injuryType });
}

/** Track prop line click */
export function trackPropLineClick(player: string, stat: string) {
  track("prop_line_click", { player, stat });
}
