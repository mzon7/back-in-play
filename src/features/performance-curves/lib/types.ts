export interface PerformanceCurve {
  curve_id: string;
  league_slug: string;
  injury_type_slug: string;
  injury_type: string;
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
