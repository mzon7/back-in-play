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
