#!/usr/bin/env python3
"""
Import NFL weekly stats via nfl_data_py for years NOT already covered by CSV import.

Our CSV import covered 2010-2024. This covers 1999-2009 to fill in historical players.
Also re-runs 2010-2024 to catch any players missed by CSV name matching.

Usage:
  python3 import_nfl_pydatapy.py
  python3 import_nfl_pydatapy.py --dry-run
  python3 import_nfl_pydatapy.py --start-year 1999 --end-year 2009
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
    for p in players:
        raw = p.get("player_name", "").strip()
        if not raw:
            continue
        norm = normalize(raw)
        name_map[norm] = p["player_id"]
    # Also build last-name index for fuzzy matching
    last_name_index = {}
    for norm, pid in name_map.items():
        parts = norm.split()
        if len(parts) >= 2:
            last = parts[-1]
            if last not in last_name_index:
                last_name_index[last] = []
            last_name_index[last].append((norm, pid))
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

# ─── Helpers ─────────────────────────────────────────────────────────────────

def safe_float(val):
    if val is None:
        return 0.0
    try:
        v = float(val)
        return 0.0 if v != v else v  # NaN check
    except (ValueError, TypeError):
        return 0.0

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

def compute_composite(rush_yds, rush_tds, rec_yds, rec_tds, receptions, pass_yds, pass_tds, ints):
    return (rush_yds * 0.1 + rush_tds * 6 +
            rec_yds * 0.1 + rec_tds * 6 +
            receptions * 1.0 +
            pass_yds * 0.04 + pass_tds * 4 -
            ints * 2)

# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--start-year", type=int, default=1999)
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

    lookup_cache = {}
    unmatched = set()
    total_rows = 0
    total_matched = 0
    total_loaded = 0

    years = list(range(args.start_year, args.end_year + 1))
    print(f"\nImporting weekly data for {len(years)} seasons: {years[0]}-{years[-1]}", flush=True)

    for year in years:
        print(f"\n{'='*60}", flush=True)
        print(f"Season: {year}", flush=True)
        try:
            weekly = nfl.import_weekly_data([year])
        except Exception as e:
            print(f"  Error loading {year}: {e}", flush=True)
            continue

        print(f"  {len(weekly)} rows, {weekly['player_display_name'].nunique()} unique players", flush=True)

        db_rows = []
        for _, row in weekly.iterrows():
            total_rows += 1

            # Skip non-regular season
            st = str(row.get("season_type", "REG"))
            if st not in ("REG", ""):
                continue

            raw_name = str(row.get("player_display_name", "")).strip()
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

            season = int(row.get("season", year))
            week = int(row.get("week", 0))
            game_date = week_to_date(season, week)
            if not game_date:
                continue

            opponent = str(row.get("opponent_team", ""))

            rush_yds = safe_float(row.get("rushing_yards"))
            rush_tds = safe_float(row.get("rushing_tds"))
            rec_yds = safe_float(row.get("receiving_yards"))
            rec_tds = safe_float(row.get("receiving_tds"))
            receptions = safe_float(row.get("receptions"))
            pass_yds = safe_float(row.get("passing_yards"))
            pass_tds = safe_float(row.get("passing_tds"))
            ints = safe_float(row.get("interceptions"))
            carries = safe_float(row.get("carries"))

            if rush_yds == 0 and rec_yds == 0 and pass_yds == 0 and receptions == 0 and carries == 0:
                continue

            composite = compute_composite(rush_yds, rush_tds, rec_yds, rec_tds,
                                          receptions, pass_yds, pass_tds, ints)

            db_row = {
                "player_id": player_id,
                "league_slug": "nfl",
                "season": season,
                "game_date": game_date,
                "opponent": opponent if opponent != "nan" else "",
                "started": None,
                "minutes": None,
                "stat_goals": rush_tds + rec_tds + pass_tds,
                "stat_assists": receptions,
                "stat_sog": carries,
                "composite": round(composite, 2),
                "source_url": "nfl_data_py",
            }
            db_rows.append(db_row)
            total_matched += 1

        if db_rows:
            if not args.dry_run:
                n = sb_upsert("back_in_play_player_game_logs", db_rows)
                total_loaded += n
            else:
                total_loaded += len(db_rows)
            print(f"  Matched: {len(db_rows)}, loaded: {total_loaded} total", flush=True)

    print(f"\n{'='*60}")
    print(f"Total rows:      {total_rows}")
    print(f"Matched rows:    {total_matched}")
    print(f"Loaded/upserted: {total_loaded}")
    print(f"Unique names:    {len(lookup_cache)}")
    print(f"Matched players: {len(lookup_cache) - len(unmatched)}")
    print(f"Unmatched:       {len(unmatched)}")
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
