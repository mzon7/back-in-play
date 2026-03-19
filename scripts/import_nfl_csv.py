#!/usr/bin/env python3
"""
Import NFL weekly player stats (from nflverse) into game logs.

CSV source: nflverse-data releases (player_stats_{year}.csv)
Columns: player_display_name, season, week, opponent_team,
         carries, rushing_yards, rushing_tds, receptions, receiving_yards,
         receiving_tds, passing_yards, passing_tds, completions, attempts, etc.

Usage:
  python3 import_nfl_csv.py
  python3 import_nfl_csv.py --csv-dir /path/to/nfl_data
  python3 import_nfl_csv.py --dry-run
"""

import argparse
import csv
import glob
import json
import os
import re
import sys
import time
import unicodedata
import urllib.request
from pathlib import Path

from db_writer import pg_upsert

# ─── Supabase read helpers (kept — reads via REST are fine) ──────────────────

def sb_get(table, params=""):
    from db_writer import SB_URL, SB_KEY
    url = SB_URL + "/rest/v1/" + table + "?" + params
    hdrs = {"apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY}
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=hdrs)
            resp = urllib.request.urlopen(req, timeout=30)
            return json.loads(resp.read().decode())
        except Exception as e:
            if attempt < 2:
                time.sleep(3)
                continue
            print(f"  [SB GET ERR] {table}: {e}", flush=True)
            return []

# ─── Name normalization ──────────────────────────────────────────────────────

SUFFIXES = {"jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"}

def normalize(name):
    nfkd = unicodedata.normalize("NFKD", name)
    stripped = "".join(c for c in nfkd if not unicodedata.combining(c))
    cleaned = stripped.replace("'", "").replace("\u2019", "").replace(".", "").replace("-", " ")
    parts = cleaned.lower().split()
    parts = [p for p in parts if p not in SUFFIXES]
    return " ".join(parts)

def build_player_map(league_id):
    players = []
    offset = 0
    while True:
        batch = sb_get("back_in_play_players",
                       f"select=player_id,player_name&league_id=eq.{league_id}&limit=1000&offset={offset}")
        if not batch:
            break
        players.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000

    name_map = {}
    for p in players:
        raw = p.get("player_name", "").strip()
        if not raw:
            continue
        norm = normalize(raw)
        name_map[norm] = p["player_id"]
    print(f"  Loaded {len(players)} players, {len(name_map)} name variants", flush=True)
    return name_map

# ─── Helpers ─────────────────────────────────────────────────────────────────

def safe_float(val):
    if val is None or str(val).strip() in ("", "-", "None", "nan", "NA", "N/A"):
        return 0.0
    try:
        return float(val)
    except (ValueError, TypeError):
        return 0.0

def week_to_date(season, week):
    """Approximate game date from season + week number.
    NFL weeks start around Sept for week 1. This is approximate."""
    import datetime
    # NFL regular season typically starts first Thursday of September
    # Week 1 is usually around Sept 7-13
    try:
        year = int(season)
        w = int(week)
        # Approximate: Sept 1 + (week-1) * 7 days
        base = datetime.date(year, 9, 1)
        # Find first Sunday
        days_until_sunday = (6 - base.weekday()) % 7
        first_sunday = base + datetime.timedelta(days=days_until_sunday)
        game_date = first_sunday + datetime.timedelta(weeks=w - 1)
        return game_date.isoformat()
    except (ValueError, TypeError):
        return None

def compute_composite(rush_yds, rush_tds, rec_yds, rec_tds, receptions, pass_yds, pass_tds, ints):
    """NFL composite: rush_yds*0.1 + rush_tds*6 + rec_yds*0.1 + rec_tds*6 + receptions*1 +
    pass_yds*0.04 + pass_tds*4 - ints*2 (fantasy-style scoring)"""
    return (rush_yds * 0.1 + rush_tds * 6 +
            rec_yds * 0.1 + rec_tds * 6 +
            receptions * 1.0 +
            pass_yds * 0.04 + pass_tds * 4 -
            ints * 2)

# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Import NFL weekly stats into game logs")
    parser.add_argument("--csv-dir", type=str,
                        default=os.path.join(os.path.dirname(__file__), "nfl_data"),
                        help="Directory containing player_stats_YYYY.csv files")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    csv_dir = args.csv_dir
    csv_files = sorted(glob.glob(os.path.join(csv_dir, "player_stats_*.csv")))
    if not csv_files:
        print(f"ERROR: No CSV files found in {csv_dir}")
        sys.exit(1)

    print(f"Found {len(csv_files)} CSV files", flush=True)

    # Get NFL league_id
    leagues = sb_get("back_in_play_leagues", "select=league_id,slug&slug=eq.nfl")
    if not leagues:
        print("ERROR: NFL league not found")
        sys.exit(1)
    league_id = leagues[0]["league_id"]
    print(f"NFL league_id: {league_id}", flush=True)

    # Build player lookup
    print("Building player name map...", flush=True)
    name_map = build_player_map(league_id)

    lookup_cache = {}
    unmatched = set()
    total_rows = 0
    total_matched = 0
    total_loaded = 0
    db_rows = []

    for csv_path in csv_files:
        print(f"\nReading: {os.path.basename(csv_path)}", flush=True)
        with open(csv_path, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                total_rows += 1

                # Skip non-regular season for now
                if row.get("season_type", "") not in ("REG", ""):
                    continue

                raw_name = (row.get("player_display_name") or "").strip()
                if not raw_name:
                    continue

                if raw_name in lookup_cache:
                    player_id = lookup_cache[raw_name]
                else:
                    norm = normalize(raw_name)
                    player_id = name_map.get(norm)
                    lookup_cache[raw_name] = player_id
                    if not player_id:
                        unmatched.add(raw_name)

                if not player_id:
                    continue

                season = row.get("season", "")
                week = row.get("week", "")
                game_date = week_to_date(season, week)
                if not game_date:
                    continue

                opponent = row.get("opponent_team", "")

                # Stats
                rush_yds = safe_float(row.get("rushing_yards"))
                rush_tds = safe_float(row.get("rushing_tds"))
                rec_yds = safe_float(row.get("receiving_yards"))
                rec_tds = safe_float(row.get("receiving_tds"))
                receptions = safe_float(row.get("receptions"))
                pass_yds = safe_float(row.get("passing_yards"))
                pass_tds = safe_float(row.get("passing_tds"))
                ints = safe_float(row.get("interceptions"))
                carries = safe_float(row.get("carries"))
                fantasy_pts = safe_float(row.get("fantasy_points_ppr"))

                # Skip rows with zero everything
                if rush_yds == 0 and rec_yds == 0 and pass_yds == 0 and receptions == 0 and carries == 0:
                    continue

                composite = compute_composite(rush_yds, rush_tds, rec_yds, rec_tds,
                                              receptions, pass_yds, pass_tds, ints)

                db_row = {
                    "player_id": player_id,
                    "league_slug": "nfl",
                    "season": int(season) if season else 0,
                    "game_date": game_date,
                    "opponent": opponent,
                    "started": None,
                    "minutes": None,  # NFL doesn't have minutes played in this data
                    "stat_goals": rush_tds + rec_tds + pass_tds,  # Total TDs
                    "stat_assists": receptions,
                    "stat_sog": carries,  # Using for carries
                    "stat_pass_yds": pass_yds,
                    "stat_rush_yds": rush_yds,
                    "stat_rec_yds": rec_yds,
                    "stat_rec": receptions,
                    "composite": round(composite, 2),
                    "source_url": "nflverse_csv",
                }
                db_rows.append(db_row)
                total_matched += 1

                if len(db_rows) >= 500:
                    if not args.dry_run:
                        n = pg_upsert("back_in_play_player_game_logs", db_rows, conflict_cols=["player_id", "game_date"])
                        total_loaded += n
                    else:
                        total_loaded += len(db_rows)
                    db_rows = []
                    if total_matched % 5000 < 500:
                        print(f"  [{total_rows} rows] {total_matched} matched, "
                              f"{total_loaded} loaded, {len(unmatched)} unmatched", flush=True)

    # Final batch
    if db_rows:
        if not args.dry_run:
            n = pg_upsert("back_in_play_player_game_logs", db_rows, conflict_cols=["player_id", "game_date"])
            total_loaded += n
        else:
            total_loaded += len(db_rows)

    print(f"\n{'=' * 60}")
    print(f"CSV rows:        {total_rows}")
    print(f"Matched rows:    {total_matched}")
    print(f"Loaded/upserted: {total_loaded}")
    print(f"Unique players:  {len(lookup_cache)}")
    print(f"Matched players: {len(lookup_cache) - len(unmatched)}")
    print(f"Unmatched:       {len(unmatched)}")
    if args.dry_run:
        print("(DRY RUN - no DB writes)")
    print(f"{'=' * 60}")

    if unmatched and len(unmatched) <= 40:
        print("\nUnmatched player names:")
        for name in sorted(unmatched):
            print(f"  {name}")
    elif unmatched:
        print(f"\nFirst 40 unmatched (of {len(unmatched)}):")
        for name in sorted(unmatched)[:40]:
            print(f"  {name}")

if __name__ == "__main__":
    main()
