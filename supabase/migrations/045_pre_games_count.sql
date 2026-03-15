-- Add pre_games_count to track baseline sample size
ALTER TABLE back_in_play_injury_return_cases
  ADD COLUMN IF NOT EXISTS pre_games_count INT;

ALTER TABLE back_in_play_injuries
  ADD COLUMN IF NOT EXISTS pre_games_count INT;
