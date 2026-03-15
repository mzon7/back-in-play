#!/usr/bin/env python3
"""
Import NHL game-by-game CSV (moneypuck skaters) into back_in_play_player_game_logs.

CSV source: /workspace/back-in-play/scripts/nhl_skaters_gamebygame.csv
Columns: name, season, gameDate, opposingTeam, icetime, I_F_goals,
         I_F_primaryAssists, I_F_secondaryAssists, I_F_shotsOnGoal,
         I_F_points, I_F_hits, I_F_blockedShotAttempts, position

Usage:
  python3 import_nhl_csv.py
  python3 import_nhl_csv.py --csv /path/to/nhl_skaters_gamebygame.csv
  python3 import_nhl_csv.py --dry-run
"""

import argparse
import csv
import json
import os
import re
import sys
import unicodedata
from pathlib import Path

# ─── Env ─────────────────────────────────────────────────────────────────────

def load_env():
    for envfile in ["/root/.daemon-env", ".env", "../.env"]:
        p = Path(envfile)
        if p.exists():
            for line in p.read_text().splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, val = line.partition("=")
                    os.environ.setdefault(key.strip(), val.strip().strip("'\""))

load_env()

SB_URL = os.environ.get("SUPABASE_URL", "")
SB_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
if not SB_URL or not SB_KEY:
    print("ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
    sys.exit(1)

# ─── Supabase REST helpers ───────────────────────────────────────────────────

import urllib.request
import urllib.parse

def sb_get(table, params=""):
    url = SB_URL + "/rest/v1/" + table + "?" + params
    hdrs = {"apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY}
    try:
        req = urllib.request.Request(url, headers=hdrs)
        resp = urllib.request.urlopen(req, timeout=30)
        return json.loads(resp.read().decode())
    except Exception as e:
        print(f"  [SB GET ERR] {table}: {e}", flush=True)
        return []

def sb_upsert(table, rows, conflict=""):
    if not rows:
        return 0
    # Deduplicate by conflict keys
    if conflict:
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
    url = SB_URL + "/rest/v1/" + table
    if conflict:
        url += "?on_conflict=" + conflict
    total = 0
    for i in range(0, len(rows), 200):
        batch = rows[i:i + 200]
        try:
            req = urllib.request.Request(url, data=json.dumps(batch).encode(),
                                        headers=hdrs, method="POST")
            urllib.request.urlopen(req, timeout=120).read()
            total += len(batch)
        except Exception as e:
            # Smaller batch fallback
            for j in range(0, len(batch), 20):
                mini = batch[j:j + 20]
                try:
                    req2 = urllib.request.Request(url, data=json.dumps(mini).encode(),
                                                  headers=hdrs, method="POST")
                    urllib.request.urlopen(req2, timeout=60).read()
                    total += len(mini)
                except Exception as e2:
                    print(f"    [UPSERT ERR] batch {j}: {e2}", flush=True)
    return total

# ─── Name normalization ──────────────────────────────────────────────────────

def strip_accents(s):
    """Remove accents/diacritics from a string."""
    nfkd = unicodedata.normalize("NFKD", s)
    return "".join(c for c in nfkd if not unicodedata.combining(c))

def normalize_name(name):
    """Lowercase, strip accents, collapse whitespace."""
    return re.sub(r"\s+", " ", strip_accents(name).lower().strip())

# ─── Build player name → player_id map ──────────────────────────────────────

def build_player_map(league_id):
    """Build normalized name → player_id mapping for NHL players."""
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
        norm = normalize_name(raw)
        name_map[norm] = p["player_id"]
        # Also strip common position prefixes (e.g., "F Bobby Ryan")
        for prefix in ("f ", "c ", "d ", "g ", "lw ", "rw ", "ds ", "c/f ", "f/c ", "d/f ", "c/w ", "w "):
            if norm.startswith(prefix):
                clean = norm[len(prefix):]
                if clean and clean not in name_map:
                    name_map[clean] = p["player_id"]
                break

    print(f"  Loaded {len(players)} players, {len(name_map)} name variants", flush=True)
    return name_map

# ─── Helpers ─────────────────────────────────────────────────────────────────

def safe_float(val):
    if val is None or str(val).strip() in ("", "-", "None", "nan"):
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None

def compute_composite(goals, primary_a, secondary_a, sog, hits, blocked, minutes):
    """NHL composite: goals*6 + primary_assists*4 + secondary_assists*2 + sog*0.5 + hits*0.5 + blocked*0.5 + (minutes/20)*2"""
    return (goals * 6.0
            + primary_a * 4.0
            + secondary_a * 2.0
            + sog * 0.5
            + hits * 0.5
            + blocked * 0.5
            + (minutes / 20.0) * 2.0)

# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Import NHL moneypuck CSV into game logs")
    parser.add_argument("--csv", type=str, default="/workspace/back-in-play/scripts/nhl_skaters_gamebygame.csv",
                        help="Path to nhl_skaters_gamebygame.csv")
    parser.add_argument("--dry-run", action="store_true", help="Parse and match without upserting")
    args = parser.parse_args()

    csv_path = args.csv
    if not os.path.exists(csv_path):
        print(f"ERROR: CSV not found at {csv_path}")
        sys.exit(1)

    # Get NHL league_id
    leagues = sb_get("back_in_play_leagues", "select=league_id,slug&slug=eq.nhl")
    if not leagues:
        print("ERROR: NHL league not found in back_in_play_leagues")
        sys.exit(1)
    league_id = leagues[0]["league_id"]
    print(f"NHL league_id: {league_id}", flush=True)

    # Build player lookup
    print("Building player name map...", flush=True)
    name_map = build_player_map(league_id)

    # Cache: CSV name → player_id (avoid repeated normalize + lookup)
    lookup_cache = {}
    unmatched = set()
    total_rows = 0
    total_matched = 0
    total_loaded = 0
    db_rows = []

    print(f"Reading CSV: {csv_path}", flush=True)
    with open(csv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row_num, row in enumerate(reader, 1):
            total_rows += 1

            # --- Player lookup ---
            raw_name = (row.get("name") or "").strip()
            if not raw_name:
                continue

            if raw_name in lookup_cache:
                player_id = lookup_cache[raw_name]
            else:
                norm = normalize_name(raw_name)
                player_id = name_map.get(norm)
                lookup_cache[raw_name] = player_id
                if not player_id:
                    unmatched.add(raw_name)

            if not player_id:
                continue

            # --- Date conversion: "20090102" → "2009-01-02" ---
            gd_raw = row.get("gameDate", "")
            if len(gd_raw) != 8:
                continue
            game_date = f"{gd_raw[:4]}-{gd_raw[4:6]}-{gd_raw[6:8]}"

            # --- Season ---
            season = int(row.get("season", "0"))
            if season < 2008:
                continue

            # --- Stats ---
            icetime_sec = safe_float(row.get("icetime")) or 0
            minutes = round(icetime_sec / 60.0, 1)

            goals = safe_float(row.get("I_F_goals")) or 0
            primary_a = safe_float(row.get("I_F_primaryAssists")) or 0
            secondary_a = safe_float(row.get("I_F_secondaryAssists")) or 0
            assists = primary_a + secondary_a
            sog = safe_float(row.get("I_F_shotsOnGoal")) or 0
            hits = safe_float(row.get("I_F_hits")) or 0
            blocked = safe_float(row.get("I_F_blockedShotAttempts")) or 0

            composite = compute_composite(goals, primary_a, secondary_a, sog, hits, blocked, minutes)

            db_row = {
                "player_id": player_id,
                "league_slug": "nhl",
                "season": season + 1,  # moneypuck uses start year, we use end year
                "game_date": game_date,
                "opponent": row.get("opposingTeam", ""),
                "started": True,
                "minutes": minutes,
                "stat_goals": goals,
                "stat_assists": assists,
                "stat_sog": sog,
                "composite": round(composite, 2),
            }
            db_rows.append(db_row)
            total_matched += 1

            # Batch upsert every 500 rows
            if len(db_rows) >= 500:
                if not args.dry_run:
                    n = sb_upsert("back_in_play_player_game_logs", db_rows, conflict="player_id,game_date")
                    total_loaded += n
                else:
                    total_loaded += len(db_rows)
                db_rows = []
                if total_matched % 2000 < 500:
                    print(f"  [{total_rows} rows read] {total_matched} matched, {total_loaded} loaded, {len(unmatched)} unmatched players",
                          flush=True)

    # Final batch
    if db_rows:
        if not args.dry_run:
            n = sb_upsert("back_in_play_player_game_logs", db_rows, conflict="player_id,game_date")
            total_loaded += n
        else:
            total_loaded += len(db_rows)

    # Summary
    print(f"\n{'=' * 60}")
    print(f"CSV rows:        {total_rows}")
    print(f"Matched rows:    {total_matched}")
    print(f"Loaded/upserted: {total_loaded}")
    print(f"Unique players:  {len(lookup_cache)}")
    print(f"Unmatched:       {len(unmatched)}")
    if args.dry_run:
        print("(DRY RUN - no DB writes)")
    print(f"{'=' * 60}")

    if unmatched and len(unmatched) <= 30:
        print("\nUnmatched player names:")
        for name in sorted(unmatched):
            print(f"  {name}")
    elif unmatched:
        print(f"\nFirst 30 unmatched (of {len(unmatched)}):")
        for name in sorted(unmatched)[:30]:
            print(f"  {name}")


if __name__ == "__main__":
    main()
