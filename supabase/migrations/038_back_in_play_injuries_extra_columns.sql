-- Add extra columns to back_in_play_injuries for richer injury data
-- These columns store fields from ESPN + RotoWire that the original schema lacked.

-- Safe: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS pattern via DO block

DO $$
BEGIN
  -- expected_return: free text like "Early March", "Week 5", "2026-04-01"
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'back_in_play_injuries' AND column_name = 'expected_return'
  ) THEN
    ALTER TABLE back_in_play_injuries ADD COLUMN expected_return text;
  END IF;

  -- side: "left" or "right"
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'back_in_play_injuries' AND column_name = 'side'
  ) THEN
    ALTER TABLE back_in_play_injuries ADD COLUMN side text;
  END IF;

  -- long_comment: detailed ESPN injury comment
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'back_in_play_injuries' AND column_name = 'long_comment'
  ) THEN
    ALTER TABLE back_in_play_injuries ADD COLUMN long_comment text;
  END IF;

  -- short_comment: brief comment / fantasy impact note
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'back_in_play_injuries' AND column_name = 'short_comment'
  ) THEN
    ALTER TABLE back_in_play_injuries ADD COLUMN short_comment text;
  END IF;

  -- injury_location: body part from source (raw, not classified)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'back_in_play_injuries' AND column_name = 'injury_location'
  ) THEN
    ALTER TABLE back_in_play_injuries ADD COLUMN injury_location text;
  END IF;
END $$;
