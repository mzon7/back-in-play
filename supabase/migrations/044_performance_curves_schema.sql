-- Performance Curves: post-injury recovery analytics
-- ===================================================

-- Add sport-reference slug to players for game log lookups
ALTER TABLE back_in_play_players
  ADD COLUMN IF NOT EXISTS sport_ref_id TEXT;

-- Player game logs (one row per game per player)
CREATE TABLE IF NOT EXISTS back_in_play_player_game_logs (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  player_id     UUID NOT NULL REFERENCES back_in_play_players(player_id),
  league_slug   TEXT NOT NULL,
  season        INT NOT NULL,
  game_date     DATE NOT NULL,
  opponent      TEXT,
  started       BOOLEAN,
  minutes       REAL,
  -- Generic stat columns (meaning varies by league, all nullable)
  stat_pts      REAL,
  stat_reb      REAL,
  stat_ast      REAL,
  stat_stl      REAL,
  stat_blk      REAL,
  stat_sog      REAL,
  stat_rush_yds REAL,
  stat_rush_td  REAL,
  stat_pass_yds REAL,
  stat_pass_td  REAL,
  stat_rec      REAL,
  stat_rec_yds  REAL,
  stat_hr       REAL,
  stat_rbi      REAL,
  stat_r        REAL,
  stat_sb       REAL,
  stat_h        REAL,
  stat_ip       REAL,
  stat_k        REAL,
  stat_era      REAL,
  stat_goals    REAL,
  stat_assists  REAL,
  composite     REAL,
  source_url    TEXT,
  scraped_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(player_id, game_date)
);

CREATE INDEX IF NOT EXISTS idx_game_logs_player_date
  ON back_in_play_player_game_logs(player_id, game_date);
CREATE INDEX IF NOT EXISTS idx_game_logs_league_season
  ON back_in_play_player_game_logs(league_slug, season);

-- Injury return cases (one per injury with valid return)
CREATE TABLE IF NOT EXISTS back_in_play_injury_return_cases (
  case_id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  injury_id           UUID NOT NULL REFERENCES back_in_play_injuries(injury_id),
  player_id           UUID NOT NULL REFERENCES back_in_play_players(player_id),
  league_slug         TEXT NOT NULL,
  position            TEXT,
  injury_type         TEXT NOT NULL,
  injury_type_slug    TEXT NOT NULL,
  date_injured        DATE NOT NULL,
  return_date         DATE NOT NULL,
  games_missed        INT,
  games_missed_actual INT,
  recovery_days       INT,
  pre_baseline_5g     REAL,
  pre_baseline_season REAL,
  post_games_count    INT,
  post_game_composites JSONB,
  rest_of_season_avg  REAL,
  rest_of_season_games INT,
  processed_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE(injury_id)
);

CREATE INDEX IF NOT EXISTS idx_return_cases_league_injury
  ON back_in_play_injury_return_cases(league_slug, injury_type_slug);

-- Aggregated performance curves (one per league + injury type)
CREATE TABLE IF NOT EXISTS back_in_play_performance_curves (
  curve_id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  league_slug             TEXT NOT NULL,
  injury_type_slug        TEXT NOT NULL,
  injury_type             TEXT NOT NULL,
  sample_size             INT NOT NULL,
  games_missed_avg        REAL,
  recovery_days_avg       REAL,
  -- Arrays of 10 (game 1..10 post-return)
  avg_pct_recent          JSONB,
  avg_pct_season          JSONB,
  median_pct_recent       JSONB,
  p25_pct_recent          JSONB,
  p75_pct_recent          JSONB,
  avg_minutes_pct         JSONB,
  stddev_pct_recent       JSONB,
  stderr_pct_recent       JSONB,
  -- Rest-of-season aggregates
  rest_of_season_pct_recent  REAL,
  rest_of_season_pct_season  REAL,
  rest_of_season_sample      INT,
  games_to_full              REAL,
  computed_at             TIMESTAMPTZ DEFAULT now(),
  UNIQUE(league_slug, injury_type_slug)
);

-- Pipeline run tracking
CREATE TABLE IF NOT EXISTS back_in_play_pipeline_runs (
  run_id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  run_type        TEXT NOT NULL,
  league_slug     TEXT,
  started_at      TIMESTAMPTZ DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  cases_processed INT DEFAULT 0,
  logs_scraped    INT DEFAULT 0,
  errors          JSONB DEFAULT '[]'::JSONB,
  status          TEXT DEFAULT 'running'
);
