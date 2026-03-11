-- Game minutes tracking for Back In Play status flow
DO $$
BEGIN
  -- Injuries: minutes played in return game
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'back_in_play_injuries' AND column_name = 'game_minutes'
  ) THEN
    ALTER TABLE back_in_play_injuries ADD COLUMN game_minutes real;
  END IF;

  -- Players: pre-injury average minutes per game
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'back_in_play_players' AND column_name = 'pre_injury_avg_minutes'
  ) THEN
    ALTER TABLE back_in_play_players ADD COLUMN pre_injury_avg_minutes real;
  END IF;
END $$;
