-- Master player game data: one row per player per game from ESPN box scores
-- This is the ONLY source of truth for player stats
CREATE TABLE IF NOT EXISTS back_in_play_master_games (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    game_date DATE NOT NULL,
    season INTEGER,
    event_id TEXT,
    league_slug TEXT NOT NULL,
    home_team TEXT,
    away_team TEXT,
    home_score INTEGER,
    away_score INTEGER,
    player_name TEXT NOT NULL,
    player_espn_id TEXT,
    player_team TEXT,
    player_position TEXT,

    -- Stats (varies by sport)
    minutes NUMERIC,
    stat_pts NUMERIC, stat_reb NUMERIC, stat_ast NUMERIC,
    stat_stl NUMERIC, stat_blk NUMERIC, stat_3pm NUMERIC,
    turnovers NUMERIC, fg NUMERIC, ft NUMERIC,
    stat_oreb NUMERIC, stat_dreb NUMERIC,
    plus_minus NUMERIC, fouls NUMERIC,

    -- NHL
    stat_goals NUMERIC, stat_assists NUMERIC, stat_sog NUMERIC,
    toi NUMERIC, stat_shots NUMERIC, stat_hits NUMERIC,
    stat_blocks NUMERIC, stat_pim NUMERIC,
    faceoff_wins NUMERIC, faceoff_losses NUMERIC,
    stat_giveaways NUMERIC, stat_takeaways NUMERIC,

    -- NFL
    pass_catt TEXT, stat_pass_yds NUMERIC, stat_pass_td NUMERIC,
    stat_int NUMERIC, stat_sacks NUMERIC, stat_qbr NUMERIC, stat_rtg NUMERIC,
    stat_rush_att NUMERIC, stat_avg NUMERIC,
    stat_rec NUMERIC, stat_targets NUMERIC, stat_long NUMERIC,

    -- MLB
    stat_h NUMERIC, stat_r NUMERIC, stat_hr NUMERIC, stat_rbi NUMERIC,
    stat_bb NUMERIC, stat_k NUMERIC, stat_ab NUMERIC, stat_sb NUMERIC,
    stat_ip NUMERIC, stat_er NUMERIC, stat_so NUMERIC,

    -- Odds
    h2h_home_price NUMERIC, h2h_away_price NUMERIC,
    spread_home_line NUMERIC, spread_home_price NUMERIC,
    spread_away_line NUMERIC, spread_away_price NUMERIC,
    total_line NUMERIC, total_over_price NUMERIC, total_under_price NUMERIC,
    close_h2h_home_price NUMERIC, close_h2h_away_price NUMERIC,
    close_spread_home_line NUMERIC, close_spread_home_price NUMERIC,
    close_total_line NUMERIC, close_total_over_price NUMERIC, close_total_under_price NUMERIC,

    has_odds TEXT,
    source TEXT DEFAULT 'espn_boxscore',
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_master_games_player ON back_in_play_master_games(player_espn_id, game_date);
CREATE INDEX IF NOT EXISTS idx_master_games_league_date ON back_in_play_master_games(league_slug, game_date);
CREATE INDEX IF NOT EXISTS idx_master_games_player_name ON back_in_play_master_games(player_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_master_games_unique ON back_in_play_master_games(league_slug, event_id, player_espn_id);
