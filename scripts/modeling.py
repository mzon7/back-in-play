#!/usr/bin/env python3
"""
Performance prediction model for post-injury return.

Uses features like:
  - Age at injury
  - Injury type and body part
  - Total prior injuries / same body part recurrence
  - Days since last injury
  - Time missed (recovery days)
  - Pre-injury performance baseline (5g, 10g, 20g composites)
  - Minutes trend before injury
  - Position
  - League

Target: performance_drop_pct (post-return 5-game avg vs pre-injury 5-game avg)

This script is designed to be run incrementally and expanded over time.
"""

import json
import os
import sys
import math
import statistics
import argparse
from datetime import datetime
import urllib.request

# ─── Supabase helpers ─────────────────────────────────────────────────────────

def load_env():
    for f in ["/root/.daemon-env", ".env", "../.env"]:
        if os.path.exists(f):
            with open(f) as fh:
                for line in fh:
                    line = line.strip()
                    if "=" in line and not line.startswith("#"):
                        k, v = line.split("=", 1)
                        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

load_env()

SB_URL = os.environ.get("SUPABASE_URL", os.environ.get("VITE_SUPABASE_URL", ""))
SB_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", os.environ.get("VITE_SUPABASE_ANON_KEY", ""))


def sb_get(table, params=""):
    url = SB_URL + "/rest/v1/" + table + "?" + params
    hdrs = {"apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY}
    try:
        req = urllib.request.Request(url, headers=hdrs)
        resp = urllib.request.urlopen(req, timeout=60)
        return json.loads(resp.read().decode())
    except Exception as e:
        print(f"  [SB GET ERR] {table}: {e}", flush=True)
        return []


def sb_get_all(table, params=""):
    """Paginate through all rows."""
    all_rows = []
    offset = 0
    page_size = 1000
    while True:
        sep = "&" if params else ""
        page_params = f"{params}{sep}limit={page_size}&offset={offset}"
        batch = sb_get(table, page_params)
        if not batch:
            break
        all_rows.extend(batch)
        if len(batch) < page_size:
            break
        offset += page_size
    return all_rows


def sb_patch(table, filter_params, data):
    url = SB_URL + "/rest/v1/" + table + "?" + filter_params
    hdrs = {
        "apikey": SB_KEY,
        "Authorization": "Bearer " + SB_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, headers=hdrs, method="PATCH")
    try:
        urllib.request.urlopen(req, timeout=30)
    except Exception as e:
        print(f"  [SB PATCH ERR] {table}: {e}", flush=True)


# ─── Feature extraction ──────────────────────────────────────────────────────

LEAGUE_STATS = {
    "nba": ["stat_pts", "stat_reb", "stat_ast", "stat_stl", "stat_blk"],
    "nfl": ["stat_pass_yds", "stat_pass_td", "stat_rush_yds", "stat_rush_td",
             "stat_rec", "stat_rec_yds"],
    "nhl": ["stat_goals", "stat_assists", "stat_sog"],
    "mlb": ["stat_h", "stat_hr", "stat_rbi", "stat_r", "stat_sb"],
    "premier-league": ["stat_goals", "stat_assists"],
}


def extract_features(case_row, game_logs):
    """Extract model features from a return case and its game logs."""
    features = {}

    # Basic info
    features["league"] = case_row.get("league_slug", "")
    features["position"] = case_row.get("position", "")
    features["injury_type"] = case_row.get("injury_type", "")
    features["recovery_days"] = case_row.get("recovery_days", 0)
    features["games_missed"] = case_row.get("games_missed", 0) or 0

    # From enrichment columns
    features["age_at_injury"] = case_row.get("age_at_injury")
    features["total_prior_injuries"] = case_row.get("total_prior_injuries", 0) or 0
    features["days_since_last_injury"] = case_row.get("days_since_last_injury")
    features["same_body_part_prior"] = case_row.get("same_body_part_prior", 0) or 0

    # Pre-injury baselines
    features["pre_baseline_5g"] = case_row.get("pre_baseline_5g")
    features["pre_baseline_season"] = case_row.get("pre_baseline_season")

    # Game log features
    try:
        injury_date = case_row.get("date_injured", "")
        pre_games = sorted(
            [g for g in game_logs if g["game_date"] < injury_date],
            key=lambda g: g["game_date"],
            reverse=True,
        )

        # Pre-injury minutes trend
        if pre_games:
            minutes = [g.get("minutes") for g in pre_games[:10] if g.get("minutes")]
            if len(minutes) >= 3:
                features["pre_avg_minutes_5g"] = statistics.mean(minutes[:5]) if len(minutes) >= 5 else statistics.mean(minutes)
                features["pre_avg_minutes_10g"] = statistics.mean(minutes[:10])
                # Minutes trend (are they playing more or less?)
                if len(minutes) >= 5:
                    recent = statistics.mean(minutes[:3])
                    older = statistics.mean(minutes[3:min(8, len(minutes))])
                    features["minutes_trend"] = (recent - older) / older if older > 0 else 0

            # Pre-injury composite trend
            composites = [g.get("composite") for g in pre_games[:10] if g.get("composite")]
            if len(composites) >= 5:
                features["pre_composite_5g"] = statistics.mean(composites[:5])
                features["pre_composite_10g"] = statistics.mean(composites[:10])
                features["pre_composite_20g"] = statistics.mean(
                    [g.get("composite") for g in pre_games[:20] if g.get("composite")]
                )

    except (ValueError, TypeError):
        pass

    # Target: performance drop %
    features["performance_drop_pct"] = case_row.get("performance_drop_pct")

    return features


# ─── Compute performance drop for return cases ───────────────────────────────

def compute_performance_drops():
    """For each return case, compute performance_drop_pct from post_game_composites."""
    print("Loading return cases...", flush=True)
    cases = sb_get_all("back_in_play_injury_return_cases",
                       "select=case_id,injury_id,player_id,league_slug,pre_baseline_5g,post_game_composites,performance_drop_pct")

    print(f"  {len(cases)} total return cases", flush=True)

    # Only compute for cases without performance_drop_pct
    to_update = [c for c in cases if c.get("performance_drop_pct") is None and c.get("pre_baseline_5g")]
    print(f"  {len(to_update)} need performance_drop_pct computed", flush=True)

    updated = 0
    for c in to_update:
        raw = c.get("post_game_composites")
        if not raw:
            continue
        if isinstance(raw, str):
            raw = json.loads(raw)
        if isinstance(raw, dict):
            games = raw.get("games", [])
        else:
            games = raw

        # Post-return first 5 games composite average
        post_5 = [g.get("composite") for g in games[:5] if g.get("composite") is not None]
        if not post_5:
            continue

        post_avg = statistics.mean(post_5)
        pre_avg = c["pre_baseline_5g"]
        if pre_avg and pre_avg > 0:
            drop_pct = round((post_avg - pre_avg) / pre_avg * 100, 1)
            sb_patch("back_in_play_injury_return_cases",
                     f"case_id=eq.{c['case_id']}",
                     {"performance_drop_pct": drop_pct})
            updated += 1

    print(f"  Updated {updated} cases with performance_drop_pct", flush=True)


# ─── Export training data ─────────────────────────────────────────────────────

def export_training_data(output_path="training_data.json"):
    """Export features for all return cases to a JSON file for modeling."""
    print("Loading return cases...", flush=True)
    cases = sb_get_all("back_in_play_injury_return_cases",
                       "select=*&performance_drop_pct=not.is.null")
    print(f"  {len(cases)} cases with performance_drop_pct", flush=True)

    if not cases:
        print("No cases to export.")
        return

    # Load game logs for all players
    player_ids = list(set(c["player_id"] for c in cases))
    print(f"  Loading game logs for {len(player_ids)} players...", flush=True)

    game_log_map = {}
    for i in range(0, len(player_ids), 50):
        batch = player_ids[i:i + 50]
        ids_str = ",".join(batch)
        logs = sb_get("back_in_play_player_game_logs",
                      f"select=player_id,game_date,minutes,composite&player_id=in.({ids_str})&order=game_date.desc&limit=5000")
        for g in (logs or []):
            game_log_map.setdefault(g["player_id"], []).append(g)

    # Extract features
    training = []
    for c in cases:
        logs = game_log_map.get(c["player_id"], [])
        feats = extract_features(c, logs)
        if feats.get("performance_drop_pct") is not None:
            training.append(feats)

    with open(output_path, "w") as f:
        json.dump(training, f, indent=2)

    print(f"  Exported {len(training)} training examples to {output_path}", flush=True)

    # Summary stats
    drops = [t["performance_drop_pct"] for t in training]
    print(f"\n  Performance drop summary:")
    print(f"    Mean: {statistics.mean(drops):.1f}%")
    print(f"    Median: {statistics.median(drops):.1f}%")
    print(f"    Std Dev: {statistics.stdev(drops):.1f}%")
    print(f"    Min: {min(drops):.1f}%, Max: {max(drops):.1f}%")

    # By league
    by_league = {}
    for t in training:
        by_league.setdefault(t["league"], []).append(t["performance_drop_pct"])
    print(f"\n  By league:")
    for lg, vals in sorted(by_league.items()):
        print(f"    {lg}: mean={statistics.mean(vals):.1f}%, n={len(vals)}")

    # By injury type (top 10)
    by_injury = {}
    for t in training:
        by_injury.setdefault(t["injury_type"], []).append(t["performance_drop_pct"])
    top_injuries = sorted(by_injury.items(), key=lambda x: -len(x[1]))[:15]
    print(f"\n  By injury type (top 15):")
    for inj, vals in top_injuries:
        print(f"    {inj}: mean={statistics.mean(vals):.1f}%, n={len(vals)}")


# ─── Simple linear model ─────────────────────────────────────────────────────

def train_simple_model(data_path="training_data.json"):
    """Train a simple model to predict performance drop.

    This is a baseline — can be replaced with sklearn/xgboost later.
    Uses weighted feature averages as a simple predictor.
    """
    with open(data_path) as f:
        data = json.load(f)

    if len(data) < 50:
        print(f"Only {len(data)} samples — need more data for meaningful modeling.")
        return

    print(f"Training on {len(data)} samples...\n")

    # Group by (league, injury_type) and compute mean drop
    groups = {}
    for d in data:
        key = (d["league"], d["injury_type"])
        groups.setdefault(key, []).append(d["performance_drop_pct"])

    print("Predicted performance drop by (league, injury_type):")
    print(f"{'League':<20} {'Injury':<25} {'Mean Drop':>10} {'StdDev':>10} {'N':>5}")
    print("-" * 72)
    for (league, injury), vals in sorted(groups.items(), key=lambda x: -len(x[1])):
        if len(vals) >= 5:
            mean = statistics.mean(vals)
            sd = statistics.stdev(vals) if len(vals) > 1 else 0
            print(f"{league:<20} {injury:<25} {mean:>9.1f}% {sd:>9.1f}% {len(vals):>5}")

    # Feature importance (correlation with performance_drop_pct)
    numeric_features = ["recovery_days", "games_missed", "total_prior_injuries",
                        "same_body_part_prior", "age_at_injury", "days_since_last_injury"]
    print("\nFeature correlations with performance drop:")
    for feat in numeric_features:
        pairs = [(d[feat], d["performance_drop_pct"]) for d in data
                 if d.get(feat) is not None and d.get("performance_drop_pct") is not None]
        if len(pairs) < 30:
            continue
        xs, ys = zip(*pairs)
        mean_x, mean_y = statistics.mean(xs), statistics.mean(ys)
        cov = sum((x - mean_x) * (y - mean_y) for x, y in pairs) / len(pairs)
        std_x = statistics.stdev(xs)
        std_y = statistics.stdev(ys)
        corr = cov / (std_x * std_y) if std_x > 0 and std_y > 0 else 0
        print(f"  {feat:<30} r={corr:>6.3f}  (n={len(pairs)})")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Post-injury performance modeling")
    parser.add_argument("--compute-drops", action="store_true",
                        help="Compute performance_drop_pct for all return cases")
    parser.add_argument("--export", action="store_true",
                        help="Export training data to JSON")
    parser.add_argument("--train", action="store_true",
                        help="Train simple baseline model")
    parser.add_argument("--output", type=str, default="training_data.json",
                        help="Output path for training data")
    args = parser.parse_args()

    if args.compute_drops:
        compute_performance_drops()
    elif args.export:
        export_training_data(args.output)
    elif args.train:
        train_simple_model(args.output)
    else:
        # Default: run all steps
        compute_performance_drops()
        export_training_data(args.output)
        train_simple_model(args.output)


if __name__ == "__main__":
    main()
