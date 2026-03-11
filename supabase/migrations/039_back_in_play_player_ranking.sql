-- Add ranking columns to players + injuries for landing page filtering
-- league_rank = current/latest ranking
-- preseason_rank = ranking at start of season (set once, kept stable)
-- rank_at_injury = ranking at time of injury (stored per injury record)
-- Player hits landing page if either preseason_rank or rank_at_injury <= 50

DO $$
BEGIN
  -- Players table: current and preseason rank
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'back_in_play_players' AND column_name = 'league_rank'
  ) THEN
    ALTER TABLE back_in_play_players ADD COLUMN league_rank integer;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'back_in_play_players' AND column_name = 'preseason_rank'
  ) THEN
    ALTER TABLE back_in_play_players ADD COLUMN preseason_rank integer;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'back_in_play_players' AND column_name = 'headshot_url'
  ) THEN
    ALTER TABLE back_in_play_players ADD COLUMN headshot_url text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'back_in_play_players' AND column_name = 'espn_id'
  ) THEN
    ALTER TABLE back_in_play_players ADD COLUMN espn_id text;
  END IF;

  -- Injuries table: rank at time of injury
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'back_in_play_injuries' AND column_name = 'rank_at_injury'
  ) THEN
    ALTER TABLE back_in_play_injuries ADD COLUMN rank_at_injury integer;
  END IF;
END $$;
