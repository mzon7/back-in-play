#!/usr/bin/env python3
"""
Team Random Baseline — randomly picks sides for spreads, totals, and team totals.

Tests whether the team odds data itself has a bias. Uses the exact same data
pipeline and summary format as team_model_c.py so the frontend pages can display
results.

Uploads to Supabase as {league}_team_random.

Usage:
  python3 team_random.py --league nba
"""

import os, sys, json, math, statistics, argparse, pathlib, random
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from supabase import create_client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
sb = create_client(SUPABASE_URL, SUPABASE_KEY)

# ─── Shared utilities ────────────────────────────────────────────────────────
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from regression_v5_model_e import (
    paginate, build_name_index, resolve_player,
    odds_to_profit, odds_to_implied_prob, moneyline_to_implied_prob,
    WALK_FORWARD_WINDOWS,
)

# ─── Constants ───────────────────────────────────────────────────────────────
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

TEAM_STAT_COL = {
    "nba": "stat_pts",
    "nhl": "stat_goals",
    "nfl": "stat_pts",
    "mlb": "stat_r",
    "premier-league": "stat_goals",
}

# ─── Summary generation constants ───────────────────────────────────────────
EV_THRESHOLDS = [0, 5, 10, 15, 20, 30, 40, 50]
MAX_GN_VALUES = [1, 2, 3, 5, 10]
ODDS_MODES = ["scrape", "open", "close", "train", "alt"]

TEAM_MARKET_LABELS = {
    "spread": "Spread", "total": "Total",
    "home_team_total": "Home Team Total", "away_team_total": "Away Team Total",
    "h2h": "Moneyline", "btts": "BTTS", "h2h_3_way": "3-Way ML",
}

TEAM_ABBR_MAP = {
    # NBA
    "Atlanta Hawks": ["ATL"], "Boston Celtics": ["BOS"], "Brooklyn Nets": ["BKN"],
    "Charlotte Hornets": ["CHA", "CHO"], "Chicago Bulls": ["CHI"],
    "Cleveland Cavaliers": ["CLE"], "Dallas Mavericks": ["DAL"],
    "Denver Nuggets": ["DEN"], "Detroit Pistons": ["DET"],
    "Golden State Warriors": ["GS", "GSW"], "Houston Rockets": ["HOU"],
    "Indiana Pacers": ["IND"], "Los Angeles Clippers": ["LAC"],
    "LA Clippers": ["LAC"], "Los Angeles Lakers": ["LAL"],
    "Memphis Grizzlies": ["MEM"], "Miami Heat": ["MIA"],
    "Milwaukee Bucks": ["MIL"], "Minnesota Timberwolves": ["MIN"],
    "New Orleans Pelicans": ["NO", "NOP"], "New York Knicks": ["NY", "NYK"],
    "Oklahoma City Thunder": ["OKC"], "Orlando Magic": ["ORL"],
    "Philadelphia 76ers": ["PHI"], "Phoenix Suns": ["PHX"],
    "Portland Trail Blazers": ["POR"], "Sacramento Kings": ["SAC"],
    "San Antonio Spurs": ["SA", "SAS"], "Toronto Raptors": ["TOR"],
    "Utah Jazz": ["UTA", "UTAH"], "Washington Wizards": ["WAS", "WSH"],
    # NHL
    "Anaheim Ducks": ["ANA"], "Arizona Coyotes": ["ARI"],
    "Boston Bruins": ["BOS"], "Buffalo Sabres": ["BUF"],
    "Calgary Flames": ["CGY"], "Carolina Hurricanes": ["CAR"],
    "Chicago Blackhawks": ["CHI"], "Colorado Avalanche": ["COL"],
    "Columbus Blue Jackets": ["CBJ"], "Dallas Stars": ["DAL"],
    "Detroit Red Wings": ["DET"], "Edmonton Oilers": ["EDM"],
    "Florida Panthers": ["FLA"], "Los Angeles Kings": ["LAK", "LA"],
    "Minnesota Wild": ["MIN"], "Montreal Canadiens": ["MTL"],
    "Nashville Predators": ["NSH"], "New Jersey Devils": ["NJD", "NJ"],
    "New York Islanders": ["NYI"], "New York Rangers": ["NYR"],
    "Ottawa Senators": ["OTT"], "Philadelphia Flyers": ["PHI"],
    "Pittsburgh Penguins": ["PIT"], "San Jose Sharks": ["SJS", "SJ"],
    "Seattle Kraken": ["SEA"], "St Louis Blues": ["STL"],
    "St. Louis Blues": ["STL"], "Tampa Bay Lightning": ["TBL", "TB"],
    "Toronto Maple Leafs": ["TOR"], "Utah Hockey Club": ["UTA"],
    "Vancouver Canucks": ["VAN"], "Vegas Golden Knights": ["VGK"],
    "Washington Capitals": ["WSH", "WAS"], "Winnipeg Jets": ["WPG"],
}


# ─── Summary helpers (identical to team_model_c.py) ─────────────────────────
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
            label = TEAM_MARKET_LABELS.get(market, market)
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


# ─── Data loading ────────────────────────────────────────────────────────────
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
        "home_score, away_score",
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


def _load_game_logs_by_league(league, select_cols, start_year=2018, end_year=2027):
    """Load all game logs for a league using monthly date ranges."""
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


def load_teams_and_players(league):
    """Load teams and players for the league."""
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

    team_players = defaultdict(list)
    player_team = {}
    for p in players_raw:
        if p.get("team_id"):
            team_players[p["team_id"]].append(p["player_id"])
            player_team[p["player_id"]] = p["team_id"]

    abbr_to_team_name = {}
    for tname, abbrs in TEAM_ABBR_MAP.items():
        for a in abbrs:
            if tname.lower() in team_name_to_id:
                abbr_to_team_name[a] = tname

    return {
        "teams_raw": teams_raw,
        "team_id_to_name": team_id_to_name,
        "team_name_to_id": team_name_to_id,
        "team_players": team_players,
        "player_team": player_team,
        "players_raw": players_raw,
        "abbr_to_team_name": abbr_to_team_name,
    }


def build_team_game_scores(logs_by_player, team_data, league):
    """Aggregate player game logs into team-level scores per game date."""
    stat_col = TEAM_STAT_COL[league]
    player_team = team_data["player_team"]
    team_id_to_name = team_data["team_id_to_name"]

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

    team_scores = defaultdict(list)
    for (tid, gdate), player_logs in team_date_logs.items():
        tname = team_id_to_name.get(tid, "")
        tname_lower = tname.lower()
        if not tname_lower:
            continue
        scored = sum(g.get(stat_col, 0) or 0 for g in player_logs)
        team_scores[tname_lower].append({
            "game_date": gdate,
            "scored": scored,
        })

    for tname in team_scores:
        team_scores[tname].sort(key=lambda x: x["game_date"])

    print(f"  Built team game scores: {len(team_scores)} teams, "
          f"{sum(len(v) for v in team_scores.values()):,} team-games")

    return team_scores


# ─── Build random bets ──────────────────────────────────────────────────────
def build_random_bets(game_odds_events, team_scores, league):
    """For every game with odds, randomly pick sides for spread/total/team totals."""
    stat_col = TEAM_STAT_COL[league]

    # Build (team_lower, date) -> scored lookup
    team_date_scored = {}
    for tname, games in team_scores.items():
        for g in games:
            team_date_scored[(tname, g["game_date"])] = g["scored"]

    bets = []
    skips = defaultdict(int)
    processed = 0

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

        # Season label
        year = int(gdate[:4])
        month = int(gdate[5:7])
        start_year = year if month >= 7 else year - 1
        season_label = f"{start_year}-{str(start_year + 1)[2:]}"

        # ---------- SPREAD BET ----------
        spread_line = odds.get("spread_home_line")
        spread_home_price = odds.get("spread_home_price")
        spread_away_price = odds.get("spread_away_price")

        if spread_line is not None and spread_home_price is not None and spread_away_price is not None:
            spread_line = float(spread_line)
            margin = home_scored + spread_line - away_scored
            if margin == 0:
                skips["spread_push"] += 1
            else:
                target = 1 if margin > 0 else 0

                # Random pick
                side = "OVER" if random.random() < 0.5 else "UNDER"
                # OVER = home covers, UNDER = away covers
                correct = (side == "OVER" and margin > 0) or (side == "UNDER" and margin < 0)
                pnl_val = odds_to_profit(spread_home_price if side == "OVER" else spread_away_price) if correct else -1

                # Alt-book evaluation
                alt_correct = None
                alt_pnl = None
                alt_over = odds.get("alt_spread_home_price")
                alt_under = odds.get("alt_spread_away_price")
                if alt_over is not None and alt_under is not None:
                    alt_actual_side = "OVER" if margin > 0 else "UNDER" if margin < 0 else None
                    if alt_actual_side:
                        alt_correct = side == alt_actual_side
                        alt_price = alt_over if side == "OVER" else alt_under
                        alt_pnl = round(odds_to_profit(alt_price) if alt_correct else -1, 3)

                bets.append({
                    "player": f"{home_team} vs {away_team}",
                    "date": gdate,
                    "market": "spread",
                    "line": spread_line,
                    "ev": 0,
                    "rec": side,
                    "actual": margin,
                    "correct": correct,
                    "pnl": round(pnl_val, 3),
                    "scrape_correct": correct,
                    "scrape_pnl": round(pnl_val, 3),
                    "close_correct": None,
                    "close_pnl": None,
                    "alt_correct": alt_correct,
                    "alt_pnl": alt_pnl,
                    "kelly_f": 0,
                    "p_over": 0.5,
                    "model": "team_random",
                    "season": season_label,
                    "home_team": home_team,
                    "away_team": away_team,
                    "train_book": odds.get("train_book", "fanduel"),
                    "gn": 0,
                })

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
                side = "OVER" if random.random() < 0.5 else "UNDER"
                correct = (side == "OVER" and actual_total > total_line) or \
                          (side == "UNDER" and actual_total < total_line)
                pnl_val = odds_to_profit(total_over_price if side == "OVER" else total_under_price) if correct else -1

                # Alt-book evaluation
                alt_correct = None
                alt_pnl = None
                alt_over = odds.get("alt_total_over_price")
                alt_under = odds.get("alt_total_under_price")
                alt_line_val = float(odds["alt_total_line"]) if odds.get("alt_total_line") is not None else total_line
                if alt_over is not None and alt_under is not None:
                    if actual_total != alt_line_val:
                        alt_actual_side = "OVER" if actual_total > alt_line_val else "UNDER"
                        alt_correct = side == alt_actual_side
                        alt_price = alt_over if side == "OVER" else alt_under
                        alt_pnl = round(odds_to_profit(alt_price) if alt_correct else -1, 3)

                bets.append({
                    "player": f"{home_team} vs {away_team}",
                    "date": gdate,
                    "market": "total",
                    "line": total_line,
                    "ev": 0,
                    "rec": side,
                    "actual": actual_total,
                    "correct": correct,
                    "pnl": round(pnl_val, 3),
                    "scrape_correct": correct,
                    "scrape_pnl": round(pnl_val, 3),
                    "close_correct": None,
                    "close_pnl": None,
                    "alt_correct": alt_correct,
                    "alt_pnl": alt_pnl,
                    "kelly_f": 0,
                    "p_over": 0.5,
                    "model": "team_random",
                    "season": season_label,
                    "home_team": home_team,
                    "away_team": away_team,
                    "train_book": odds.get("train_book", "fanduel"),
                    "gn": 0,
                })

        # ---------- HOME TEAM TOTAL ----------
        home_total_line = odds.get("home_total_line")
        home_total_over_price = odds.get("home_total_over_price")
        home_total_under_price = odds.get("home_total_under_price")

        if home_total_line is not None and home_total_over_price is not None and home_total_under_price is not None:
            home_total_line = float(home_total_line)
            if home_scored == home_total_line:
                skips["home_total_push"] += 1
            else:
                side = "OVER" if random.random() < 0.5 else "UNDER"
                correct = (side == "OVER" and home_scored > home_total_line) or \
                          (side == "UNDER" and home_scored < home_total_line)
                pnl_val = odds_to_profit(home_total_over_price if side == "OVER" else home_total_under_price) if correct else -1

                # Alt-book evaluation
                alt_correct = None
                alt_pnl = None
                alt_over = odds.get("alt_home_total_over_price")
                alt_under = odds.get("alt_home_total_under_price")
                alt_line_val = float(odds["alt_home_total_line"]) if odds.get("alt_home_total_line") is not None else home_total_line
                if alt_over is not None and alt_under is not None:
                    if home_scored != alt_line_val:
                        alt_actual_side = "OVER" if home_scored > alt_line_val else "UNDER"
                        alt_correct = side == alt_actual_side
                        alt_price = alt_over if side == "OVER" else alt_under
                        alt_pnl = round(odds_to_profit(alt_price) if alt_correct else -1, 3)

                bets.append({
                    "player": home_team,
                    "date": gdate,
                    "market": "home_team_total",
                    "line": home_total_line,
                    "ev": 0,
                    "rec": side,
                    "actual": home_scored,
                    "correct": correct,
                    "pnl": round(pnl_val, 3),
                    "scrape_correct": correct,
                    "scrape_pnl": round(pnl_val, 3),
                    "close_correct": None,
                    "close_pnl": None,
                    "alt_correct": alt_correct,
                    "alt_pnl": alt_pnl,
                    "kelly_f": 0,
                    "p_over": 0.5,
                    "model": "team_random",
                    "season": season_label,
                    "home_team": home_team,
                    "away_team": away_team,
                    "train_book": odds.get("train_book", "fanduel"),
                    "gn": 0,
                })

        # ---------- AWAY TEAM TOTAL ----------
        away_total_line = odds.get("away_total_line")
        away_total_over_price = odds.get("away_total_over_price")
        away_total_under_price = odds.get("away_total_under_price")

        if away_total_line is not None and away_total_over_price is not None and away_total_under_price is not None:
            away_total_line = float(away_total_line)
            if away_scored == away_total_line:
                skips["away_total_push"] += 1
            else:
                side = "OVER" if random.random() < 0.5 else "UNDER"
                correct = (side == "OVER" and away_scored > away_total_line) or \
                          (side == "UNDER" and away_scored < away_total_line)
                pnl_val = odds_to_profit(away_total_over_price if side == "OVER" else away_total_under_price) if correct else -1

                # Alt-book evaluation
                alt_correct = None
                alt_pnl = None
                alt_over = odds.get("alt_away_total_over_price")
                alt_under = odds.get("alt_away_total_under_price")
                alt_line_val = float(odds["alt_away_total_line"]) if odds.get("alt_away_total_line") is not None else away_total_line
                if alt_over is not None and alt_under is not None:
                    if away_scored != alt_line_val:
                        alt_actual_side = "OVER" if away_scored > alt_line_val else "UNDER"
                        alt_correct = side == alt_actual_side
                        alt_price = alt_over if side == "OVER" else alt_under
                        alt_pnl = round(odds_to_profit(alt_price) if alt_correct else -1, 3)

                bets.append({
                    "player": away_team,
                    "date": gdate,
                    "market": "away_team_total",
                    "line": away_total_line,
                    "ev": 0,
                    "rec": side,
                    "actual": away_scored,
                    "correct": correct,
                    "pnl": round(pnl_val, 3),
                    "scrape_correct": correct,
                    "scrape_pnl": round(pnl_val, 3),
                    "close_correct": None,
                    "close_pnl": None,
                    "alt_correct": alt_correct,
                    "alt_pnl": alt_pnl,
                    "kelly_f": 0,
                    "p_over": 0.5,
                    "model": "team_random",
                    "season": season_label,
                    "home_team": home_team,
                    "away_team": away_team,
                    "train_book": odds.get("train_book", "fanduel"),
                    "gn": 0,
                })

        processed += 1
        if processed % 500 == 0:
            print(f"    Processed {processed:,} events, {len(bets):,} bets so far")

    print(f"  Built {len(bets):,} random bets from {processed:,} events")
    print(f"  Skips: {dict(skips)}")
    return bets, dict(skips)


# ─── Run ─────────────────────────────────────────────────────────────────────
def run(league):
    print(f"\n{'=' * 60}")
    print(f"TEAM RANDOM BASELINE — {league.upper()}")
    print(f"{'=' * 60}\n")

    # 1. Load shared data (doesn't depend on bookmaker)
    print("Loading data...")
    team_data = load_teams_and_players(league)

    stat_col = TEAM_STAT_COL[league]
    print(f"  Loading ALL game logs for {league} (date-range chunking)...")
    select_cols = "player_id, game_date, minutes, opponent, " + stat_col
    all_logs = _load_game_logs_by_league(league, select_cols)
    print(f"    {len(all_logs):,} game logs loaded")

    logs_by_player = defaultdict(list)
    for g in all_logs:
        logs_by_player[g["player_id"]].append(g)
    for pid in logs_by_player:
        logs_by_player[pid].sort(key=lambda x: x["game_date"])

    print("  Building team game scores...")
    team_scores = build_team_game_scores(logs_by_player, team_data, league)

    # 2. Run for each training book (FanDuel and DraftKings)
    for train_book in ["fanduel", "draftkings"]:
        book_label = train_book[:2].upper()
        print(f"\n{'=' * 60}")
        print(f"TEAM RANDOM BASELINE — {league.upper()} — Train on {train_book.upper()}")
        print(f"{'=' * 60}\n")

        game_odds_events = load_game_odds(league, train_book=train_book)
        if not game_odds_events:
            print(f"No game odds found for {train_book}!")
            continue

        # Reset RNG for reproducibility per book
        random.seed(42)

        print("\nBuilding random bets (50/50 coin flip for every market)...")
        all_bets, skip_counts = build_random_bets(game_odds_events, team_scores, league)
        if not all_bets:
            print("No bets!")
            continue

        total = len(all_bets)
        wins = sum(1 for b in all_bets if b["correct"])
        pnl = sum(b["pnl"] for b in all_bets)

        print(f"\n{'=' * 60}")
        print(f"RESULTS: {total:,} bets, Win: {wins / total * 100:.1f}%, "
              f"ROI: {pnl / total * 100:+.1f}%, PnL: {pnl:+.1f}u")
        print(f"{'=' * 60}")

        # By market breakdown
        by_market = defaultdict(list)
        for b in all_bets:
            by_market[b["market"]].append(b)
        print(f"\nBy Market:")
        for m in sorted(by_market):
            m_bets = by_market[m]
            mw = sum(1 for b in m_bets if b["correct"])
            mp = sum(b["pnl"] for b in m_bets)
            label = TEAM_MARKET_LABELS.get(m, m)
            print(f"  {label:20s}: {len(m_bets):,} bets  "
                  f"Win: {mw / len(m_bets) * 100:.1f}%  "
                  f"ROI: {mp / len(m_bets) * 100:+.1f}%  "
                  f"PnL: {mp:+.1f}u")

        # By season breakdown
        by_season = defaultdict(list)
        for b in all_bets:
            by_season[b.get("season", "unknown")].append(b)
        print(f"\nBy Season:")
        for s in sorted(by_season):
            s_bets = by_season[s]
            sw = sum(1 for b in s_bets if b["correct"])
            sp = sum(b["pnl"] for b in s_bets)
            print(f"  {s}: {len(s_bets):,} bets  "
                  f"Win: {sw / len(s_bets) * 100:.1f}%  "
                  f"ROI: {sp / len(s_bets) * 100:+.1f}%  "
                  f"PnL: {sp:+.1f}u")

        # Build results + summary
        results = {
            "league": league,
            "model": "team_random",
            "train_book": train_book,
            "total_bets": total,
            "accuracy": round(wins / total, 4),
            "auc": 0.5,
            "features": [],
            "feature_importance": {},
            "bets": all_bets,
            "walk_forward": False,
            "skip_counts": skip_counts,
        }

        print("\nComputing summary...")
        summary = compute_summary(results)

        out = f"/workspace/back-in-play/data/team_random_{league}_{train_book[:2]}.json"
        try:
            with open(out, "w") as f:
                json.dump(results, f)
            print(f"Saved to {out}")
        except Exception as e:
            print(f"Could not save local file: {e}")

        # Upload to Supabase with book suffix
        try:
            league_key = f"{league}_team_random_{train_book[:2]}"
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
    parser = argparse.ArgumentParser(description="Team Random Baseline")
    parser.add_argument("--league", required=True,
                        choices=list(LEAGUE_IDS.keys()),
                        help="League to run (nba, nhl, nfl, mlb, premier-league)")
    args = parser.parse_args()
    run(args.league)
