export interface RecoveryStat {
  stat_id: string;
  injury_type: string;
  injury_type_slug: string;
  league_slug: string;
  league_name: string;
  average_recovery_days: number | null;
  median_recovery_days: number | null;
  min_recovery_days: number | null;
  max_recovery_days: number | null;
  sample_size: number;
  computed_at: string;
}

export interface RecoveryStatGroup {
  league_slug: string;
  league_name: string;
  stats: RecoveryStat[];
}

export type LeagueFilter = "all" | "nfl" | "nba" | "mlb" | "nhl" | "premier-league";

export const LEAGUE_LABELS: Record<string, string> = {
  all: "All Leagues",
  nfl: "NFL",
  nba: "NBA",
  mlb: "MLB",
  nhl: "NHL",
  "premier-league": "Premier League",
};

export const INJURY_SEVERITY: Record<string, "critical" | "major" | "moderate" | "minor"> = {
  "ACL Tear": "critical",
  "Knee": "major",
  "Shoulder": "major",
  "Elbow": "major",
  "Foot": "moderate",
  "Back": "moderate",
  "Hip": "moderate",
  "Hamstring": "moderate",
  "Groin": "moderate",
  "Quad": "moderate",
  "Calf": "minor",
  "Ankle Sprain": "minor",
  "Wrist": "minor",
  "Concussion": "moderate",
};

export function getSeverityColor(injuryType: string): string {
  const severity = INJURY_SEVERITY[injuryType] ?? "moderate";
  return {
    critical: "#FF4D4D",
    major: "#FF8C00",
    moderate: "#1C7CFF",
    minor: "#3DFF8F",
  }[severity];
}

/**
 * Prediction model: estimate return date from injury date + median recovery days.
 * expected_return_date = injury_date + median_recovery_days
 *
 * @param injuryDate  ISO date string (YYYY-MM-DD)
 * @param medianDays  Median recovery days for this injury type in this league
 * @returns           ISO date string (YYYY-MM-DD) for predicted return
 */
export function predictReturnDate(injuryDate: string, medianDays: number): string {
  const ms = new Date(injuryDate).getTime() + Math.round(medianDays) * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().split("T")[0];
}

/**
 * Look up the best-matching RecoveryStat for a given injury description and league,
 * then return the predicted return date (or null if no stat found).
 */
export function predictReturnDateFromStat(
  injuryDate: string,
  stat: RecoveryStat | null | undefined
): string | null {
  if (!stat || stat.median_recovery_days == null) return null;
  return predictReturnDate(injuryDate, stat.median_recovery_days);
}
