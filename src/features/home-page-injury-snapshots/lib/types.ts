export type InjuryStatus = "out" | "doubtful" | "questionable" | "probable" | "returned";

export interface InjuryWithPlayer {
  injury_id: string;
  player_id: string;
  injury_type: string;
  injury_type_slug: string;
  injury_description: string | null;
  date_injured: string;
  expected_recovery_range: string | null;
  expected_return_date: string | null;
  status: InjuryStatus;
  back_in_play_players: {
    player_id: string;
    player_name: string;
    slug: string;
    position: string | null;
    back_in_play_teams: {
      team_id: string;
      team_name: string;
      back_in_play_leagues: {
        league_id: string;
        league_name: string;
        slug: string;
      };
    };
  };
}
