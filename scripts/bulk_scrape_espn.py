#!/usr/bin/env python3
"""
Bulk-scrape ESPN game logs for all players with espn_id in Supabase.

Covers: NBA, NFL, NHL, MLB, EPL
Seasons: 2019-2025
Upserts into back_in_play_player_game_logs with composite scores.

Usage:
  python3 bulk_scrape_espn.py                    # all leagues
  python3 bulk_scrape_espn.py --league nba       # single league
  python3 bulk_scrape_espn.py --season 2024      # single season
  python3 bulk_scrape_espn.py --dry-run           # preview counts only

Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY env vars
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
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
                    key, _, val = line.partition("=")
                    os.environ.setdefault(key.strip(), val.strip().strip("'\""))

load_env()

SB_URL = os.environ.get("SUPABASE_URL", "")
SB_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
if not SB_URL or not SB_KEY:
    print("ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
    sys.exit(1)

USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

RATE_LIMIT_DELAY = 0.5  # seconds between ESPN requests

SEASONS = list(range(2019, 2026))  # 2019-2025

# ─── League config ───────────────────────────────────────────────────────────

LEAGUE_CONFIG = {
    "nba": {
        "sport": "basketball",
        "league_code": "nba",
        "slug": "nba",
    },
    "nfl": {
        "sport": "football",
        "league_code": "nfl",
        "slug": "nfl",
    },
    "nhl": {
        "sport": "hockey",
        "league_code": "nhl",
        "slug": "nhl",
    },
    "mlb": {
        "sport": "baseball",
        "league_code": "mlb",
        "slug": "mlb",
    },
    "epl": {
        "sport": "soccer",
        "league_code": "eng.1",
        "slug": "premier-league",
    },
}

# ─── Supabase helpers ────────────────────────────────────────────────────────

def sb_get(table, params=""):
    url = f"{SB_URL}/rest/v1/{table}?{params}"
    hdrs = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"}
    try:
        req = urllib.request.Request(url, headers=hdrs)
        resp = urllib.request.urlopen(req, timeout=30)
        return json.loads(resp.read().decode())
    except Exception as e:
        print(f"  [SB GET ERR] {table}: {e}", flush=True)
        return []


def sb_upsert(table, rows, conflict=""):
    """Upsert rows in batches of 200, with fallback to smaller batches."""
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
        "Authorization": f"Bearer {SB_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal,resolution=merge-duplicates",
    }
    url = f"{SB_URL}/rest/v1/{table}"
    if conflict:
        url += f"?on_conflict={conflict}"

    total = 0
    for i in range(0, len(rows), 200):
        batch = rows[i:i + 200]
        try:
            req = urllib.request.Request(url, data=json.dumps(batch).encode(),
                                        headers=hdrs, method="POST")
            urllib.request.urlopen(req, timeout=120).read()
            total += len(batch)
        except Exception:
            # Fallback: smaller batches
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


def sb_get_all(table, params=""):
    """Paginate through all rows (Supabase default limit is 1000)."""
    all_rows = []
    offset = 0
    while True:
        sep = "&" if params else ""
        batch = sb_get(table, f"{params}{sep}limit=1000&offset={offset}")
        if not batch:
            break
        all_rows.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000
    return all_rows

# ─── ESPN fetch ──────────────────────────────────────────────────────────────

def fetch_espn_gamelog(sport, league_code, espn_id, season):
    """Fetch ESPN gamelog JSON for a player/season. Returns dict or None."""
    url = (f"https://site.api.espn.com/apis/common/v3/sports/{sport}/"
           f"{league_code}/athletes/{espn_id}/gamelog?season={season}")
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
    })
    try:
        resp = urllib.request.urlopen(req, timeout=20)
        return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None  # player not active that season
        if e.code == 400:
            return None  # bad request (invalid season for sport)
        print(f"    [ESPN {e.code}] {sport}/{league_code} espn_id={espn_id} season={season}", flush=True)
        return None
    except Exception as e:
        print(f"    [ESPN ERR] {e}", flush=True)
        return None

# ─── Stat parsing per league ────────────────────────────────────────────────

def _safe_float(val):
    """Convert a stat value to float, handling '-', '', etc."""
    if val is None:
        return None
    s = str(val).strip()
    if s in ("", "-", "--", "DNP", "DNS"):
        return None
    try:
        return float(s)
    except (ValueError, TypeError):
        return None


def _parse_minutes(val):
    """Parse minutes from ESPN format (could be '35:22', '35', etc.)."""
    if val is None:
        return None
    s = str(val).strip()
    if s in ("", "-", "--", "DNP"):
        return None
    if ":" in s:
        parts = s.split(":")
        try:
            return float(parts[0]) + float(parts[1]) / 60.0
        except (ValueError, IndexError):
            return None
    return _safe_float(s)


def _label_index(labels, name):
    """Find the index of a label (case-insensitive). Returns -1 if not found."""
    name_lower = name.lower()
    for i, label in enumerate(labels):
        if label.lower() == name_lower:
            return i
    return -1


def _stat_at(stats, idx):
    """Get stat value at index, or None if out of range."""
    if idx < 0 or idx >= len(stats):
        return None
    return stats[idx]


def parse_nba_event(labels, event):
    """Parse an NBA game event into a game log row dict (stats only)."""
    stats = event.get("stats", [])
    row = {}

    # Common NBA labels: MIN, FGM, FGA, FG%, 3PM, 3PA, 3P%, FTM, FTA, FT%, REB, AST, BLK, STL, PF, TO, PTS
    min_idx = _label_index(labels, "MIN")
    pts_idx = _label_index(labels, "PTS")
    reb_idx = _label_index(labels, "REB")
    ast_idx = _label_index(labels, "AST")
    stl_idx = _label_index(labels, "STL")
    blk_idx = _label_index(labels, "BLK")

    row["minutes"] = _parse_minutes(_stat_at(stats, min_idx))
    row["stat_pts"] = _safe_float(_stat_at(stats, pts_idx))
    row["stat_reb"] = _safe_float(_stat_at(stats, reb_idx))
    row["stat_ast"] = _safe_float(_stat_at(stats, ast_idx))
    row["stat_stl"] = _safe_float(_stat_at(stats, stl_idx))
    row["stat_blk"] = _safe_float(_stat_at(stats, blk_idx))
    return row


def parse_nfl_event(labels, event):
    """Parse an NFL game event."""
    stats = event.get("stats", [])
    row = {}

    # NFL labels vary by position group. Common ones:
    # Passing: C/ATT, YDS, AVG, TD, INT, SACKS, QBR, RTG
    # Rushing: CAR, YDS, AVG, TD, LONG
    # Receiving: REC, YDS, AVG, TD, LONG, TGTS
    # Try multiple label names
    pass_yds_idx = _label_index(labels, "YDS")  # first YDS is usually passing
    pass_td_idx = _label_index(labels, "TD")

    # For NFL, the labels structure can be nested by category
    # We'll try common patterns
    row["stat_pass_yds"] = _safe_float(_stat_at(stats, _label_index(labels, "PYDS")))
    row["stat_pass_td"] = _safe_float(_stat_at(stats, _label_index(labels, "PTD")))
    row["stat_rush_yds"] = _safe_float(_stat_at(stats, _label_index(labels, "RYDS")))
    row["stat_rush_td"] = _safe_float(_stat_at(stats, _label_index(labels, "RTD")))
    row["stat_rec"] = _safe_float(_stat_at(stats, _label_index(labels, "REC")))
    row["stat_rec_yds"] = _safe_float(_stat_at(stats, _label_index(labels, "RECYDS")))

    # Fallback: if none found, try positional label patterns
    if all(row[k] is None for k in row):
        # Try generic labels (passing section)
        yds_idx = _label_index(labels, "YDS")
        td_idx = _label_index(labels, "TD")
        if yds_idx >= 0:
            row["stat_pass_yds"] = _safe_float(_stat_at(stats, yds_idx))
        if td_idx >= 0:
            row["stat_pass_td"] = _safe_float(_stat_at(stats, td_idx))

    return row


def parse_nhl_event(labels, event):
    """Parse an NHL game event."""
    stats = event.get("stats", [])
    row = {}

    g_idx = _label_index(labels, "G")
    a_idx = _label_index(labels, "A")
    sog_idx = _label_index(labels, "SOG")
    toi_idx = _label_index(labels, "TOI")
    if toi_idx < 0:
        toi_idx = _label_index(labels, "ATOI")

    row["stat_goals"] = _safe_float(_stat_at(stats, g_idx))
    row["stat_assists"] = _safe_float(_stat_at(stats, a_idx))
    row["stat_sog"] = _safe_float(_stat_at(stats, sog_idx))
    row["minutes"] = _parse_minutes(_stat_at(stats, toi_idx))
    return row


def parse_mlb_event(labels, event):
    """Parse an MLB game event (handles both hitters and pitchers)."""
    stats = event.get("stats", [])
    row = {}

    # Hitter labels: AB, R, H, 2B, 3B, HR, RBI, BB, SO, SB, CS, AVG, OBP, SLG, OPS
    h_idx = _label_index(labels, "H")
    hr_idx = _label_index(labels, "HR")
    rbi_idx = _label_index(labels, "RBI")
    r_idx = _label_index(labels, "R")
    sb_idx = _label_index(labels, "SB")

    # Pitcher labels: IP, H, R, ER, BB, K, HR, ERA, WHIP
    ip_idx = _label_index(labels, "IP")
    k_idx = _label_index(labels, "K")
    if k_idx < 0:
        k_idx = _label_index(labels, "SO")
    era_idx = _label_index(labels, "ERA")

    row["stat_h"] = _safe_float(_stat_at(stats, h_idx))
    row["stat_hr"] = _safe_float(_stat_at(stats, hr_idx))
    row["stat_rbi"] = _safe_float(_stat_at(stats, rbi_idx))
    row["stat_r"] = _safe_float(_stat_at(stats, r_idx))
    row["stat_sb"] = _safe_float(_stat_at(stats, sb_idx))
    row["stat_ip"] = _safe_float(_stat_at(stats, ip_idx))
    row["stat_k"] = _safe_float(_stat_at(stats, k_idx))
    row["stat_era"] = _safe_float(_stat_at(stats, era_idx))
    return row


def parse_epl_event(labels, event):
    """Parse an EPL/soccer game event."""
    stats = event.get("stats", [])
    row = {}

    g_idx = _label_index(labels, "G")
    if g_idx < 0:
        g_idx = _label_index(labels, "GLS")
    a_idx = _label_index(labels, "A")
    if a_idx < 0:
        a_idx = _label_index(labels, "AST")
    min_idx = _label_index(labels, "MIN")

    row["stat_goals"] = _safe_float(_stat_at(stats, g_idx))
    row["stat_assists"] = _safe_float(_stat_at(stats, a_idx))
    row["minutes"] = _safe_float(_stat_at(stats, min_idx))
    return row


PARSERS = {
    "nba": parse_nba_event,
    "nfl": parse_nfl_event,
    "nhl": parse_nhl_event,
    "mlb": parse_mlb_event,
    "epl": parse_epl_event,
}

# ─── Composite score computation ────────────────────────────────────────────

def _g(row, field):
    v = row.get(field)
    return float(v) if v is not None else 0.0


def compute_composite(row, league_key):
    if league_key == "nba":
        return (_g(row, "stat_pts") + 1.2 * _g(row, "stat_reb") +
                1.5 * _g(row, "stat_ast") + 3.0 * _g(row, "stat_stl") +
                3.0 * _g(row, "stat_blk"))
    elif league_key == "nfl":
        return (0.04 * _g(row, "stat_pass_yds") + 4.0 * _g(row, "stat_pass_td") +
                0.1 * _g(row, "stat_rush_yds") + 6.0 * _g(row, "stat_rush_td") +
                _g(row, "stat_rec") + 0.1 * _g(row, "stat_rec_yds"))
    elif league_key == "nhl":
        return (6.0 * _g(row, "stat_goals") + 3.0 * _g(row, "stat_assists") +
                0.5 * _g(row, "stat_sog"))
    elif league_key == "mlb":
        # Hitter composite
        h_comp = (2.0 * _g(row, "stat_h") + 4.0 * _g(row, "stat_hr") +
                  1.5 * _g(row, "stat_rbi") + 1.5 * _g(row, "stat_r") +
                  2.0 * _g(row, "stat_sb"))
        # Pitcher composite
        ip = _g(row, "stat_ip")
        k = _g(row, "stat_k")
        era = _g(row, "stat_era")
        p_comp = ip * 3.0 + k * 2.0 - (era if era > 0 else 0)
        # Use whichever is non-zero (or higher if both)
        if ip > 0 and h_comp > 0:
            return max(h_comp, p_comp)
        elif ip > 0:
            return p_comp
        return h_comp
    elif league_key == "epl":
        return (6.0 * _g(row, "stat_goals") + 3.0 * _g(row, "stat_assists") +
                (_g(row, "minutes") / 90.0) * 1.0)
    return 0.0

# ─── Core: process one player ───────────────────────────────────────────────

def process_player(player, league_key, config, seasons):
    """Fetch and parse all seasons for one player. Returns list of db rows."""
    espn_id = player["espn_id"]
    player_id = player["player_id"]
    player_name = player.get("player_name", "???")
    sport = config["sport"]
    league_code = config["league_code"]
    league_slug = config["slug"]

    parser = PARSERS[league_key]
    all_rows = []

    for season in seasons:
        data = fetch_espn_gamelog(sport, league_code, espn_id, season)
        time.sleep(RATE_LIMIT_DELAY)

        if not data:
            continue

        # ESPN structure: labels at top level, events nested in seasonTypes → categories
        # Top-level "events" is a dict of game metadata (NOT stat rows)
        top_labels = data.get("labels", [])

        # Collect all (labels, event_list) pairs from seasonTypes
        label_event_pairs = []
        for st in data.get("seasonTypes", []):
            for cat in st.get("categories", []):
                cat_labels = cat.get("labels", []) or top_labels
                cat_events = cat.get("events", [])
                if cat_labels and cat_events and isinstance(cat_events, list):
                    label_event_pairs.append((cat_labels, cat_events))

        if not label_event_pairs:
            continue

        for labels, events in label_event_pairs:
            for event in events:
                if not isinstance(event, dict):
                    continue
                game_date_raw = event.get("gameDate", "")
                if not game_date_raw:
                    continue
                game_date = game_date_raw[:10]  # "2024-01-15T00:00Z" → "2024-01-15"

                opponent_obj = event.get("opponent", {})
                opponent = ""
                if isinstance(opponent_obj, dict):
                    opponent = opponent_obj.get("abbreviation", "") or opponent_obj.get("displayName", "")
                elif isinstance(opponent_obj, str):
                    opponent = opponent_obj

                # Parse stats using league-specific parser
                stat_row = parser(labels, event)

                db_row = {
                    "player_id": player_id,
                    "league_slug": league_slug,
                    "season": season,
                    "game_date": game_date,
                    "opponent": opponent[:20] if opponent else "",
                    "started": True,  # ESPN gamelog = they played
                }
                db_row.update(stat_row)

                db_row["composite"] = round(compute_composite(db_row, league_key), 2)
                db_row["source_url"] = (
                    f"https://www.espn.com/{config['sport']}/player/gamelog/_/id/{espn_id}"
                )
                all_rows.append(db_row)

    return all_rows

# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Bulk scrape ESPN game logs")
    parser.add_argument("--league", type=str,
                        help="Single league key: nba, nfl, nhl, mlb, epl")
    parser.add_argument("--season", type=int,
                        help="Single season year (default: 2019-2025)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Just show counts, don't scrape")
    parser.add_argument("--force", action="store_true",
                        help="Scrape even if player already has game logs")
    args = parser.parse_args()

    seasons = [args.season] if args.season else SEASONS
    league_keys = [args.league] if args.league else list(LEAGUE_CONFIG.keys())

    print("=" * 60)
    print("ESPN Bulk Game Log Scraper")
    print(f"Leagues: {league_keys}")
    print(f"Seasons: {seasons[0]}-{seasons[-1]}")
    print("=" * 60)

    # Get league_id → slug mapping
    leagues_db = sb_get_all("back_in_play_leagues", "select=league_id,slug")
    slug_to_league_id = {l["slug"]: l["league_id"] for l in leagues_db}

    # Get players who already have game logs (to skip)
    if not args.force:
        print("\nChecking existing game logs...", flush=True)
        existing_players = set()
        existing = sb_get_all("back_in_play_player_game_logs",
                              "select=player_id&limit=1000")
        # This gives us up to 1000 unique player_ids per page
        # We need a smarter approach: get distinct player_ids
        # Use RPC or just get all and deduplicate
        offset = 0
        while True:
            batch = sb_get("back_in_play_player_game_logs",
                           f"select=player_id&limit=1000&offset={offset}")
            if not batch:
                break
            for r in batch:
                existing_players.add(r["player_id"])
            if len(batch) < 1000:
                break
            offset += 1000
        print(f"  {len(existing_players)} players already have game logs", flush=True)
    else:
        existing_players = set()

    grand_total = 0
    grand_skipped = 0
    grand_errors = 0

    for league_key in league_keys:
        config = LEAGUE_CONFIG[league_key]
        league_slug = config["slug"]
        league_id = slug_to_league_id.get(league_slug)

        if not league_id:
            print(f"\n[SKIP] League '{league_slug}' not found in DB")
            continue

        print(f"\n{'─' * 60}")
        print(f"League: {league_key.upper()} (slug={league_slug})")
        print(f"{'─' * 60}")

        # Get all players with espn_id for this league
        players = sb_get_all(
            "back_in_play_players",
            f"select=player_id,player_name,espn_id&league_id=eq.{league_id}"
            f"&espn_id=not.is.null&order=player_name.asc"
        )

        # Filter out players without espn_id (extra safety)
        players = [p for p in players if p.get("espn_id")]

        print(f"  Players with espn_id: {len(players)}", flush=True)

        if not args.force:
            before = len(players)
            players = [p for p in players if p["player_id"] not in existing_players]
            skipped = before - len(players)
            grand_skipped += skipped
            print(f"  Skipping {skipped} with existing logs → {len(players)} to scrape")

        if args.dry_run:
            print(f"  [DRY RUN] Would scrape {len(players)} players × {len(seasons)} seasons")
            continue

        if not players:
            print("  Nothing to scrape.")
            continue

        league_total = 0
        league_errors = 0

        for i, player in enumerate(players):
            pname = player.get("player_name", "???")
            eid = player["espn_id"]
            if (i + 1) <= 3 or (i + 1) % 10 == 0:
                print(f"  [{i+1}/{len(players)}] Scraping {pname} (espn_id={eid})...", flush=True)

            try:
                rows = process_player(player, league_key, config, seasons)
            except Exception as e:
                print(f"  [{i+1}/{len(players)}] ERROR {pname} (espn_id={eid}): {e}",
                      flush=True)
                league_errors += 1
                continue

            if rows:
                n = sb_upsert("back_in_play_player_game_logs", rows,
                              conflict="player_id,game_date")
                league_total += n
                if (i + 1) % 25 == 0 or n > 50:
                    print(f"  [{i+1}/{len(players)}] {pname}: {n} games upserted "
                          f"(total: {league_total})", flush=True)
            else:
                if (i + 1) % 100 == 0:
                    print(f"  [{i+1}/{len(players)}] {pname}: 0 games found", flush=True)

        print(f"\n  {league_key.upper()} DONE: {league_total} game logs upserted, "
              f"{league_errors} errors")
        grand_total += league_total
        grand_errors += league_errors

    print(f"\n{'=' * 60}")
    print(f"GRAND TOTAL: {grand_total} game logs upserted")
    print(f"  Skipped (already had logs): {grand_skipped}")
    print(f"  Errors: {grand_errors}")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
