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

from db_writer import pg_upsert

USER_AGENT = "Mozilla/5.0 (compatible)"

# ─── Supabase read helpers (kept — reads via REST are fine) ──────────────────

def sb_get(table, params=""):
    from db_writer import SB_URL, SB_KEY
    url = SB_URL + "/rest/v1/" + table + "?" + params
    hdrs = {"apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY}
    try:
        req = urllib.request.Request(url, headers=hdrs)
        resp = urllib.request.urlopen(req, timeout=30)
        return json.loads(resp.read().decode())
    except Exception as e:
        print(f"  [SB GET ERR] {table}: {e}", flush=True)
        return []

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
    # Common position prefixes in scraped player names (e.g., "F Bobby Ryan")
    pos_prefixes = ("f ", "c ", "d ", "g ", "lw ", "rw ", "ds ", "c/f ", "f/c ", "d/f ",
                    "c/w ", "w ", "rw/lw ", "lw/rw ")
    for p in players:
        name = p.get("player_name", "").strip().lower()
        if name:
            name_map[name] = p["player_id"]
            # Also add without position prefix for matching
            for prefix in pos_prefixes:
                if name.startswith(prefix):
                    clean = name[len(prefix):]
                    if clean and clean not in name_map:
                        name_map[clean] = p["player_id"]
                    break
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
            n = pg_upsert("back_in_play_player_game_logs", db_rows, conflict_cols=["player_id", "game_date"])
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
        n = pg_upsert("back_in_play_player_game_logs", db_rows, conflict_cols=["player_id", "game_date"])
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

def load_nhl(league_id):
    """NHL: Load from moneypuck extracted CSV (nhl_skaters_gamebygame.csv).
    This is a 48MB extract of the 2.6GB full file, filtered to situation='all'.
    Columns: name, season, gameDate, opposingTeam, icetime, I_F_goals,
             I_F_primaryAssists, I_F_secondaryAssists, I_F_shotsOnGoal,
             I_F_points, I_F_hits, I_F_blockedShotAttempts, position
    """
    csv_path = os.path.join(os.path.dirname(__file__), "nhl_skaters_gamebygame.csv")
    if not os.path.exists(csv_path):
        print(f"  NHL CSV not found at {csv_path}", flush=True)
        print("  Extract it from moneypuck 2008_to_2024.csv (situation='all' rows only)", flush=True)
        return 0

    name_map = build_player_map(league_id)

    total_loaded = 0
    total_matched = 0
    unmatched = set()
    db_rows = []

    with open(csv_path, "r") as f:
        reader = csv.DictReader(f)
        for row_num, row in enumerate(reader, 1):
            name = (row.get("name") or "").strip().lower()
            player_id = name_map.get(name)
            if not player_id:
                unmatched.add(name)
                continue

            gd_raw = row.get("gameDate", "")
            if len(gd_raw) == 8:  # 20090102 → 2009-01-02
                game_date = f"{gd_raw[:4]}-{gd_raw[4:6]}-{gd_raw[6:8]}"
            else:
                continue

            season = int(row.get("season", "0"))
            if season < 2008:
                continue

            icetime = _safe_float(row.get("icetime"))
            minutes = round(icetime / 60.0, 1) if icetime else None

            goals = _safe_float(row.get("I_F_goals")) or 0
            sog = _safe_float(row.get("I_F_shotsOnGoal")) or 0
            primary_a = _safe_float(row.get("I_F_primaryAssists")) or 0
            secondary_a = _safe_float(row.get("I_F_secondaryAssists")) or 0
            assists = primary_a + secondary_a

            db_row = {
                "player_id": player_id,
                "league_slug": "nhl",
                "season": season + 1,  # moneypuck uses start year, we use end year for NHL
                "game_date": game_date,
                "opponent": row.get("opposingTeam", ""),
                "started": True,  # moneypuck doesn't track this
                "minutes": minutes,
                "stat_goals": goals,
                "stat_assists": assists,
                "stat_sog": sog,
                "stat_hits": _safe_float(row.get("I_F_hits")),
                "stat_blocks": _safe_float(row.get("I_F_blockedShotAttempts")),
            }
            # NHL composite: 3*G + 2*A + 0.5*SOG + 0.5*hits + 0.5*blocks
            db_row["composite"] = 3.0 * goals + 2.0 * assists + 0.5 * sog

            db_rows.append(db_row)
            total_matched += 1

            if len(db_rows) >= 500:
                n = pg_upsert("back_in_play_player_game_logs", db_rows, conflict_cols=["player_id", "game_date"])
                total_loaded += n
                db_rows = []
                if total_loaded % 10000 < 500:
                    print(f"  {total_loaded} loaded so far...", flush=True)

    if db_rows:
        n = pg_upsert("back_in_play_player_game_logs", db_rows, conflict_cols=["player_id", "game_date"])
        total_loaded += n

    print(f"\nNHL: {total_loaded} game logs loaded, {total_matched} matched, {len(unmatched)} unmatched", flush=True)
    if len(unmatched) <= 20:
        for name in sorted(unmatched):
            print(f"    unmatched: {name}", flush=True)
    return total_loaded


# ─── NHL API loader (for players missing from moneypuck CSV) ─────────────────

NHL_API_SEASONS = ["20102011", "20112012", "20122013", "20132014", "20142015",
                   "20152016", "20162017", "20172018", "20182019", "20192020",
                   "20202021", "20212022", "20222023", "20232024", "20242025", "20252026"]


def _nhl_api_search(player_name):
    """Search NHL API for a player by name, return NHL playerId or None."""
    q = urllib.parse.quote(player_name)
    url = f"https://search.d3.nhle.com/api/v1/search/player?culture=en-us&limit=3&q={q}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        resp = urllib.request.urlopen(req, timeout=10)
        data = json.loads(resp.read().decode())
        if data:
            return str(data[0].get("playerId", ""))
    except Exception:
        pass
    return None


def _nhl_api_game_log(nhl_player_id, season_str):
    """Fetch game log from NHL API. Returns list of game dicts."""
    url = f"https://api-web.nhle.com/v1/player/{nhl_player_id}/game-log/{season_str}/2"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        resp = urllib.request.urlopen(req, timeout=15)
        data = json.loads(resp.read().decode())
        return data.get("gameLog", [])
    except Exception:
        return []


def _parse_toi(toi_str):
    """Parse TOI like '17:31' to minutes float."""
    if not toi_str or ":" not in toi_str:
        return None
    parts = toi_str.split(":")
    try:
        return float(parts[0]) + float(parts[1]) / 60.0
    except (ValueError, IndexError):
        return None


def load_nhl_api(league_id):
    """Load NHL game logs via NHL API for players missing from moneypuck CSV."""
    from supabase import create_client
    sb = create_client(SB_URL, SB_KEY)

    # Get all NHL players
    players = []
    offset = 0
    while True:
        batch = sb.table("back_in_play_players").select(
            "player_id,player_name"
        ).eq("league_id", league_id).range(offset, offset + 999).execute()
        if not batch.data:
            break
        players.extend(batch.data)
        if len(batch.data) < 1000:
            break
        offset += 1000

    # Find players without game logs
    missing = []
    for p in players:
        pid = p["player_id"]
        existing = sb.table("back_in_play_player_game_logs").select(
            "id"
        ).eq("player_id", pid).limit(1).execute()
        if not existing.data:
            missing.append(p)

    print(f"  {len(missing)} NHL players without game logs (out of {len(players)} total)", flush=True)
    if not missing:
        return 0

    total_loaded = 0
    total_searched = 0

    for i, p in enumerate(missing):
        name = p["player_name"]
        # Strip position prefixes
        clean_name = name
        for prefix in ("F ", "C ", "D ", "G ", "LW ", "RW ", "Ds ", "C/F ", "F/C "):
            if name.startswith(prefix):
                clean_name = name[len(prefix):]
                break

        nhl_id = _nhl_api_search(clean_name)
        total_searched += 1
        if not nhl_id:
            if (i + 1) % 100 == 0:
                print(f"  [{i + 1}/{len(missing)}] searched ({total_loaded} loaded)...", flush=True)
            time.sleep(0.3)
            continue

        # Fetch game logs for recent seasons
        db_rows = []
        for season_str in NHL_API_SEASONS[-6:]:  # last 6 seasons
            games = _nhl_api_game_log(nhl_id, season_str)
            season_year = int(season_str[:4]) + 1

            for g in games:
                gd = g.get("gameDate", "")
                if not gd:
                    continue
                goals = g.get("goals", 0) or 0
                assists = g.get("assists", 0) or 0
                shots = g.get("shots", 0) or 0
                minutes = _parse_toi(g.get("toi"))

                db_rows.append({
                    "player_id": p["player_id"],
                    "league_slug": "nhl",
                    "season": season_year,
                    "game_date": gd,
                    "opponent": g.get("opponentAbbrev", ""),
                    "started": True,
                    "minutes": minutes,
                    "stat_goals": goals,
                    "stat_assists": assists,
                    "stat_sog": shots,
                    "composite": 3.0 * goals + 2.0 * assists + 0.5 * shots,
                })

            time.sleep(0.3)

        if db_rows:
            n = pg_upsert("back_in_play_player_game_logs", db_rows, conflict_cols=["player_id", "game_date"])
            total_loaded += n
            if total_loaded % 500 < len(db_rows):
                print(f"  [{i + 1}/{len(missing)}] {clean_name}: {len(db_rows)} games loaded", flush=True)

        if (i + 1) % 100 == 0:
            print(f"  [{i + 1}/{len(missing)}] searched ({total_loaded} loaded)...", flush=True)

    print(f"\nNHL API: {total_loaded} game logs loaded for {total_searched} players searched", flush=True)
    return total_loaded


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
            n = pg_upsert("back_in_play_player_game_logs", db_rows, conflict_cols=["player_id", "game_date"])
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

    total_loaded = 0
    total_matched = 0
    unmatched = set()

    # Load Chadwick register for retrosheet ID → name mapping
    # Only keep entries with a retrosheet key (saves memory)
    print("  Loading Chadwick register for name mapping...", flush=True)
    retro_to_name = {}
    register_files = [f"people-{c}.csv" for c in "0123456789abcdef"]
    for rf in register_files:
        reg_url = f"https://raw.githubusercontent.com/chadwickbureau/register/master/data/{rf}"
        try:
            resp = urllib.request.urlopen(reg_url, timeout=30)
            text = resp.read().decode("utf-8", errors="replace")
            reader = csv.DictReader(io.StringIO(text))
            for r in reader:
                key = r.get("key_retro", "").strip()
                if not key:
                    continue
                first = r.get("name_first", "").strip()
                last = r.get("name_last", "").strip()
                if first and last:
                    retro_to_name[key] = f"{first} {last}".lower()
            print(f"    {rf}: {len(retro_to_name)} total mappings so far", flush=True)
        except Exception as e:
            print(f"  Failed to fetch {rf}: {e}", flush=True)
            continue

    print(f"  Register: {len(retro_to_name)} retrosheet ID → name mappings", flush=True)

    # Process one year at a time to limit memory usage
    for year in MLB_YEARS:
        url = f"https://raw.githubusercontent.com/chadwickbureau/retrosplits/master/daybyday/playing-{year}.csv"
        try:
            resp = urllib.request.urlopen(url, timeout=60)
            text = resp.read().decode("utf-8", errors="replace")
            rows = list(csv.DictReader(io.StringIO(text)))
        except Exception as e:
            print(f"  {year}: SKIP ({e})", flush=True)
            continue

        print(f"  {year}: {len(rows)} rows, processing...", flush=True)
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

            # Batch upsert every 500 rows to limit memory
            if len(db_rows) >= 500:
                n = pg_upsert("back_in_play_player_game_logs", db_rows, conflict_cols=["player_id", "game_date"])
                total_loaded += n
                db_rows = []

        if db_rows:
            n = pg_upsert("back_in_play_player_game_logs", db_rows, conflict_cols=["player_id", "game_date"])
            total_loaded += n
        # Free memory for this year
        del rows, db_rows
        print(f"  {year}: done (total so far: {total_loaded})", flush=True)

    print(f"\nMLB: {total_loaded} game logs loaded, {total_matched} matched, {len(unmatched)} unmatched", flush=True)
    if len(unmatched) <= 20:
        print(f"  Unmatched: {sorted(unmatched)[:20]}")
    return total_loaded

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Load historical game logs from public datasets")
    parser.add_argument("--league", type=str, help="Single league (nba, nfl, nhl, mlb, premier-league)")
    parser.add_argument("--nhl-api", action="store_true",
                        help="Use NHL API to fill missing NHL players (after moneypuck CSV load)")
    args = parser.parse_args()

    if args.nhl_api:
        leagues = sb_get("back_in_play_leagues", "select=league_id,slug")
        lid_map = {l["slug"]: l["league_id"] for l in (leagues or [])}
        nhl_id = lid_map.get("nhl")
        if nhl_id:
            print(f"\n{'=' * 50}")
            print(f"Loading NHL game logs via NHL API (missing players)")
            print(f"{'=' * 50}\n")
            load_nhl_api(nhl_id)
        return

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
