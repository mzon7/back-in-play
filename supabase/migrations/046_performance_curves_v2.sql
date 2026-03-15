-- Expand performance_curves for per-position and per-stat breakdowns

-- 1. Add position column (empty string = all positions combined)
ALTER TABLE back_in_play_performance_curves
  ADD COLUMN IF NOT EXISTS position TEXT NOT NULL DEFAULT '';

-- 2. Add per-stat curve arrays (JSONB: { "stat_pts": [g1,g2,...g10], "stat_reb": [...] })
ALTER TABLE back_in_play_performance_curves
  ADD COLUMN IF NOT EXISTS stat_avg_pct JSONB,       -- per-stat avg % of pre-injury baseline
  ADD COLUMN IF NOT EXISTS stat_median_pct JSONB,     -- per-stat median %
  ADD COLUMN IF NOT EXISTS stat_stddev_pct JSONB,     -- per-stat stddev
  ADD COLUMN IF NOT EXISTS stat_stderr_pct JSONB;     -- per-stat stderr

-- 3. Drop old unique constraint and create new one with position
ALTER TABLE back_in_play_performance_curves
  DROP CONSTRAINT IF EXISTS back_in_play_performance_curves_league_slug_injury_type_slug_key;

ALTER TABLE back_in_play_performance_curves
  ADD CONSTRAINT back_in_play_performance_curves_league_injury_pos_key
    UNIQUE (league_slug, injury_type_slug, position);

-- 4. Add position index for filtering
CREATE INDEX IF NOT EXISTS idx_perf_curves_league_position
  ON back_in_play_performance_curves (league_slug, position);

-- 5. Add age at injury to return cases for modeling
ALTER TABLE back_in_play_injury_return_cases
  ADD COLUMN IF NOT EXISTS age_at_injury INT,
  ADD COLUMN IF NOT EXISTS total_prior_injuries INT,
  ADD COLUMN IF NOT EXISTS days_since_last_injury INT,
  ADD COLUMN IF NOT EXISTS same_body_part_prior INT,
  ADD COLUMN IF NOT EXISTS performance_drop_pct REAL;

-- 6. Enable RLS
ALTER TABLE back_in_play_performance_curves ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "perf_curves_read" ON back_in_play_performance_curves;
CREATE POLICY "perf_curves_read" ON back_in_play_performance_curves FOR SELECT USING (true);
