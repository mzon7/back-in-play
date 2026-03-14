export interface PerformanceCurve {
  curve_id: string;
  league_slug: string;
  injury_type_slug: string;
  injury_type: string;
  position: string;
  sample_size: number;
  games_missed_avg: number | null;
  recovery_days_avg: number | null;
  avg_pct_recent: number[];
  avg_pct_season: number[];
  median_pct_recent: number[];
  p25_pct_recent: number[];
  p75_pct_recent: number[];
  avg_minutes_pct: number[];
  stddev_pct_recent: number[];
  stderr_pct_recent: number[];
  rest_of_season_pct_recent: number | null;
  rest_of_season_pct_season: number | null;
  rest_of_season_sample: number | null;
  games_to_full: number | null;
  computed_at: string;
  // Per-stat breakdowns
  stat_avg_pct: Record<string, (number | null)[]> | null;
  stat_median_pct: Record<string, (number | null)[]> | null;
  stat_stddev_pct: Record<string, (number | null)[]> | null;
  stat_stderr_pct: Record<string, (number | null)[]> | null;
}

export interface ReturnCase {
  case_id: string;
  injury_id: string;
  player_id: string;
  league_slug: string;
  position: string;
  injury_type: string;
  injury_type_slug: string;
  date_injured: string;
  return_date: string;
  games_missed: number | null;
  recovery_days: number | null;
  pre_baseline_5g: number | null;
  pre_baseline_season: number | null;
  post_games_count: number;
  post_game_composites: PostGameEntry[];
  rest_of_season_avg: number | null;
  rest_of_season_games: number | null;
}

export interface PostGameEntry {
  game_num: number;
  game_date: string;
  composite: number;
  minutes_pct?: number;
}

/** A chart data point for recharts */
export interface CurvePoint {
  game: number;
  label: string;
  avg: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  minutesPct: number | null;
  playerPct?: number | null;
  // Error bars
  stddevUpper?: number | null;
  stddevLower?: number | null;
}

export type LeagueFilter = "all" | "nfl" | "nba" | "mlb" | "nhl" | "premier-league";

export const LEAGUE_LABELS: Record<string, string> = {
  all: "All Leagues",
  nfl: "NFL",
  nba: "NBA",
  mlb: "MLB",
  nhl: "NHL",
  "premier-league": "EPL",
};

export const STAT_LABELS: Record<string, string> = {
  stat_pts: "Points",
  stat_reb: "Rebounds",
  stat_ast: "Assists",
  stat_stl: "Steals",
  stat_blk: "Blocks",
  stat_pass_yds: "Pass Yards",
  stat_pass_td: "Pass TDs",
  stat_rush_yds: "Rush Yards",
  stat_rush_td: "Rush TDs",
  stat_rec: "Receptions",
  stat_rec_yds: "Rec Yards",
  stat_goals: "Goals",
  stat_assists: "Assists",
  stat_sog: "Shots on Goal",
  stat_h: "Hits",
  stat_hr: "Home Runs",
  stat_rbi: "RBI",
  stat_r: "Runs",
  stat_sb: "Stolen Bases",
  // NHL goalie stats
  stat_sv: "Saves",
  stat_ga: "Goals Against",
  stat_sv_pct: "Save %",
  stat_w: "Wins",
};

export const LEAGUE_STATS: Record<string, string[]> = {
  nba: ["stat_pts", "stat_reb", "stat_ast", "stat_stl", "stat_blk"],
  nfl: ["stat_pass_yds", "stat_pass_td", "stat_rush_yds", "stat_rush_td", "stat_rec", "stat_rec_yds"],
  nhl: ["stat_goals", "stat_assists", "stat_sog"],
  "nhl-goalie": ["stat_sv", "stat_ga", "stat_sv_pct", "stat_w"],
  mlb: ["stat_h", "stat_hr", "stat_rbi", "stat_r", "stat_sb"],
  "premier-league": ["stat_goals", "stat_assists"],
};
