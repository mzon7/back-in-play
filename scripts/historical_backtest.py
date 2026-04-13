#!/usr/bin/env python3
"""
Historical EV Model Backtest — Fast, batch-loaded version.

Loads all data into memory first, then processes in-memory.
No individual DB queries during the simulation loop.

Usage:
  python3 historical_backtest.py --league nba
"""

import os
import sys
import json
import math
import statistics
import argparse
import pathlib
from collections import defaultdict

from supabase import create_client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
    sys.exit(1)

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

MARKET_TO_STAT = {
    "player_points": "stat_pts",
    "player_rebounds": "stat_reb",
    "player_assists": "stat_ast",
    "player_pass_yds": "stat_pass_yds",
    "player_rush_yds": "stat_rush_yds",
    "player_receptions": "stat_rec",
    "player_reception_yds": "stat_rec_yds",
    "player_goals": "stat_goals",
    "player_shots_on_goal": "stat_sog",
    "player_shots": "stat_sog",
    "player_shots_on_target": "stat_sog",
    "batter_hits": "stat_h",
    "batter_total_bases": "stat_stl",  # MLB: totalBases stored in stat_stl
    "batter_rbis": "stat_rbi",
}

LEAGUE_IDS = {
    "nba": "2aa180e9-a7c2-4d08-a1d8-a16152827b5d",
    "nfl": "0fea41a7-250e-40bf-9220-97853a69b6d7",
    "nhl": "0894f8ac-c744-4b58-9023-20c514f64fff",
    "mlb": "312485db-3c4a-4f83-b4b0-c761e114d870",
    "premier-league": "759cf693-7e15-4ea5-a3ed-ff9fd7d6bbb0",
}

HAS_MINUTES = {"nba", "nhl"}  # NFL doesn't have minutes in game logs

# ── Helpers ──

def med(arr):
    return statistics.median(arr) if arr else None

def normal_cdf(z):
    if z < -8: return 0.0
    if z > 8: return 1.0
    a1, a2, a3, a4, a5 = 0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429
    p = 0.3275911
    sign = -1 if z < 0 else 1
    x = abs(z) / math.sqrt(2)
    t = 1.0 / (1.0 + p * x)
    y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * math.exp(-x * x)
    return 0.5 * (1.0 + sign * y)

def odds_to_profit(odds):
    if odds < 0: return 100 / abs(odds)
    return odds / 100

def compute_baseline_minutes(games, stat_key):
    with_min = [g for g in games if g.get("minutes") and g["minutes"] > 0]
    if len(with_min) < 5: return None
    typical = med([g["minutes"] for g in with_min])
    thresh = typical * 0.25
    real = [g for g in with_min if g["minutes"] >= thresh][:10]
    if len(real) < 5: return None
    med_min = med([g["minutes"] for g in real])
    rates = [g[stat_key] / g["minutes"] for g in real if g.get(stat_key) is not None and g["minutes"] > 0]
    if not rates: return None
    return med(rates) * med_min

def compute_baseline_simple(games, stat_key):
    vals = [g[stat_key] for g in games[:10] if g.get(stat_key) is not None]
    if len(vals) < 5: return None
    return med(vals)


# ── Batch data loading ──

def paginate(table, select, filters=None, order_col=None, order_desc=False, batch=1000):
    """Paginate through a Supabase table."""
    all_data = []
    offset = 0
    while True:
        q = sb.table(table).select(select)
        if filters:
            for method, args in filters:
                q = getattr(q, method)(*args)
        if order_col:
            q = q.order(order_col, desc=order_desc)
        q = q.range(offset, offset + batch - 1)
        r = q.execute()
        if not r.data:
            break
        all_data.extend(r.data)
        if len(r.data) < batch:
            break
        offset += batch
    return all_data


def load_props_from_files(league):
    """Load props from local JSON files (faster than Supabase)."""
    data_dir = pathlib.Path(f"/workspace/back-in-play/data/historical_props/{league}")
    if not data_dir.exists():
        return []
    all_props = []
    for date_dir in sorted(data_dir.iterdir()):
        if not date_dir.is_dir() or date_dir.name == "checkpoint.json":
            continue
        for f in date_dir.glob("*.json"):
            try:
                props = json.loads(f.read_text())
                if isinstance(props, list):
                    all_props.extend(p for p in props if isinstance(p, dict))
            except:
                pass
    return all_props


def load_all_data(league):
    """Load all required data into memory."""
    league_id = LEAGUE_IDS[league]

    # 1. Load props (from files — fast)
    print("Loading historical props from files...")
    props = load_props_from_files(league)
    print(f"  {len(props):,} props loaded")

    if not props:
        # Fallback to Supabase
        print("  Trying Supabase...")
        props = paginate("back_in_play_historical_props", "*",
                        filters=[("eq", ("league", league))],
                        order_col="game_date")
        print(f"  {len(props):,} props from Supabase")

    # 2. Load players → name→id mapping
    print("Loading players...")
    players_raw = paginate("back_in_play_players", "player_id, player_name",
                          filters=[("eq", ("league_id", league_id))])
    name_to_id = {}
    for p in players_raw:
        name_to_id[p["player_name"].lower()] = p["player_id"]
    print(f"  {len(name_to_id):,} players")

    # 3. Load all injuries for these players
    print("Loading injuries...")
    player_ids = list(set(name_to_id.values()))
    all_injuries = []
    CHUNK = 50
    for i in range(0, len(player_ids), CHUNK):
        chunk = player_ids[i:i + CHUNK]
        offset = 0
        while True:
            r = (sb.table("back_in_play_injuries")
                 .select("player_id, injury_type_slug, date_injured, return_date")
                 .in_("player_id", chunk)
                 .not_.is_("return_date", "null")
                 .range(offset, offset + 999)
                 .execute())
            all_injuries.extend(r.data)
            if len(r.data) < 1000:
                break
            offset += 1000
    # Index: player_id → list of injuries sorted by return_date desc
    injuries_by_player = defaultdict(list)
    for inj in all_injuries:
        injuries_by_player[inj["player_id"]].append(inj)
    for pid in injuries_by_player:
        injuries_by_player[pid].sort(key=lambda x: x["return_date"], reverse=True)
    print(f"  {len(all_injuries):,} injuries for {len(injuries_by_player):,} players")

    # 4. Load game logs — only for players who have both props AND injuries
    print("Loading game logs...")
    prop_player_names = set(p.get("player_name", "").lower() for p in props if isinstance(p, dict))
    prop_player_ids = [pid for name, pid in name_to_id.items() if name in prop_player_names]
    needed_ids = list(set(prop_player_ids) & set(injuries_by_player.keys()))
    print(f"  Need game logs for {len(needed_ids):,} players (have props + injuries)")
    stat_cols = "player_id, game_date, minutes, stat_pts, stat_reb, stat_ast, stat_sog, stat_rush_yds, stat_pass_yds, stat_rec, stat_rec_yds, stat_goals, stat_h, stat_rbi, stat_stl"
    all_logs = []
    for i in range(0, len(needed_ids), CHUNK):
        chunk = needed_ids[i:i + CHUNK]
        logs = paginate("back_in_play_player_game_logs", stat_cols,
                       filters=[
                           ("in_", ("player_id", chunk)),
                           ("eq", ("league_slug", league)),
                       ],
                       order_col="game_date", order_desc=True,
                       batch=1000)
        all_logs.extend(logs)
        if (i // CHUNK) % 10 == 0:
            print(f"    chunk {i // CHUNK + 1}/{(len(needed_ids) + CHUNK - 1) // CHUNK}: {len(all_logs):,} logs so far")
    # Index: player_id → list of games sorted by date desc
    logs_by_player = defaultdict(list)
    for g in all_logs:
        logs_by_player[g["player_id"]].append(g)
    for pid in logs_by_player:
        logs_by_player[pid].sort(key=lambda x: x["game_date"], reverse=True)
    print(f"  {len(all_logs):,} game logs for {len(logs_by_player):,} players")

    # 5. Load performance curves (use holdout curves if available for proper backtesting)
    print("Loading performance curves...")
    # Try holdout curves first (built from pre-cutoff data only)
    curves_raw = paginate("back_in_play_holdout_curves",
                         "injury_type_slug, stat_median_pct, median_pct_recent, sample_size",
                         filters=[
                             ("eq", ("league_slug", league)),
                             ("eq", ("position", "")),
                         ])
    if not curves_raw:
        # Fallback to production curves
        print("  No holdout curves found, using production curves")
        curves_raw = paginate("back_in_play_performance_curves",
                             "injury_type_slug, stat_median_pct, median_pct_recent, sample_size",
                             filters=[
                                 ("eq", ("league_slug", league)),
                                 ("eq", ("position", "")),
                             ])
    curves = {}
    for row in curves_raw:
        slug = row["injury_type_slug"]
        # Parse JSON strings if needed
        for key in ("stat_median_pct", "median_pct_recent"):
            if isinstance(row.get(key), str):
                try:
                    row[key] = json.loads(row[key])
                except:
                    pass
        if slug not in curves or (row.get("sample_size") or 0) > (curves[slug].get("sample_size") or 0):
            curves[slug] = row
    print(f"  {len(curves)} performance curves")

    return props, name_to_id, injuries_by_player, logs_by_player, curves


# ── Simulation ──

def run_backtest(league):
    print("=" * 60)
    print(f"EV MODEL BACKTEST — {league.upper()}")
    print("=" * 60)

    props, name_to_id, injuries_by_player, logs_by_player, curves = load_all_data(league)

    if not props:
        print("No props found!")
        return

    # Split: use only the most recent season as test set (holdout)
    # NBA/NHL: 2024-10-22 onwards (2024-25 season)
    # MLB: 2024-07-15 onwards (second half of 2024 season — no data after Oct)
    holdout_start = "2024-07-15" if league == "mlb" else "2024-10-22"
    test_props = [p for p in props if p.get("game_date", "") >= holdout_start]
    train_props = [p for p in props if p.get("game_date", "") < holdout_start]
    print(f"  Train period: {len(train_props):,} props (before {holdout_start})")
    print(f"  Test period:  {len(test_props):,} props (from {holdout_start})")
    print(f"  Running on TEST set only (holdout)\n")
    props = test_props  # Only run on holdout data

    use_minutes = league in HAS_MINUTES

    results = {
        "total": 0, "correct": 0, "profit": 0.0,
        "by_game_num": defaultdict(lambda: {"total": 0, "correct": 0, "profit": 0.0}),
        "by_ev_tier": defaultdict(lambda: {"total": 0, "correct": 0, "profit": 0.0}),
        "by_confidence": defaultdict(lambda: {"total": 0, "correct": 0, "profit": 0.0}),
        "by_market": defaultdict(lambda: {"total": 0, "correct": 0, "profit": 0.0}),
        "bets": [],  # Individual bet records for client-side filtering
        "skip_no_player": 0, "skip_no_injury": 0, "skip_no_baseline": 0,
        "skip_no_curve": 0, "skip_no_actual": 0, "skip_no_ev": 0,
        "skip_no_stat": 0, "skip_games_back": 0, "skip_no_pct": 0,
    }

    # Debug: show some sample prop player names vs our DB names
    prop_names = set(p.get("player_name", "").lower() for p in props[:500])
    matched = prop_names & set(name_to_id.keys())
    print(f"\n  Name match rate (first 500): {len(matched)}/{len(prop_names)} ({len(matched)/max(len(prop_names),1)*100:.0f}%)")
    unmatched = list(prop_names - set(name_to_id.keys()))[:5]
    if unmatched:
        print(f"  Unmatched examples: {unmatched}")

    print(f"\nProcessing {len(props):,} props...")

    for idx, prop in enumerate(props):
        player_name = prop.get("player_name", "")
        game_date = prop.get("game_date", "")
        market = prop.get("market", "")
        line = float(prop.get("line", 0))
        over_odds = prop.get("over_price") or prop.get("open_over")
        under_odds = prop.get("under_price") or prop.get("open_under")

        stat_key = MARKET_TO_STAT.get(market)
        if not stat_key:
            results["skip_no_stat"] += 1
            continue

        # Resolve player
        player_id = name_to_id.get(player_name.lower())
        if not player_id:
            results["skip_no_player"] += 1
            continue

        # Find most recent injury before game date
        injury = None
        for inj in injuries_by_player.get(player_id, []):
            if inj["return_date"] and inj["return_date"] <= game_date:
                injury = inj
                break
        if not injury:
            results["skip_no_injury"] += 1
            continue

        injury_slug = injury["injury_type_slug"]
        date_injured = injury["date_injured"]
        return_date = injury["return_date"]

        # Must have matching curve
        curve = curves.get(injury_slug)
        if not curve:
            results["skip_no_curve"] += 1
            continue

        # Get player's game logs
        all_logs = logs_by_player.get(player_id, [])
        if not all_logs:
            results["skip_no_baseline"] += 1
            continue

        # Pre-injury games (before date_injured)
        pre_games = [g for g in all_logs if g["game_date"] < date_injured]

        # Post-return games before this game date
        post_games = [g for g in all_logs if return_date <= g["game_date"] < game_date]
        post_games.sort(key=lambda x: x["game_date"])  # ascending

        games_back = len(post_games)
        if games_back >= 10:
            results["skip_games_back"] += 1
            continue  # Only test first 10 games

        # Compute baseline
        if use_minutes:
            baseline = compute_baseline_minutes(pre_games, stat_key)
        else:
            baseline = compute_baseline_simple(pre_games, stat_key)

        if baseline is None or baseline <= 0:
            results["skip_no_baseline"] += 1
            continue

        # Actual game result
        actual_game = next((g for g in all_logs if g["game_date"] == game_date), None)
        if not actual_game or actual_game.get(stat_key) is None:
            results["skip_no_actual"] += 1
            continue

        actual_stat = actual_game[stat_key]

        # ── EV Model ──
        stat_medians = curve.get("stat_median_pct") or {}
        composite_pcts = curve.get("median_pct_recent") or []
        stat_pcts = stat_medians.get(stat_key, []) if isinstance(stat_medians, dict) else []

        pct = None
        if stat_pcts and games_back < len(stat_pcts):
            pct = stat_pcts[games_back]
        if pct is None and composite_pcts and games_back < len(composite_pcts):
            pct = composite_pcts[games_back]
        if pct is None or not isinstance(pct, (int, float)):
            results["skip_no_pct"] += 1
            continue

        expected_hist = baseline * pct

        # Recent form
        recent_avg = None
        if post_games:
            recent_vals = [g[stat_key] for g in post_games if g.get(stat_key) is not None]
            if recent_vals:
                recent_avg = statistics.mean(recent_vals)

        # Blend
        if games_back <= 1: hw, rw = 0.8, 0.2
        elif games_back <= 4: hw, rw = 0.6, 0.4
        else: hw, rw = 0.4, 0.6

        expected = hw * expected_hist + rw * recent_avg if recent_avg is not None else expected_hist

        # Probability
        stddev = baseline * 0.25
        z = (line - expected) / stddev if stddev > 0 else 0
        prob_under = normal_cdf(z)
        prob_over = 1 - prob_under

        # EV
        ev_over = ev_under = None
        try:
            if over_odds is not None:
                ev_over = prob_over * odds_to_profit(float(over_odds)) - prob_under
            if under_odds is not None:
                ev_under = prob_under * odds_to_profit(float(under_odds)) - prob_over
        except:
            continue

        # Best side
        rec = best_ev = bet_odds = None
        if ev_over is not None and ev_under is not None:
            if ev_over > ev_under and ev_over > 0:
                rec, best_ev, bet_odds = "OVER", ev_over, float(over_odds)
            elif ev_under > ev_over and ev_under > 0:
                rec, best_ev, bet_odds = "UNDER", ev_under, float(under_odds)
        elif ev_over is not None and ev_over > 0:
            rec, best_ev, bet_odds = "OVER", ev_over, float(over_odds)
        elif ev_under is not None and ev_under > 0:
            rec, best_ev, bet_odds = "UNDER", ev_under, float(under_odds)

        if rec is None:
            results["skip_no_ev"] += 1
            continue

        correct = (rec == "OVER" and actual_stat > line) or (rec == "UNDER" and actual_stat < line)
        pnl = odds_to_profit(bet_odds) if correct else -1.0

        # Confidence
        ss = curve.get("sample_size") or 0
        conf = "High" if ss >= 500 and games_back >= 2 else ("Medium" if ss >= 100 else "Low")

        # EV tier
        ep = best_ev * 100
        tier = "≥50%" if ep >= 50 else "30-50%" if ep >= 30 else "20-30%" if ep >= 20 else "10-20%" if ep >= 10 else "5-10%" if ep >= 5 else "<5%"

        # Record individual bet
        # NOTE: p_over and kelly_f omitted — heuristic stddev=0.25*baseline
        # produces overconfident probabilities unsuitable for Kelly sizing.
        results["bets"].append({
            "player": player_name,
            "date": game_date,
            "market": market,
            "line": line,
            "ev": round(best_ev * 100, 1),
            "rec": rec,
            "actual": actual_stat,
            "correct": correct,
            "pnl": round(pnl, 3),
            "gn": games_back + 1,
            "conf": conf,
            "injury": injury_slug,
        })

        # Aggregate
        results["total"] += 1
        if correct: results["correct"] += 1
        results["profit"] += pnl

        gn = games_back + 1
        for key, val in [("by_game_num", gn), ("by_ev_tier", tier), ("by_confidence", conf), ("by_market", market)]:
            results[key][val]["total"] += 1
            if correct: results[key][val]["correct"] += 1
            results[key][val]["profit"] += pnl

        if results["total"] % 100 == 0:
            acc = results["correct"] / results["total"] * 100
            roi = results["profit"] / results["total"] * 100
            print(f"  [{results['total']:,} bets] Win: {acc:.1f}% | ROI: {roi:+.1f}% | "
                  f"Profit: {results['profit']:+.1f}u")

    # ── Print results ──
    print("\n" + "=" * 60)
    print(f"RESULTS — {league.upper()}")
    print("=" * 60)

    total = results["total"]
    if total == 0:
        print("No predictions made!")
        for k in ["skip_no_stat", "skip_no_player", "skip_no_injury", "skip_games_back", "skip_no_curve", "skip_no_baseline", "skip_no_actual", "skip_no_pct", "skip_no_ev"]:
            print(f"  {k}: {results[k]}")
        return

    correct = results["correct"]
    profit = results["profit"]
    print(f"Total bets: {total:,}")
    print(f"Win rate: {correct}/{total} ({correct/total*100:.1f}%)")
    print(f"ROI: {profit/total*100:+.1f}%")
    print(f"Net profit: {profit:+.1f} units")
    print()
    for k in ["skip_no_stat", "skip_no_player", "skip_no_injury", "skip_games_back", "skip_no_curve", "skip_no_baseline", "skip_no_actual", "skip_no_pct", "skip_no_ev"]:
        print(f"  {k}: {results[k]:,}")

    print("\n── By Game Number ──")
    for gn in sorted(results["by_game_num"].keys()):
        d = results["by_game_num"][gn]
        if d["total"] == 0: continue
        print(f"  G{gn}: {d['correct']}/{d['total']} ({d['correct']/d['total']*100:.1f}%) | ROI: {d['profit']/d['total']*100:+.1f}%")

    print("\n── By EV Tier ──")
    for tier in ["<5%", "5-10%", "10-20%", "20-30%", "30-50%", "≥50%"]:
        d = results["by_ev_tier"].get(tier)
        if not d or d["total"] == 0: continue
        print(f"  {tier:>6s}: {d['correct']}/{d['total']} ({d['correct']/d['total']*100:.1f}%) | ROI: {d['profit']/d['total']*100:+.1f}%")

    print("\n── By Confidence ──")
    for conf in ["High", "Medium", "Low"]:
        d = results["by_confidence"].get(conf)
        if not d or d["total"] == 0: continue
        print(f"  {conf:>6s}: {d['correct']}/{d['total']} ({d['correct']/d['total']*100:.1f}%) | ROI: {d['profit']/d['total']*100:+.1f}%")

    print("\n── By Market ──")
    for market, d in sorted(results["by_market"].items(), key=lambda x: x[1]["total"], reverse=True):
        if d["total"] == 0: continue
        print(f"  {market:>25s}: {d['correct']}/{d['total']} ({d['correct']/d['total']*100:.1f}%) | ROI: {d['profit']/d['total']*100:+.1f}%")

    # Save
    output = {
        "league": league, "total_bets": total,
        "win_rate": round(correct/total*100, 2),
        "roi": round(profit/total*100, 2),
        "net_profit_units": round(profit, 2),
        "by_game_num": {str(k): dict(v) for k, v in results["by_game_num"].items()},
        "by_ev_tier": {k: dict(v) for k, v in results["by_ev_tier"].items()},
        "by_confidence": {k: dict(v) for k, v in results["by_confidence"].items()},
        "by_market": {k: dict(v) for k, v in results["by_market"].items()},
    }
    outfile = f"/workspace/back-in-play/data/backtest_{league}.json"
    with open(outfile, "w") as f:
        json.dump(output, f, indent=2)
    print(f"\nSummary saved to {outfile}")

    # Save individual bets for client-side filtering
    bets_file = f"/workspace/back-in-play/data/backtest_{league}_bets.json"
    with open(bets_file, "w") as f:
        json.dump(results["bets"], f)
    print(f"Individual bets saved to {bets_file} ({len(results['bets']):,} bets)")

    # Also upsert to Supabase for the frontend to fetch
    try:
        import requests as req
        url = os.environ['SUPABASE_URL'] + '/rest/v1/back_in_play_backtest_results'
        headers = {
            'apikey': os.environ['SUPABASE_SERVICE_ROLE_KEY'],
            'Authorization': f'Bearer {os.environ["SUPABASE_SERVICE_ROLE_KEY"]}',
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
        }
        data = {'league': league, 'results': json.dumps({"summary": output, "bets": results["bets"]})}
        req.post(url, headers=headers, json=data)
        print("Uploaded to Supabase")
    except Exception as e:
        print(f"Supabase upload failed: {e}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--league", required=True)
    args = parser.parse_args()
    run_backtest(args.league)
