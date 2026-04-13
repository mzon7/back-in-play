-- Add league_id directly to players for faster league-scoped queries
ALTER TABLE back_in_play_players
  ADD COLUMN IF NOT EXISTS league_id uuid REFERENCES back_in_play_leagues(league_id);

-- Backfill from teams table
UPDATE back_in_play_players p
SET league_id = t.league_id
FROM back_in_play_teams t
WHERE p.team_id = t.team_id AND p.league_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_bip_players_league
  ON back_in_play_players (league_id);
