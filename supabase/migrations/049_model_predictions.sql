-- Store live model predictions for today's/tomorrow's bets
-- Uses the exact same feature engineering as the backtest scripts
CREATE TABLE IF NOT EXISTS back_in_play_model_predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_name TEXT NOT NULL,
  player_id UUID,
  league TEXT NOT NULL,
  model TEXT NOT NULL,
  market TEXT NOT NULL,
  game_date DATE NOT NULL,
  prop_line REAL NOT NULL,
  over_odds TEXT,
  under_odds TEXT,
  p_over REAL NOT NULL,
  ev REAL NOT NULL,
  recommendation TEXT NOT NULL,
  game_number_back INT,
  injury_type TEXT,
  injury_date DATE,
  return_date DATE,
  days_missed INT,
  baseline REAL,
  recent_avg REAL,
  form_ratio REAL,
  curve_pct REAL,
  features_json JSONB,
  event_id TEXT,
  home_team TEXT,
  away_team TEXT,
  kelly_fraction REAL,
  position TEXT,
  predicted_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(player_name, model, market, game_date)
);

CREATE INDEX IF NOT EXISTS idx_predictions_date_league ON back_in_play_model_predictions(game_date, league);
CREATE INDEX IF NOT EXISTS idx_predictions_model ON back_in_play_model_predictions(model);

-- Allow anon read for frontend
ALTER TABLE back_in_play_model_predictions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_predictions" ON back_in_play_model_predictions
  FOR SELECT USING (true);
CREATE POLICY "service_write_predictions" ON back_in_play_model_predictions
  FOR ALL USING (true) WITH CHECK (true);
