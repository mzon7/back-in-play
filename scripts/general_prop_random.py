#!/usr/bin/env python3
"""
General Prop Random Baseline — randomly picks OVER/UNDER for every prop.

Tests whether the odds data itself has a bias (i.e. can you beat the market
by flipping a coin?). Uses the exact same data pipeline and summary format
as general_prop_model_c.py so the frontend pages can display results.

Uploads to Supabase as {league}_general_random.

Usage:
  python3 general_prop_random.py --league nba
"""

import os, sys, json, math, statistics, argparse, pathlib, random
from collections import defaultdict
from datetime import datetime, timedelta, timezone
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
    find_open_close_line, WALK_FORWARD_WINDOWS,
)

# Reproducibility
random.seed(42)

# ─── Game log columns to load ───────────────────────────────────────────────
GAME_LOG_COLS = (
    "player_id, game_date, opponent, minutes, "
    "stat_pts, stat_reb, stat_ast, stat_rush_yds, stat_pass_yds, "
    "stat_rec, stat_rec_yds, stat_goals, stat_sog, stat_h, stat_rbi, "
    "stat_stl, stat_3pm, stat_blk, stat_r, stat_sb, stat_k, stat_ip, "
    "stat_hr, stat_pass_td, stat_rush_td, stat_assists, stat_pass_comp, "
    "stat_pass_att, stat_rush_att, stat_total_shots"
)

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


# ─── Summary helpers (identical to general_prop_model_c.py) ──────────────────
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


# ─── Efficient game log loading (date-range chunking) ────────────────────────
def load_game_logs_by_league(league, select_cols, start_year=2018, end_year=2027):
    """Load all game logs for a league using monthly date ranges."""
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
            time.sleep(0.1)
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

    # Load game logs for ALL players in the league
    print(f"  Loading ALL game logs for {league} (date-range chunking)...")
    all_logs = load_game_logs_by_league(league, GAME_LOG_COLS)
    logs_by_player = defaultdict(list)
    for g in all_logs:
        logs_by_player[g["player_id"]].append(g)
    for pid in logs_by_player:
        logs_by_player[pid].sort(key=lambda x: x["game_date"])
    print(f"  {len(all_logs):,} game logs loaded")

    return {
        "props": props, "open_close": open_close,
        "name_to_id": name_to_id, "norm_to_id": norm_to_id, "fuzzy_to_id": fuzzy_to_id,
        "name_to_pos": name_to_pos,
        "logs_by_player": dict(logs_by_player),
    }


# ─── Build bets (random side selection) ─────────────────────────────────────
def build_random_bets(data, league):
    """Iterate every prop, resolve actual result, randomly pick OVER/UNDER."""
    props = data["props"]
    open_close = data["open_close"]
    name_to_id = data["name_to_id"]
    norm_to_id = data["norm_to_id"]
    fuzzy_to_id = data.get("fuzzy_to_id", {})
    name_to_pos = data.get("name_to_pos", {})
    logs_by_player = data["logs_by_player"]

    bets = []
    skips = defaultdict(int)

    for prop in props:
        player_name = prop.get("player_name", "")
        market = prop.get("market", "")
        game_date = prop.get("game_date", "")
        line = prop.get("line")
        over_price = prop.get("over_price")
        under_price = prop.get("under_price")
        event_id = prop.get("event_id", "")

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
        if not all_games:
            skips["no_games"] += 1
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

        # Resolve open/close lines (same as model_c)
        open_line_val, close_line_val, open_over_price, open_under_price, close_over_price, close_under_price = \
            find_open_close_line(open_close, event_id, player_name, market)
        if open_line_val is None:
            open_line_val = line
            open_over_price = over_price
            open_under_price = under_price
            close_line_val = line
            close_over_price = over_price
            close_under_price = under_price

        # ─── RANDOM PICK ────────────────────────────────────────────────
        side = "OVER" if random.random() < 0.5 else "UNDER"

        # ─── Evaluate against open line ────────────────────────────────
        if actual_stat == open_line_val:
            skips["push_open"] += 1
            continue
        open_actual_side = "OVER" if actual_stat > open_line_val else "UNDER"
        correct = side == open_actual_side
        price_for_side = open_over_price if side == "OVER" else open_under_price
        if price_for_side is None:
            price_for_side = over_price if side == "OVER" else under_price
        if price_for_side is None:
            skips["no_price"] += 1
            continue
        open_pnl_val = odds_to_profit(price_for_side) if correct else -1

        # ─── Scrape line evaluation ───────────────────────────────────
        scrape_actual_side = "OVER" if actual_stat > line else "UNDER"
        scrape_correct = side == scrape_actual_side if actual_stat != line else None
        scrape_pnl = None
        if scrape_correct is not None:
            scrape_pnl = round(
                odds_to_profit(over_price if side == "OVER" else under_price) if scrape_correct else -1, 3
            )

        # ─── Close line evaluation ────────────────────────────────────
        close_correct = None
        close_pnl = None
        if close_line_val is not None and actual_stat != close_line_val:
            close_actual_side = "OVER" if actual_stat > close_line_val else "UNDER"
            close_correct = side == close_actual_side
            if side == "OVER" and close_over_price is not None:
                close_pnl = round(odds_to_profit(close_over_price) if close_correct else -1, 3)
            elif side == "UNDER" and close_under_price is not None:
                close_pnl = round(odds_to_profit(close_under_price) if close_correct else -1, 3)

        # Season label
        year = int(game_date[:4])
        month = int(game_date[5:7])
        start_year = year if month >= 7 else year - 1
        season_label = f"{start_year}-{str(start_year + 1)[2:]}"

        bets.append({
            "player": player_name,
            "date": game_date,
            "market": market,
            "line": line,
            "ev": 0,             # no EV concept for random
            "rec": side,
            "actual": actual_stat,
            "correct": correct,
            "pnl": round(open_pnl_val, 3),
            "scrape_correct": scrape_correct,
            "scrape_pnl": scrape_pnl,
            "close_correct": close_correct,
            "close_pnl": close_pnl,
            "gn": 0,            # no game-number-back filtering
            "injury": "",
            "kelly_f": 0,       # no edge estimate for random
            "p_over": 0.5,      # coin flip
            "open_line": open_line_val,
            "close_line": close_line_val,
            "model": "general_random",
            "position": name_to_pos.get(player_name.lower(), ""),
            "season": season_label,
        })

    print(f"  Built {len(bets):,} random bets")
    print(f"  Skips: {dict(skips)}")
    return bets, dict(skips)


# ─── Run ─────────────────────────────────────────────────────────────────────
def run(league):
    print(f"\n{'=' * 60}")
    print(f"GENERAL PROP RANDOM BASELINE — {league.upper()}")
    print(f"{'=' * 60}\n")

    data = load_all_data(league)
    if not data:
        return

    for train_book in ["fanduel", "draftkings"]:
        book_tag = train_book[:2]
        print(f"\n{'~' * 60}")
        print(f"  TRAIN BOOK: {train_book} (tag={book_tag})")
        print(f"{'~' * 60}")

        print("\nBuilding random bets (ALL props, 50/50 coin flip)...")
        all_bets, skip_counts = build_random_bets(data, league)
        if not all_bets:
            print("No bets!")
            continue

        total = len(all_bets)
        wins = sum(1 for b in all_bets if b["correct"])
        pnl = sum(b["pnl"] for b in all_bets)

        print(f"\n{'=' * 60}")
        print(f"RESULTS ({train_book}): {total:,} bets, Win: {wins / total * 100:.1f}%, "
              f"ROI: {pnl / total * 100:+.1f}%, PnL: {pnl:+.1f}u")
        print(f"{'=' * 60}")

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

        # By market
        by_market = defaultdict(list)
        for b in all_bets:
            by_market[b["market"]].append(b)
        print(f"\nBy Market:")
        for m in sorted(by_market):
            m_bets = by_market[m]
            mw = sum(1 for b in m_bets if b["correct"])
            mp = sum(b["pnl"] for b in m_bets)
            label = MARKET_LABELS.get(m, m)
            print(f"  {label:25s}: {len(m_bets):,} bets  Win: {mw / len(m_bets) * 100:.1f}%  "
                  f"ROI: {mp / len(m_bets) * 100:+.1f}%  PnL: {mp:+.1f}u")

        # Build results + summary
        league_key = f"{league}_general_random_{book_tag}"
        results = {
            "league": league,
            "model": "general_random",
            "train_book": train_book,
            "total_bets": total,
            "skip_counts": skip_counts,
            "accuracy": round(wins / total, 4),
            "auc": 0.5,  # random has no discrimination
            "features": [],
            "feature_importance": {},
            "bets": all_bets,
            "seasons": list(by_season.keys()),
        }

        print("\nComputing summary...")
        summary = compute_summary(results)

        out = f"/workspace/back-in-play/data/general_random_{league}_{book_tag}.json"
        try:
            with open(out, "w") as f:
                json.dump(results, f)
            print(f"Saved to {out}")
        except Exception as e:
            print(f"Could not save local file: {e}")

        # Upload to Supabase
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
    parser = argparse.ArgumentParser(description="General Prop Random Baseline")
    parser.add_argument("--league", required=True,
                        choices=["nba", "nhl", "nfl", "mlb", "premier-league"],
                        help="League to run")
    args = parser.parse_args()
    run(args.league)
