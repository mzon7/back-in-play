#!/usr/bin/env python3
"""
Team Model G: Conservative team-level betting predictions (spreads, totals, team totals).

Based on Team Model C but with:
  - Reduced feature set (top 8 by importance)
  - More conservative LightGBM hyperparameters (shallower trees, stronger regularisation)

Features (13):
  A. League Baseline   (1): league_avg_stat
  B. Team Recent Form  (3): team_stat_ewa, team_stat_trend, team_vs_league
  C. Opponent Context  (3): opp_allowed_ewa, opp_allowed_trend, opp_vs_league
  D. Combined          (1): blended_team_projection
  E. Pitcher (MLB)     (3): sp_k_per_ip_ewa, bp_quality, pitching_quality_index
  F. Park Factors      (2): park_runs_factor, park_factor_vs_league

Usage:
  python3 team_model_g.py --league nba
"""

import os, sys, json, math, statistics, argparse, pathlib, pickle
from collections import defaultdict
from datetime import datetime, timedelta, timezone
import numpy as np
from lightgbm import LGBMClassifier
from sklearn.metrics import accuracy_score, roc_auc_score
from sklearn.model_selection import StratifiedKFold
from supabase import create_client

# ---------------------------------------------------------------------------
# Supabase client
# ---------------------------------------------------------------------------
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
sb = create_client(SUPABASE_URL, SUPABASE_KEY)

# ---------------------------------------------------------------------------
# Shared helpers (inlined from regression_v5_model_e / regression_v8_model_h)
# ---------------------------------------------------------------------------
def paginate(table, select, filters=None, order_col=None, batch=1000):
    import time as _time
    all_data, offset = [], 0
    while True:
        for attempt in range(5):
            try:
                q = sb.table(table).select(select)
                if filters:
                    for method, args in filters:
                        q = getattr(q, method)(*args)
                if order_col:
                    q = q.order(order_col)
                q = q.range(offset, offset + batch - 1)
                data = (q.execute()).data or []
                break
            except Exception as e:
                if attempt < 4:
                    print(f"  Retry {attempt+1} for {table} (offset {offset}): {e}")
                    _time.sleep(5 * (attempt + 1))
                else:
                    raise
        all_data.extend(data)
        if len(data) < batch:
            break
        offset += batch
    return all_data


def odds_to_implied_prob(odds):
    if odds is None:
        return 0.5
    odds = float(odds)
    if odds > 0:
        return 100 / (odds + 100)
    return abs(odds) / (abs(odds) + 100)


def odds_to_profit(odds):
    odds = float(odds)
    if odds > 0:
        return odds / 100
    return 100 / abs(odds)


WALK_FORWARD_WINDOWS = {
    "nba": [
        {"train_end": "2024-04-15", "test_start": "2024-04-15", "test_end": "2024-10-22", "season": "2023-24"},
        {"train_end": "2024-10-22", "test_start": "2024-10-22", "test_end": "2025-04-15", "season": "2024-25"},
        {"train_end": "2025-04-15", "test_start": "2025-04-15", "test_end": "2099-01-01", "season": "2025-26"},
    ],
    "nhl": [
        {"train_end": "2024-04-15", "test_start": "2024-04-15", "test_end": "2024-10-22", "season": "2023-24"},
        {"train_end": "2024-10-22", "test_start": "2024-10-22", "test_end": "2025-04-15", "season": "2024-25"},
        {"train_end": "2025-04-15", "test_start": "2025-04-15", "test_end": "2099-01-01", "season": "2025-26"},
    ],
    "nfl": [
        {"train_end": "2024-02-01", "test_start": "2024-02-01", "test_end": "2024-09-05", "season": "2023-24"},
        {"train_end": "2024-09-05", "test_start": "2024-09-05", "test_end": "2025-02-01", "season": "2024-25"},
        {"train_end": "2025-02-01", "test_start": "2025-02-01", "test_end": "2099-01-01", "season": "2025-26"},
    ],
    "mlb": [
        {"train_end": "2024-07-15", "test_start": "2024-07-15", "test_end": "2025-03-28", "season": "2024"},
        {"train_end": "2025-03-28", "test_start": "2025-03-28", "test_end": "2099-01-01", "season": "2025"},
    ],
    "premier-league": [
        {"train_end": "2024-08-17", "test_start": "2024-08-17", "test_end": "2025-08-17", "season": "2024-25"},
        {"train_end": "2025-08-17", "test_start": "2025-08-17", "test_end": "2099-01-01", "season": "2025-26"},
    ],
}

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
LEAGUE_IDS = {
    "nba": "2aa180e9-a7c2-4d08-a1d8-a16152827b5d",
    "nfl": "0fea41a7-250e-40bf-9220-97853a69b6d7",
    "nhl": "0894f8ac-c744-4b58-9023-20c514f64fff",
    "mlb": "312485db-3c4a-4f83-b4b0-c761e114d870",
    "premier-league": "759cf693-7e15-4ea5-a3ed-ff9fd7d6bbb0",
}

SPORT_KEYS = {
    "nba": "basketball_nba",
    "nhl": "icehockey_nhl",
    "nfl": "americanfootball_nfl",
    "mlb": "baseball_mlb",
    "premier-league": "soccer_epl",
}

# Stat column used for team scoring per league
TEAM_STAT_COL = {
    "nba": "stat_pts",
    "nhl": "stat_goals",
    "nfl": "stat_pts",      # NFL game logs may not have team pts; use rush+pass TDs proxy
    "mlb": "stat_r",
    "premier-league": "stat_goals",
}

# ── Summary generation constants ─────────────────────────────────────────
EV_THRESHOLDS = [0, 5, 10, 15, 20, 30, 40, 50]
MAX_GN_VALUES = [1, 2, 3, 5, 10]
ODDS_MODES = ["scrape", "open", "close", "train", "alt"]

TEAM_MARKET_LABELS = {
    "spread": "Spread", "total": "Total",
    "home_team_total": "Home Team Total", "away_team_total": "Away Team Total",
    "h2h": "Moneyline", "btts": "BTTS", "h2h_3_way": "3-Way ML",
}


# ── Summary helpers ──────────────────────────────────────────────────────
def _bet_pnl(b, mode="scrape"):
    if mode in ("open", "train"):
        return b.get("pnl", 0)
    if mode == "alt" and b.get("alt_pnl") is not None:
        return b["alt_pnl"]
    if mode == "close" and b.get("close_pnl") is not None:
        return b["close_pnl"]
    if mode == "scrape":
        if b.get("scrape_pnl") is not None:
            return b["scrape_pnl"]
        return b.get("pnl", 0)
    return b.get("pnl", 0)


def _bet_correct(b, mode="scrape"):
    if mode in ("open", "train"):
        return b.get("correct", False)
    if mode == "alt" and b.get("alt_correct") is not None:
        return b["alt_correct"]
    if mode == "close" and b.get("close_correct") is not None:
        return b["close_correct"]
    if mode == "scrape":
        if b.get("scrape_correct") is not None:
            return b["scrape_correct"]
        return b.get("correct", False)
    return b.get("correct", False)


def _bankroll_sim(bets, bet_pct_fn, mode="scrape"):
    if not bets:
        return 0
    bankroll = 100.0
    for b in bets:
        pct = bet_pct_fn(b)
        if pct <= 0:
            continue
        stake = bankroll * pct
        if _bet_correct(b, mode):
            profit = _bet_pnl(b, mode)
            bankroll += stake * (profit if profit > 0 else 0.909)
        else:
            bankroll -= stake
        if bankroll <= 0:
            return -100
    return bankroll - 100


def _flat_bankroll(bets, unit_pct=1, mode="scrape"):
    return _bankroll_sim(bets, lambda b: unit_pct / 100, mode)


def _kelly_bankroll(bets, fraction=1.0, mode="scrape"):
    cap = 0.035 if fraction >= 1.0 else 0.025
    def kelly_pct(b):
        kf = b.get("kelly_f") or 0
        if kf <= 0 and b.get("p_over") is not None:
            pnl_v = _bet_pnl(b, mode)
            op = pnl_v if pnl_v > 0 else 0.909
            p = b["p_over"] if b.get("rec") == "OVER" else 1 - b["p_over"]
            q = 1 - p
            kf = max((p * op - q) / op, 0) if op > 0 else 0
        return min(kf * fraction, cap)
    return _bankroll_sim(bets, kelly_pct, mode)


def _compute_market_stats(bets, mode="scrape"):
    if not bets:
        return None
    wins = sum(1 for b in bets if _bet_correct(b, mode))
    flat_pnl = sum(_bet_pnl(b, mode) for b in bets)
    stats = {
        "bets": len(bets),
        "wins": wins,
        "win_rate": round(wins / len(bets) * 100, 1),
        "flat_pnl": round(flat_pnl, 1),
        "flat_roi": round(flat_pnl / len(bets) * 100, 1),
        "flat_br": round(_flat_bankroll(bets, 1, mode), 1),
        "half_kelly_br": round(_kelly_bankroll(bets, 0.5, mode), 1),
        "full_kelly_br": round(_kelly_bankroll(bets, 1.0, mode), 1),
    }
    clv_bets = [b for b in bets if b.get("beat_close") is not None]
    clv_vals = [b["clv"] for b in bets if b.get("clv") is not None]
    prob_vals = [b["clv_prob_edge"] for b in bets if b.get("clv_prob_edge") is not None]
    stats["avg_raw_clv"] = round(sum(clv_vals) / len(clv_vals), 3) if clv_vals else None
    stats["avg_clv_prob_edge"] = round(sum(prob_vals) / len(prob_vals), 4) if prob_vals else None
    stats["pct_beat_close"] = round(sum(1 for b in clv_bets if b["beat_close"]) / len(clv_bets) * 100, 1) if clv_bets else None
    # Audit metrics: turnover, odds-range, drawdown
    stats["total_wagered"] = len(bets)
    stats["turnover"] = round(len(bets) / 100, 2)
    # Odds-range breakdown by model probability
    buckets = {}
    for b in bets:
        p = b.get("p_over", 0.5)
        if p >= 0.7: bk = "heavy_fav"
        elif p >= 0.6: bk = "fav"
        elif p >= 0.55: bk = "slight_fav"
        elif p >= 0.45: bk = "even"
        elif p >= 0.35: bk = "dog"
        else: bk = "big_dog"
        if bk not in buckets:
            buckets[bk] = {"bets": 0, "wins": 0, "pnl": 0.0}
        buckets[bk]["bets"] += 1
        if _bet_correct(b, mode): buckets[bk]["wins"] += 1
        buckets[bk]["pnl"] += _bet_pnl(b, mode)
    stats["odds_buckets"] = {
        k: {**v, "pnl": round(v["pnl"], 1), "roi": round(v["pnl"] / v["bets"] * 100, 1) if v["bets"] > 0 else 0}
        for k, v in buckets.items()
    }
    # Max drawdown (flat staking)
    peak = bankroll = 100.0
    max_dd = 0.0
    for b in bets:
        bankroll += _bet_pnl(b, mode)
        if bankroll > peak: peak = bankroll
        dd = (peak - bankroll) / peak * 100 if peak > 0 else 0
        if dd > max_dd: max_dd = dd
    stats["max_drawdown"] = round(max_dd, 1)
    return stats


def _compute_by_market(bets, mode):
    by_market = {}
    market_bets = {}
    for b in bets:
        m = b.get("market", "unknown")
        market_bets.setdefault(m, []).append(b)
    all_stats = _compute_market_stats(bets, mode)
    if all_stats:
        by_market["ALL"] = all_stats
    for market, m_bets in sorted(market_bets.items()):
        stats = _compute_market_stats(m_bets, mode)
        if stats:
            by_market[market] = stats
    return by_market


def _bet_season(b):
    d = b.get("date", "")
    if not d:
        return ""
    year = int(d[:4])
    month = int(d[5:7])
    start_year = year if month >= 7 else year - 1
    return f"{start_year}-{str(start_year + 1)[2:]}"


def compute_summary(results_data):
    """Compute full summary with all EV/GN/mode combinations."""
    all_bets = results_data.get("bets", [])
    if not all_bets:
        return None
    summary = {
        "total_bets": len(all_bets),
        "features": results_data.get("features", []),
        "feature_importance": results_data.get("feature_importance", {}),
        "accuracy": results_data.get("accuracy"),
        "auc": results_data.get("auc"),
        "skip_counts": results_data.get("skip_counts"),
    }
    seasons = set()
    for b in all_bets:
        s = b.get("season")
        if s:
            seasons.add(s)
        else:
            d = b.get("date", "")
            if d:
                year = int(d[:4])
                month = int(d[5:7])
                start_year = year if month >= 7 else year - 1
                seasons.add(f"{start_year}-{str(start_year + 1)[2:]}")
    summary["seasons"] = sorted(seasons)
    for mode in ODDS_MODES:
        for ev_thresh in EV_THRESHOLDS:
            for max_gn in MAX_GN_VALUES:
                filtered = [b for b in all_bets
                            if b.get("ev", 0) >= ev_thresh
                            and b.get("gn", 0) <= max_gn]
                if not filtered:
                    continue
                key = f"by_market_{mode}_ev{ev_thresh}_gn{max_gn}"
                summary[key] = _compute_by_market(filtered, mode)
                for season in seasons:
                    season_bets = [b for b in filtered
                                   if b.get("season") == season or
                                   (not b.get("season") and _bet_season(b) == season)]
                    if season_bets:
                        skey = f"by_market_{mode}_ev{ev_thresh}_gn{max_gn}_s{season}"
                        summary[skey] = _compute_by_market(season_bets, mode)
    return summary


# NBA team name -> common abbreviations found in game_logs opponent field
TEAM_ABBR_MAP = {
    # NBA
    "Atlanta Hawks": ["ATL"],
    "Boston Celtics": ["BOS"],
    "Brooklyn Nets": ["BKN"],
    "Charlotte Hornets": ["CHA", "CHO"],
    "Chicago Bulls": ["CHI"],
    "Cleveland Cavaliers": ["CLE"],
    "Dallas Mavericks": ["DAL"],
    "Denver Nuggets": ["DEN"],
    "Detroit Pistons": ["DET"],
    "Golden State Warriors": ["GS", "GSW"],
    "Houston Rockets": ["HOU"],
    "Indiana Pacers": ["IND"],
    "Los Angeles Clippers": ["LAC"],
    "LA Clippers": ["LAC"],
    "Los Angeles Lakers": ["LAL"],
    "Memphis Grizzlies": ["MEM"],
    "Miami Heat": ["MIA"],
    "Milwaukee Bucks": ["MIL"],
    "Minnesota Timberwolves": ["MIN"],
    "New Orleans Pelicans": ["NO", "NOP"],
    "New York Knicks": ["NY", "NYK"],
    "Oklahoma City Thunder": ["OKC"],
    "Orlando Magic": ["ORL"],
    "Philadelphia 76ers": ["PHI"],
    "Phoenix Suns": ["PHX"],
    "Portland Trail Blazers": ["POR"],
    "Sacramento Kings": ["SAC"],
    "San Antonio Spurs": ["SA", "SAS"],
    "Toronto Raptors": ["TOR"],
    "Utah Jazz": ["UTA", "UTAH"],
    "Washington Wizards": ["WAS", "WSH"],
    # NHL
    "Anaheim Ducks": ["ANA"],
    "Arizona Coyotes": ["ARI"],
    "Boston Bruins": ["BOS"],
    "Buffalo Sabres": ["BUF"],
    "Calgary Flames": ["CGY"],
    "Carolina Hurricanes": ["CAR"],
    "Chicago Blackhawks": ["CHI"],
    "Colorado Avalanche": ["COL"],
    "Columbus Blue Jackets": ["CBJ"],
    "Dallas Stars": ["DAL"],
    "Detroit Red Wings": ["DET"],
    "Edmonton Oilers": ["EDM"],
    "Florida Panthers": ["FLA"],
    "Los Angeles Kings": ["LAK", "LA"],
    "Minnesota Wild": ["MIN"],
    "Montreal Canadiens": ["MTL"],
    "Nashville Predators": ["NSH"],
    "New Jersey Devils": ["NJD", "NJ"],
    "New York Islanders": ["NYI"],
    "New York Rangers": ["NYR"],
    "Ottawa Senators": ["OTT"],
    "Philadelphia Flyers": ["PHI"],
    "Pittsburgh Penguins": ["PIT"],
    "San Jose Sharks": ["SJS", "SJ"],
    "Seattle Kraken": ["SEA"],
    "St Louis Blues": ["STL"],
    "St. Louis Blues": ["STL"],
    "Tampa Bay Lightning": ["TBL", "TB"],
    "Toronto Maple Leafs": ["TOR"],
    "Utah Hockey Club": ["UTA"],
    "Vancouver Canucks": ["VAN"],
    "Vegas Golden Knights": ["VGK"],
    "Washington Capitals": ["WSH", "WAS"],
    "Winnipeg Jets": ["WPG"],
}

# ---------------------------------------------------------------------------
# Model G: reduced feature set (top 8 from Model C importance)
# ---------------------------------------------------------------------------
FEATURES = [
    "league_avg_stat",           # 808
    "team_stat_ewa",             # 604
    "team_stat_trend",           # 597
    "opp_allowed_ewa",           # 583
    "opp_allowed_trend",         # 581
    "team_vs_league",            # 562
    "opp_vs_league",             # 518
    "blended_team_projection",   # 316
    # D2. Home/Away Splits (all leagues)
    "team_home_away_ewa",
    "team_home_away_diff",
    # E. Pitcher (MLB only, 0 for other leagues)
    "sp_k_per_ip_ewa",
    "bp_quality",
    "pitching_quality_index",
    # F. Park Factors (MLB only)
    "park_runs_factor",
    "park_factor_vs_league",
]

EWA_ALPHA = 0.3
SHRINK_MIN_GAMES = 5

# Conservative hyperparameters (vs Model C)
LGB_PARAMS = dict(
    n_estimators=300, max_depth=3, learning_rate=0.03,
    num_leaves=15, min_child_samples=50, subsample=0.8,
    colsample_bytree=0.7, reg_alpha=5.0, reg_lambda=5.0,
    random_state=42, verbose=-1,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def ewa(values, alpha=EWA_ALPHA):
    """Exponentially weighted average. Returns final EWA value."""
    if not values:
        return 0.0
    result = values[0]
    for v in values[1:]:
        result = alpha * v + (1 - alpha) * result
    return result


def ewa_shrunk(values, season_avg, alpha=EWA_ALPHA, min_n=SHRINK_MIN_GAMES):
    """EWA with shrinkage toward season_avg when sample < min_n."""
    if not values:
        return season_avg
    raw = ewa(values, alpha)
    n = len(values)
    if n >= min_n:
        return raw
    w = n / min_n
    return w * raw + (1 - w) * season_avg


def date_diff(d1, d2):
    """Days between two YYYY-MM-DD strings."""
    try:
        return (datetime.strptime(d2, "%Y-%m-%d") - datetime.strptime(d1, "%Y-%m-%d")).days
    except Exception:
        return 0


# ---------------------------------------------------------------------------
# Data Loading
# ---------------------------------------------------------------------------
def load_game_odds(league, train_book="fanduel"):
    """Load game odds from Supabase. Primary odds from train_book, alt book odds as alt_* fields."""
    sport_key = SPORT_KEYS.get(league)
    if not sport_key:
        print(f"  No sport_key for {league}")
        return {}

    print(f"  Loading game odds (train_book={train_book})...")
    all_rows = paginate(
        "back_in_play_game_odds",
        "event_id, game_date, home_team, away_team, sport_key, source, "
        "h2h_home_price, h2h_away_price, "
        "spread_home_line, spread_home_price, spread_away_line, spread_away_price, "
        "total_line, total_over_price, total_under_price, "
        "home_total_line, home_total_over_price, home_total_under_price, "
        "away_total_line, away_total_over_price, away_total_under_price, "
        "home_score, away_score, "
        "close_h2h_home_price, close_h2h_away_price, "
        "close_spread_home_line, close_spread_home_price, close_spread_away_line, close_spread_away_price, "
        "close_total_line, close_total_over_price, close_total_under_price, "
        "close_home_total_line, close_home_total_over_price, close_home_total_under_price, "
        "close_away_total_line, close_away_total_over_price, close_away_total_under_price",
        filters=[("eq", ("sport_key", sport_key))],
    )
    print(f"    Raw rows: {len(all_rows):,}")

    alt_book = "draftkings" if train_book == "fanduel" else "fanduel"
    by_event = defaultdict(list)
    for r in all_rows:
        by_event[r["event_id"]].append(r)

    # Fields to merge from alt book
    ALT_FIELDS = [
        "h2h_home_price", "h2h_away_price",
        "spread_home_line", "spread_home_price", "spread_away_line", "spread_away_price",
        "total_line", "total_over_price", "total_under_price",
        "home_total_line", "home_total_over_price", "home_total_under_price",
        "away_total_line", "away_total_over_price", "away_total_under_price",
        "close_h2h_home_price", "close_h2h_away_price",
        "close_spread_home_line", "close_spread_home_price", "close_spread_away_line", "close_spread_away_price",
        "close_total_line", "close_total_over_price", "close_total_under_price",
        "close_home_total_line", "close_home_total_over_price", "close_home_total_under_price",
        "close_away_total_line", "close_away_total_over_price", "close_away_total_under_price",
    ]

    events = {}
    for eid, rows in by_event.items():
        primary = None
        alt = None
        for r in rows:
            src = (r.get("source") or "").lower()
            if src == train_book and not primary:
                primary = r
            elif src == alt_book and not alt:
                alt = r

        if not primary:
            primary = alt  # fallback to alt book if train book missing
        if not primary:
            continue

        # Merge alt book odds as alt_* fields
        if alt and alt is not primary:
            for field in ALT_FIELDS:
                primary[f"alt_{field}"] = alt.get(field)

        primary["train_book"] = train_book
        events[eid] = primary

    print(f"    Unique events: {len(events):,} (train={train_book}, alt={alt_book})")
    return events


def load_teams_and_players(league):
    """Load teams and players for the league. Returns team data structures."""
    league_id = LEAGUE_IDS[league]

    print("  Loading teams...")
    teams_raw = paginate("back_in_play_teams", "team_id, team_name",
                         filters=[("eq", ("league_id", league_id))])
    team_id_to_name = {t["team_id"]: t["team_name"] for t in teams_raw}
    team_name_to_id = {}
    for t in teams_raw:
        team_name_to_id[t["team_name"].lower()] = t["team_id"]
    print(f"    {len(teams_raw)} teams")

    print("  Loading players...")
    players_raw = paginate("back_in_play_players", "player_id, player_name, team_id, position",
                           filters=[("eq", ("league_id", league_id))])
    print(f"    {len(players_raw):,} players")

    # Build team_id -> list of player_ids
    team_players = defaultdict(list)
    player_team = {}
    for p in players_raw:
        if p.get("team_id"):
            team_players[p["team_id"]].append(p["player_id"])
            player_team[p["player_id"]] = p["team_id"]

    # Build abbreviation -> team_name mapping
    abbr_to_team_name = {}
    for tname, abbrs in TEAM_ABBR_MAP.items():
        for a in abbrs:
            if tname.lower() in team_name_to_id:
                abbr_to_team_name[a] = tname

    # Also build team_name -> abbreviations for reverse lookups
    team_name_to_abbrs = {}
    for tname, abbrs in TEAM_ABBR_MAP.items():
        if tname.lower() in team_name_to_id:
            team_name_to_abbrs[tname.lower()] = abbrs

    # Build player_position lookup (needed for MLB pitcher identification)
    player_position = {}
    for p in players_raw:
        player_position[p["player_id"]] = (p.get("position") or "").upper()

    return {
        "teams_raw": teams_raw,
        "team_id_to_name": team_id_to_name,
        "team_name_to_id": team_name_to_id,
        "team_players": team_players,
        "player_team": player_team,
        "players_raw": players_raw,
        "abbr_to_team_name": abbr_to_team_name,
        "team_name_to_abbrs": team_name_to_abbrs,
        "player_position": player_position,
    }


def _load_game_logs_by_league(league, select_cols, start_year=2018, end_year=2027):
    """Load all game logs for a league using monthly date ranges to avoid offset pagination timeouts."""
    import time as _time
    all_logs = []
    for year in range(start_year, end_year):
        for month in range(1, 13):
            d_start = f"{year}-{month:02d}-01"
            d_end = f"{year + 1}-01-01" if month == 12 else f"{year}-{month + 1:02d}-01"
            data = paginate(
                "back_in_play_player_game_logs",
                select_cols,
                filters=[
                    ("eq", ("league_slug", league)),
                    ("gte", ("game_date", d_start)),
                    ("lt", ("game_date", d_end)),
                ],
                order_col="game_date",
            )
            if data:
                all_logs.extend(data)
            if len(all_logs) % 50000 < 5000 and len(all_logs) > 0:
                print(f"    ... {len(all_logs):,} logs loaded (through {d_start})")
            _time.sleep(0.1)
    return all_logs


def load_game_logs_for_teams(league, team_data):
    """Load game logs for all players on teams we care about.
    Returns logs_by_player dict and also builds team_game_scores."""
    stat_col = TEAM_STAT_COL[league]

    print(f"  Loading ALL game logs for {league} (date-range chunking)...")

    # Include pitcher stats for MLB
    if league == "mlb":
        select_cols = "player_id, game_date, minutes, opponent, " + stat_col + ", stat_ip, stat_k"
    else:
        select_cols = "player_id, game_date, minutes, opponent, " + stat_col
    all_logs = _load_game_logs_by_league(league, select_cols)

    print(f"    {len(all_logs):,} game logs loaded")

    # Organize by player
    logs_by_player = defaultdict(list)
    for g in all_logs:
        logs_by_player[g["player_id"]].append(g)
    for pid in logs_by_player:
        logs_by_player[pid].sort(key=lambda x: x["game_date"])

    return logs_by_player


def build_team_game_scores(logs_by_player, team_data, league):
    """Aggregate player game logs into team-level scores per game date.

    Returns:
      team_scores: {team_name_lower: [{game_date, scored, opponent, opponent_scored}, ...]}
      Also returns team_game_players: {(team_name_lower, game_date): [player_log, ...]}
    """
    stat_col = TEAM_STAT_COL[league]
    player_team = team_data["player_team"]
    team_id_to_name = team_data["team_id_to_name"]
    abbr_to_team_name = team_data["abbr_to_team_name"]

    # Group logs by (team_id, game_date)
    team_date_logs = defaultdict(list)
    for pid, logs in logs_by_player.items():
        tid = player_team.get(pid)
        if not tid:
            continue
        for g in logs:
            val = g.get(stat_col)
            if val is None:
                continue
            team_date_logs[(tid, g["game_date"])].append(g)

    # Build team_scores: sorted list of game results per team
    team_scores = defaultdict(list)
    team_game_players = {}  # (team_lower, game_date) -> [logs]

    for (tid, gdate), player_logs in team_date_logs.items():
        tname = team_id_to_name.get(tid, "")
        tname_lower = tname.lower()
        if not tname_lower:
            continue

        scored = sum(g.get(stat_col, 0) or 0 for g in player_logs)

        # Determine opponent from player logs (all should have same opponent)
        opp_abbr = None
        for g in player_logs:
            if g.get("opponent"):
                opp_abbr = g["opponent"]
                break

        opp_name = abbr_to_team_name.get(opp_abbr, "").lower() if opp_abbr else ""

        team_scores[tname_lower].append({
            "game_date": gdate,
            "scored": scored,
            "opponent": opp_name,
            "opp_abbr": opp_abbr,
        })
        team_game_players[(tname_lower, gdate)] = player_logs

    # Sort by date
    for tname in team_scores:
        team_scores[tname].sort(key=lambda x: x["game_date"])

    print(f"  Built team game scores: {len(team_scores)} teams, "
          f"{sum(len(v) for v in team_scores.values()):,} team-games")

    return team_scores, team_game_players


def build_opponent_allowed(team_scores):
    """Build how many points/goals each team ALLOWS per game.

    For a team T, the points they allowed on date D is what the opponent scored.
    We find the opponent's scored value for games played against T on date D.

    Returns: {team_lower: [{game_date, allowed}, ...]}
    """
    # Build a lookup: (team, date) -> scored
    team_date_scored = {}
    for tname, games in team_scores.items():
        for g in games:
            team_date_scored[(tname, g["game_date"])] = g["scored"]

    team_allowed = defaultdict(list)
    for tname, games in team_scores.items():
        for g in games:
            opp = g["opponent"]
            if not opp:
                continue
            # What the opponent scored in this game
            opp_scored = team_date_scored.get((opp, g["game_date"]))
            if opp_scored is not None:
                team_allowed[tname].append({
                    "game_date": g["game_date"],
                    "allowed": opp_scored,
                })

    for tname in team_allowed:
        team_allowed[tname].sort(key=lambda x: x["game_date"])

    return team_allowed


# ---------------------------------------------------------------------------
# MLB Pitcher Feature Helpers
# ---------------------------------------------------------------------------
def _is_pitcher(player_id, player_position):
    """Check if a player is a pitcher based on position."""
    pos = player_position.get(player_id, "")
    return "P" in pos  # Matches RHP, LHP, SP, RP, P, CL, etc.


def _identify_game_starters(team_game_players, player_position, logs_by_player):
    """Build cache: (team_lower, game_date) -> starter_player_id.
    Starter = pitcher with highest IP for that team on that date."""
    cache = {}
    for (team_lower, gdate), player_logs in team_game_players.items():
        best_pid, best_ip = None, -1
        for plog in player_logs:
            pid = plog["player_id"]
            if not _is_pitcher(pid, player_position):
                continue
            ip = plog.get("stat_ip") or 0
            if ip > best_ip:
                best_ip = ip
                best_pid = pid
        if best_pid and best_ip > 0:
            cache[(team_lower, gdate)] = best_pid
    return cache


def _get_pitcher_start_history(pitcher_id, logs_by_player, game_date, starter_cache):
    """Get a pitcher's history of STARTS (not relief appearances) before game_date.
    Returns list of {game_date, ip, k, k_per_ip} sorted chronologically."""
    all_logs = logs_by_player.get(pitcher_id, [])
    starts = []
    for g in all_logs:
        gd = g.get("game_date", "")
        if gd >= game_date:
            continue
        ip = g.get("stat_ip") or 0
        if ip <= 0:
            continue
        # Check if this pitcher was the starter in this game
        # We check all team keys in the cache for this date
        was_starter = False
        for key, starter_pid in starter_cache.items():
            if key[1] == gd and starter_pid == pitcher_id:
                was_starter = True
                break
        if was_starter:
            k = g.get("stat_k") or 0
            starts.append({
                "game_date": gd,
                "ip": ip,
                "k": k,
                "k_per_ip": k / ip if ip > 0 else 0,
            })
    starts.sort(key=lambda x: x["game_date"])
    return starts


def compute_pitcher_features(
    team_name_lower, opp_name_lower, game_date,
    team_game_players, logs_by_player, player_position,
    starter_cache, league_games_before,
):
    """Compute 10 MLB pitcher features for a team in a game.
    Returns list of 10 floats."""
    ZERO = [0.0] * 10

    # Identify this team's starter for the upcoming game.
    # We use the starter from the team's most recent game as a proxy
    # (since we don't know the announced starter from historical data).
    # For the CURRENT game, we look at who started for this team most recently.
    team_game_dates = sorted(
        [gd for (t, gd) in starter_cache if t == team_name_lower and gd < game_date]
    )
    if not team_game_dates:
        return ZERO

    # Get the most recent game's starter
    recent_game_date = team_game_dates[-1]
    starter_id = starter_cache.get((team_name_lower, recent_game_date))
    if not starter_id:
        return ZERO

    # Get starter's historical starts
    starts = _get_pitcher_start_history(starter_id, logs_by_player, game_date, starter_cache)
    if len(starts) < 2:
        return ZERO

    # --- G. Starting Pitcher Features ---
    last_5 = starts[-5:]
    last_3 = starts[-3:] if len(starts) >= 3 else starts

    # 1. sp_k_per_ip_ewa: EWA of K/IP over last 5 starts, shrunk to season
    k_rates = [s["k_per_ip"] for s in last_5]
    season_k = sum(s["k"] for s in starts)
    season_ip = sum(s["ip"] for s in starts)
    season_k_per_ip = season_k / season_ip if season_ip > 0 else 0
    sp_k_per_ip_ewa = ewa_shrunk(k_rates, season_k_per_ip) if k_rates else season_k_per_ip

    # 2. sp_ip_ewa: EWA of IP over last 5 starts
    ip_vals = [s["ip"] for s in last_5]
    sp_ip_ewa_val = ewa(ip_vals) if ip_vals else 5.0

    # 3. sp_season_k_per_ip
    sp_season_k_per_ip = season_k_per_ip

    # 4. sp_ip_consistency: 1 - CV(IP over last 5 starts)
    if len(ip_vals) >= 2:
        ip_mean = statistics.mean(ip_vals)
        ip_std = statistics.stdev(ip_vals)
        cv = ip_std / ip_mean if ip_mean > 0 else 0
        sp_ip_consistency = max(0, min(1, 1 - cv))
    else:
        sp_ip_consistency = 0.5

    # 5. sp_vs_league: starter K/IP vs league avg starter K/IP
    # Compute league avg K/IP from all starters in league_games_before
    league_total_k, league_total_ip = 0, 0
    for (t, gd), starter_pid in starter_cache.items():
        if gd >= game_date:
            continue
        p_logs = logs_by_player.get(starter_pid, [])
        for g in p_logs:
            if g.get("game_date") == gd:
                league_total_k += g.get("stat_k") or 0
                league_total_ip += g.get("stat_ip") or 0
    league_avg_k_per_ip = league_total_k / league_total_ip if league_total_ip > 0 else 1.0
    sp_vs_league = season_k_per_ip / league_avg_k_per_ip if league_avg_k_per_ip > 0 else 1.0

    # 6. sp_recent_form: EWA(K/IP, last 3) / EWA(K/IP, last 5)
    k_rates_3 = [s["k_per_ip"] for s in last_3]
    ewa_3 = ewa(k_rates_3) if k_rates_3 else sp_k_per_ip_ewa
    ewa_5 = ewa(k_rates) if k_rates else sp_k_per_ip_ewa
    sp_recent_form = ewa_3 / ewa_5 if ewa_5 > 0 else 1.0

    # --- H. Bullpen Features ---
    # Bullpen quality: season avg K/IP for all non-starter pitcher appearances
    bp_total_k, bp_total_ip = 0, 0
    bp_recent_ip = 0  # IP in last 3 days

    # Get all team game dates before this game
    for (t, gd) in team_game_players:
        if t != team_name_lower or gd >= game_date:
            continue
        game_starter = starter_cache.get((t, gd))
        for plog in team_game_players[(t, gd)]:
            pid = plog["player_id"]
            if not _is_pitcher(pid, player_position):
                continue
            if pid == game_starter:
                continue  # Skip the starter
            ip = plog.get("stat_ip") or 0
            k = plog.get("stat_k") or 0
            if ip > 0:
                bp_total_k += k
                bp_total_ip += ip
                # Check if within last 3 days for fatigue
                if gd >= game_date[:8] + str(max(1, int(game_date[8:10]) - 3)).zfill(2):
                    bp_recent_ip += ip

    bp_quality = bp_total_k / bp_total_ip if bp_total_ip > 0 else 0.7  # league avg fallback

    # Bullpen fatigue: more precise date diff for last 3 days
    from datetime import datetime as _dt, timedelta as _td
    try:
        gd_dt = _dt.strptime(game_date, "%Y-%m-%d")
        cutoff = (gd_dt - _td(days=3)).strftime("%Y-%m-%d")
    except:
        cutoff = game_date

    bp_fatigue_ip = 0
    for (t, gd) in team_game_players:
        if t != team_name_lower or gd >= game_date or gd < cutoff:
            continue
        game_starter = starter_cache.get((t, gd))
        for plog in team_game_players[(t, gd)]:
            pid = plog["player_id"]
            if not _is_pitcher(pid, player_position):
                continue
            if pid == game_starter:
                continue
            bp_fatigue_ip += plog.get("stat_ip") or 0

    # 9. bp_expected_ip: 9 - starter's expected IP
    bp_expected_ip = max(2.0, min(7.0, 9.0 - sp_ip_ewa_val))

    # --- I. Combined ---
    fatigue_factor = max(0, 1 - bp_fatigue_ip / 15)
    pitching_quality_index = 0.6 * sp_k_per_ip_ewa + 0.25 * bp_quality + 0.15 * fatigue_factor

    return [
        sp_k_per_ip_ewa,
        sp_ip_ewa_val,
        sp_season_k_per_ip,
        sp_ip_consistency,
        sp_vs_league,
        sp_recent_form,
        bp_quality,
        bp_fatigue_ip,
        bp_expected_ip,
        pitching_quality_index,
    ]


def compute_park_factors(team_name_lower, game_date, team_scores, home_games_set, league_games_before):
    """Compute park factors for MLB using home vs away scoring splits.
    home_games_set = set of (team_lower, game_date) tuples for home games.
    Returns [park_runs_factor, park_factor_vs_league]."""

    team_games = team_scores.get(team_name_lower, [])
    past_games = [g for g in team_games if g["game_date"] < game_date]

    if len(past_games) < 10:
        return [1.0, 1.0]

    # Split into home and away
    home_runs, away_runs = [], []
    for g in past_games:
        if (team_name_lower, g["game_date"]) in home_games_set:
            home_runs.append(g["scored"])
        else:
            away_runs.append(g["scored"])

    if len(home_runs) < 5 or len(away_runs) < 5:
        return [1.0, 1.0]

    home_avg = sum(home_runs) / len(home_runs)
    away_avg = sum(away_runs) / len(away_runs)

    # Park runs factor: >1 = hitter-friendly park
    park_runs_factor = home_avg / away_avg if away_avg > 0 else 1.0

    # Park factor vs league: compute league-wide park factor and compare
    league_park_factors = []
    for tname, games in team_scores.items():
        t_past = [g for g in games if g["game_date"] < game_date]
        t_home = [g["scored"] for g in t_past if (tname, g["game_date"]) in home_games_set]
        t_away = [g["scored"] for g in t_past if (tname, g["game_date"]) not in home_games_set]
        if len(t_home) >= 5 and len(t_away) >= 5:
            t_pf = sum(t_home) / len(t_home) / (sum(t_away) / len(t_away))
            league_park_factors.append(t_pf)

    league_avg_pf = statistics.mean(league_park_factors) if league_park_factors else 1.0
    park_vs_league = park_runs_factor / league_avg_pf if league_avg_pf > 0 else 1.0

    return [park_runs_factor, park_vs_league]


# ---------------------------------------------------------------------------
# Feature Engineering
# ---------------------------------------------------------------------------
def compute_team_features(
    team_name_lower, opp_name_lower, game_date, is_home_flag,
    market_line, market_price_over, market_price_under,
    team_scores, team_allowed, team_game_players, logs_by_player,
    league_games_before, stat_col,
    league=None, player_position=None, starter_cache=None, home_games_set=None,
):
    """Compute the 15 features for a single team in a single game (10 base + 3 pitcher + 2 park).

    Returns feature vector (list of 15 floats) or None if insufficient data.
    """
    # --- League average up to this point ---
    league_scored = [g["scored"] for games in league_games_before.values() for g in games]
    league_avg = statistics.mean(league_scored) if league_scored else 0
    if league_avg == 0:
        return None

    # --- A. Team Recent Form ---
    team_games = team_scores.get(team_name_lower, [])
    past_games = [g for g in team_games if g["game_date"] < game_date]
    if len(past_games) < 3:
        return None

    # Season avg (all games before this date)
    season_scored = [g["scored"] for g in past_games]
    season_avg = statistics.mean(season_scored)

    last_10 = [g["scored"] for g in past_games[-10:]]
    last_3 = [g["scored"] for g in past_games[-3:]]

    team_stat_ewa = ewa_shrunk(last_10, season_avg)
    ewa_last3 = ewa(last_3) if last_3 else team_stat_ewa
    ewa_last10 = ewa(last_10) if last_10 else team_stat_ewa
    team_stat_trend = ewa_last3 / ewa_last10 if ewa_last10 > 0 else 1.0
    team_vs_league = season_avg / league_avg if league_avg > 0 else 1.0

    # --- B. Opponent Context ---
    opp_allowed_games = team_allowed.get(opp_name_lower, [])
    opp_past_allowed = [g for g in opp_allowed_games if g["game_date"] < game_date]

    if not opp_past_allowed:
        # Fallback: use league average
        opp_season_allowed = league_avg
        opp_allowed_ewa_val = league_avg
        opp_allowed_trend_val = 1.0
        opp_vs_league_val = 1.0
    else:
        opp_season_vals = [g["allowed"] for g in opp_past_allowed]
        opp_season_allowed = statistics.mean(opp_season_vals)
        opp_last10 = [g["allowed"] for g in opp_past_allowed[-10:]]
        opp_last3 = [g["allowed"] for g in opp_past_allowed[-3:]]
        opp_allowed_ewa_val = ewa_shrunk(opp_last10, opp_season_allowed)
        opp_ewa_last3 = ewa(opp_last3) if opp_last3 else opp_allowed_ewa_val
        opp_ewa_last10 = ewa(opp_last10) if opp_last10 else opp_allowed_ewa_val
        opp_allowed_trend_val = opp_ewa_last3 / opp_ewa_last10 if opp_ewa_last10 > 0 else 1.0
        opp_vs_league_val = opp_season_allowed / league_avg if league_avg > 0 else 1.0

    # --- C. Lineup-Based Projection (needed for blended_team_projection) ---
    # Use players who played in the team's PREVIOUS game as proxy for lineup
    if len(past_games) < 1:
        return None
    prev_game_date = past_games[-1]["game_date"]
    prev_player_logs = team_game_players.get((team_name_lower, prev_game_date), [])

    if not prev_player_logs:
        lineup_projected_stat = team_stat_ewa  # fallback
    else:
        lineup_proj_sum = 0.0

        for plog in prev_player_logs:
            pid = plog["player_id"]
            p_logs = logs_by_player.get(pid, [])
            p_before = [g for g in p_logs if g["game_date"] < game_date]
            if not p_before:
                continue

            # Player stat and minutes history
            p_stats = [(g.get(stat_col, 0) or 0) for g in p_before if g.get("minutes") and g["minutes"] > 0]
            p_mins = [g["minutes"] for g in p_before if g.get("minutes") and g["minutes"] > 0]

            if not p_stats or not p_mins:
                continue

            # Per-minute rate
            last_10_stats = p_stats[-10:]
            last_10_mins = p_mins[-10:]
            per_min_rates = [s / m for s, m in zip(last_10_stats, last_10_mins) if m > 0]

            if not per_min_rates:
                continue

            ewa_per_min = ewa(per_min_rates)
            season_per_min = sum(p_stats) / sum(p_mins) if sum(p_mins) > 0 else 0
            # Blend: 0.7 * EWA + 0.3 * season
            blended_per_min = 0.7 * ewa_per_min + 0.3 * season_per_min

            # Expected minutes
            last_5_mins = p_mins[-5:]
            ewa_mins_last5 = ewa(last_5_mins) if last_5_mins else 0

            lineup_proj_sum += blended_per_min * ewa_mins_last5

        lineup_projected_stat = lineup_proj_sum if lineup_proj_sum > 0 else team_stat_ewa

    # --- D. Combined Projection ---
    blended_team_projection = (
        0.5 * lineup_projected_stat +
        0.3 * team_stat_ewa +
        0.2 * league_avg
    )

    # --- D2. Home/Away Splits ---
    if home_games_set:
        home_scored = [g["scored"] for g in past_games if (team_name_lower, g["game_date"]) in home_games_set]
        away_scored = [g["scored"] for g in past_games if (team_name_lower, g["game_date"]) not in home_games_set]
        # EWA for the matching venue type
        if is_home_flag and len(home_scored) >= 3:
            team_home_away_ewa = ewa(home_scored[-10:])
        elif not is_home_flag and len(away_scored) >= 3:
            team_home_away_ewa = ewa(away_scored[-10:])
        else:
            team_home_away_ewa = team_stat_ewa  # fallback to overall
        # Diff: home avg - away avg (positive = strong home advantage)
        if len(home_scored) >= 3 and len(away_scored) >= 3:
            team_home_away_diff = statistics.mean(home_scored) - statistics.mean(away_scored)
        else:
            team_home_away_diff = 0.0
    else:
        team_home_away_ewa = team_stat_ewa
        team_home_away_diff = 0.0

    base_features = [
        league_avg,
        team_stat_ewa,
        team_stat_trend,
        opp_allowed_ewa_val,
        opp_allowed_trend_val,
        team_vs_league,
        opp_vs_league_val,
        blended_team_projection,
        team_home_away_ewa,
        team_home_away_diff,
    ]

    # --- E. MLB Pitcher Features (3 selected, 0 for non-MLB) ---
    if league == "mlb" and player_position and starter_cache is not None:
        pitcher_feats_full = compute_pitcher_features(
            team_name_lower, opp_name_lower, game_date,
            team_game_players, logs_by_player, player_position,
            starter_cache, league_games_before,
        )
        # Select only: sp_k_per_ip_ewa (idx 0), bp_quality (idx 6), pitching_quality_index (idx 9)
        pitcher_feats = [pitcher_feats_full[0], pitcher_feats_full[6], pitcher_feats_full[9]]
    else:
        pitcher_feats = [0.0] * 3

    # --- F. Park Factors (MLB only) ---
    if league == "mlb" and home_games_set is not None:
        park_feats = compute_park_factors(
            team_name_lower, game_date, team_scores, home_games_set, league_games_before
        )
    else:
        park_feats = [1.0, 1.0]

    return base_features + pitcher_feats + park_feats


# ---------------------------------------------------------------------------
# Dataset Building
# ---------------------------------------------------------------------------
def build_dataset(game_odds_events, team_scores, team_allowed, team_game_players,
                  logs_by_player, team_data, league):
    """Build training/test samples for team bets.

    Generates up to 3 bet types per event:
      - spread: did home team cover?
      - total: did game go over?
      - team_total (home/away): did team score go over?

    Since game_odds has no scores, derive from team_scores aggregation.
    """
    stat_col = TEAM_STAT_COL[league]
    team_name_to_abbrs = team_data["team_name_to_abbrs"]
    player_position = team_data.get("player_position", {})

    # Build starter cache for MLB pitcher features
    starter_cache = {}
    if league == "mlb" and player_position:
        print("  Building MLB starter cache...")
        starter_cache = _identify_game_starters(team_game_players, player_position, logs_by_player)
        print(f"    Identified starters for {len(starter_cache)} team-games")

    # Build home_games_set from game_odds (for park factor computation)
    home_games_set = set()
    for eid, odds in game_odds_events.items():
        ht = (odds.get("home_team") or "").strip().lower()
        gd = odds.get("game_date")
        if ht and gd:
            home_games_set.add((ht, gd))

    # Build (team_lower, date) -> scored lookup
    team_date_scored = {}
    for tname, games in team_scores.items():
        for g in games:
            team_date_scored[(tname, g["game_date"])] = g["scored"]

    samples = []
    skips = defaultdict(int)
    processed = 0

    # Pre-compute league games before each date (will be filtered per sample)
    all_game_dates = sorted(set(
        g["game_date"]
        for games in team_scores.values()
        for g in games
    ))

    for eid, odds in game_odds_events.items():
        gdate = odds.get("game_date")
        home_team = (odds.get("home_team") or "").strip()
        away_team = (odds.get("away_team") or "").strip()
        if not gdate or not home_team or not away_team:
            skips["missing_teams"] += 1
            continue

        home_lower = home_team.lower()
        away_lower = away_team.lower()

        # Derive scores from team game logs
        home_scored = team_date_scored.get((home_lower, gdate))
        away_scored = team_date_scored.get((away_lower, gdate))

        if home_scored is None or away_scored is None:
            skips["no_scores"] += 1
            continue

        # League games before this date (for league_avg computation)
        league_games_before = {}
        for tname, games in team_scores.items():
            before = [g for g in games if g["game_date"] < gdate]
            if before:
                league_games_before[tname] = before

        if not league_games_before:
            skips["no_league_context"] += 1
            continue

        # ---------- SPREAD BET ----------
        spread_line = odds.get("spread_home_line")
        spread_home_price = odds.get("spread_home_price")
        spread_away_price = odds.get("spread_away_price")

        if spread_line is not None and spread_home_price is not None and spread_away_price is not None:
            spread_line = float(spread_line)
            # Target: did home cover? (home_score + spread > away_score)
            margin = home_scored + spread_line - away_scored
            if margin == 0:
                skips["spread_push"] += 1
            else:
                target = 1 if margin > 0 else 0

                # Features for home team
                feats = compute_team_features(
                    home_lower, away_lower, gdate, True,
                    abs(spread_line), spread_home_price, spread_away_price,
                    team_scores, team_allowed, team_game_players, logs_by_player,
                    league_games_before, stat_col,
                    league=league, player_position=player_position, starter_cache=starter_cache, home_games_set=home_games_set,
                )
                if feats is not None:
                    samples.append({
                        "features": feats,
                        "target": target,
                        "market": "spread",
                        "date": gdate,
                        "player": f"{home_team} vs {away_team}",
                        "line": spread_line,
                        "over_price": spread_home_price,
                        "under_price": spread_away_price,
                        "actual": margin,
                        "home_team": home_team,
                        "away_team": away_team,
                        "home_scored": home_scored,
                        "away_scored": away_scored,
                        "event_id": eid,
                        "close_line": float(odds["close_spread_home_line"]) if odds.get("close_spread_home_line") is not None else None,
                        "close_over_price": odds.get("close_spread_home_price"),
                        "close_under_price": odds.get("close_spread_away_price"),
                        "alt_over_price": odds.get("alt_spread_home_price"),
                        "alt_under_price": odds.get("alt_spread_away_price"),
                        "alt_line": float(odds["alt_spread_home_line"]) if odds.get("alt_spread_home_line") is not None else None,
                        "train_book": odds.get("train_book", "fanduel"),
                    })
                else:
                    skips["spread_no_features"] += 1

        # ---------- TOTAL BET ----------
        total_line = odds.get("total_line")
        total_over_price = odds.get("total_over_price")
        total_under_price = odds.get("total_under_price")

        if total_line is not None and total_over_price is not None and total_under_price is not None:
            total_line = float(total_line)
            actual_total = home_scored + away_scored
            if actual_total == total_line:
                skips["total_push"] += 1
            else:
                target = 1 if actual_total > total_line else 0

                # Use home team perspective for features (arbitrary but consistent)
                feats = compute_team_features(
                    home_lower, away_lower, gdate, True,
                    total_line, total_over_price, total_under_price,
                    team_scores, team_allowed, team_game_players, logs_by_player,
                    league_games_before, stat_col,
                    league=league, player_position=player_position, starter_cache=starter_cache, home_games_set=home_games_set,
                )
                if feats is not None:
                    samples.append({
                        "features": feats,
                        "target": target,
                        "market": "total",
                        "date": gdate,
                        "player": f"{home_team} vs {away_team}",
                        "line": total_line,
                        "over_price": total_over_price,
                        "under_price": total_under_price,
                        "actual": actual_total,
                        "home_team": home_team,
                        "away_team": away_team,
                        "home_scored": home_scored,
                        "away_scored": away_scored,
                        "event_id": eid,
                        "close_line": float(odds["close_total_line"]) if odds.get("close_total_line") is not None else None,
                        "close_over_price": odds.get("close_total_over_price"),
                        "close_under_price": odds.get("close_total_under_price"),
                        "alt_over_price": odds.get("alt_total_over_price"),
                        "alt_under_price": odds.get("alt_total_under_price"),
                        "alt_line": float(odds["alt_total_line"]) if odds.get("alt_total_line") is not None else None,
                        "train_book": odds.get("train_book", "fanduel"),
                    })
                else:
                    skips["total_no_features"] += 1

        # ---------- HOME TEAM TOTAL ----------
        home_total_line = odds.get("home_total_line")
        home_total_over_price = odds.get("home_total_over_price")
        home_total_under_price = odds.get("home_total_under_price")

        if home_total_line is not None and home_total_over_price is not None and home_total_under_price is not None:
            home_total_line = float(home_total_line)
            if home_scored == home_total_line:
                skips["home_total_push"] += 1
            else:
                target = 1 if home_scored > home_total_line else 0
                feats = compute_team_features(
                    home_lower, away_lower, gdate, True,
                    home_total_line, home_total_over_price, home_total_under_price,
                    team_scores, team_allowed, team_game_players, logs_by_player,
                    league_games_before, stat_col,
                    league=league, player_position=player_position, starter_cache=starter_cache, home_games_set=home_games_set,
                )
                if feats is not None:
                    samples.append({
                        "features": feats,
                        "target": target,
                        "market": "home_team_total",
                        "date": gdate,
                        "player": home_team,
                        "line": home_total_line,
                        "over_price": home_total_over_price,
                        "under_price": home_total_under_price,
                        "actual": home_scored,
                        "home_team": home_team,
                        "away_team": away_team,
                        "home_scored": home_scored,
                        "away_scored": away_scored,
                        "event_id": eid,
                        "close_line": float(odds["close_home_total_line"]) if odds.get("close_home_total_line") is not None else None,
                        "close_over_price": odds.get("close_home_total_over_price"),
                        "close_under_price": odds.get("close_home_total_under_price"),
                        "alt_over_price": odds.get("alt_home_total_over_price"),
                        "alt_under_price": odds.get("alt_home_total_under_price"),
                        "alt_line": float(odds["alt_home_total_line"]) if odds.get("alt_home_total_line") is not None else None,
                        "train_book": odds.get("train_book", "fanduel"),
                    })
                else:
                    skips["home_total_no_features"] += 1

        # ---------- AWAY TEAM TOTAL ----------
        away_total_line = odds.get("away_total_line")
        away_total_over_price = odds.get("away_total_over_price")
        away_total_under_price = odds.get("away_total_under_price")

        if away_total_line is not None and away_total_over_price is not None and away_total_under_price is not None:
            away_total_line = float(away_total_line)
            if away_scored == away_total_line:
                skips["away_total_push"] += 1
            else:
                target = 1 if away_scored > away_total_line else 0
                feats = compute_team_features(
                    away_lower, home_lower, gdate, False,
                    away_total_line, away_total_over_price, away_total_under_price,
                    team_scores, team_allowed, team_game_players, logs_by_player,
                    league_games_before, stat_col,
                    league=league, player_position=player_position, starter_cache=starter_cache, home_games_set=home_games_set,
                )
                if feats is not None:
                    samples.append({
                        "features": feats,
                        "target": target,
                        "market": "away_team_total",
                        "date": gdate,
                        "player": away_team,
                        "line": away_total_line,
                        "over_price": away_total_over_price,
                        "under_price": away_total_under_price,
                        "actual": away_scored,
                        "home_team": home_team,
                        "away_team": away_team,
                        "home_scored": home_scored,
                        "away_scored": away_scored,
                        "event_id": eid,
                        "close_line": float(odds["close_away_total_line"]) if odds.get("close_away_total_line") is not None else None,
                        "close_over_price": odds.get("close_away_total_over_price"),
                        "close_under_price": odds.get("close_away_total_under_price"),
                        "alt_over_price": odds.get("alt_away_total_over_price"),
                        "alt_under_price": odds.get("alt_away_total_under_price"),
                        "alt_line": float(odds["alt_away_total_line"]) if odds.get("alt_away_total_line") is not None else None,
                        "train_book": odds.get("train_book", "fanduel"),
                    })
                else:
                    skips["away_total_no_features"] += 1

        processed += 1
        if processed % 200 == 0:
            print(f"    Processed {processed:,} events, {len(samples):,} samples so far")

    print(f"  Built {len(samples):,} samples from {processed:,} events")
    print(f"  Skips: {dict(skips)}")
    return samples, dict(skips)


# ---------------------------------------------------------------------------
# Make Bets (team-specific version)
# ---------------------------------------------------------------------------
def make_team_bets(test_samples, y_proba, model_name, season_label):
    """Generate bet list from test samples and model predictions for team bets."""
    bets = []
    for i, s in enumerate(test_samples):
        p_over = float(y_proba[i])
        p_under = 1 - p_over

        over_price = s.get("over_price")
        under_price = s.get("under_price")
        if over_price is None or under_price is None:
            continue

        over_profit = odds_to_profit(over_price)
        under_profit = odds_to_profit(under_price)
        ev_over = p_over * over_profit - p_under
        ev_under = p_under * under_profit - p_over

        if ev_over > ev_under and ev_over * 100 >= 0:
            side, ev = "OVER", ev_over
        elif ev_under * 100 >= 0:
            side, ev = "UNDER", ev_under
        else:
            continue

        # For spreads: OVER = home covers, UNDER = away covers
        # For totals: OVER/UNDER as normal
        actual = s["actual"]
        line = s["line"]
        if actual == line:
            continue  # push

        if s["market"] == "spread":
            # actual = margin = home_score + spread - away_score
            correct = (side == "OVER" and actual > 0) or (side == "UNDER" and actual < 0)
        else:
            correct = (side == "OVER" and actual > line) or (side == "UNDER" and actual < line)

        pnl_val = odds_to_profit(over_price if side == "OVER" else under_price) if correct else -1

        # Close odds tracking
        close_correct = None
        close_pnl = None
        close_line = s.get("close_line")
        if close_line is not None:
            if s["market"] == "spread":
                close_actual_side = "OVER" if actual > 0 else "UNDER" if actual < 0 else None
            else:
                close_actual_side = "OVER" if actual > close_line else "UNDER" if actual < close_line else None
            if close_actual_side:
                close_correct = side == close_actual_side
                cp = s.get("close_over_price") if side == "OVER" else s.get("close_under_price")
                if cp is not None:
                    close_pnl = round(odds_to_profit(cp) if close_correct else -1, 3)

        # CLV
        clv = None
        beat_close = None
        clv_prob_edge = None
        if close_line is not None and line is not None:
            clv = close_line - line if side == "OVER" else line - close_line
            beat_close = clv > 0
            open_price = over_price if side == "OVER" else under_price
            close_price = s.get("close_over_price") if side == "OVER" else s.get("close_under_price")
            if open_price is not None and close_price is not None:
                op = odds_to_implied_prob(open_price)
                cp_prob = odds_to_implied_prob(close_price)
                if op and cp_prob:
                    clv_prob_edge = round(cp_prob - op, 4)

        # Alt-book evaluation (the other bookmaker we didn't train on)
        alt_correct = None
        alt_pnl = None
        alt_over = s.get("alt_over_price")
        alt_under = s.get("alt_under_price")
        alt_line_val = s.get("alt_line") or line
        if alt_over is not None and alt_under is not None:
            if s["market"] == "spread":
                alt_actual_side = "OVER" if actual > 0 else "UNDER" if actual < 0 else None
            elif alt_line_val is not None and actual != alt_line_val:
                alt_actual_side = "OVER" if actual > alt_line_val else "UNDER"
            else:
                alt_actual_side = None
            if alt_actual_side:
                alt_correct = side == alt_actual_side
                alt_price = alt_over if side == "OVER" else alt_under
                alt_pnl = round(odds_to_profit(alt_price) if alt_correct else -1, 3)

        b_profit = odds_to_profit(over_price if side == "OVER" else under_price)
        p_win = p_over if side == "OVER" else p_under
        kelly_f = max((p_win * b_profit - (1 - p_win)) / b_profit, 0) if b_profit > 0 else 0

        bets.append({
            "player": s["player"],
            "date": s["date"],
            "market": s["market"],
            "line": line,
            "ev": round(ev * 100, 1),
            "rec": side,
            "actual": actual,
            "correct": correct,
            "pnl": round(pnl_val, 3),
            "close_correct": close_correct,
            "close_pnl": close_pnl,
            "alt_correct": alt_correct,
            "alt_pnl": alt_pnl,
            "clv": round(clv, 2) if clv is not None else None,
            "clv_prob_edge": clv_prob_edge,
            "beat_close": beat_close,
            "kelly_f": round(kelly_f, 4),
            "p_over": round(p_over, 3),
            "model": model_name,
            "season": season_label,
            "home_team": s.get("home_team", ""),
            "away_team": s.get("away_team", ""),
            "train_book": s.get("train_book", "fanduel"),
            "gn": 0,  # no game-number-back concept for team bets
        })

    return bets


# ---------------------------------------------------------------------------
# Walk-Forward Training
# ---------------------------------------------------------------------------
def run(league):
    print(f"\n{'=' * 60}")
    print(f"TEAM MODEL G — {league.upper()} (Walk-Forward)")
    print(f"{'=' * 60}\n")

    # 1. Load shared data (doesn't depend on bookmaker)
    print("Loading data...")
    team_data = load_teams_and_players(league)
    logs_by_player = load_game_logs_for_teams(league, team_data)

    print("  Building team game scores...")
    team_scores, team_game_players = build_team_game_scores(
        logs_by_player, team_data, league
    )

    print("  Building opponent allowed stats...")
    team_allowed = build_opponent_allowed(team_scores)

    windows = WALK_FORWARD_WINDOWS.get(league, [])
    if not windows:
        print(f"No walk-forward windows defined for {league}")
        return

    # 2. Run for each training book (FanDuel and DraftKings)
    for train_book in ["fanduel", "draftkings"]:
        book_label = train_book[:2].upper()
        print(f"\n{'=' * 60}")
        print(f"TEAM MODEL G — {league.upper()} — Train on {train_book.upper()}")
        print(f"{'=' * 60}\n")

        game_odds_events = load_game_odds(league, train_book=train_book)
        if not game_odds_events:
            print(f"No game odds found for {train_book}!")
            continue

        print("\nBuilding dataset...")
        samples, skip_counts = build_dataset(
            game_odds_events, team_scores, team_allowed, team_game_players,
            logs_by_player, team_data, league,
        )
        if not samples:
            print("No samples built!")
            continue

        all_bets = []
        combined_acc = []
        combined_auc = []
        last_model = None
        last_fi = None
        last_kept_features = None

        for wi, window in enumerate(windows):
            season = window["season"]
            train = [s for s in samples if s["date"] < window["train_end"]]
            test = [s for s in samples
                    if s["date"] >= window["test_start"] and s["date"] < window["test_end"]]

            print(f"\n--- Window {wi + 1}: {season} ---")
            print(f"  Train: {len(train):,} (< {window['train_end']})  "
                  f"Test: {len(test):,} ({window['test_start']} to {window['test_end']})")

            if len(train) < 50:
                print("  Skipping: not enough training data")
                continue
            if not test:
                print("  Skipping: no test data")
                continue

            # --- Per-market training with CV feature selection ---
            all_markets = sorted(set(s["market"] for s in train) | set(s["market"] for s in test))
            window_y_test_all = []
            window_y_proba_all = []
            window_test_samples_all = []

            for mkt in all_markets:
                mkt_train = [s for s in train if s["market"] == mkt]
                mkt_test = [s for s in test if s["market"] == mkt]
                if len(mkt_train) < 30 or not mkt_test:
                    if mkt_test:
                        print(f"    {mkt}: skipped ({len(mkt_train)} train samples)")
                    continue

                X_train_full = np.array([s["features"] for s in mkt_train])
                X_test_full = np.array([s["features"] for s in mkt_test])
                y_tr = np.array([s["target"] for s in mkt_train])
                y_te = np.array([s["target"] for s in mkt_test])

                # CV-based feature selection
                n_pos = int(sum(y_tr == 1))
                n_neg = int(sum(y_tr == 0))
                n_splits = min(5, max(2, n_pos, n_neg))
                if n_splits >= 2 and len(mkt_train) >= n_splits * 2:
                    cv = StratifiedKFold(n_splits=min(5, n_splits), shuffle=True, random_state=42)
                    cv_importances = np.zeros(len(FEATURES))
                    try:
                        for fold_train_idx, fold_val_idx in cv.split(X_train_full, y_tr):
                            fold_model = LGBMClassifier(**LGB_PARAMS)
                            fold_model.fit(X_train_full[fold_train_idx], y_tr[fold_train_idx])
                            cv_importances += fold_model.feature_importances_
                        cv_importances /= min(5, n_splits)
                        threshold = 0.1
                        keep_mask = cv_importances >= threshold
                    except Exception:
                        keep_mask = np.ones(len(FEATURES), dtype=bool)
                else:
                    keep_mask = np.ones(len(FEATURES), dtype=bool)

                kept_features = [f for f, k in zip(FEATURES, keep_mask) if k]
                X_train = X_train_full[:, keep_mask]
                X_test = X_test_full[:, keep_mask]

                mkt_model = LGBMClassifier(**LGB_PARAMS)
                mkt_model.fit(X_train, y_tr)

                y_pr = mkt_model.predict_proba(X_test)[:, 1]
                mkt_acc = accuracy_score(y_te, (y_pr > 0.5).astype(int))
                try:
                    mkt_auc = roc_auc_score(y_te, y_pr)
                except Exception:
                    mkt_auc = 0
                dropped_n = len(FEATURES) - len(kept_features)
                print(f"    {mkt}: train={len(mkt_train)} test={len(mkt_test)} "
                      f"acc={mkt_acc:.4f} auc={mkt_auc:.4f} dropped={dropped_n}")

                window_y_test_all.extend(y_te.tolist())
                window_y_proba_all.extend(y_pr.tolist())
                window_test_samples_all.extend(mkt_test)

                last_model = mkt_model
                last_fi = {n: int(i) for n, i in zip(kept_features, mkt_model.feature_importances_)}
                last_kept_features = kept_features

            if not window_test_samples_all:
                print("  No markets had enough data")
                continue

            y_test = np.array(window_y_test_all)
            y_proba = np.array(window_y_proba_all)
            test_for_bets = window_test_samples_all

            acc = accuracy_score(y_test, (y_proba > 0.5).astype(int))
            try:
                auc = roc_auc_score(y_test, y_proba)
            except Exception:
                auc = 0
            print(f"  Combined: acc={acc:.4f} auc={auc:.4f}")
            combined_acc.append((acc, len(test_for_bets)))
            combined_auc.append((auc, len(test_for_bets)))

            window_bets = make_team_bets(test_for_bets, y_proba, "team_g", season)
            wins = sum(1 for b in window_bets if b["correct"])
            pnl = sum(b["pnl"] for b in window_bets)
            if window_bets:
                print(f"  Bets: {len(window_bets):,}  "
                      f"Win: {wins / len(window_bets) * 100:.1f}%  "
                      f"ROI: {pnl / len(window_bets) * 100:+.1f}%  "
                      f"PnL: {pnl:+.1f}u")
            all_bets.extend(window_bets)

        # --- Summary ---
        if not all_bets:
            print("No bets from any window!")
            continue

        total_test = sum(n for _, n in combined_acc)
        avg_acc = sum(a * n for a, n in combined_acc) / total_test if total_test > 0 else 0
        avg_auc = sum(a * n for a, n in combined_auc) / total_test if total_test > 0 else 0

        total = len(all_bets)
        wins = sum(1 for b in all_bets if b["correct"])
        pnl = sum(b["pnl"] for b in all_bets)

        print(f"\n{'=' * 60}")
        print("COMBINED WALK-FORWARD RESULTS")
        print(f"{'=' * 60}")
        print(f"  Windows: {len(combined_acc)}  Total bets: {total:,}")
        print(f"  Win: {wins / total * 100:.1f}%  ROI: {pnl / total * 100:+.1f}%  PnL: {pnl:+.1f}u")
        print(f"  Avg Accuracy: {avg_acc:.4f}  Avg AUC: {avg_auc:.4f}")

        if last_fi:
            print(f"\n  Feature importance (last window):")
            for name, imp in sorted(last_fi.items(), key=lambda x: -x[1]):
                print(f"    {name:35s} {imp:6d}")

        # By market breakdown
        by_market = defaultdict(list)
        for b in all_bets:
            by_market[b["market"]].append(b)
        print(f"\n  By Market:")
        for m in sorted(by_market):
            m_bets = by_market[m]
            mw = sum(1 for b in m_bets if b["correct"])
            mp = sum(b["pnl"] for b in m_bets)
            print(f"    {m:20s}: {len(m_bets):,} bets  "
                  f"Win: {mw / len(m_bets) * 100:.1f}%  "
                  f"ROI: {mp / len(m_bets) * 100:+.1f}%  "
                  f"PnL: {mp:+.1f}u")

        # By season breakdown
        by_season = defaultdict(list)
        for b in all_bets:
            by_season[b.get("season", "unknown")].append(b)
        print(f"\n  By Season:")
        for s in sorted(by_season):
            s_bets = by_season[s]
            sw = sum(1 for b in s_bets if b["correct"])
            sp = sum(b["pnl"] for b in s_bets)
            print(f"    {s}: {len(s_bets):,} bets  "
                  f"Win: {sw / len(s_bets) * 100:.1f}%  "
                  f"ROI: {sp / len(s_bets) * 100:+.1f}%  "
                  f"PnL: {sp:+.1f}u")

        # --- Save results ---
        results = {
            "league": league,
            "model": "team_g",
            "train_book": train_book,
            "total_bets": total,
            "accuracy": round(avg_acc, 4),
            "auc": round(avg_auc, 4),
            "features": FEATURES,
            "kept_features": last_kept_features if last_kept_features else FEATURES,
            "feature_importance": last_fi or {},
            "bets": all_bets,
            "walk_forward": True,
            "windows": len(combined_acc),
            "skip_counts": skip_counts,
        }

        out = f"/workspace/back-in-play/data/team_g_{league}_{train_book[:2]}.json"
        with open(out, "w") as f:
            json.dump(results, f)
        print(f"\nSaved to {out}")

        # Compute full summary with by_market_{mode}_ev{X}_gn{Y} keys
        print("\nComputing summary...")
        summary = compute_summary(results)

        # Upload to Supabase with book suffix
        try:
            league_key = f"{league}_team_g_{train_book[:2]}"
            row = {
                "league": league_key,
                "results": json.dumps(results),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
            if summary:
                row["summary"] = json.dumps(summary)
            sb.table("back_in_play_backtest_results").upsert(row).execute()
            print(f"Uploaded to Supabase as {league_key}")
        except Exception as e:
            print(f"Upload failed: {e}")

    # Save model pickle
    if last_model:
        pkl_path = f"/workspace/back-in-play/data/team_g_{league}.pkl"
        with open(pkl_path, "wb") as f:
            pickle.dump(last_model, f)
        print(f"Saved model to {pkl_path}")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Team Model G: conservative team-level betting predictions")
    parser.add_argument("--league", required=True, choices=list(LEAGUE_IDS.keys()),
                        help="League to run (nba, nhl, nfl, mlb, premier-league)")
    args = parser.parse_args()
    run(args.league)
