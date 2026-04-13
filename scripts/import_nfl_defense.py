#!/usr/bin/env python3
"""
Import NFL snap counts + defensive stats via nfl_data_py.

This covers ALL positions including defense, OL, kickers, etc.
Snap counts available from 2012+. PFR defensive stats from 2018+.

Usage:
  python3 import_nfl_defense.py
  python3 import_nfl_defense.py --dry-run
  python3 import_nfl_defense.py --start-year 2012 --end-year 2024
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
            else:
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
                else:
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

def build_player_map(league_id):
    players = []
    offset = 0
    while True:
        batch = sb_get("back_in_play_players",
                       "select=player_id,player_name&league_id=eq." + league_id + "&limit=1000&offset=" + str(offset))
        if not batch:
            break
        players.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000
    name_map = {}
    last_name_index = {}
    for p in players:
        raw = p.get("player_name", "").strip()
        if not raw:
            continue
        norm = normalize(raw)
        name_map[norm] = p["player_id"]
        parts = norm.split()
        if len(parts) >= 2:
            last = parts[-1]
            if last not in last_name_index:
                last_name_index[last] = []
            last_name_index[last].append((norm, p["player_id"]))
    print(f"  Loaded {len(players)} players, {len(name_map)} name variants", flush=True)
    return name_map, last_name_index

def fuzzy_match(name, name_map, last_name_index):
    norm = normalize(name)
    if norm in name_map:
        return name_map[norm]
    parts = norm.split()
    if len(parts) < 2:
        return None
    last = parts[-1]
    first_initial = parts[0][0] if parts[0] else ""
    candidates = last_name_index.get(last, [])
    if not candidates:
        return None
    for cand_norm, cand_pid in candidates:
        cand_parts = cand_norm.split()
        if len(cand_parts) >= 2 and cand_parts[0][0] == first_initial:
            return cand_pid
    return None

def week_to_date(season, week):
    import datetime
    try:
        year = int(season)
        w = int(week)
        base = datetime.date(year, 9, 1)
        days_until_sunday = (6 - base.weekday()) % 7
        first_sunday = base + datetime.timedelta(days=days_until_sunday)
        game_date = first_sunday + datetime.timedelta(weeks=w - 1)
        return game_date.isoformat()
    except (ValueError, TypeError):
        return None

def safe_float(val):
    if val is None:
        return 0.0
    try:
        v = float(val)
        return 0.0 if v != v else v
    except (ValueError, TypeError):
        return 0.0

# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--start-year", type=int, default=2012)
    parser.add_argument("--end-year", type=int, default=2024)
    args = parser.parse_args()

    import nfl_data_py as nfl

    leagues = sb_get("back_in_play_leagues", "select=league_id,slug&slug=eq.nfl")
    if not leagues:
        print("ERROR: NFL league not found")
        sys.exit(1)
    league_id = leagues[0]["league_id"]
    print(f"NFL league_id: {league_id}", flush=True)

    print("Building player name map...", flush=True)
    name_map, last_name_index = build_player_map(league_id)

    # Get player_ids that already have game logs (skip those)
    existing_pids = set()
    offset = 0
    while True:
        batch = sb_get("back_in_play_player_game_logs",
            "select=player_id&league_slug=eq.nfl&limit=1000&offset=" + str(offset))
        if not batch:
            break
        for r in batch:
            existing_pids.add(r["player_id"])
        if len(batch) < 1000:
            break
        offset += 1000
    print(f"  {len(existing_pids)} players already have game logs (will still import for completeness)", flush=True)

    lookup_cache = {}
    unmatched = set()
    total_rows = 0
    total_matched = 0
    total_loaded = 0
    total_new_players = 0

    years = list(range(args.start_year, args.end_year + 1))
    print(f"\nImporting snap counts for {len(years)} seasons: {years[0]}-{years[-1]}", flush=True)

    for year in years:
        print(f"\n{'='*60}", flush=True)
        print(f"Season: {year}", flush=True)

        # Load snap counts for this year
        try:
            snaps = nfl.import_snap_counts([year])
        except Exception as e:
            print(f"  Error loading snap counts for {year}: {e}", flush=True)
            continue

        # Filter to regular season
        snaps = snaps[snaps["game_type"] == "REG"]
        unique_players = snaps["player"].nunique()
        print(f"  {len(snaps)} snap rows, {unique_players} unique players", flush=True)

        db_rows = []
        for _, row in snaps.iterrows():
            total_rows += 1

            raw_name = str(row.get("player", "")).strip()
            if not raw_name or raw_name == "nan":
                continue

            if raw_name in lookup_cache:
                player_id = lookup_cache[raw_name]
            else:
                player_id = fuzzy_match(raw_name, name_map, last_name_index)
                lookup_cache[raw_name] = player_id
                if not player_id:
                    unmatched.add(raw_name)

            if not player_id:
                continue

            if player_id not in existing_pids:
                total_new_players += 1
                existing_pids.add(player_id)

            season = int(row.get("season", year))
            week = int(row.get("week", 0))
            game_date = week_to_date(season, week)
            if not game_date:
                continue

            opponent = str(row.get("opponent", ""))
            off_snaps = safe_float(row.get("offense_snaps"))
            def_snaps = safe_float(row.get("defense_snaps"))
            st_snaps = safe_float(row.get("st_snaps"))
            total_snaps = off_snaps + def_snaps + st_snaps

            if total_snaps == 0:
                continue

            # Composite for non-skill positions: snap participation score
            # Scale: 1 point per 10 snaps played
            composite = total_snaps * 0.1

            db_row = {
                "player_id": player_id,
                "league_slug": "nfl",
                "season": season,
                "game_date": game_date,
                "opponent": opponent if opponent != "nan" else "",
                "started": None,
                "minutes": round(total_snaps, 0),  # Using minutes for total snaps
                "stat_goals": 0,
                "stat_assists": 0,
                "stat_sog": 0,
                "composite": round(composite, 2),
                "source_url": "nfl_snap_counts",
            }
            db_rows.append(db_row)
            total_matched += 1

        if db_rows:
            if not args.dry_run:
                n = sb_upsert("back_in_play_player_game_logs", db_rows)
                total_loaded += n
            else:
                total_loaded += len(db_rows)
            print(f"  Matched: {len(db_rows)}, loaded: {total_loaded} total, new players: {total_new_players}", flush=True)

    print(f"\n{'='*60}")
    print(f"Total snap rows:     {total_rows}")
    print(f"Matched rows:        {total_matched}")
    print(f"Loaded/upserted:     {total_loaded}")
    print(f"Unique names:        {len(lookup_cache)}")
    print(f"Matched players:     {len(lookup_cache) - len(unmatched)}")
    print(f"New players w/logs:  {total_new_players}")
    print(f"Unmatched:           {len(unmatched)}")
    if args.dry_run:
        print("(DRY RUN - no DB writes)")
    print(f"{'='*60}")

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
