-- Add unique constraint for upsert support on player props
-- This allows the scraper to upsert (update existing, insert new) instead of
-- deleting and re-inserting, preserving historical props data.
ALTER TABLE back_in_play_player_props
  ADD CONSTRAINT uq_player_props_event_player_market_source
  UNIQUE (event_id, player_name, market, source);
