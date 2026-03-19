#!/usr/bin/env python3
"""
Back In Play — Daily Game Log Refresh
======================================
Fetches current-season game logs from ESPN for all players with ESPN IDs.
Unlike import_espn_gamelogs.py (which only fills gaps for players with NO logs),
this script refreshes the current season for ALL players.

Designed to run daily via cron on the droplet.

Usage:
  python3 daily_gamelog_refresh.py --league premier-league
  python3 daily_gamelog_refresh.py --league all
  python3 daily_gamelog_refresh.py --league nhl --dry-run
"""

import argparse
import json
import os
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

from db_writer import pg_upsert, pg_query

# ─── ESPN config ─────────────────────────────────────────────────────────────

def current_season(slug):
    """Return the current ESPN season year for this league."""
    now = datetime.now()
    # EPL/NHL/NBA seasons span two calendar years — use the start year
    if slug in ("premier-league", "nhl", "nba"):
        return now.year if now.month >= 8 else now.year - 1
    # NFL season starts in Sep
    if slug == "nfl":
        return now.year if now.month >= 9 else now.year - 1
    # MLB is within a single calendar year
    return now.year

ESPN_LEAGUES = {
    "nba":             {"sport": "basketball", "league": "nba"},
    "nfl":             {"sport": "football",   "league": "nfl"},
    "nhl":             {"sport": "hockey",     "league": "nhl"},
    "mlb":             {"sport": "baseball",   "league": "mlb"},
    "premier-league":  {"sport": "soccer",     "league": "eng.1"},
}

# Leagues where ESPN data is unreliable and a better primary source exists:
#   NHL: ESPN has no SOG -> use NHL API (bulk_scrape_nhl_api.py)
#   NFL: ESPN category labels are ambiguous -> use nflverse CSV (import_nfl_csv.py)
#   MLB: ESPN missing totalBases -> use MLB Stats API (import_mlb_api.py)
# ESPN is only reliable for NBA. EPL has limited stats from ESPN too.
ESPN_SKIP_LEAGUES = {"nhl", "nfl", "mlb"}

# ─── Stat parsing per league ────────────────────────────────────────────────

def sf(stats, *keys):
    """Safe float from stats dict, trying multiple key names."""
    for k in keys:
        v = stats.get(k, None)
        if v is not None:
            try:
                return float(v)
            except (ValueError, TypeError):
                pass
    return 0.0

def sf_or_none(stats, *keys):
    """Safe float, returns None if key not found (avoids overwriting good data with 0)."""
    for k in keys:
        v = stats.get(k, None)
        if v is not None:
            try:
                return float(v)
            except (ValueError, TypeError):
                pass
    return None

def parse_stats_nba(stats):
    return {
        "minutes": sf(stats, "MIN", "Min"),
        "stat_pts": sf(stats, "PTS", "Pts"),
        "stat_reb": sf(stats, "REB", "Reb"),
        "stat_ast": sf(stats, "AST", "Ast"),
        "stat_stl": sf(stats, "STL", "Stl"),
        "stat_blk": sf(stats, "BLK", "Blk"),
    }

def parse_stats_nhl(stats):
    return {
        "stat_goals": sf(stats, "G", "Goals"),
        "stat_assists": sf(stats, "A", "Assists"),
        # ESPN doesn't reliably provide SOG for NHL — use sf_or_none
        # to avoid overwriting correct NHL API data with 0
        "stat_sog": sf_or_none(stats, "SOG", "Shots"),
    }

def parse_stats_nfl(stats):
    return {
        "stat_pass_yds": sf(stats, "passing_YDS", "PYDS", "PassYds"),
        "stat_rush_yds": sf(stats, "rushing_YDS", "RYDS", "RushYds"),
        "stat_rec_yds": sf(stats, "receiving_YDS", "RECYDS", "RecYds"),
        "stat_rec": sf(stats, "receiving_REC", "REC", "Rec"),
    }

def parse_stats_mlb(stats):
    return {
        "stat_h": sf_or_none(stats, "H", "Hits"),
        "stat_rbi": sf_or_none(stats, "RBI"),
        "stat_goals": sf_or_none(stats, "HR"),  # overloading goals for HR
        "stat_stl": sf_or_none(stats, "TB", "TotalBases"),  # totalBases stored in stat_stl
    }

def parse_stats_epl(stats):
    return {
        "stat_goals": sf_or_none(stats, "G", "GLS", "Goals"),
        "stat_assists": sf_or_none(stats, "A", "AST", "Assists"),
        "stat_sog": sf_or_none(stats, "SOT", "ShotsOnTarget"),
        "minutes": sf_or_none(stats, "MIN", "Min"),
    }

STAT_PARSERS = {
    "nba": parse_stats_nba,
    "nfl": parse_stats_nfl,
    "nhl": parse_stats_nhl,
    "mlb": parse_stats_mlb,
    "premier-league": parse_stats_epl,
}

def compute_composite(slug, stats):
    if slug == "nba":
        return sf(stats, "PTS") + sf(stats, "REB") * 1.2 + sf(stats, "AST") * 1.5 + sf(stats, "STL") * 3 + sf(stats, "BLK") * 3
    elif slug == "nhl":
        return sf(stats, "G", "Goals") * 6 + sf(stats, "A", "Assists") * 3 + sf(stats, "SOG", "Shots") * 0.5
    elif slug == "premier-league":
        return (sf(stats, "G", "GLS", "Goals") * 6 + sf(stats, "A", "AST", "Assists") * 3)
    elif slug == "mlb":
        return sf(stats, "H") + sf(stats, "HR") * 4 + sf(stats, "RBI") + sf(stats, "R") + sf(stats, "SB") * 2
    elif slug == "nfl":
        return (sf(stats, "rushing_YDS", "RYDS", "RushYds") * 0.1 +
                sf(stats, "receiving_YDS", "RECYDS", "RecYds") * 0.1 +
                sf(stats, "receiving_REC", "REC", "Rec") +
                sf(stats, "passing_YDS", "PYDS", "PassYds") * 0.04)
    return 0

# ─── HTTP helpers ────────────────────────────────────────────────────────────

def http_get_json(url, timeout=30):
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "BackInPlay/1.0"})
            resp = urllib.request.urlopen(req, timeout=timeout)
            return json.loads(resp.read().decode())
        except Exception:
            if attempt < 2:
                time.sleep(2 * (attempt + 1))
    return None

# ─── ESPN gamelog fetch ──────────────────────────────────────────────────────

def fetch_espn_gamelog(sport, league, espn_id, season):
    url = (f"https://site.api.espn.com/apis/common/v3/sports/{sport}/{league}"
           f"/athletes/{espn_id}/gamelog?season={season}")
    data = http_get_json(url)
    if not data:
        return []

    events_map = data.get("events", {})
    season_types = data.get("seasonTypes", [])
    top_labels = data.get("labels", [])
    top_names = data.get("names", [])

    event_info = {}
    if isinstance(events_map, dict):
        for eid, edata in events_map.items():
            if isinstance(edata, dict):
                event_info[eid] = {
                    "date": edata.get("gameDate", ""),
                    "opponent": edata.get("opponent", {}).get("abbreviation", "")
                                if isinstance(edata.get("opponent"), dict) else "",
                }

    # For NFL, ESPN returns separate categories (passing, rushing, receiving)
    # with overlapping label names (YDS, TD). We need to merge them per event
    # and prefix labels with the category name to disambiguate.
    # For other sports, categories don't overlap so no prefix needed.
    merged = {}  # eid -> {"date": ..., "opponent": ..., "stats": {...}}

    for st in season_types:
        for cat in st.get("categories", []):
            cat_name = cat.get("displayName", cat.get("name", "")).lower()
            cat_labels = cat.get("labels", top_labels)
            if not cat_labels:
                cat_stats = cat.get("stats", [])
                cat_labels = [s.get("abbreviation", s.get("name", ""))
                              for s in cat_stats] if cat_stats else []

            for event in cat.get("events", []):
                eid = str(event.get("eventId", ""))
                stats_vals = event.get("stats", [])
                info = event_info.get(eid, {})
                game_date = info.get("date", "")
                if game_date and "T" in game_date:
                    game_date = game_date[:10]
                if not game_date:
                    continue

                if eid not in merged:
                    merged[eid] = {"date": game_date, "opponent": info.get("opponent", ""), "stats": {}}

                labels = cat_labels if cat_labels else top_labels
                for idx, val in enumerate(stats_vals):
                    if idx < len(labels):
                        label = labels[idx]
                        # Prefix ambiguous NFL labels with category name
                        if cat_name in ("passing", "rushing", "receiving", "defense"):
                            merged[eid]["stats"][f"{cat_name}_{label}"] = val
                        # Also store unprefixed for non-NFL sports
                        merged[eid]["stats"][label] = val

    return list(merged.values())

# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--league", required=True, help="nba, nhl, mlb, nfl, premier-league, or all")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.league == "all":
        league_slugs = list(ESPN_LEAGUES.keys())
    else:
        league_slugs = [args.league]

    for slug in league_slugs:
        if slug not in ESPN_LEAGUES:
            print(f"Unknown league: {slug}")
            continue
        if slug in ESPN_SKIP_LEAGUES:
            print(f"\n  Skipping {slug} — ESPN data unreliable, use dedicated importer instead")
            continue

        cfg = ESPN_LEAGUES[slug]
        season = current_season(slug)
        parse_fn = STAT_PARSERS.get(slug, parse_stats_nba)

        print(f"\n{'='*60}", flush=True)
        print(f"Refreshing {slug} — season {season}", flush=True)
        print(f"{'='*60}", flush=True)

        # Get league_id
        lgs = pg_query("back_in_play_leagues", "league_id", filters={"slug": "eq." + slug})
        if not lgs:
            print(f"  League {slug} not found in DB")
            continue
        league_id = lgs[0]["league_id"]

        # Get all players with ESPN IDs for this league
        from db_writer import pg_query_paginate
        players = pg_query_paginate("back_in_play_players",
            select="player_id,espn_id",
            filters={"league_id": "eq." + league_id, "espn_id": "not.is.null"})

        print(f"  {len(players)} players with ESPN IDs", flush=True)

        total_logs = 0
        total_loaded = 0
        players_with_data = 0

        for i, p in enumerate(players):
            pid = p["player_id"]
            espn_id = p["espn_id"]

            games = fetch_espn_gamelog(cfg["sport"], cfg["league"], espn_id, season)
            if not games:
                time.sleep(0.05)
                continue

            rows = []
            for g in games:
                game_date = g["date"]
                if not game_date or len(game_date) < 8:
                    continue

                raw_stats = g["stats"]
                parsed = parse_fn(raw_stats)
                composite = compute_composite(slug, raw_stats)

                db_row = {
                    "player_id": pid,
                    "league_slug": slug,
                    "season": season,
                    "game_date": game_date,
                    "opponent": g.get("opponent", ""),
                    "composite": round(composite, 2),
                    "source_url": "espn_gamelog_api",
                }
                # Add parsed stats (skip None/zero to avoid overwriting better data)
                for k, v in parsed.items():
                    if v is not None:
                        db_row[k] = v

                rows.append(db_row)

            if rows:
                players_with_data += 1
                total_logs += len(rows)
                if not args.dry_run:
                    n = pg_upsert("back_in_play_player_game_logs", rows, conflict_cols=["player_id", "game_date"])
                    total_loaded += n
                else:
                    total_loaded += len(rows)

            if (i + 1) % 50 == 0:
                print(f"  [{i+1}/{len(players)}] {players_with_data} with data, "
                      f"{total_logs} logs, {total_loaded} loaded", flush=True)

            time.sleep(0.1)

        print(f"\n  {slug} complete:", flush=True)
        print(f"    Players processed: {len(players)}", flush=True)
        print(f"    Players with data: {players_with_data}", flush=True)
        print(f"    Game logs: {total_logs}", flush=True)
        print(f"    Loaded: {total_loaded}", flush=True)

if __name__ == "__main__":
    main()
