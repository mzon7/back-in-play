-- Add star/starter flags to players table
ALTER TABLE back_in_play_players
  ADD COLUMN IF NOT EXISTS is_star boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_starter boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_bip_players_star
  ON back_in_play_players (is_star) WHERE is_star = true;

-- Add ESPN team ID to teams table for API lookups
ALTER TABLE back_in_play_teams
  ADD COLUMN IF NOT EXISTS espn_team_id text;
