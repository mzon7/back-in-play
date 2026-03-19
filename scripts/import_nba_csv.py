#!/usr/bin/env python3
"""
Import NBA game-by-game CSV (from NocturneBear/NBA-Data-2010-2024) into game logs.

Matches CSV player names to our DB players using fuzzy matching.
No ESPN IDs needed — matches by name directly.

CSV columns: season_year, game_date, personId, personName, position,
             minutes, points, reboundsTotal, assists, steals, blocks,
             turnovers, fieldGoalsMade, fieldGoalsAttempted, etc.

Usage:
  python3 import_nba_csv.py
  python3 import_nba_csv.py --csv-dir /path/to/nba_data
  python3 import_nba_csv.py --dry-run

Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
"""

import argparse
import csv
import json
import os
import re
import sys
import time
import unicodedata
import urllib.parse
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
    """Build normalized name → player_id mapping for NBA players."""
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
    if val is None or str(val).strip() in ("", "-", "None", "nan", "N/A"):
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None

def parse_minutes(minutes_str):
    """Parse minutes string like '32:15' or '32' to float."""
    if not minutes_str or minutes_str.strip() in ("", "-", "None"):
        return 0.0
    try:
        if ":" in minutes_str:
            parts = minutes_str.split(":")
            return int(parts[0]) + int(parts[1]) / 60.0
        return float(minutes_str)
    except (ValueError, IndexError):
        return 0.0

def season_to_int(season_str):
    """Convert '2023-24' to 2024 (end year)."""
    try:
        parts = season_str.split("-")
        start = int(parts[0])
        return start + 1
    except (ValueError, IndexError):
        return 0

def compute_composite(pts, reb, ast, stl, blk):
    """NBA composite: pts + reb*1.2 + ast*1.5 + stl*3 + blk*3"""
    return (pts + reb * 1.2 + ast * 1.5 + stl * 3.0 + blk * 3.0)

# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Import NBA CSV box scores into game logs")
    parser.add_argument("--csv-dir", type=str,
                        default=os.path.join(os.path.dirname(__file__), "nba_data"),
                        help="Directory containing part1.csv, part2.csv, part3.csv")
    parser.add_argument("--dry-run", action="store_true", help="Parse and match without upserting")
    args = parser.parse_args()

    csv_dir = args.csv_dir
    csv_files = []
    for name in ["part1.csv", "part2.csv", "part3.csv",
                  "regular_season_box_scores_2010_2024_part_1.csv",
                  "regular_season_box_scores_2010_2024_part_2.csv",
                  "regular_season_box_scores_2010_2024_part_3.csv"]:
        path = os.path.join(csv_dir, name)
        if os.path.exists(path):
            csv_files.append(path)

    if not csv_files:
        print(f"ERROR: No CSV files found in {csv_dir}")
        sys.exit(1)

    print(f"CSV files: {csv_files}", flush=True)

    # Get NBA league_id
    leagues = sb_get("back_in_play_leagues", "select=league_id,slug&slug=eq.nba")
    if not leagues:
        print("ERROR: NBA league not found")
        sys.exit(1)
    league_id = leagues[0]["league_id"]
    print(f"NBA league_id: {league_id}", flush=True)

    # Build player lookup
    print("Building player name map...", flush=True)
    name_map = build_player_map(league_id)

    # Process CSVs
    lookup_cache = {}
    unmatched = set()
    total_rows = 0
    total_matched = 0
    total_loaded = 0
    db_rows = []

    for csv_path in csv_files:
        print(f"\nReading: {csv_path}", flush=True)
        with open(csv_path, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                total_rows += 1

                # Player lookup
                raw_name = (row.get("personName") or "").strip()
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

                # Date
                game_date = row.get("game_date", "")
                if not game_date or len(game_date) < 8:
                    continue

                # Season
                season_str = row.get("season_year", "")
                season = season_to_int(season_str)
                if season < 2010:
                    continue

                # Stats
                minutes = parse_minutes(row.get("minutes", ""))
                pts = safe_float(row.get("points")) or 0
                reb = safe_float(row.get("reboundsTotal")) or 0
                ast = safe_float(row.get("assists")) or 0
                stl = safe_float(row.get("steals")) or 0
                blk = safe_float(row.get("blocks")) or 0
                fgm = safe_float(row.get("fieldGoalsMade")) or 0
                fga = safe_float(row.get("fieldGoalsAttempted")) or 0
                tpm = safe_float(row.get("threePointersMade")) or 0

                composite = compute_composite(pts, reb, ast, stl, blk)

                # Opponent from matchup (e.g., "NJN @ CLE" -> "CLE" if NJN is our team)
                matchup = row.get("matchup", "")
                opponent = ""
                if " @ " in matchup:
                    parts = matchup.split(" @ ")
                    team_tri = row.get("teamTricode", "")
                    if team_tri == parts[0].strip():
                        opponent = parts[1].strip()
                    else:
                        opponent = parts[0].strip()
                elif " vs. " in matchup:
                    parts = matchup.split(" vs. ")
                    team_tri = row.get("teamTricode", "")
                    if team_tri == parts[0].strip():
                        opponent = parts[1].strip()
                    else:
                        opponent = parts[0].strip()

                db_row = {
                    "player_id": player_id,
                    "league_slug": "nba",
                    "season": season,
                    "game_date": game_date,
                    "opponent": opponent,
                    "started": None,
                    "minutes": round(minutes, 1),
                    "stat_goals": pts,  # Using stat_goals for points in NBA
                    "stat_assists": ast,
                    "stat_sog": fgm,  # Using stat_sog for FGM
                    "composite": round(composite, 2),
                    "source_url": "nba_csv_2010_2024",
                }
                db_rows.append(db_row)
                total_matched += 1

                # Batch upsert every 500
                if len(db_rows) >= 500:
                    if not args.dry_run:
                        n = pg_upsert("back_in_play_player_game_logs", db_rows, conflict_cols=["player_id", "game_date"])
                        total_loaded += n
                    else:
                        total_loaded += len(db_rows)
                    db_rows = []
                    if total_matched % 5000 < 500:
                        print(f"  [{total_rows} rows] {total_matched} matched, "
                              f"{total_loaded} loaded, {len(unmatched)} unmatched",
                              flush=True)

    # Final batch
    if db_rows:
        if not args.dry_run:
            n = pg_upsert("back_in_play_player_game_logs", db_rows, conflict_cols=["player_id", "game_date"])
            total_loaded += n
        else:
            total_loaded += len(db_rows)

    # Summary
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
