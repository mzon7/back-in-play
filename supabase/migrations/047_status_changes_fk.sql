-- Add foreign key on status_changes → players so Supabase PostgREST can do embedded joins.
-- Delete orphaned rows first (player was removed but status change remained).
DELETE FROM back_in_play_status_changes
WHERE player_id NOT IN (SELECT player_id FROM back_in_play_players);

ALTER TABLE back_in_play_status_changes
  ALTER COLUMN player_id TYPE text;

ALTER TABLE back_in_play_status_changes
  ADD CONSTRAINT fk_status_changes_player
  FOREIGN KEY (player_id) REFERENCES back_in_play_players(player_id)
  ON DELETE CASCADE;
