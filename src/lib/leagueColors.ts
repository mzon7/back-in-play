/** League accent colors for visual differentiation in multi-league views */
export const LEAGUE_COLORS: Record<string, string> = {
  nba: "#22c55e",
  nfl: "#ef4444",
  mlb: "#f97316",
  nhl: "#3b82f6",
  "premier-league": "#a855f7",
};

/** Get league color with fallback */
export function leagueColor(leagueSlug: string): string {
  return LEAGUE_COLORS[leagueSlug] ?? "#6b7280";
}
