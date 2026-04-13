-- Corrected injuries: dates verified against ESPN box scores
-- Original back_in_play_injuries stays untouched
CREATE TABLE IF NOT EXISTS back_in_play_injuries_corrected (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_injury_id UUID NOT NULL,
    player_id UUID NOT NULL,
    player_name TEXT,
    league_slug TEXT,

    -- Corrected dates (from ESPN box score absence detection)
    date_injured DATE,
    return_date DATE,
    games_missed INTEGER,

    -- Original dates (preserved for comparison)
    original_date_injured DATE,
    original_return_date DATE,
    original_games_missed INTEGER,

    -- Injury info (copied from original)
    injury_type TEXT,
    injury_description TEXT,

    -- Match quality
    grade TEXT,  -- A, B, C, D
    start_day_diff INTEGER,
    return_day_diff INTEGER,
    duration_pct_off NUMERIC,
    match_notes TEXT,

    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_injuries_corrected_player ON back_in_play_injuries_corrected(player_id);
CREATE INDEX IF NOT EXISTS idx_injuries_corrected_grade ON back_in_play_injuries_corrected(grade);
CREATE INDEX IF NOT EXISTS idx_injuries_corrected_league ON back_in_play_injuries_corrected(league_slug);
