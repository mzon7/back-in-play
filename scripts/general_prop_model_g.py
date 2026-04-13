#!/usr/bin/env python3
"""
General Prop Model G — Reduced feature set (top 8 from Model C) with conservative LightGBM.

All players (no injury requirement). Uses exponentially weighted averages (alpha=0.3)
instead of simple rolling averages, with shrinkage toward season baseline when N<5.
Core projection = expected_minutes * blended_per_min_rate, adjusted by opponent defense.

Feature Architecture (8 features — top importance from Model C):
  A. Expected Minutes/Role (4): expected_minutes, minute_share, minutes_trend, role_stability
  B. Per-Minute Production (1): per_min_trend
  C. Projected Stat (1): projected_stat_opp_adj
  D. Team & Opponent Context (2): team_stat_form, opp_defense_ratio

Uses LightGBM with conservative hyperparameters (lower depth, more regularisation).

Usage:
  python3 general_prop_model_g.py --league nba
"""

import os, sys, json, math, statistics, argparse, pathlib, pickle
from collections import defaultdict
from datetime import datetime, timedelta, timezone
import numpy as np
from lightgbm import LGBMClassifier
from sklearn.metrics import accuracy_score, roc_auc_score
from sklearn.model_selection import StratifiedKFold
from supabase import create_client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
sb = create_client(SUPABASE_URL, SUPABASE_KEY)

# ─── Reuse from Model E ─────────────────────────────────────────────────────
sys.path.insert(0, "/workspace/back-in-play/scripts")
from regression_v5_model_e import (
    MARKET_TO_STAT, NHL_MARKET_OVERRIDES, EPL_MARKET_OVERRIDES,
    LEAGUE_IDS, build_name_index, resolve_player, paginate,
    load_props_from_files, load_game_odds_from_files, load_game_odds_from_supabase,
    odds_to_implied_prob, odds_to_profit, moneyline_to_implied_prob,
    find_open_close_line, make_bets, WALK_FORWARD_WINDOWS,
)

# ─── Game log columns to load ───────────────────────────────────────────────
GAME_LOG_COLS = (
    "player_id, game_date, opponent, minutes, "
    "stat_pts, stat_reb, stat_ast, stat_rush_yds, stat_pass_yds, "
    "stat_rec, stat_rec_yds, stat_goals, stat_sog, stat_h, stat_rbi, "
    "stat_stl, stat_3pm, stat_blk, stat_r, stat_sb, stat_k, stat_ip, "
    "stat_hr, stat_pass_td, stat_rush_td, stat_assists, stat_pass_comp, "
    "stat_pass_att, stat_rush_att, stat_total_shots"
)

HAS_MINUTES = {"nba", "nfl", "nhl"}

FEATURES = [
    # A. Expected Minutes / Role
    "minutes_trend",            # EWA(last 3 mins) / EWA(last 10 mins)
    "expected_minutes",         # EWA of minutes (last 10), shrunk toward season avg when N<5
    "minute_share",             # EWA of (player mins / team mins on that date) last 5
    "role_stability",           # 1 - CV(minute_share over last 10), clipped [0,1]
    # B. Per-Minute Production
    "per_min_trend",            # EWA(stat/min, last 3) / season_per_min_rate
    # C. Projected Stat
    "projected_stat_opp_adj",   # projected_stat * opp_defense_ratio
    # D. Team & Opponent Context
    "team_stat_form",           # EWA(team total for stat, last 5) / league_avg
    "opp_defense_ratio",        # EWA(opponent allowed for stat, last 10) / league_avg
    # E. Home/Away Splits
    "home_away_per_min_rate",   # per-min rate in matching venue (home if home, away if away)
    "home_away_projected_stat", # home_away_per_min_rate * expected_minutes
]

COMBO_FORMULAS = {
    "player_points_rebounds_assists": ["stat_pts", "stat_reb", "stat_ast"],
    "player_points_rebounds": ["stat_pts", "stat_reb"],
    "player_points_assists": ["stat_pts", "stat_ast"],
    "player_rebounds_assists": ["stat_reb", "stat_ast"],
    "player_threes": ["stat_3pm"],
}

# ─── Summary generation constants ───────────────────────────────────────────
EV_THRESHOLDS = [0, 5, 10, 15, 20, 30, 40, 50]
MAX_GN_VALUES = [1, 2, 3, 5, 10]
ODDS_MODES = ["scrape", "open", "close", "train", "alt"]
MARKET_LABELS = {
    "player_points": "Points", "player_rebounds": "Rebounds", "player_assists": "Assists",
    "player_pass_yds": "Pass Yds", "player_rush_yds": "Rush Yds",
    "player_reception_yds": "Rec Yds", "player_receptions": "Receptions",
    "player_goals": "Goals", "player_shots_on_goal": "SOG",
    "batter_hits": "Hits", "batter_rbis": "RBIs", "batter_total_bases": "Total Bases",
    "player_steals": "Steals", "player_blocks": "Blocks",
    "player_points_rebounds_assists": "PRA", "player_points_rebounds": "PR",
    "player_points_assists": "PA", "player_rebounds_assists": "RA",
    "player_threes": "Threes", "player_shots_on_target": "SOT",
    "player_assists_ice_hockey": "Assists (NHL)",
    "player_pass_tds": "Pass TDs", "player_rush_attempts": "Rush Att",
    "player_anytime_td": "Anytime TD", "player_pass_completions": "Pass Comp",
    "pitcher_strikeouts": "K", "pitcher_outs": "Outs",
    "batter_home_runs": "HR", "batter_runs_scored": "Runs",
    "batter_stolen_bases": "SB",
}


# ─── EWA helper ──────────────────────────────────────────────────────────────
def ewa(values, alpha=0.3):
    """Exponentially weighted average. values in chronological order (most recent last)."""
    if not values:
        return 0.0
    result = values[0]
    for v in values[1:]:
        result = alpha * v + (1 - alpha) * result
    return result


def coeff_of_variation(values):
    """Coefficient of variation. Returns 0 if mean is 0 or fewer than 2 values."""
    if len(values) < 2:
        return 0.0
    m = statistics.mean(values)
    if m == 0:
        return 0.0
    return statistics.stdev(values) / abs(m)


def date_diff(d1, d2):
    try:
        return (datetime.strptime(d2, "%Y-%m-%d") - datetime.strptime(d1, "%Y-%m-%d")).days
    except Exception:
        return 0


# ─── Summary helpers (from backfill_summaries.py) ────────────────────────────
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
            pnl = _bet_pnl(b, mode)
            op = pnl if pnl > 0 else 0.909
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
            label = MARKET_LABELS.get(market, market)
            by_market[label] = stats
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


# ─── Efficient game log loading (date-range chunking, avoids offset pagination) ──
def load_game_logs_by_league(league, select_cols, start_year=2018, end_year=2027):
    """Load all game logs for a league using monthly date ranges to avoid offset pagination timeouts."""
    import time
    all_logs = []
    for year in range(start_year, end_year):
        for month in range(1, 13):
            d_start = f"{year}-{month:02d}-01"
            if month == 12:
                d_end = f"{year + 1}-01-01"
            else:
                d_end = f"{year}-{month + 1:02d}-01"
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
            time.sleep(0.1)  # gentle on Supabase
    return all_logs


# ─── Data loading ────────────────────────────────────────────────────────────
def load_all_data(league):
    league_id = LEAGUE_IDS[league]
    print("Loading props + open/close data...")
    props, open_close, multi_book = load_props_from_files(league)
    print(f"  {len(props):,} props, {len(open_close):,} open/close, {len(multi_book):,} multi-book keys")

    # Prefer DraftKings/FanDuel, require both sides
    PREFERRED_BOOKS = ["draftkings", "fanduel"]

    def book_rank(p):
        b = (p.get("bookmaker") or "").lower()
        has_both = 0 if (p.get("over_price") is not None and p.get("under_price") is not None) else 1
        try:
            brank = PREFERRED_BOOKS.index(b)
        except ValueError:
            brank = 99
        return (has_both, brank)

    seen = {}
    for p in props:
        key = f"{p.get('player_name', '')}|{p.get('market', '')}|{p.get('game_date', '')}"
        if key not in seen or book_rank(p) < book_rank(seen[key]):
            seen[key] = p
    props = [p for p in seen.values()
             if p.get("over_price") is not None and p.get("under_price") is not None]
    print(f"  {len(props):,} after dedup")

    print("Loading players...")
    teams_raw = paginate("back_in_play_teams", "team_id, team_name",
                         filters=[("eq", ("league_id", league_id))])
    team_names = {t["team_id"]: t["team_name"] for t in teams_raw}
    players_raw = paginate("back_in_play_players",
                           "player_id, player_name, position, team_id",
                           filters=[("eq", ("league_id", league_id))])
    name_to_id, norm_to_id, _, fuzzy_to_id = build_name_index(players_raw)
    name_to_pos = {}
    for p in players_raw:
        name_to_pos[p["player_name"].lower()] = p.get("position", "")
    player_team = {}
    for p in players_raw:
        player_team[p["player_id"]] = team_names.get(p.get("team_id"), "")

    # Load game logs for ALL players in the league (needed for team/opp context)
    print(f"  Loading ALL game logs for {league} (date-range chunking)...")
    all_logs = load_game_logs_by_league(league, GAME_LOG_COLS)
    logs_by_player = defaultdict(list)
    for g in all_logs:
        logs_by_player[g["player_id"]].append(g)
    for pid in logs_by_player:
        logs_by_player[pid].sort(key=lambda x: x["game_date"])
    print(f"  {len(all_logs):,} game logs loaded")

    # Build opponent-date index: (opponent_code, game_date) -> [game_log, ...]
    logs_by_opp_date = defaultdict(list)
    for g in all_logs:
        opp = g.get("opponent")
        gd = g.get("game_date")
        if opp and gd:
            logs_by_opp_date[(opp, gd)].append(g)

    print("Loading game odds...")
    game_odds = load_game_odds_from_files(league)
    db_odds = load_game_odds_from_supabase()
    for eid, row in db_odds.items():
        if eid not in game_odds:
            game_odds[eid] = row
    print(f"  {len(game_odds)} events with game odds")

    return {
        "props": props, "open_close": open_close, "multi_book": multi_book,
        "name_to_id": name_to_id, "norm_to_id": norm_to_id, "fuzzy_to_id": fuzzy_to_id,
        "team_names": team_names, "player_team": player_team,
        "name_to_pos": name_to_pos, "players_raw": players_raw,
        "logs_by_player": dict(logs_by_player),
        "logs_by_opp_date": dict(logs_by_opp_date),
        "game_odds": game_odds,
    }


# ─── Dataset building ────────────────────────────────────────────────────────
def build_dataset(data, league):
    """Build dataset for ALL players (no injury filter) with EWA features — top 8 only."""
    props = data["props"]
    open_close = data["open_close"]
    multi_book = data["multi_book"]
    name_to_id = data["name_to_id"]
    norm_to_id = data["norm_to_id"]
    fuzzy_to_id = data.get("fuzzy_to_id", {})
    player_team = data.get("player_team", {})
    name_to_pos = data.get("name_to_pos", {})
    logs_by_player = data["logs_by_player"]
    logs_by_opp_date = data.get("logs_by_opp_date", {})
    game_odds = data.get("game_odds", {})

    # Build home_games_set: (team_lower, game_date) -> True for home games
    home_games_set = set()
    for go_val in game_odds.values():
        ht = (go_val.get("home_team") or "").lower()
        gd = go_val.get("game_date")
        if ht and gd:
            home_games_set.add((ht, gd))

    samples = []
    skips = defaultdict(int)

    _league_avg_cache = {}

    def get_league_avg_stat(stat_key_or_combo, market, all_logs_by_opp_date):
        """Compute league average per game for a stat across all available game logs."""
        cache_key = (stat_key_or_combo if isinstance(stat_key_or_combo, str)
                     else market)
        if cache_key in _league_avg_cache:
            return _league_avg_cache[cache_key]

        vals = []
        sampled = 0
        for (opp, gd), logs in all_logs_by_opp_date.items():
            if sampled > 50000:
                break
            total = 0
            count = 0
            for g in logs:
                if market in COMBO_FORMULAS:
                    combo_cols = COMBO_FORMULAS[market]
                    if all(g.get(c) is not None for c in combo_cols):
                        total += sum(g[c] for c in combo_cols)
                        count += 1
                else:
                    v = g.get(stat_key_or_combo)
                    if v is not None:
                        total += v
                        count += 1
            if count > 0:
                vals.append(total)
                sampled += count

        avg = statistics.mean(vals) if vals else 1.0
        _league_avg_cache[cache_key] = max(avg, 0.001)
        return _league_avg_cache[cache_key]

    for prop in props:
        player_name = prop.get("player_name", "")
        market = prop.get("market", "")
        game_date = prop.get("game_date", "")
        line = prop.get("line")
        over_price = prop.get("over_price")
        under_price = prop.get("under_price")
        event_id = prop.get("event_id", "")
        home_team = prop.get("home_team", "")
        away_team = prop.get("away_team", "")

        if not player_name or not market or not game_date or line is None:
            skips["missing"] += 1
            continue
        stat_key = MARKET_TO_STAT.get(market)
        if league == "nhl" and market in NHL_MARKET_OVERRIDES:
            stat_key = NHL_MARKET_OVERRIDES[market]
        elif league == "premier-league" and market in EPL_MARKET_OVERRIDES:
            stat_key = EPL_MARKET_OVERRIDES[market]
        if not stat_key:
            skips["unknown_market"] += 1
            continue

        # NHL: player_points = goals + assists
        nhl_combo = league in ("nhl", "premier-league") and market == "player_points"
        if nhl_combo:
            COMBO_FORMULAS["player_points"] = ["stat_goals", "stat_assists"]

        pid = resolve_player(player_name, name_to_id, norm_to_id, fuzzy_to_id)
        if not pid:
            skips["no_player"] += 1
            continue

        all_games = logs_by_player.get(pid, [])
        min_games = 3 if league == "nfl" else 8
        if len(all_games) < min_games:
            skips["few_games"] += 1
            continue

        # All games BEFORE this game date, chronological (oldest first)
        prior_games = [g for g in all_games if g["game_date"] < game_date]
        prior_games.sort(key=lambda x: x["game_date"])  # chronological for EWA

        if len(prior_games) < (2 if league == "nfl" else 5):
            skips["few_prior"] += 1
            continue

        # Find actual game on this date
        actual_game = next((g for g in all_games if g["game_date"] == game_date), None)
        if not actual_game:
            skips["no_actual"] += 1
            continue

        # Get actual stat value
        if market in COMBO_FORMULAS:
            combo_cols = COMBO_FORMULAS[market]
            if all(actual_game.get(c) is not None for c in combo_cols):
                actual_stat = sum(actual_game[c] for c in combo_cols)
            else:
                skips["no_actual"] += 1
                continue
        else:
            actual_stat = actual_game.get(stat_key)

        if actual_stat is None:
            skips["no_actual"] += 1
            continue
        if actual_stat == line:
            skips["push"] += 1
            continue

        # ─── Extract prior stats (chronological) ────────────────────────
        if market in COMBO_FORMULAS:
            combo_cols = COMBO_FORMULAS[market]
            prior_stat_values = [
                sum(g.get(c, 0) or 0 for c in combo_cols)
                for g in prior_games
                if all(g.get(c) is not None for c in combo_cols)
            ]
        else:
            prior_stat_values = [
                g[stat_key] for g in prior_games if g.get(stat_key) is not None
            ]

        if len(prior_stat_values) < (2 if league == "nfl" else 3):
            skips["few_stats"] += 1
            continue

        # Season boundaries
        _gd_year = int(game_date[:4])
        _gd_month = int(game_date[5:7])
        _lb_year = _gd_year - 1 if _gd_month <= 6 else _gd_year
        season_start = f"{_lb_year}-07-01"

        season_games = [g for g in prior_games if g["game_date"] >= season_start]
        if market in COMBO_FORMULAS:
            combo_cols = COMBO_FORMULAS[market]
            season_stat_values = [
                sum(g.get(c, 0) or 0 for c in combo_cols)
                for g in season_games
                if all(g.get(c) is not None for c in combo_cols)
            ]
        else:
            season_stat_values = [
                g[stat_key] for g in season_games if g.get(stat_key) is not None
            ]

        season_avg = statistics.mean(season_stat_values) if season_stat_values else statistics.mean(prior_stat_values)

        # ─── A. Expected Minutes / Role ──────────────────────────────────

        # Minutes values (chronological)
        prior_minutes = [g["minutes"] for g in prior_games
                         if g.get("minutes") and g["minutes"] > 0]
        season_minutes = [g["minutes"] for g in season_games
                          if g.get("minutes") and g["minutes"] > 0]
        season_avg_min = statistics.mean(season_minutes) if season_minutes else (
            statistics.mean(prior_minutes) if prior_minutes else 0
        )

        # 1. expected_minutes: EWA of last 10, shrunk toward season avg when N<5
        last_10_min = prior_minutes[-10:]  # chronological (most recent last)
        n_recent = len(last_10_min)
        raw_ewa_min = ewa(last_10_min) if last_10_min else season_avg_min
        if n_recent < 5 and season_avg_min > 0:
            shrink_w = n_recent / 5.0
            expected_minutes = shrink_w * raw_ewa_min + (1 - shrink_w) * season_avg_min
        else:
            expected_minutes = raw_ewa_min

        # 2. minute_share: EWA of (player mins / team mins on date) over last 5
        minute_shares = []
        for g in prior_games[-10:]:
            if not g.get("minutes") or g["minutes"] <= 0:
                continue
            opp_code = g.get("opponent")
            gd = g.get("game_date")
            if opp_code and gd:
                team_logs = logs_by_opp_date.get((opp_code, gd), [])
                team_total_min = sum(
                    tl["minutes"] for tl in team_logs
                    if tl.get("minutes") and tl["minutes"] > 0
                )
                if team_total_min > 0:
                    minute_shares.append(g["minutes"] / team_total_min)

        last_5_shares = minute_shares[-5:]  # chronological
        minute_share = ewa(last_5_shares) if last_5_shares else 0.0

        # 3. minutes_trend: EWA(last 3 mins) / EWA(last 10 mins)
        last_3_min = prior_minutes[-3:]
        ewa_last_3_min = ewa(last_3_min) if last_3_min else expected_minutes
        ewa_last_10_min = ewa(last_10_min) if last_10_min else season_avg_min
        minutes_trend = ewa_last_3_min / ewa_last_10_min if ewa_last_10_min > 0 else 1.0

        # 4. role_stability: 1 - CV(minute_share over last 10), clipped [0,1]
        role_stability = max(0.0, min(1.0, 1.0 - coeff_of_variation(minute_shares[-10:]))) if len(minute_shares) >= 2 else 0.5

        # ─── B. Per-Minute Production ────────────────────────────────────

        # Compute per-minute rate for each prior game (needed for per_min_trend and projected_stat_opp_adj)
        per_min_rates = []
        for g in prior_games:
            if not g.get("minutes") or g["minutes"] <= 0:
                continue
            if market in COMBO_FORMULAS:
                combo_cols = COMBO_FORMULAS[market]
                if all(g.get(c) is not None for c in combo_cols):
                    val = sum(g[c] for c in combo_cols)
                else:
                    continue
            else:
                val = g.get(stat_key)
                if val is None:
                    continue
            per_min_rates.append(val / g["minutes"])

        season_per_min_rates = []
        for g in season_games:
            if not g.get("minutes") or g["minutes"] <= 0:
                continue
            if market in COMBO_FORMULAS:
                combo_cols = COMBO_FORMULAS[market]
                if all(g.get(c) is not None for c in combo_cols):
                    val = sum(g[c] for c in combo_cols)
                else:
                    continue
            else:
                val = g.get(stat_key)
                if val is None:
                    continue
            season_per_min_rates.append(val / g["minutes"])

        season_per_min_rate = statistics.mean(season_per_min_rates) if season_per_min_rates else (
            statistics.mean(per_min_rates) if per_min_rates else 0
        )

        # blended_per_min_rate (intermediate — needed for projected_stat_opp_adj)
        last_10_pmr = per_min_rates[-10:]
        n_recent_pmr = len(last_10_pmr)
        ewa_pmr_10 = ewa(last_10_pmr) if last_10_pmr else season_per_min_rate
        w = min(n_recent_pmr / 10.0, 1.0)
        blended_per_min_rate = w * ewa_pmr_10 + (1 - w) * season_per_min_rate

        # 5. per_min_trend
        last_3_pmr = per_min_rates[-3:]
        ewa_pmr_3 = ewa(last_3_pmr) if last_3_pmr else blended_per_min_rate
        per_min_trend = ewa_pmr_3 / season_per_min_rate if season_per_min_rate > 0 else 1.0

        # ─── C. Projected Stat ───────────────────────────────────────────

        # projected_stat (intermediate — needed for projected_stat_opp_adj)
        projected_stat = expected_minutes * blended_per_min_rate

        # ─── D. Team & Opponent Context ──────────────────────────────────

        # Determine the player's opponent code from this game
        player_opp_code = actual_game.get("opponent", "")

        # League average stat (team total per game)
        league_avg_stat = get_league_avg_stat(stat_key, market, logs_by_opp_date)

        # 6. team_stat_form: EWA(team total for stat, last 5) / league_avg
        team_totals = []
        for g in prior_games[-5:]:
            opp = g.get("opponent")
            gd = g.get("game_date")
            if not opp or not gd:
                continue
            team_logs = logs_by_opp_date.get((opp, gd), [])
            if market in COMBO_FORMULAS:
                combo_cols = COMBO_FORMULAS[market]
                total = sum(
                    sum(tl.get(c, 0) or 0 for c in combo_cols)
                    for tl in team_logs
                    if all(tl.get(c) is not None for c in combo_cols)
                )
            else:
                total = sum(tl.get(stat_key, 0) or 0 for tl in team_logs
                            if tl.get(stat_key) is not None)
            team_totals.append(total)
        team_stat_form = ewa(team_totals) / league_avg_stat if team_totals and league_avg_stat > 0 else 1.0

        # 7. opp_defense_ratio: EWA(opponent allowed for stat, last 10) / league_avg
        opp_allowed_totals = []
        opp_game_dates = set()
        for (opp, gd), logs in logs_by_opp_date.items():
            if opp == player_opp_code and gd < game_date:
                opp_game_dates.add(gd)

        opp_dates_sorted = sorted(opp_game_dates)[-10:]
        for gd in opp_dates_sorted:
            team_logs = logs_by_opp_date.get((player_opp_code, gd), [])
            if market in COMBO_FORMULAS:
                combo_cols = COMBO_FORMULAS[market]
                total = sum(
                    sum(tl.get(c, 0) or 0 for c in combo_cols)
                    for tl in team_logs
                    if all(tl.get(c) is not None for c in combo_cols)
                )
            else:
                total = sum(tl.get(stat_key, 0) or 0 for tl in team_logs
                            if tl.get(stat_key) is not None)
            opp_allowed_totals.append(total)

        opp_defense_ratio = ewa(opp_allowed_totals) / league_avg_stat if opp_allowed_totals and league_avg_stat > 0 else 1.0

        # 8. projected_stat_opp_adj
        projected_stat_opp_adj = projected_stat * opp_defense_ratio

        # ─── E. Home/Away Splits ──────────────────────────────────────────
        player_team_name_lc = player_team.get(pid, "").lower()
        home = home_team.lower() if home_team else ""
        away = away_team.lower() if away_team else ""
        is_home = 1 if (player_team_name_lc and player_team_name_lc in home) else (
            0 if (player_team_name_lc and player_team_name_lc in away) else 0.5
        )
        is_home_bool = is_home == 1
        venue_games = []
        for g in prior_games:
            g_at_home = (player_team_name_lc, g["game_date"]) in home_games_set
            if g_at_home == is_home_bool:
                venue_games.append(g)

        if len(venue_games) >= 3:
            venue_stats = [(g.get(stat_key, 0) or 0) for g in venue_games[-10:] if g.get("minutes") and g["minutes"] > 0]
            venue_mins = [g["minutes"] for g in venue_games[-10:] if g.get("minutes") and g["minutes"] > 0]
            if venue_stats and venue_mins:
                venue_per_min_rates = [s / m for s, m in zip(venue_stats, venue_mins) if m > 0]
                home_away_per_min_rate = ewa(venue_per_min_rates) if venue_per_min_rates else blended_per_min_rate
            else:
                home_away_per_min_rate = blended_per_min_rate
        else:
            home_away_per_min_rate = blended_per_min_rate  # fallback to overall
        home_away_projected_stat = home_away_per_min_rate * expected_minutes

        # ─── Open/close lines (needed for target + bet metadata) ─────────
        open_line_val, close_line_val, open_over_price, open_under_price, close_over_price, close_under_price = \
            find_open_close_line(open_close, event_id, player_name, market)
        if open_line_val is None:
            open_line_val = line
            open_over_price = over_price
            open_under_price = under_price
            close_line_val = line
            close_over_price = over_price
            close_under_price = under_price

        # ─── Target ──────────────────────────────────────────────────────
        target = 1 if actual_stat > open_line_val else 0

        # ─── Feature vector ───────────────────────────────────────────────
        feature_vec = [
            # A. Expected Minutes / Role
            minutes_trend,
            expected_minutes,
            minute_share,
            role_stability,
            # B. Per-Minute Production
            per_min_trend,
            # C. Projected Stat
            projected_stat_opp_adj,
            # D. Team & Opponent Context
            team_stat_form,
            opp_defense_ratio,
            # E. Home/Away Splits
            home_away_per_min_rate,
            home_away_projected_stat,
        ]

        samples.append({
            "features": feature_vec,
            "target": target,
            "player": player_name, "date": game_date, "market": market,
            "line": line, "over_price": over_price, "under_price": under_price,
            "actual": actual_stat, "gn": 0, "injury": "",
            "close_line": close_line_val, "open_line": open_line_val,
            "open_over_price": open_over_price, "open_under_price": open_under_price,
            "close_over_price": close_over_price, "close_under_price": close_under_price,
            "position": name_to_pos.get(player_name.lower(), ""),
        })

    print(f"  Built {len(samples):,} samples")
    print(f"  Skips: {dict(skips)}")
    return samples, dict(skips)


# ─── Run ─────────────────────────────────────────────────────────────────────
def run(league):
    print(f"\n{'=' * 60}")
    print(f"GENERAL PROP MODEL G — {league.upper()} (Walk-Forward)")
    print(f"{'=' * 60}\n")

    data = load_all_data(league)
    if not data:
        return

    for train_book in ["fanduel", "draftkings"]:
        book_tag = train_book[:2]
        print(f"\n{'~' * 60}")
        print(f"  TRAIN BOOK: {train_book} (tag={book_tag})")
        print(f"{'~' * 60}")

        print("\nBuilding dataset (ALL players, top 8 EWA features)...")
        samples, skip_counts = build_dataset(data, league)
        if not samples:
            continue

        windows = WALK_FORWARD_WINDOWS.get(league, [])
        if not windows:
            print(f"No walk-forward windows defined for {league}")
            continue

        all_bets = []
        combined_acc = []
        combined_auc = []
        last_fi = None

        lgb_params = dict(
            n_estimators=300, max_depth=3, learning_rate=0.03,
            num_leaves=15, min_child_samples=50, subsample=0.8,
            colsample_bytree=0.7, reg_alpha=5.0, reg_lambda=5.0,
            random_state=42, verbose=-1,
        )

        for wi, window in enumerate(windows):
            season = window["season"]
            train = [s for s in samples if s["date"] < window["train_end"]]
            test = [s for s in samples
                    if s["date"] >= window["test_start"] and s["date"] < window["test_end"]]

            print(f"\n--- Window {wi + 1}: {season} ---")
            print(f"  Train: {len(train):,} (< {window['train_end']})  Test: {len(test):,}")

            if len(train) < 100:
                print("  Skipping: not enough training data")
                continue
            if not test:
                print("  Skipping: no test data")
                continue

            # Per-market training with CV feature selection
            all_markets = sorted(set(s["market"] for s in train) | set(s["market"] for s in test))
            window_y_test_all = []
            window_y_proba_all = []
            window_test_all = []

            for mkt in all_markets:
                mkt_train = [s for s in train if s["market"] == mkt]
                mkt_test = [s for s in test if s["market"] == mkt]
                if len(mkt_train) < 50 or not mkt_test:
                    if mkt_test:
                        print(f"    {mkt}: skipped ({len(mkt_train)} train)")
                    continue

                X_train_full = np.array([s["features"] for s in mkt_train])
                X_test_full = np.array([s["features"] for s in mkt_test])
                y_tr = np.array([s["target"] for s in mkt_train])
                y_te = np.array([s["target"] for s in mkt_test])

                # CV-based feature selection (from Model E)
                n_splits = min(5, max(2, int(sum(y_tr == 0)), int(sum(y_tr == 1))))
                if n_splits >= 2 and len(mkt_train) >= n_splits * 2:
                    cv = StratifiedKFold(n_splits=min(5, n_splits), shuffle=True, random_state=42)
                    cv_importances = np.zeros(len(FEATURES))
                    try:
                        for fold_train_idx, fold_val_idx in cv.split(X_train_full, y_tr):
                            fold_model = LGBMClassifier(**lgb_params)
                            fold_model.fit(X_train_full[fold_train_idx], y_tr[fold_train_idx])
                            cv_importances += fold_model.feature_importances_
                        cv_importances /= min(5, n_splits)
                        keep_mask = cv_importances >= 0.1
                    except Exception:
                        keep_mask = np.ones(len(FEATURES), dtype=bool)
                else:
                    keep_mask = np.ones(len(FEATURES), dtype=bool)

                kept_features = [f for f, k in zip(FEATURES, keep_mask) if k]
                X_train = X_train_full[:, keep_mask]
                X_test = X_test_full[:, keep_mask]

                mkt_model = LGBMClassifier(**lgb_params)
                mkt_model.fit(X_train, y_tr)

                y_pr = mkt_model.predict_proba(X_test)[:, 1]
                mkt_acc = accuracy_score(y_te, (y_pr > 0.5).astype(int))
                try:
                    mkt_auc = roc_auc_score(y_te, y_pr)
                except Exception:
                    mkt_auc = 0
                dropped = len(FEATURES) - len(kept_features)
                print(f"    {mkt}: train={len(mkt_train):,} test={len(mkt_test):,} "
                      f"acc={mkt_acc:.4f} auc={mkt_auc:.4f} kept={len(kept_features)}/{len(FEATURES)}")

                window_y_test_all.extend(y_te.tolist())
                window_y_proba_all.extend(y_pr.tolist())
                window_test_all.extend(mkt_test)

                last_fi = {n: int(i) for n, i in zip(kept_features, mkt_model.feature_importances_)}

            if not window_test_all:
                print("  No markets had enough data")
                continue

            y_test = np.array(window_y_test_all)
            y_proba = np.array(window_y_proba_all)

            acc = accuracy_score(y_test, (y_proba > 0.5).astype(int))
            try:
                auc = roc_auc_score(y_test, y_proba)
            except Exception:
                auc = 0
            print(f"  Combined: acc={acc:.4f} auc={auc:.4f}")
            combined_acc.append((acc, len(window_test_all)))
            combined_auc.append((auc, len(window_test_all)))

            window_bets = make_bets(window_test_all, y_proba, "general_g", season)
            wins = sum(1 for b in window_bets if b["correct"])
            pnl = sum(b["pnl"] for b in window_bets)
            if window_bets:
                print(f"  Bets: {len(window_bets):,}  Win: {wins / len(window_bets) * 100:.1f}%  "
                      f"ROI: {pnl / len(window_bets) * 100:+.1f}%  PnL: {pnl:+.1f}u")
            all_bets.extend(window_bets)

        if not all_bets:
            print("No bets!")
            continue

        total_test = sum(n for _, n in combined_acc)
        avg_acc = sum(a * n for a, n in combined_acc) / total_test if total_test > 0 else 0
        avg_auc = sum(a * n for a, n in combined_auc) / total_test if total_test > 0 else 0
        total = len(all_bets)
        wins = sum(1 for b in all_bets if b["correct"])
        pnl = sum(b["pnl"] for b in all_bets)

        print(f"\n{'=' * 60}")
        print(f"RESULTS ({train_book}): {total:,} bets, Win: {wins / total * 100:.1f}%, "
              f"ROI: {pnl / total * 100:+.1f}%, PnL: {pnl:+.1f}u")
        print(f"Accuracy: {avg_acc:.4f}, AUC: {avg_auc:.4f}")
        print(f"{'=' * 60}")

        if last_fi:
            print(f"\nFeature importance (last window):")
            for name, imp in sorted(last_fi.items(), key=lambda x: -x[1]):
                print(f"  {name:30s} {imp:6d}")

        # By season
        by_season = defaultdict(list)
        for b in all_bets:
            by_season[b.get("season", "unknown")].append(b)
        print(f"\nBy Season:")
        for s in sorted(by_season):
            s_bets = by_season[s]
            sw = sum(1 for b in s_bets if b["correct"])
            sp = sum(b["pnl"] for b in s_bets)
            print(f"  {s}: {len(s_bets):,} bets  Win: {sw / len(s_bets) * 100:.1f}%  "
                  f"ROI: {sp / len(s_bets) * 100:+.1f}%  PnL: {sp:+.1f}u")

        # Build results + summary
        league_key = f"{league}_general_g_{book_tag}"
        results = {
            "league": league, "model": "general_g",
            "train_book": train_book,
            "total_bets": total,
            "skip_counts": skip_counts,
            "accuracy": round(avg_acc, 4), "auc": round(avg_auc, 4),
            "features": FEATURES,
            "feature_importance": last_fi or {},
            "bets": all_bets,
            "seasons": list(by_season.keys()),
        }

        # Compute summary with by_market_{mode}_ev{X}_gn{Y} keys
        print("\nComputing summary...")
        summary = compute_summary(results)

        out = f"/workspace/back-in-play/data/general_g_{league}_{book_tag}.json"
        with open(out, "w") as f:
            json.dump(results, f)
        print(f"Saved to {out}")

        # Upload results + summary to Supabase
        try:
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


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--league", required=True)
    args = parser.parse_args()
    run(args.league)
