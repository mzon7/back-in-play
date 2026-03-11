-- Status change log for "Player Status Updates" feed
CREATE TABLE IF NOT EXISTS back_in_play_status_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id text NOT NULL,
  injury_id text,
  old_status text,
  new_status text NOT NULL,
  change_type text NOT NULL,  -- 'status_change', 'new_injury', 'activated', 'updated'
  summary text NOT NULL,       -- human-readable e.g. "Downgraded to OUT"
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bip_status_changes_at
  ON back_in_play_status_changes (changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_bip_status_changes_player
  ON back_in_play_status_changes (player_id);

-- RLS: read-only for anon
ALTER TABLE back_in_play_status_changes ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'back_in_play_status_changes' AND policyname = 'anon_read'
  ) THEN
    CREATE POLICY anon_read ON back_in_play_status_changes FOR SELECT USING (true);
  END IF;
END $$;
