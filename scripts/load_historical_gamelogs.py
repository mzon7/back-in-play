#!/usr/bin/env python3
"""
Load historical game log data from public datasets into back_in_play_player_game_logs.
Matches players by name to our DB, computes composite scores.

Sources:
  NBA: github.com/NocturneBear/NBA-Data-2010-2024 (box scores 2010-2024)
  NFL: github.com/nflverse/nflverse-data (player stats 1999-present)
  NHL: moneypuck.com skaters game-by-game (2008-2024, local CSV)
  EPL: github.com/vaastav/Fantasy-Premier-League (2016-2025)
  MLB: github.com/chadwickbureau/retrosplits (per-game stats 2010-2025)

Usage:
  python3 load_historical_gamelogs.py --league nba
  python3 load_historical_gamelogs.py --league nfl
  python3 load_historical_gamelogs.py --league nhl
  python3 load_historical_gamelogs.py --league mlb
  python3 load_historical_gamelogs.py --league premier-league
  python3 load_historical_gamelogs.py                          # all leagues
"""

import argparse
import csv
import io
import json
import os
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

# ─── Env & Supabase ──────────────────────────────────────────────────────────

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

USER_AGENT = "Mozilla/5.0 (compatible)"

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
        "Prefer": "return=representation,resolution=merge-duplicates",
    }
    url = SB_URL + "/rest/v1/" + table
    if conflict:
        url += "?on_conflict=" + conflict
    total = 0
    for i in range(0, len(rows), 50):
        batch = rows[i:i + 50]
        try:
            req = urllib.request.Request(url, data=json.dumps(batch).encode(),
                                        headers=hdrs, method="POST")
            resp = urllib.request.urlopen(req, timeout=60)
            result = json.loads(resp.read().decode())
            total += len(result) if isinstance(result, list) else 1
        except Exception as e:
            # Row-by-row fallback
            for row in batch:
                try:
                    req2 = urllib.request.Request(url, data=json.dumps([row]).encode(),
                                                  headers=hdrs, method="POST")
                    urllib.request.urlopen(req2, timeout=30).read()
                    total += 1
                except Exception:
                    pass
    return total

def fetch_csv(url):
    """Download a CSV and return parsed rows."""
    print(f"  Downloading {url[:80]}...", flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    resp = urllib.request.urlopen(req, timeout=120)
    text = resp.read().decode("utf-8", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    return list(reader)

# ─── Composite score (same as pipeline) ─────────────────────────────────────

def compute_composite(row, league):
    def g(field):
        v = row.get(field)
        return float(v) if v is not None else 0.0
    if league == "nba":
        return g("stat_pts") + 1.2 * g("stat_reb") + 1.5 * g("stat_ast") + 3.0 * g("stat_stl") + 3.0 * g("stat_blk")
    elif league == "nfl":
        return (0.04 * g("stat_pass_yds") + 4.0 * g("stat_pass_td") +
                0.1 * g("stat_rush_yds") + 6.0 * g("stat_rush_td") +
                g("stat_rec") + 0.1 * g("stat_rec_yds"))
    elif league == "nhl":
        return 3.0 * g("stat_goals") + 0.5 * g("stat_sog")
    elif league == "premier-league":
        return 6.0 * g("stat_goals") + 3.0 * g("stat_assists") + 0.1 * g("minutes")
    return 0.0

# ─── Player name → player_id mapping ────────────────────────────────────────

def build_player_map(league_id):
    """Build name → player_id mapping for a league."""
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
        name = p.get("player_name", "").strip().lower()
        if name:
            name_map[name] = p["player_id"]
    print(f"  Loaded {len(name_map)} players from DB", flush=True)
    return name_map

# ─── NBA loader ──────────────────────────────────────────────────────────────

NBA_CSV_URLS = [
    "https://raw.githubusercontent.com/NocturneBear/NBA-Data-2010-2024/main/regular_season_box_scores_2010_2024_part_1.csv",
    "https://raw.githubusercontent.com/NocturneBear/NBA-Data-2010-2024/main/regular_season_box_scores_2010_2024_part_2.csv",
    "https://raw.githubusercontent.com/NocturneBear/NBA-Data-2010-2024/main/regular_season_box_scores_2010_2024_part_3.csv",
    "https://raw.githubusercontent.com/NocturneBear/NBA-Data-2010-2024/main/play_off_box_scores_2010_2024.csv",
]

def _parse_nba_minutes(mins_str):
    """Parse NBA minutes like '35:22' or 'PT35M22S' or '35'."""
    if not mins_str or mins_str.strip() in ("", "-", "None"):
        return None
    mins_str = mins_str.strip()
    if ":" in mins_str:
        parts = mins_str.split(":")
        try:
            return float(parts[0]) + float(parts[1]) / 60.0
        except ValueError:
            return None
    if "PT" in mins_str:
        # ISO duration: PT35M22.00S
        import re
        m = re.search(r'(\d+)M', mins_str)
        s = re.search(r'([\d.]+)S', mins_str)
        total = 0
        if m: total += int(m.group(1))
        if s: total += float(s.group(1)) / 60.0
        return total if total > 0 else None
    try:
        return float(mins_str)
    except ValueError:
        return None

def _safe_float(val):
    if val is None or str(val).strip() in ("", "-", "None", "nan"):
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None

def load_nba(league_id):
    name_map = build_player_map(league_id)

    total_loaded = 0
    matched = 0
    unmatched = set()

    for csv_url in NBA_CSV_URLS:
        rows = fetch_csv(csv_url)
        print(f"  {len(rows)} rows in CSV", flush=True)

        db_rows = []
        for row in rows:
            name = (row.get("personName") or "").strip().lower()
            player_id = name_map.get(name)
            if not player_id:
                unmatched.add(name)
                continue

            # Parse game date: "2010-11-10" format
            game_date = row.get("game_date", "")
            if not game_date or len(game_date) < 10:
                continue
            game_date = game_date[:10]

            minutes = _parse_nba_minutes(row.get("minutes"))
            if minutes is None or minutes == 0:
                continue

            # Season year from "2010-11" → 2011, "2023-24" → 2024
            season_str = row.get("season_year", "")
            try:
                season = int(season_str.split("-")[0]) + 1 if "-" in season_str else int(season_str)
            except (ValueError, IndexError):
                continue

            db_row = {
                "player_id": player_id,
                "league_slug": "nba",
                "season": season,
                "game_date": game_date,
                "opponent": row.get("matchup", "")[-3:] if row.get("matchup") else "",
                "started": row.get("position", "") != "",
                "minutes": minutes,
                "stat_pts": _safe_float(row.get("points")),
                "stat_reb": _safe_float(row.get("reboundsTotal")),
                "stat_ast": _safe_float(row.get("assists")),
                "stat_stl": _safe_float(row.get("steals")),
                "stat_blk": _safe_float(row.get("blocks")),
            }
            db_row["composite"] = compute_composite(db_row, "nba")
            db_rows.append(db_row)
            matched += 1

        # Upsert in batches
        if db_rows:
            n = sb_upsert("back_in_play_player_game_logs", db_rows, conflict="player_id,game_date")
            total_loaded += n
            print(f"  Upserted {n} rows", flush=True)

    print(f"\nNBA: {total_loaded} game logs loaded, {matched} matched, {len(unmatched)} unmatched players", flush=True)
    if len(unmatched) <= 20:
        print(f"  Unmatched: {sorted(unmatched)[:20]}")
    return total_loaded

# ─── NFL loader ──────────────────────────────────────────────────────────────

NFL_CSV_URL = "https://github.com/nflverse/nflverse-data/releases/download/player_stats/player_stats.csv"

def load_nfl(league_id):
    name_map = build_player_map(league_id)

    rows = fetch_csv(NFL_CSV_URL)
    print(f"  {len(rows)} rows in CSV", flush=True)

    db_rows = []
    matched = 0
    unmatched = set()

    for row in rows:
        name = (row.get("player_display_name") or "").strip().lower()
        player_id = name_map.get(name)
        if not player_id:
            unmatched.add(name)
            continue

        # NFL doesn't have per-game dates directly. We need season + week.
        # Skip for now if no way to get exact date.
        # Actually, nflverse has schedule data we could cross-reference,
        # but for simplicity let's construct a pseudo-date from season/week.
        season = row.get("season")
        week = row.get("week")
        season_type = row.get("season_type", "REG")
        opponent = row.get("opponent_team", "")

        if not season or not week:
            continue
        try:
            season = int(season)
            week = int(week)
        except ValueError:
            continue

        # Approximate game date: NFL regular season starts week 1 in early September
        # Week 1 ≈ Sept 7, each subsequent week +7 days
        if season_type == "REG":
            # Sept 7 + (week-1)*7 days as approximation
            base = datetime(season, 9, 7)
        else:
            # Postseason: Jan of next year
            base = datetime(season + 1, 1, 7)

        from datetime import timedelta
        game_date = (base + timedelta(days=(week - 1) * 7)).strftime("%Y-%m-%d")

        db_row = {
            "player_id": player_id,
            "league_slug": "nfl",
            "season": season,
            "game_date": game_date,
            "opponent": opponent,
            "started": False,
            "minutes": None,
            "stat_pass_yds": _safe_float(row.get("passing_yards")),
            "stat_pass_td": _safe_float(row.get("passing_tds")),
            "stat_rush_yds": _safe_float(row.get("rushing_yards")),
            "stat_rush_td": _safe_float(row.get("rushing_tds")),
            "stat_rec": _safe_float(row.get("receptions")),
            "stat_rec_yds": _safe_float(row.get("receiving_yards")),
        }
        db_row["composite"] = compute_composite(db_row, "nfl")
        db_rows.append(db_row)
        matched += 1

    if db_rows:
        n = sb_upsert("back_in_play_player_game_logs", db_rows, conflict="player_id,game_date")
        print(f"  Upserted {n} rows", flush=True)
    else:
        n = 0

    print(f"\nNFL: {n} game logs loaded, {matched} matched, {len(unmatched)} unmatched players", flush=True)
    return n

# ─── NHL loader (moneypuck skaters game-by-game) ─────────────────────────────
# Uses local CSV: ~/Downloads/moneypuck/small_csv/2008_to_2024.csv
# Columns: playerId, name, gameId, season, playerTeam, opposingTeam,
#           home_or_away, gameDate, position, situation, icetime, goals, ongoal
# Note: no assists column in game-by-game data; composite uses goals + SOG

NHL_CSV_PATH = os.path.expanduser("~/Downloads/moneypuck/small_csv/skaters_2008_to_2024.csv")

def load_nhl(league_id):
    name_map = build_player_map(league_id)

    if not os.path.exists(NHL_CSV_PATH):
        print(f"  NHL CSV not found at {NHL_CSV_PATH}", flush=True)
        print("  Run: cd ~/Downloads/moneypuck && unzip -o 'skaters_2008_to_2024.zip'", flush=True)
        return 0

    print(f"  Reading {NHL_CSV_PATH}...", flush=True)
    with open(NHL_CSV_PATH, "r", encoding="utf-8", errors="replace") as f:
        reader = csv.DictReader(f)
        rows_by_player = {}  # (player_id, game_date) → row
        matched = 0
        unmatched = set()
        skipped_situation = 0

        for row in reader:
            # Only use "all" situation (sum of all situations)
            if row.get("situation") != "all":
                skipped_situation += 1
                continue

            # Skip goalies
            if row.get("position") == "G":
                continue

            name = (row.get("name") or "").strip().lower()
            player_id = name_map.get(name)
            if not player_id:
                unmatched.add(name)
                continue

            # Parse gameDate: "20081009" → "2008-10-09"
            gd_raw = row.get("gameDate", "")
            if len(gd_raw) != 8:
                continue
            game_date = f"{gd_raw[:4]}-{gd_raw[4:6]}-{gd_raw[6:8]}"

            season = int(row.get("season", 0))
            if not season:
                continue

            # NHL season convention: 2008 means 2008-09 season
            # Our DB uses end year for NBA/NHL: 2008-09 = 2009
            # But moneypuck uses start year. Convert to end year.
            season_end = season + 1

            icetime = _safe_float(row.get("icetime"))
            # icetime is in seconds for "all" situation
            minutes = icetime / 60.0 if icetime and icetime > 0 else None
            if not minutes or minutes < 1:
                continue

            goals = _safe_float(row.get("goals"))
            sog = _safe_float(row.get("ongoal"))

            key = (player_id, game_date)
            db_row = {
                "player_id": player_id,
                "league_slug": "nhl",
                "season": season_end,
                "game_date": game_date,
                "opponent": row.get("opposingTeam", ""),
                "started": True,  # NHL players who appear in game data played
                "minutes": round(minutes, 1) if minutes else None,
                "stat_goals": goals,
                "stat_sog": sog,
            }
            db_row["composite"] = compute_composite(db_row, "nhl")
            rows_by_player[key] = db_row
            matched += 1

    db_rows = list(rows_by_player.values())
    print(f"  {matched} matched rows, {len(unmatched)} unmatched players, {skipped_situation} non-all rows skipped", flush=True)

    total = 0
    if db_rows:
        for i in range(0, len(db_rows), 500):
            batch = db_rows[i:i + 500]
            n = sb_upsert("back_in_play_player_game_logs", batch, conflict="player_id,game_date")
            total += n
            if (i + 500) % 5000 == 0:
                print(f"  Upserted {total} rows so far...", flush=True)
        print(f"  Upserted {total} total rows", flush=True)

    print(f"\nNHL: {total} game logs loaded, {matched} matched, {len(unmatched)} unmatched players", flush=True)
    if len(unmatched) <= 20:
        print(f"  Unmatched: {sorted(unmatched)[:20]}")
    return total


# ─── EPL loader (FPL CSV) ───────────────────────────────────────────────────

FPL_SEASONS = [
    "2016-17", "2017-18", "2018-19", "2019-20",
    "2020-21", "2021-22", "2022-23", "2023-24", "2024-25",
]

def load_epl(league_id):
    name_map = build_player_map(league_id)

    total_loaded = 0
    total_matched = 0
    unmatched = set()

    for season_str in FPL_SEASONS:
        url = f"https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data/{season_str}/gws/merged_gw.csv"
        try:
            rows = fetch_csv(url)
        except Exception as e:
            print(f"  Failed to fetch {season_str}: {e}", flush=True)
            continue

        print(f"  {season_str}: {len(rows)} rows", flush=True)

        # Season year: "2023-24" → 2023
        season_year = int(season_str.split("-")[0])

        db_rows = []
        for row in rows:
            name = (row.get("name") or "").strip().lower()
            player_id = name_map.get(name)
            if not player_id:
                unmatched.add(name)
                continue

            kickoff = row.get("kickoff_time", "")
            game_date = kickoff[:10] if kickoff else ""
            if not game_date:
                continue

            minutes = _safe_float(row.get("minutes"))
            if minutes is None or minutes == 0:
                continue

            db_row = {
                "player_id": player_id,
                "league_slug": "premier-league",
                "season": season_year,
                "game_date": game_date,
                "opponent": str(row.get("opponent_team", "")),
                "started": row.get("starts", "0") == "1",
                "minutes": minutes,
                "stat_goals": _safe_float(row.get("goals_scored")),
                "stat_assists": _safe_float(row.get("assists")),
            }
            db_row["composite"] = compute_composite(db_row, "premier-league")
            db_rows.append(db_row)
            total_matched += 1

        if db_rows:
            n = sb_upsert("back_in_play_player_game_logs", db_rows, conflict="player_id,game_date")
            total_loaded += n
            print(f"  {season_str}: upserted {n} rows", flush=True)

    print(f"\nEPL: {total_loaded} game logs loaded, {total_matched} matched, {len(unmatched)} unmatched", flush=True)
    return total_loaded


# ─── MLB loader (retrosplits day-by-day) ─────────────────────────────────────
# Uses github.com/chadwickbureau/retrosplits/daybyday/playing-{YEAR}.csv
# Per-game batting + pitching stats per player
# Key batting cols: B_AB, B_H, B_HR, B_RBI, B_BB, B_SO, B_R, B_2B, B_3B
# Key pitching cols: P_G, P_GS, P_OUT, P_SO (strikeouts), P_BB, P_ER, P_H
# MLB composite: batting = H + 2*2B + 3*3B + 4*HR + RBI + 0.5*BB
#                pitching = (IP*3) + SO - ER - 0.5*BB  (outs → IP)

MLB_YEARS = list(range(2010, 2026))  # 2010-2025

def load_mlb(league_id):
    name_map = build_player_map(league_id)

    # retrosplits uses person.key (retrosheet IDs like "abadf001")
    # Our DB uses player_name for matching. Build name→player_id map (already done above).

    total_loaded = 0
    total_matched = 0
    unmatched = set()

    for year in MLB_YEARS:
        url = f"https://raw.githubusercontent.com/chadwickbureau/retrosplits/master/daybyday/playing-{year}.csv"
        try:
            rows = fetch_csv(url)
        except Exception as e:
            print(f"  Failed to fetch {year}: {e}", flush=True)
            continue

        print(f"  {year}: {len(rows)} rows", flush=True)

        # retrosplits uses person.key (retrosheet ID), not player name.
        # We need to map retrosheet IDs to our player names.
        # Since we only have name→player_id, we need a retrosheet_id→name mapping.
        # Unfortunately retrosplits doesn't include player names in playing files.
        # We'll need to use the register or skip this approach.
        # Alternative: build a retrosheet_id→name map from our DB's sport_ref_id field.

        # Actually, our DB has sport_ref_id which for MLB IS the baseball-reference ID
        # (e.g., "troutmi01"). Retrosheet uses a different ID format ("troum001").
        # These don't match directly.

        # Better approach: use the Chadwick register to map person.key → name,
        # then match name to our DB.
        # For now, skip if we can't match.
        # Let's try fetching the register for name mapping.
        pass

    # The retrosplits data uses retrosheet IDs (person.key) which don't match
    # our DB's player names directly. We need a mapping file.
    # Try Chadwick register: github.com/chadwickbureau/register
    print("  Loading Chadwick register for name mapping...", flush=True)
    register_url = "https://raw.githubusercontent.com/chadwickbureau/register/master/data/people.csv"
    try:
        reg_rows = fetch_csv(register_url)
    except Exception as e:
        print(f"  Failed to fetch register: {e}", flush=True)
        print("  Cannot map retrosheet IDs to names. Aborting MLB load.", flush=True)
        return 0

    # Build retrosheet_key → full_name map
    retro_to_name = {}
    for r in reg_rows:
        key = r.get("key_retro", "").strip()
        first = r.get("name_first", "").strip()
        last = r.get("name_last", "").strip()
        if key and first and last:
            retro_to_name[key] = f"{first} {last}".lower()

    print(f"  Register: {len(retro_to_name)} retrosheet ID → name mappings", flush=True)

    # Now process each year
    for year in MLB_YEARS:
        url = f"https://raw.githubusercontent.com/chadwickbureau/retrosplits/master/daybyday/playing-{year}.csv"
        try:
            rows = fetch_csv(url)
        except Exception as e:
            continue

        db_rows = []
        for row in rows:
            # Only regular season
            if row.get("season.phase", "R") != "R":
                continue

            person_key = row.get("person.key", "").strip()
            name = retro_to_name.get(person_key)
            if not name:
                continue

            player_id = name_map.get(name)
            if not player_id:
                unmatched.add(name)
                continue

            game_date = row.get("game.date", "")
            if not game_date or len(game_date) < 10:
                continue

            # Determine if this is a batting or pitching line
            b_ab = _safe_float(row.get("B_AB"))
            p_out = _safe_float(row.get("P_OUT"))

            is_batter = b_ab is not None and b_ab > 0
            is_pitcher = p_out is not None and p_out > 0

            if not is_batter and not is_pitcher:
                continue

            db_row = {
                "player_id": player_id,
                "league_slug": "mlb",
                "season": year,
                "game_date": game_date,
                "opponent": row.get("opponent.key", ""),
                "started": int(row.get("slot", "0") or "0") > 0,
            }

            if is_batter:
                hits = _safe_float(row.get("B_H")) or 0
                doubles = _safe_float(row.get("B_2B")) or 0
                triples = _safe_float(row.get("B_3B")) or 0
                hr = _safe_float(row.get("B_HR")) or 0
                rbi = _safe_float(row.get("B_RBI")) or 0
                bb = _safe_float(row.get("B_BB")) or 0

                db_row["stat_hits"] = hits
                db_row["stat_hr"] = hr
                db_row["stat_rbi"] = rbi
                db_row["stat_bb"] = bb
                db_row["stat_so"] = _safe_float(row.get("B_SO"))
                db_row["stat_ab"] = b_ab
                # Batting composite: H + 2*2B + 3*3B + 4*HR + RBI + 0.5*BB
                db_row["composite"] = hits + 2 * doubles + 3 * triples + 4 * hr + rbi + 0.5 * bb

            if is_pitcher:
                p_so = _safe_float(row.get("P_SO")) or 0
                p_er = _safe_float(row.get("P_ER")) or 0
                p_bb = _safe_float(row.get("P_BB")) or 0
                ip = (p_out or 0) / 3.0
                db_row["stat_ip"] = round(ip, 1)
                db_row["stat_er"] = p_er
                db_row["stat_k"] = p_so
                db_row["minutes"] = ip * 15  # rough estimate for "time played"
                # Pitching composite: IP*3 + K - ER - 0.5*BB
                p_composite = ip * 3 + p_so - p_er - 0.5 * p_bb
                if not is_batter:
                    db_row["composite"] = p_composite
                else:
                    # Two-way player: use higher composite
                    db_row["composite"] = max(db_row.get("composite", 0), p_composite)

            db_rows.append(db_row)
            total_matched += 1

        if db_rows:
            n = sb_upsert("back_in_play_player_game_logs", db_rows, conflict="player_id,game_date")
            total_loaded += n
            print(f"  {year}: upserted {n} rows", flush=True)

    print(f"\nMLB: {total_loaded} game logs loaded, {total_matched} matched, {len(unmatched)} unmatched", flush=True)
    if len(unmatched) <= 20:
        print(f"  Unmatched: {sorted(unmatched)[:20]}")
    return total_loaded

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Load historical game logs from public datasets")
    parser.add_argument("--league", type=str, help="Single league (nba, nfl, nhl, mlb, premier-league)")
    args = parser.parse_args()

    # Get league IDs
    leagues = sb_get("back_in_play_leagues", "select=league_id,slug")
    lid_map = {l["slug"]: l["league_id"] for l in (leagues or [])}

    leagues_to_load = [args.league] if args.league else ["nba", "nfl", "nhl", "mlb", "premier-league"]

    for slug in leagues_to_load:
        lid = lid_map.get(slug)
        if not lid:
            print(f"League {slug} not found in DB")
            continue

        print(f"\n{'=' * 50}")
        print(f"Loading {slug.upper()} historical game logs")
        print(f"{'=' * 50}\n")

        if slug == "nba":
            load_nba(lid)
        elif slug == "nfl":
            load_nfl(lid)
        elif slug == "nhl":
            load_nhl(lid)
        elif slug == "premier-league":
            load_epl(lid)
        elif slug == "mlb":
            load_mlb(lid)
        else:
            print(f"No loader for {slug} yet")


if __name__ == "__main__":
    main()
