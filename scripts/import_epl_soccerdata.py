#!/usr/bin/env python3
"""
Import EPL player match stats via soccerdata (FBref) into Supabase.

Uses probberechts/soccerdata to pull FBref player match logs.

Usage:
  python3 import_epl_soccerdata.py
  python3 import_epl_soccerdata.py --dry-run
  python3 import_epl_soccerdata.py --start-season 2020 --end-season 2024
"""

import argparse
import json
import os
import sys
import time
import unicodedata
import urllib.request
from pathlib import Path

# ─── Env ─────────────────────────────────────────────────────────────────────

def load_env():
    for envfile in ["/root/.daemon-env", ".env", "../.env"]:
        p = Path(envfile)
        if p.exists():
            for line in p.read_text().splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    if line.startswith("export "):
                        line = line[7:]
                    key, _, val = line.partition("=")
                    os.environ.setdefault(key.strip(), val.strip().strip("'\""))

load_env()

SB_URL = os.environ.get("SUPABASE_URL", "")
SB_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
if not SB_URL or not SB_KEY:
    print("ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
    sys.exit(1)

# ─── Supabase REST helpers ───────────────────────────────────────────────────

def sb_get(table, params=""):
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

def sb_upsert(table, rows, conflict="player_id,game_date"):
    if not rows:
        return 0
    keys = conflict.split(",")
    seen = set()
    unique = []
    for r in rows:
        k = tuple(r.get(c) for c in keys)
        if k not in seen:
            seen.add(k)
            unique.append(r)
    rows = unique

    hdrs = {
        "apikey": SB_KEY,
        "Authorization": "Bearer " + SB_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=minimal,resolution=merge-duplicates",
    }
    url = SB_URL + "/rest/v1/" + table + "?on_conflict=" + conflict
    total = 0
    for i in range(0, len(rows), 200):
        batch = rows[i:i + 200]
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, data=json.dumps(batch).encode(),
                                            headers=hdrs, method="POST")
                urllib.request.urlopen(req, timeout=120).read()
                total += len(batch)
                break
            except Exception as e:
                if attempt < 2:
                    time.sleep(5 * (attempt + 1))
                    continue
                for j in range(0, len(batch), 20):
                    mini = batch[j:j + 20]
                    try:
                        req2 = urllib.request.Request(url, data=json.dumps(mini).encode(),
                                                     headers=hdrs, method="POST")
                        urllib.request.urlopen(req2, timeout=60).read()
                        total += len(mini)
                    except Exception as e2:
                        print(f"    [UPSERT ERR] {e2}", flush=True)
    return total

# ─── Name normalization ──────────────────────────────────────────────────────

SUFFIXES = {"jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"}

def normalize(name):
    nfkd = unicodedata.normalize("NFKD", name)
    stripped = "".join(c for c in nfkd if not unicodedata.combining(c))
    cleaned = stripped.replace("'", "").replace("\u2019", "").replace(".", "").replace("-", " ")
    parts = cleaned.lower().split()
    parts = [p for p in parts if p not in SUFFIXES]
    return " ".join(parts)

# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Import EPL player stats via soccerdata/FBref")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--start-season", type=int, default=2017)
    parser.add_argument("--end-season", type=int, default=2024)
    args = parser.parse_args()

    try:
        import soccerdata as sd
        import pandas as pd
    except ImportError:
        print("ERROR: Install soccerdata: pip3 install soccerdata")
        sys.exit(1)

    # Get EPL league_id from our DB
    leagues = sb_get("back_in_play_leagues", "select=league_id,slug&slug=eq.premier-league")
    if not leagues:
        print("ERROR: EPL league not found")
        sys.exit(1)
    league_id = leagues[0]["league_id"]
    print(f"EPL league_id: {league_id}", flush=True)

    # Build player name map from DB
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
    print(f"Loaded {len(players)} EPL players, {len(name_map)} name variants", flush=True)

    # Pull FBref data season by season
    total_logs = 0
    total_loaded = 0
    total_matched = 0
    unmatched = set()
    lookup_cache = {}

    for season_year in range(args.start_season, args.end_season + 1):
        season_str = str(season_year)
        print(f"\n{'='*60}", flush=True)
        print(f"Fetching FBref data for {season_str}...", flush=True)

        try:
            fbref = sd.FBref("ENG-Premier League", season_str)
            # Try to get player match logs
            try:
                player_stats = fbref.read_player_season_stats(stat_type="standard")
            except Exception as e:
                print(f"  Error reading stats for {season_str}: {e}", flush=True)
                continue

            if player_stats is None or player_stats.empty:
                print(f"  No data for {season_str}", flush=True)
                continue

            print(f"  Got {len(player_stats)} player-season rows", flush=True)

            # Reset index to get player names as columns
            df = player_stats.reset_index()
            print(f"  Columns: {list(df.columns)[:20]}", flush=True)

            db_rows = []
            for _, row in df.iterrows():
                # Try to find the player name column
                raw_name = None
                for col in ["player", "Player", "player_name"]:
                    if col in df.columns:
                        raw_name = str(row[col]).strip()
                        break

                if not raw_name or raw_name == "nan":
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

                total_matched += 1

                # Extract stats - column names vary by FBref version
                goals = 0
                assists = 0
                minutes = 0
                for col_name, var_name in [
                    (("Gls", "goals", "Goals"), "goals"),
                    (("Ast", "assists", "Assists"), "assists"),
                    (("Min", "minutes", "Minutes"), "minutes"),
                ]:
                    for cn in col_name:
                        if cn in df.columns:
                            try:
                                val = float(row[cn]) if str(row[cn]) not in ("", "nan", "None") else 0
                            except (ValueError, TypeError):
                                val = 0
                            if var_name == "goals":
                                goals = val
                            elif var_name == "assists":
                                assists = val
                            elif var_name == "minutes":
                                minutes = val
                            break

                # For season-level stats, create a single summary row per season
                # We'll use July 1 of the end year as a placeholder date
                game_date = f"{season_year + 1}-01-01"

                matches_played = 0
                for cn in ("MP", "matches_played", "Matches"):
                    if cn in df.columns:
                        try:
                            matches_played = int(float(str(row[cn]))) if str(row[cn]) not in ("", "nan") else 0
                        except (ValueError, TypeError):
                            pass
                        break

                # EPL composite: goals*6 + assists*3 + (minutes/90)*0.5
                nineties = minutes / 90.0 if minutes > 0 else 0
                composite = goals * 6 + assists * 3 + nineties * 0.5

                db_row = {
                    "player_id": player_id,
                    "league_slug": "premier-league",
                    "season": season_year,
                    "game_date": game_date,
                    "opponent": "",
                    "started": None,
                    "minutes": round(minutes, 1) if minutes else None,
                    "stat_goals": goals,
                    "stat_assists": assists,
                    "stat_sog": matches_played,  # Using for matches played
                    "composite": round(composite, 2),
                    "source_url": "fbref_soccerdata",
                }
                db_rows.append(db_row)
                total_logs += 1

            # Upsert this season
            if db_rows:
                if not args.dry_run:
                    n = sb_upsert("back_in_play_player_game_logs", db_rows)
                    total_loaded += n
                else:
                    total_loaded += len(db_rows)
                print(f"  Season {season_str}: {len(db_rows)} rows, {total_loaded} total loaded", flush=True)

            # Rate limit FBref scraping
            time.sleep(5)

        except Exception as e:
            print(f"  Error for season {season_str}: {e}", flush=True)
            import traceback
            traceback.print_exc()
            time.sleep(5)

    print(f"\n{'='*60}")
    print(f"EPL Players in DB:    {len(players)}")
    print(f"Matched to FBref:     {total_matched}")
    print(f"Game log rows:        {total_logs}")
    print(f"Loaded/upserted:      {total_loaded}")
    print(f"Unmatched:            {len(unmatched)}")
    if args.dry_run:
        print("(DRY RUN - no DB writes)")
    print(f"{'='*60}")

    if unmatched and len(unmatched) <= 40:
        print("\nUnmatched player names:")
        for name in sorted(unmatched):
            print(f"  {name}")

if __name__ == "__main__":
    main()
