#!/usr/bin/env python3
"""
Model H: Anti-overfit model with stability-focused features.

Design principles (from GPT audit):
  1. Signal quality > feature quantity
  2. Aggregated stability features > raw per-game features
  3. Sample-size-aware reliability weighting
  4. Noise feature test: random column included, any real feature
     with importance <= noise gets dropped, then retrain
  5. Very strict LightGBM: depth=2, leaves=4, min_child=100, reg=10

Features (10 max, auto-pruned):
  - open_implied_over_prob: market's view (strongest single predictor)
  - line_vs_baseline: prop line / pre-injury baseline
  - early_recovery_effect: avg stat ratio G1-3 vs baseline (aggregated, not per-game)
  - consistency_score: 1 - CV of post-return stats (higher = more predictable)
  - reliable_curve_pct: curve_pct × min(sample_size/200, 1) — discounts small samples
  - form_momentum: trend in last 3 games (slope direction)
  - minutes_recovery_pct: post-return avg minutes / pre-injury minutes
  - market_line_vs_consensus: (prop_line - books_avg) / books_spread
  - recovery_phase: 0=early(G1-3), 1=mid(G4-6), 2=late(G7-10)
  - stat_volatility: stddev of pre-injury stat / baseline (normalized noise level)
  - _noise: random feature for overfitting detection (auto-removed after test)

Usage:
  python3 regression_v8_model_h.py --league nba
"""

import os, sys, json, math, statistics, argparse, pathlib, pickle, random
from collections import defaultdict
from datetime import datetime, timedelta, timezone
import numpy as np
from lightgbm import LGBMClassifier
from sklearn.metrics import accuracy_score, roc_auc_score
from supabase import create_client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
sb = create_client(SUPABASE_URL, SUPABASE_KEY)

MARKET_TO_STAT = {
    # NBA
    "player_points": "stat_pts", "player_rebounds": "stat_reb", "player_assists": "stat_ast",
    "player_steals": "stat_stl", "player_blocks": "stat_blk",
    # NFL
    "player_pass_yds": "stat_pass_yds", "player_rush_yds": "stat_rush_yds",
    "player_receptions": "stat_rec", "player_reception_yds": "stat_rec_yds",
    "player_pass_tds": "stat_pass_td", "player_rush_attempts": "stat_rush_att",
    "player_anytime_td": "stat_rush_td", "player_pass_completions": "stat_pass_comp",
    # NHL / EPL
    "player_goals": "stat_goals", "player_goal_scorer_anytime": "stat_goals",
    "player_shots_on_goal": "stat_sog", "player_shots": "stat_total_shots",  # fixed: total shots not SOG. REMOVED was: — total shots ≠ stat_sog (shots on goal)
   "player_shots_on_target": "stat_sog", 
    "player_assists_ice_hockey": "stat_assists",
    # MLB
    "batter_hits": "stat_h", "batter_rbis": "stat_rbi", "batter_total_bases": "stat_stl",
    "batter_home_runs": "stat_hr", "batter_runs_scored": "stat_r",
    "batter_stolen_bases": "stat_sb",
    "pitcher_strikeouts": "stat_k", "pitcher_outs": "stat_ip",
    # NBA combos (computed in build_dataset)
    "player_threes": "stat_3pm",  # placeholder - computed below
    "player_points_rebounds_assists": "stat_pts",  # placeholder - computed below
    "player_points_rebounds": "stat_pts",  # placeholder - computed below
    "player_points_assists": "stat_pts",  # placeholder - computed below
    "player_rebounds_assists": "stat_reb",  # placeholder - computed below
    # NFL
    "player_pass_attempts": "stat_pass_att",
    # NHL
    # "player_blocked_shots": REMOVED — blocked shots ≠ stat_sog
}

# League-specific overrides applied at runtime
NHL_MARKET_OVERRIDES = {
    "player_points": "stat_goals",  # NHL points = goals+assists, use goals as stat_key
    "player_assists": "stat_assists",  # NHL uses stat_assists not stat_ast
}
EPL_MARKET_OVERRIDES = {
    "player_assists": "stat_assists",  # EPL uses stat_assists not stat_ast
}

LEAGUE_IDS = {
    "nba": "2aa180e9-a7c2-4d08-a1d8-a16152827b5d",
    "nfl": "0fea41a7-250e-40bf-9220-97853a69b6d7",
    "nhl": "0894f8ac-c744-4b58-9023-20c514f64fff",
    "mlb": "312485db-3c4a-4f83-b4b0-c761e114d870",
    "premier-league": "759cf693-7e15-4ea5-a3ed-ff9fd7d6bbb0",
}

HOLDOUT_STARTS = {
    "nba": "2024-10-22", "nhl": "2024-10-22", "nfl": "2023-10-15",
    "mlb": "2024-07-15", "premier-league": "2024-05-10",
}

HAS_MINUTES = {"nba", "nfl", "nhl"}

FEATURES_INITIAL = [
    # Model H: stability-focused, auto-pruned via noise test
    "open_implied_over_prob",   # market's implied probability
    "line_vs_baseline",         # prop_line / pre_injury_baseline
    "early_recovery_effect",    # avg(G1-G3 stat / baseline), aggregated window
    "consistency_score",        # 1 - CV of post-return stats (0=chaotic, 1=stable)
    "reliable_curve_pct",       # curve_pct × min(sample_size/200, 1)
    "form_momentum",            # slope of last 3 post-return games
    "minutes_recovery_pct",     # post avg minutes / pre avg minutes
    "market_line_vs_consensus", # (line - books_avg) / max(books_spread, 0.5)
    "recovery_phase",           # 0=G1-3, 1=G4-6, 2=G7-10
    "stat_volatility",          # pre-injury stddev / baseline (normalized noise)
    "_noise",                   # random noise for overfitting detection
]
# After noise test, _noise and any feature weaker than it are dropped
FEATURES = list(FEATURES_INITIAL)  # will be pruned at runtime









def build_name_index(players_raw):
    """Build name-to-id mapping. Returns (name_to_id, norm_to_id, name_to_all_ids).
    name_to_all_ids maps each lowercase name to ALL matching player_ids (for dedup)."""
    import re as _re
    import unicodedata as _ud
    name_to_id = {}
    name_to_all_ids = {}  # name -> [pid1, pid2, ...]
    for p in players_raw:
        key = p["player_name"].lower()
        name_to_id[key] = p["player_id"]
        name_to_all_ids.setdefault(key, []).append(p["player_id"])
    
    def _normalize(name):
        name = name.lower().strip()
        name = _re.sub(r"\s+total$", "", name)  # strip " Total" suffix
        name = _re.sub(r"\s*\([^)]+\)", "", name)  # strip (BAL) etc.
        name = _ud.normalize("NFD", name)
        name = "".join(c for c in name if _ud.category(c) != "Mn")
        name = _re.sub(r"\s+(jr\.?|sr\.?|iii|ii|iv)$", "", name)
        name = _re.sub(r"\.(?=\s|[A-Za-z])", "", name)
        name = _re.sub(r"\s+", " ", name)
        return name
    
    norm_to_id = {}
    for p in players_raw:
        norm = _normalize(p["player_name"])
        if norm not in norm_to_id:
            norm_to_id[norm] = p["player_id"]
    
    # Build additional fuzzy lookup: reversed names, suffix variants, accent-stripped
    def _strip_accents(s):
        s = _ud.normalize("NFD", s)
        return "".join(c for c in s if _ud.category(c) != "Mn")
    
    fuzzy_to_id = {}
    for p in players_raw:
        name = p["player_name"].lower().strip()
        pid = p["player_id"]
        
        # Accent-stripped
        stripped = _strip_accents(name)
        if stripped != name and stripped not in fuzzy_to_id:
            fuzzy_to_id[stripped] = pid
        
        # Without Jr./Sr./III etc
        no_suffix = _re.sub(r"\s+(jr\.?|sr\.?|iii|ii|iv)$", "", name)
        if no_suffix != name and no_suffix not in fuzzy_to_id:
            fuzzy_to_id[no_suffix] = pid
        
        # With Jr. added
        if not _re.search(r"(jr\.?|sr\.?|iii|ii|iv)$", name):
            for suffix in ["jr.", "jr"]:
                variant = f"{name} {suffix}"
                if variant not in fuzzy_to_id:
                    fuzzy_to_id[variant] = pid
        
        # " total" variant (NHL multi-team aggregates)
        total_name = f"{name} total"
        if total_name not in fuzzy_to_id:
            fuzzy_to_id[total_name] = pid

        # Reversed name (last first -> first last)
        parts = name.split()
        if len(parts) == 2:
            reversed_name = f"{parts[1]} {parts[0]}"
            if reversed_name not in fuzzy_to_id:
                fuzzy_to_id[reversed_name] = pid
        
        # P.J. -> pj, P.J -> pj etc
        no_dots = name.replace(".", "")
        if no_dots != name and no_dots not in fuzzy_to_id:
            fuzzy_to_id[no_dots] = pid
        
        # Combined: accent-stripped + no-suffix
        combo = _strip_accents(no_suffix)
        if combo not in fuzzy_to_id:
            fuzzy_to_id[combo] = pid
    
    return name_to_id, norm_to_id, name_to_all_ids, fuzzy_to_id

def resolve_player(player_name, name_to_id, norm_to_id, fuzzy_to_id=None):
    """Try exact match, then normalized (accent-stripped, suffix-stripped) match."""
    import re as _re
    import unicodedata as _ud
    pid = name_to_id.get(player_name.lower())
    if pid:
        return pid
    
    def _normalize(name):
        name = name.lower().strip()
        name = _re.sub(r"\s+total$", "", name)  # strip " Total" suffix
        name = _re.sub(r"\s*\([^)]+\)", "", name)  # strip (BAL) etc.
        name = _ud.normalize("NFD", name)
        name = "".join(c for c in name if _ud.category(c) != "Mn")
        name = _re.sub(r"\s+(jr\.?|sr\.?|iii|ii|iv)$", "", name)
        name = _re.sub(r"\.(?=\s|[A-Za-z])", "", name)
        name = name.replace("\u2019", "'").replace("\u2018", "'")  # curly quotes
        name = _re.sub(r"\s+", " ", name)
        return name
    
    pid = norm_to_id.get(_normalize(player_name))
    if pid:
        return pid
    # Fuzzy fallbacks
    return fuzzy_to_id.get(_normalize(player_name)) if fuzzy_to_id else None

def med(arr):
    return statistics.median(arr) if arr else 0

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
        if len(data) < batch: break
        offset += batch
    return all_data

def load_props_from_files(league):
    data_dir = pathlib.Path(f"/workspace/back-in-play/data/historical_props/{league}")
    if not data_dir.exists(): return [], {}, {}
    all_props = []
    open_close = {}
    multi_book = defaultdict(list)  # (player, market, date) -> list of lines

    for date_dir in sorted(data_dir.iterdir()):
        if not date_dir.is_dir(): continue
        for f in date_dir.glob("*.json"):
            if f.name.startswith("open_close_"):
                try:
                    oc = json.loads(f.read_text())
                    open_close[oc["event_id"]] = oc
                except: pass
            else:
                try:
                    props = json.loads(f.read_text())
                    for p in props:
                        key = (p.get("player_name","").lower(), p.get("market",""), p.get("game_date",""))
                        multi_book[key].append(p.get("line", 0))
                    all_props.extend(props)
                except: pass
    return all_props, open_close, multi_book

def odds_to_implied_prob(odds):
    if odds is None: return 0.5
    odds = float(odds)
    if odds > 0: return 100 / (odds + 100)
    return abs(odds) / (abs(odds) + 100)

def odds_to_profit(odds):
    odds = float(odds)
    if odds > 0: return odds / 100
    return 100 / abs(odds)

def odds_to_implied_prob(american_odds):
    """Convert American odds to implied probability (vig-included)."""
    if american_odds is None: return None
    american_odds = float(american_odds)
    if american_odds >= 100:
        return 100 / (american_odds + 100)
    else:
        return (-american_odds) / (-american_odds + 100)

def load_all_data(league):
    league_id = LEAGUE_IDS[league]
    print("Loading props + open/close data...")
    props, open_close, multi_book = load_props_from_files(league)
    print(f"  {len(props):,} props, {len(open_close):,} open/close, {len(multi_book):,} multi-book keys")

    # Prefer DraftKings, require both over_price and under_price
    PREFERRED_BOOKS = ["draftkings", "fanduel"]
    def book_rank(p):
        b = (p.get("bookmaker") or "").lower()
        has_both = 0 if (p.get("over_price") is not None and p.get("under_price") is not None) else 1
        try: brank = PREFERRED_BOOKS.index(b)
        except ValueError: brank = 99
        return (has_both, brank)
    seen = {}
    for p in props:
        key = f"{p.get('player_name','')}|{p.get('market','')}|{p.get('game_date','')}"
        if key not in seen or book_rank(p) < book_rank(seen[key]):
            seen[key] = p
    # Drop props missing either side
    props = [p for p in seen.values() if p.get("over_price") is not None and p.get("under_price") is not None]
    print(f"  {len(props):,} after dedup (preferred books, both sides required)")

    print("Loading players...")
    # Load team names for is_home determination
    teams_raw = paginate("back_in_play_teams", "team_id, team_name",
                         filters=[("eq", ("league_id", league_id))])
    team_names = {t["team_id"]: t["team_name"] for t in teams_raw}
    players_raw = paginate("back_in_play_players", "player_id, player_name",
                          filters=[("eq", ("league_id", league_id))])
    name_to_id, norm_to_id, name_to_all_ids, fuzzy_to_id = build_name_index(players_raw)

    print("Loading injuries...")
    all_injuries = []
    player_ids = list(set(pid for pids in name_to_all_ids.values() for pid in pids))
    chunk_size = 10 if len(player_ids) > 2000 else 50
    for i in range(0, len(player_ids), chunk_size):
        chunk = player_ids[i:i+chunk_size]
        data = paginate("back_in_play_injuries",
                       "player_id, injury_type, date_injured, return_date, status",
                       filters=[("in_", ("player_id", chunk))],
                       order_col="date_injured")
        all_injuries.extend(data)
    injuries_by_player = defaultdict(list)
    for inj in all_injuries:
        injuries_by_player[inj["player_id"]].append(inj)
    for pid in injuries_by_player:
        injuries_by_player[pid].sort(key=lambda x: x["date_injured"])
    print(f"  {len(all_injuries):,} injuries")

    print("Loading game logs...")
    # Only load logs for players who appear in props AND have injuries (saves RAM for MLB)
    prop_names = set(p.get("player_name", "").lower() for p in props)
    prop_pids = set()
    for name in prop_names:
        pid = name_to_id.get(name) or norm_to_id.get(name)
        if pid:
            prop_pids.add(pid)
    injured_pids = set(injuries_by_player.keys())
    relevant_pids = list(prop_pids & injured_pids) if prop_pids and injured_pids else player_ids
    print(f"  Filtered to {len(relevant_pids):,} players with props+injuries (of {len(player_ids):,} total)")
    all_logs = []
    chunk_size = 10 if len(relevant_pids) > 2000 else 50
    for i in range(0, len(relevant_pids), chunk_size):
        chunk = relevant_pids[i:i+chunk_size]
        data = paginate("back_in_play_player_game_logs",
                       "player_id, game_date, minutes, stat_pts, stat_reb, stat_ast, stat_rush_yds, stat_pass_yds, stat_rec, stat_rec_yds, stat_goals, stat_sog, stat_h, stat_rbi, stat_stl, stat_3pm, stat_blk, stat_r, stat_sb, stat_k, stat_ip, stat_hr, stat_pass_td, stat_rush_td, stat_assists, stat_pass_comp, stat_pass_att, stat_rush_att, stat_total_shots",
                       filters=[("in_", ("player_id", chunk))],
                       order_col="game_date")
        all_logs.extend(data)
    logs_by_player = defaultdict(list)
    for g in all_logs:
        logs_by_player[g["player_id"]].append(g)
    for pid in logs_by_player:
        logs_by_player[pid].sort(key=lambda x: x["game_date"])
    print(f"  {len(all_logs):,} game logs (raw)")

    # Merge game logs from duplicate player IDs into the canonical ID
    merge_count = 0
    for name, pids in name_to_all_ids.items():
        if len(pids) <= 1:
            continue
        # Canonical ID = the one name_to_id resolved to
        canonical = name_to_id.get(name)
        if not canonical:
            continue
        # Merge all logs from other IDs into canonical, deduped by game_date
        existing_dates = {g["game_date"] for g in logs_by_player.get(canonical, [])}
        for pid in pids:
            if pid == canonical:
                continue
            for g in logs_by_player.get(pid, []):
                if g["game_date"] not in existing_dates:
                    g_copy = dict(g)
                    g_copy["player_id"] = canonical
                    logs_by_player[canonical].append(g_copy)
                    existing_dates.add(g["game_date"])
                    merge_count += 1
        # Re-sort
        if canonical in logs_by_player:
            logs_by_player[canonical].sort(key=lambda x: x["game_date"])
    print(f"  Merged {merge_count:,} game logs from {len([n for n, p in name_to_all_ids.items() if len(p) > 1]):,} duplicate names")

    # Also merge injuries from duplicate IDs
    for name, pids in name_to_all_ids.items():
        if len(pids) <= 1:
            continue
        canonical = name_to_id.get(name)
        if not canonical:
            continue
        existing_dates = {inj["date_injured"] for inj in injuries_by_player.get(canonical, [])}
        for pid in pids:
            if pid == canonical:
                continue
            for inj in injuries_by_player.get(pid, []):
                if inj["date_injured"] not in existing_dates:
                    inj_copy = dict(inj)
                    inj_copy["player_id"] = canonical
                    injuries_by_player[canonical].append(inj_copy)
                    existing_dates.add(inj["date_injured"])
        if canonical in injuries_by_player:
            injuries_by_player[canonical].sort(key=lambda x: x["date_injured"])

    print("Loading curves...")
    curves_raw = paginate("back_in_play_holdout_curves", "*",
                         filters=[("eq", ("league_slug", league))])
    if not curves_raw:
        curves_raw = paginate("back_in_play_performance_curves", "*",
                             filters=[("eq", ("league_slug", league))])
    curve_map = {}
    for c in curves_raw:
        for key in ("stat_median_pct", "median_pct_recent"):
            if isinstance(c.get(key), str): c[key] = json.loads(c[key])
        curve_map[c["injury_type_slug"]] = c
    print(f"  {len(curve_map)} curves")

    print("Loading game odds...")
    # Merge: file odds as base, DB odds override

    return {
        "props": props, "open_close": open_close, "multi_book": multi_book,
        "name_to_id": name_to_id, "norm_to_id": norm_to_id, "fuzzy_to_id": fuzzy_to_id, "team_names": team_names, "players_raw": players_raw, "injuries_by_player": injuries_by_player,
        "logs_by_player": logs_by_player, "curve_map": curve_map,
    }

def find_open_close_line(open_close, event_id, player_name, market):
    oc = open_close.get(event_id)
    if not oc: return None, None, None, None, None, None
    pn = player_name.lower()
    def find_props(pl):
        over_line, over_price, under_price = None, None, None
        for p in pl:
            if p["player_name"].lower() == pn and p["market"] == market:
                if p["side"] == "Over":
                    over_line = p["line"]
                    over_price = p.get("price")
                elif p["side"] == "Under":
                    under_price = p.get("price")
        return over_line, over_price, under_price
    ol, oop, oup = find_props(oc.get("open_props", []))
    cl, cop, cup = find_props(oc.get("close_props", []))
    return ol, cl, oop, oup, cop, cup

def date_diff(d1, d2):
    try:
        return (datetime.strptime(d2, "%Y-%m-%d") - datetime.strptime(d1, "%Y-%m-%d")).days
    except: return 0

def build_dataset(data, league):
    props = data["props"]
    open_close = data["open_close"]
    multi_book = data["multi_book"]
    name_to_id = data["name_to_id"]
    norm_to_id = data["norm_to_id"]
    fuzzy_to_id = data.get("fuzzy_to_id", {})
    team_names = data.get("team_names", {})
    player_team = {}
    for p in data.get("players_raw", []):
        player_team[p["player_id"]] = team_names.get(p.get("team_id"), "")
    injuries_by_player = data["injuries_by_player"]
    logs_by_player = data["logs_by_player"]
    curve_map = data["curve_map"]

    samples = []
    skips = defaultdict(int)

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
            skips["missing"] += 1; continue
        stat_key = MARKET_TO_STAT.get(market)
        # Apply league-specific overrides
        if league == "nhl" and market in NHL_MARKET_OVERRIDES:
            stat_key = NHL_MARKET_OVERRIDES[market]
        elif league == "premier-league" and market in EPL_MARKET_OVERRIDES:
            stat_key = EPL_MARKET_OVERRIDES[market]
        if not stat_key:
            skips["unknown_market"] += 1; continue
        pid = resolve_player(player_name, name_to_id, norm_to_id, fuzzy_to_id)
        if not pid:
            skips["no_player"] += 1; continue

        all_games = logs_by_player.get(pid, [])
        min_games = 2 if league == "nfl" else 5
        if len(all_games) < min_games:
            skips["few_games"] += 1; continue

        player_injuries = injuries_by_player.get(pid, [])
        relevant_injury = None
        injury_count = 0
        # Look back up to 12 months for relevant injuries
        _gd_year = int(game_date[:4])
        _gd_month = int(game_date[5:7])
        _lb_year = _gd_year - 1 if _gd_month <= 6 else _gd_year
        season_start = f"{_lb_year}-01-01"

        for inj in player_injuries:
            if inj["date_injured"] < game_date and inj["date_injured"] >= season_start:
                injury_count += 1
            if (inj.get("return_date") and inj["return_date"] <= game_date
                and inj["date_injured"] < game_date):
                relevant_injury = inj

        if not relevant_injury:
            skips["no_injury"] += 1; continue

        injury_slug = relevant_injury["injury_type"].lower().replace(" ", "-").replace("/", "-")
        injury_slug = "-".join(w for w in injury_slug.split("-") if w)

        post_games = [g for g in all_games
                     if g["game_date"] > relevant_injury.get("return_date", relevant_injury["date_injured"])
                     and g["game_date"] <= game_date]
        post_games.sort(key=lambda x: x["game_date"])

        if not post_games:
            skips["no_post_games"] += 1; continue
        game_number = len(post_games)
        max_games_back = 10
        if game_number > max_games_back:
            skips["too_far_back"] += 1; continue

        actual_game = next((g for g in post_games if g["game_date"] == game_date), None)

        if not actual_game:
            skips["no_actual"] += 1; continue

        # Compute combo stats
        COMBO_FORMULAS = {
            "player_points_rebounds_assists": ["stat_pts", "stat_reb", "stat_ast"],
            "player_points_rebounds": ["stat_pts", "stat_reb"],
            "player_points_assists": ["stat_pts", "stat_ast"],
            "player_rebounds_assists": ["stat_reb", "stat_ast"],
            "player_threes": ["stat_3pm"],
        }
        # NHL: player_points = goals + assists (not stat_pts)
        if league in ("nhl", "premier-league") and market == "player_points":
            COMBO_FORMULAS["player_points"] = ["stat_goals", "stat_assists"]
        if market in COMBO_FORMULAS:
            combo_cols = COMBO_FORMULAS[market]
            if all(actual_game.get(c) is not None for c in combo_cols):
                actual_stat = sum(actual_game[c] for c in combo_cols)
            else:
                skips["no_actual"] += 1; continue
        else:
            actual_stat = actual_game.get(stat_key)
        if actual_stat is None:
            skips["no_actual"] += 1; continue
        if actual_stat == line:
            skips["push"] += 1; continue

        pre_games = sorted([g for g in all_games if g["game_date"] < relevant_injury["date_injured"]],
                          key=lambda x: x["game_date"], reverse=True)
        if market in COMBO_FORMULAS:
            combo_cols = COMBO_FORMULAS[market]
            pre_stats = [sum(g.get(c, 0) or 0 for c in combo_cols) for g in pre_games[:10]
                        if all(g.get(c) is not None for c in combo_cols)]
        else:
            pre_stats = [g[stat_key] for g in pre_games[:10] if g.get(stat_key) is not None]
        min_pre = 1 if league == "nfl" else 3
        if len(pre_stats) < min_pre:
            skips["few_pre_stats"] += 1; continue

        pre_baseline = statistics.median(pre_stats)
        pre_std = statistics.stdev(pre_stats) if len(pre_stats) >= 3 else 0
        pre_min_list = [g["minutes"] for g in pre_games[:10] if g.get("minutes") and g["minutes"] > 0]
        pre_minutes = statistics.median(pre_min_list) if pre_min_list else 0

        season_games = [g for g in all_games if g["game_date"] >= season_start and g["game_date"] < game_date]
        if market in COMBO_FORMULAS:
            season_stats = [sum(g.get(c, 0) or 0 for c in COMBO_FORMULAS[market]) for g in season_games
                           if all(g.get(c) is not None for c in COMBO_FORMULAS[market])]
        else:
            season_stats = [g[stat_key] for g in season_games if g.get(stat_key) is not None]
        season_avg = statistics.mean(season_stats) if season_stats else pre_baseline
        season_min = [g["minutes"] for g in season_games if g.get("minutes") and g["minutes"] > 0]
        season_avg_min = statistics.mean(season_min) if season_min else pre_minutes

        prior_games = post_games[:-1]
        post_stats = [g[stat_key] for g in prior_games if g.get(stat_key) is not None]
        post_avg_stat = statistics.mean(post_stats) if post_stats else 0
        post_min = [g["minutes"] for g in prior_games if g.get("minutes") and g["minutes"] > 0]
        post_avg_min = statistics.mean(post_min) if post_min else 0

        min_ratio = post_avg_min / pre_minutes if pre_minutes > 0 and post_avg_min > 0 else 1.0
        form_ratio = post_avg_stat / pre_baseline if pre_baseline > 0 and post_avg_stat > 0 else 1.0

        curve = curve_map.get(injury_slug)
        curve_pct = 1.0
        if curve:
            medians = curve.get("stat_median_pct") or {}
            g_idx = min(max(game_number - 1, 0), 9)
            pct = medians.get(str(g_idx))
            if pct is not None: curve_pct = pct

        open_line, close_line, open_over_price, open_under_price, close_over_price, close_under_price = find_open_close_line(open_close, event_id, player_name, market)

        # NEW: days missed
        days_missed = date_diff(relevant_injury["date_injured"],
                               relevant_injury.get("return_date", game_date))

        # NEW: rest days (days since last game)
        prev_game_date = prior_games[-1]["game_date"] if prior_games else relevant_injury.get("return_date", game_date)
        rest_days = date_diff(prev_game_date, game_date)

        # NEW: is_home (check if player's team is home — heuristic: check if name matches home/away)
        player_team_name = player_team.get(pid, "").lower()
        home = home_team.lower() if home_team else ""
        away = away_team.lower() if away_team else ""
        is_home = 1 if (player_team_name and player_team_name in home) else (0 if (player_team_name and player_team_name in away) else 0.5)  # default unknown

        # NEW: multi-book consensus
        mb_key = (player_name.lower(), market, game_date)
        book_lines = multi_book.get(mb_key, [line])
        books_avg = statistics.mean(book_lines) if book_lines else line
        books_spread = max(book_lines) - min(book_lines) if len(book_lines) > 1 else 0

        impl_over = odds_to_implied_prob(over_price)

        # Fall back to scraped line if no open/close data available
        if open_line is None:
            open_line = line
            open_over_price = over_price
            open_under_price = under_price
            close_line = line
            close_over_price = over_price
            close_under_price = under_price

        open_impl_over = odds_to_implied_prob(open_over_price) if open_over_price else impl_over
        # Close-odds features
        close_impl_over = odds_to_implied_prob(close_over_price) if close_over_price else open_impl_over
        impl_prob_delta = close_impl_over - open_impl_over
        line_delta = (close_line - open_line) if close_line is not None and open_line is not None else 0.0



        if actual_stat is None or open_line is None:
            continue
        target = 1 if actual_stat > open_line else 0

        # ── Model H: stability-focused feature construction ──

        # 1. line_vs_baseline: how the line compares to player's established level
        line_vs_baseline = open_line / pre_baseline if pre_baseline > 0 else 1.0

        # 2. early_recovery_effect: average stat ratio for G1-3 (aggregated window)
        early_games = [g for g in prior_games[:3]]  # first 3 post-return games
        if market in COMBO_FORMULAS:
            combo_cols = COMBO_FORMULAS[market]
            early_stats = [sum(g.get(c, 0) or 0 for c in combo_cols) for g in early_games
                          if all(g.get(c) is not None for c in combo_cols)]
        else:
            early_stats = [g[stat_key] for g in early_games if g.get(stat_key) is not None]
        # Shrink early_recovery by reliability so noisy small-sample curves are dampened
        curve_sample_size = curve.get("sample_size", 0) if curve else 0
        reliability = min(curve_sample_size / 200, 1.0)
        raw_early_recovery = (statistics.mean(early_stats) / pre_baseline) if early_stats and pre_baseline > 0 else curve_pct
        early_recovery = raw_early_recovery * reliability + 1.0 * (1 - reliability)  # blend toward neutral when unreliable

        # 3. consistency_score: 1 - CV of post-return stats (higher = more predictable)
        #    Clipped to [0, 1] — CV is unstable when mean is small
        if market in COMBO_FORMULAS:
            combo_cols = COMBO_FORMULAS[market]
            all_post_stats = [sum(g.get(c, 0) or 0 for c in combo_cols) for g in prior_games
                             if all(g.get(c) is not None for c in combo_cols)]
        else:
            all_post_stats = [g[stat_key] for g in prior_games if g.get(stat_key) is not None]
        if len(all_post_stats) >= 2 and statistics.mean(all_post_stats) > 0.5:  # require meaningful mean
            cv = min(statistics.stdev(all_post_stats) / statistics.mean(all_post_stats), 2.0)  # cap CV at 2
            consistency = max(0.0, min(1.0, 1 - cv))
        else:
            consistency = 0.5  # unknown — neutral

        # 4. reliable_curve_pct: curve_pct weighted by sample size reliability
        reliable_curve_pct = curve_pct * reliability + (1.0 - reliability) * 1.0  # blend toward 1.0 when unreliable

        # 5. form_momentum: slope of last 3 post-return games
        momentum_games = prior_games[-3:] if len(prior_games) >= 3 else prior_games
        if market in COMBO_FORMULAS:
            combo_cols = COMBO_FORMULAS[market]
            momentum_stats = [sum(g.get(c, 0) or 0 for c in combo_cols) for g in momentum_games
                             if all(g.get(c) is not None for c in combo_cols)]
        else:
            momentum_stats = [g[stat_key] for g in momentum_games if g.get(stat_key) is not None]
        if len(momentum_stats) >= 2 and pre_baseline > 0:
            # Simple slope: last - first, normalized by baseline
            form_momentum = (momentum_stats[-1] - momentum_stats[0]) / pre_baseline
        else:
            form_momentum = 0.0

        # 6. minutes_recovery_pct
        minutes_recovery = post_avg_min / pre_minutes if pre_minutes > 0 and post_avg_min > 0 else 1.0

        # 7. market_line_vs_consensus
        line_vs_consensus = (open_line - books_avg) / max(books_spread, 0.5) if books_spread > 0 else 0.0

        # 8. recovery_phase: bucketed
        recovery_phase = 0 if game_number <= 3 else (1 if game_number <= 6 else 2)

        # 9. stat_volatility: pre-injury stddev normalized by baseline
        stat_volatility = pre_std / pre_baseline if pre_baseline > 0 else 0.25

        # 10. _noise: random value for overfitting detection
        noise_val = random.gauss(0, 1)

        feature_vec = [
            open_impl_over,         # open_implied_over_prob
            line_vs_baseline,       # line_vs_baseline
            early_recovery,         # early_recovery_effect
            consistency,            # consistency_score
            reliable_curve_pct,     # reliable_curve_pct
            form_momentum,          # form_momentum
            minutes_recovery,       # minutes_recovery_pct
            line_vs_consensus,      # market_line_vs_consensus
            recovery_phase,         # recovery_phase
            stat_volatility,        # stat_volatility
            noise_val,              # _noise (removed after test)
        ]

        samples.append({
            "features": feature_vec,
            "target": target,
            "player": player_name, "date": game_date, "market": market,
            "line": line, "over_price": over_price, "under_price": under_price,
            "actual": actual_stat, "gn": game_number, "injury": injury_slug,
            "close_line": close_line, "open_line": open_line,
            "open_over_price": open_over_price, "open_under_price": open_under_price,
            "close_over_price": close_over_price, "close_under_price": close_under_price,
        })

    print(f"  Built {len(samples):,} samples")
    print(f"  Skips: {dict(skips)}")
    return samples, dict(skips)


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

def make_bets(test_samples, y_proba, model_name, season_label):
    """Generate bet list from test samples and model predictions."""
    bets = []
    for i, s in enumerate(test_samples):
        p_over = float(y_proba[i])
        p_under = 1 - p_over

        open_over_price = s.get("open_over_price") or s.get("over_price")
        open_under_price = s.get("open_under_price") or s.get("under_price")
        if open_over_price is None:
            continue
        if open_under_price is None:
            continue  # skip props without real under price

        over_profit = odds_to_profit(open_over_price)
        under_profit = odds_to_profit(open_under_price)
        ev_over = p_over * over_profit - p_under
        ev_under = p_under * under_profit - p_over

        if ev_over > ev_under and ev_over * 100 >= 0:
            side, ev = "OVER", ev_over
        elif ev_under * 100 >= 0:
            side, ev = "UNDER", ev_under
        else:
            continue

        open_line = s.get("open_line") or s["line"]
        open_actual_side = "OVER" if s["actual"] > open_line else "UNDER"
        if s["actual"] == open_line:
            continue
        correct = side == open_actual_side
        open_pnl_val = odds_to_profit(open_over_price if side == "OVER" else open_under_price) if correct else -1

        scrape_actual_side = "OVER" if s["actual"] > s["line"] else "UNDER"
        scrape_correct = side == scrape_actual_side if s["actual"] != s["line"] else None
        scrape_pnl = None
        if scrape_correct is not None and s.get("over_price") is not None and s.get("under_price") is not None:
            scrape_pnl = round(odds_to_profit(s["over_price"] if side == "OVER" else s["under_price"]) if scrape_correct else -1, 3)

        close_correct = None
        close_pnl = None
        if s.get("close_line") is not None and s["actual"] != s["close_line"]:
            close_actual_side = "OVER" if s["actual"] > s["close_line"] else "UNDER"
            close_correct = side == close_actual_side
            if side == "OVER" and s.get("close_over_price") is not None:
                close_pnl = round(odds_to_profit(s["close_over_price"]) if close_correct else -1, 3)
            elif side == "UNDER" and s.get("close_under_price") is not None:
                close_pnl = round(odds_to_profit(s["close_under_price"]) if close_correct else -1, 3)

        clv = None
        if s.get("close_line") is not None:
            if side == "OVER": clv = s["close_line"] - open_line
            else: clv = open_line - s["close_line"]

        # Probability-based CLV
        clv_prob_edge = None
        beat_close = None
        if clv is not None:
            beat_close = clv > 0
            open_price = open_over_price if side == "OVER" else open_under_price
            close_price = s.get("close_over_price") if side == "OVER" else s.get("close_under_price")
            if open_price is not None and close_price is not None:
                open_prob = odds_to_implied_prob(open_price)
                close_prob = odds_to_implied_prob(close_price)
                if open_prob and close_prob:
                    clv_prob_edge = close_prob - open_prob  # positive = market moved toward our bet

        # Alt-book evaluation
        alt_correct = None
        alt_pnl = None
        alt_over = s.get("alt_over_price")
        alt_under = s.get("alt_under_price")
        alt_line_val = s.get("alt_line") or open_line
        if alt_over is not None and alt_under is not None:
            if alt_line_val is not None and s["actual"] != alt_line_val:
                alt_actual_side = "OVER" if s["actual"] > alt_line_val else "UNDER"
                alt_correct = side == alt_actual_side
                alt_price = alt_over if side == "OVER" else alt_under
                alt_pnl = round(odds_to_profit(alt_price) if alt_correct else -1, 3)

        b_profit = odds_to_profit(open_over_price if side == "OVER" else open_under_price)
        kelly_f = max((p_over * b_profit - p_under) / b_profit if side == "OVER" else (p_under * b_profit - p_over) / b_profit, 0)

        bets.append({
            "player": s["player"], "date": s["date"], "market": s["market"],
            "line": s["line"], "ev": round(ev * 100, 1), "rec": side,
            "actual": s["actual"],
            "correct": correct, "pnl": round(open_pnl_val, 3),
            "scrape_correct": scrape_correct, "scrape_pnl": scrape_pnl,
            "close_correct": close_correct, "close_pnl": close_pnl,
            "alt_correct": alt_correct, "alt_pnl": alt_pnl,
            "gn": s["gn"], "injury": s["injury"],
            "clv": round(clv, 2) if clv is not None else None,
            "clv_prob_edge": round(clv_prob_edge, 4) if clv_prob_edge is not None else None,
            "beat_close": beat_close,
            "kelly_f": round(kelly_f, 4),
            "p_over": round(p_over, 3),
            "open_line": s.get("open_line"),
            "close_line": s.get("close_line"),
            "train_book": s.get("train_book", "fanduel"),
            "model": model_name,
            "position": s.get("position", ""),
            "season": season_label,
        })
    return bets


def run(league):
    print(f"\n{'='*60}")
    print(f"MODEL H — {league.upper()} (Walk-Forward)")
    print(f"{'='*60}\n")

    data = load_all_data(league)
    if not data: return

    print("\nBuilding dataset...")
    samples, skip_counts = build_dataset(data, league)
    if not samples: return

    windows = WALK_FORWARD_WINDOWS.get(league, [])
    if not windows:
        print(f"No walk-forward windows defined for {league}")
        return

    all_bets = []
    combined_acc = []
    combined_auc = []
    last_model = None
    last_fi = None
    final_features = list(FEATURES_INITIAL)

    for wi, window in enumerate(windows):
        season = window["season"]
        train = [s for s in samples if s["date"] < window["train_end"]]
        test = [s for s in samples if s["date"] >= window["test_start"] and s["date"] < window["test_end"]]

        print(f"\n--- Window {wi+1}: {season} ---")
        print(f"  Train: {len(train):,} (< {window['train_end']})  Test: {len(test):,} ({window['test_start']} to {window['test_end']})")

        if len(train) < 50:
            print(f"  Skipping: not enough training data")
            continue
        if not test:
            print(f"  Skipping: no test data")
            continue

        # --- Per-market training ---
        markets_in_train = sorted(set(s["market"] for s in train))
        markets_in_test = sorted(set(s["market"] for s in test))
        all_markets = sorted(set(markets_in_train) | set(markets_in_test))

        window_y_test_all = []
        window_y_proba_all = []
        window_test_samples_all = []

        for mkt in all_markets:
            mkt_train = [s for s in train if s["market"] == mkt]
            mkt_test = [s for s in test if s["market"] == mkt]
            if len(mkt_train) < 80 or not mkt_test:
                # Too few samples for this market — skip it
                if mkt_test:
                    print(f"    {mkt}: skipped ({len(mkt_train)} train samples)")
                continue

            X_tr = np.array([s["features"] for s in mkt_train])
            X_te = np.array([s["features"] for s in mkt_test])
            y_tr = np.array([s["target"] for s in mkt_train])
            y_te = np.array([s["target"] for s in mkt_test])

            # ── Model H: strict anti-overfit LightGBM ──
            # Softened from initial design per GPT feedback (depth=2 was too blunt)
            lgbm_params = dict(
                n_estimators=120, max_depth=3, learning_rate=0.05,
                num_leaves=6, min_child_samples=75, subsample=0.7,
                colsample_bytree=0.8, reg_alpha=8.0, reg_lambda=8.0,
                random_state=42, verbose=-1,
            )

            # Step 1: Train with all features (including _noise)
            mkt_model = LGBMClassifier(**lgbm_params)
            mkt_model.fit(X_tr, y_tr)

            # Step 2: Noise test — drop features weaker than the noise column
            fi = dict(zip(FEATURES_INITIAL, mkt_model.feature_importances_))
            noise_importance = fi.get("_noise", 0)
            kept_idx = [i for i, f in enumerate(FEATURES_INITIAL)
                       if f == "_noise" or fi.get(f, 0) > noise_importance]
            dropped = [f for i, f in enumerate(FEATURES_INITIAL)
                      if i not in kept_idx and f != "_noise"]

            # Step 3: Remove _noise itself and retrain on surviving features only
            final_idx = [i for i in kept_idx if FEATURES_INITIAL[i] != "_noise"]
            if len(final_idx) < 3:
                # Fallback: keep top 5 features by importance (excluding noise)
                ranked = sorted([(f, fi.get(f, 0)) for f in FEATURES_INITIAL if f != "_noise"],
                               key=lambda x: -x[1])
                final_idx = [FEATURES_INITIAL.index(f) for f, _ in ranked[:5]]
                dropped = [f for i, f in enumerate(FEATURES_INITIAL)
                          if i not in final_idx and f != "_noise"]

            final_features = [FEATURES_INITIAL[i] for i in final_idx]
            X_tr_pruned = X_tr[:, final_idx]
            X_te_pruned = X_te[:, final_idx]

            # Step 4: Retrain on pruned features
            mkt_model = LGBMClassifier(**lgbm_params)
            mkt_model.fit(X_tr_pruned, y_tr)

            y_pr = mkt_model.predict_proba(X_te_pruned)[:, 1]
            mkt_acc = accuracy_score(y_te, (y_pr > 0.5).astype(int))
            try: mkt_auc = roc_auc_score(y_te, y_pr)
            except: mkt_auc = 0

            n_dropped = len(dropped)
            drop_str = f" (dropped {n_dropped}: {', '.join(dropped)})" if dropped else ""

            # ── Ablation: train without market features to check if model has independent edge ──
            market_features = {"open_implied_over_prob", "market_line_vs_consensus"}
            non_market_idx = [i for i, f in enumerate(final_features) if f not in market_features]
            ablation_str = ""
            if len(non_market_idx) >= 2 and len(mkt_train) >= 100:
                X_tr_no_mkt = X_tr_pruned[:, non_market_idx]
                X_te_no_mkt = X_te_pruned[:, non_market_idx]
                ablation_model = LGBMClassifier(**lgbm_params)
                ablation_model.fit(X_tr_no_mkt, y_tr)
                y_abl = ablation_model.predict_proba(X_te_no_mkt)[:, 1]
                try: abl_auc = roc_auc_score(y_te, y_abl)
                except: abl_auc = 0
                ablation_str = f" | no-market AUC={abl_auc:.4f}"

            print(f"    {mkt}: train={len(mkt_train)} test={len(mkt_test)} acc={mkt_acc:.4f} auc={mkt_auc:.4f} features={len(final_features)}{drop_str}{ablation_str}")

            window_y_test_all.extend(y_te.tolist())
            window_y_proba_all.extend(y_pr.tolist())
            window_test_samples_all.extend(mkt_test)

            last_model = mkt_model
            last_fi = {n: int(i) for n, i in zip(final_features, mkt_model.feature_importances_)}

        if not window_test_samples_all:
            print(f"  No markets had enough data")
            continue

        y_test = np.array(window_y_test_all)
        y_proba = np.array(window_y_proba_all)
        test = window_test_samples_all

        acc = accuracy_score(y_test, (y_proba > 0.5).astype(int))
        try: auc = roc_auc_score(y_test, y_proba)
        except: auc = 0
        print(f"  Combined: acc={acc:.4f} auc={auc:.4f}")
        combined_acc.append((acc, len(test)))
        combined_auc.append((auc, len(test)))

        window_bets = make_bets(test, y_proba, "model_h", season)
        wins = sum(1 for b in window_bets if b["correct"])
        pnl = sum(b["pnl"] for b in window_bets)
        if window_bets:
            print(f"  Bets: {len(window_bets):,}  Win: {wins/len(window_bets)*100:.1f}%  ROI: {pnl/len(window_bets)*100:+.1f}%  PnL: {pnl:+.1f}u")
        all_bets.extend(window_bets)


    if not all_bets:
        print("No bets from any window!")
        return

    # Weighted average accuracy/AUC
    total_test = sum(n for _, n in combined_acc)
    avg_acc = sum(a * n for a, n in combined_acc) / total_test if total_test > 0 else 0
    avg_auc = sum(a * n for a, n in combined_auc) / total_test if total_test > 0 else 0

    total = len(all_bets)
    wins = sum(1 for b in all_bets if b["correct"])
    pnl = sum(b["pnl"] for b in all_bets)

    print(f"\n{'='*60}")
    print(f"COMBINED WALK-FORWARD RESULTS")
    print(f"{'='*60}")
    print(f"  Windows: {len(combined_acc)}  Total bets: {total:,}")
    print(f"  Win: {wins/total*100:.1f}%  ROI: {pnl/total*100:+.1f}%  PnL: {pnl:+.1f}u")
    print(f"  Avg Accuracy: {avg_acc:.4f}  Avg AUC: {avg_auc:.4f}")

    if last_fi:
        print(f"\n  Feature importance (last window):")
        for name, imp in sorted(last_fi.items(), key=lambda x: -x[1]):
            print(f"    {name:30s} {imp:6d}")

    # By season breakdown
    by_season = defaultdict(list)
    for b in all_bets:
        by_season[b.get("season", "unknown")].append(b)
    print(f"\n  By Season:")
    for s in sorted(by_season):
        s_bets = by_season[s]
        sw = sum(1 for b in s_bets if b["correct"])
        sp = sum(b["pnl"] for b in s_bets)
        print(f"    {s}: {len(s_bets):,} bets  Win: {sw/len(s_bets)*100:.1f}%  ROI: {sp/len(s_bets)*100:+.1f}%  PnL: {sp:+.1f}u")

    results = {
        "league": league, "model": "model_h",
        "total_bets": total,
        "skip_counts": skip_counts,
        "accuracy": round(avg_acc, 4), "auc": round(avg_auc, 4),
        "features": final_features if final_features else FEATURES_INITIAL,
        "feature_importance": last_fi or {},
        "bets": all_bets,
        "walk_forward": True,
        "windows": len(combined_acc),
    }
    out = f"/workspace/back-in-play/data/model_h_{league}.json"
    with open(out, "w") as f:
        json.dump(results, f)
    print(f"\nSaved to {out}")

    try:
        sb.table("back_in_play_backtest_results").upsert({
            "league": f"{league}_model_g",
            "results": json.dumps(results),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).execute()
        print("Uploaded to Supabase")
    except Exception as e:
        print(f"Upload failed: {e}")

    if last_model:
        with open(f"/workspace/back-in-play/data/model_h_{league}.pkl", "wb") as f:
            pickle.dump(last_model, f)




def run_eval_only(league):
    """Re-evaluate bets using saved model — no retraining."""
    import numpy as np, pickle
    from collections import defaultdict
    from datetime import datetime, timezone

    print(f"\n{'='*60}")
    print(f"MODEL_C — {{league.upper()}} (Eval Only)")
    print(f"{'='*60}\n")

    data = load_all_data(league)
    if not data: return

    print("\nBuilding dataset...")
    samples, skip_counts = build_dataset(data, league)
    if not samples: return

    pkl_path = f"/workspace/back-in-play/data/model_h_{{league}}.pkl"
    if not os.path.exists(pkl_path):
        print(f"No saved model at {{pkl_path}} — run without --eval-only first")
        return
    with open(pkl_path, "rb") as f:
        saved_model = pickle.load(f)
    print(f"Loaded saved model from {{pkl_path}}")

    windows = WALK_FORWARD_WINDOWS.get(league, [])
    if not windows:
        print(f"No walk-forward windows defined for {{league}}")
        return

    all_bets = []
    for wi, window in enumerate(windows):
        season = window["season"]
        test = [s for s in samples if s["date"] >= window["test_start"] and s["date"] < window["test_end"]]

        print(f"\n--- Window {{wi+1}}: {{season}} ---")
        print(f"  Test: {{len(test):,}} ({{window['test_start']}} to {{window['test_end']}})")

        if not test:
            continue

        all_markets = sorted(set(s["market"] for s in test))
        window_test_all = []
        window_proba_all = []

        for mkt in all_markets:
            mkt_test = [s for s in test if s["market"] == mkt]
            if not mkt_test:
                continue
            X_test = np.array([s["features"] for s in mkt_test])
            try:
                y_pr = saved_model.predict_proba(X_test)[:, 1]
            except Exception as e:
                print(f"    {{mkt}}: prediction failed ({{e}})")
                continue
            print(f"    {{mkt}}: {{len(mkt_test)}} samples")
            window_test_all.extend(mkt_test)
            window_proba_all.extend(y_pr.tolist())

        if not window_test_all:
            continue

        y_proba = np.array(window_proba_all)
        window_bets = make_bets(window_test_all, y_proba, "model_h", season)
        wins = sum(1 for b in window_bets if b["correct"])
        pnl = sum(b["pnl"] for b in window_bets)
        if window_bets:
            print(f"  Bets: {{len(window_bets):,}}  Win: {{wins/len(window_bets)*100:.1f}}%  ROI: {{pnl/len(window_bets)*100:+.1f}}%  PnL: {{pnl:+.1f}}u")
        all_bets.extend(window_bets)

    if not all_bets:
        print("No bets!")
        return

    total = len(all_bets)
    wins = sum(1 for b in all_bets if b["correct"])
    pnl = sum(b["pnl"] for b in all_bets)

    print(f"\n{'='*60}")
    print(f"EVAL-ONLY RESULTS")
    print(f"{'='*60}")
    print(f"  Total bets: {{total:,}}")
    print(f"  Win: {{wins/total*100:.1f}}%  ROI: {{pnl/total*100:+.1f}}%  PnL: {{pnl:+.1f}}u")

    by_season = defaultdict(list)
    for b in all_bets:
        by_season[b.get("season", "unknown")].append(b)
    print(f"\n  By Season:")
    for s in sorted(by_season):
        s_bets = by_season[s]
        sw = sum(1 for b in s_bets if b["correct"])
        sp = sum(b["pnl"] for b in s_bets)
        print(f"    {{s}}: {{len(s_bets):,}} bets  Win: {{sw/len(s_bets)*100:.1f}}%  ROI: {{sp/len(s_bets)*100:+.1f}}%  PnL: {{sp:+.1f}}u")

    results = {{
        "league": league, "model": "model_h",
        "total_bets": total,
        "bets": all_bets,
        "skip_counts": skip_counts,
    }}
    out = f"/workspace/back-in-play/data/model_h_{{league}}.json"
    with open(out, "w") as f:
        json.dump(results, f)
    print(f"\nSaved to {{out}}")

    try:
        sb.table("back_in_play_backtest_results").upsert({{
            "league": f"{{league}}_model_g",
            "results": json.dumps(results),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }}).execute()
        print("Uploaded to Supabase")
    except Exception as e:
        print(f"Upload failed: {{e}}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--league", required=True)
    parser.add_argument("--eval-only", action="store_true")
    args = parser.parse_args()
    if args.eval_only:
        run_eval_only(args.league)
    else:
        run(args.league)
