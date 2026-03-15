#!/usr/bin/env python3
"""
Import game logs from ESPN API for all players who have ESPN IDs but no game logs.

ESPN gamelog endpoint:
  site.api.espn.com/apis/common/v3/sports/{sport}/{league}/athletes/{espn_id}/gamelog?season={year}

Usage:
  python3 import_espn_gamelogs.py --league nfl
  python3 import_espn_gamelogs.py --league nba --dry-run
  python3 import_espn_gamelogs.py --league all
"""

import argparse
import json
import os
import sys
import time
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

# ─── ESPN config ─────────────────────────────────────────────────────────────

ESPN_LEAGUES = {
    "nba": {"sport": "basketball", "league": "nba", "seasons": range(2015, 2026)},
    "nfl": {"sport": "football", "league": "nfl", "seasons": range(2015, 2026)},
    "nhl": {"sport": "hockey", "league": "nhl", "seasons": range(2015, 2026)},
    "mlb": {"sport": "baseball", "league": "mlb", "seasons": range(2015, 2026)},
    "premier-league": {"sport": "soccer", "league": "eng.1", "seasons": range(2015, 2026)},
}

# ─── HTTP / Supabase helpers ────────────────────────────────────────────────

def http_get_json(url, timeout=30):
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "BackInPlay/1.0"})
            resp = urllib.request.urlopen(req, timeout=timeout)
            return json.loads(resp.read().decode())
        except Exception as e:
            if attempt < 2:
                time.sleep(2 * (attempt + 1))
            else:
                return None

def sb_get(table, params=""):
    url = SB_URL + "/rest/v1/" + table + "?" + params
    hdrs = {"apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY}
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=hdrs)
            resp = urllib.request.urlopen(req, timeout=60)
            return json.loads(resp.read().decode())
        except Exception:
            time.sleep(3)
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
                        except Exception:
                            pass
    return total

# ─── ESPN gamelog parsing ────────────────────────────────────────────────────

def fetch_espn_gamelog(sport, league, espn_id, season):
    """Fetch gamelog from ESPN API. Returns list of game entries or None."""
    url = (f"https://site.api.espn.com/apis/common/v3/sports/{sport}/{league}"
           f"/athletes/{espn_id}/gamelog?season={season}")
    data = http_get_json(url)
    if not data:
        return None

    # ESPN gamelog structure:
    # - Top-level "labels" / "names" arrays = stat column headers
    # - "seasonTypes"[].categories[].events[].stats[] = positional stat values
    # - "events" dict keyed by event ID = game metadata (date, opponent)
    events_map = data.get("events", {})
    season_types = data.get("seasonTypes", [])
    top_labels = data.get("labels", [])
    top_names = data.get("names", [])

    if not season_types and not events_map:
        return None

    games = []

    # Parse events map for game dates and opponents
    event_info = {}
    if isinstance(events_map, dict):
        for eid, edata in events_map.items():
            if isinstance(edata, dict):
                event_info[eid] = {
                    "date": edata.get("gameDate", ""),
                    "opponent": edata.get("opponent", {}).get("abbreviation", "")
                                if isinstance(edata.get("opponent"), dict) else "",
                    "home": edata.get("homeAway", ""),
                }

    # Parse seasonTypes -> categories -> events for stats
    for st in season_types:
        categories = st.get("categories", [])
        for cat in categories:
            cat_events = cat.get("events", [])
            # Labels come from: category-level "labels" or top-level "labels"
            cat_labels = cat.get("labels", top_labels)
            cat_names = cat.get("names", top_names)
            # Some responses put labels in cat.stats[].abbreviation
            if not cat_labels:
                cat_stats = cat.get("stats", [])
                cat_labels = [s.get("abbreviation", s.get("name", ""))
                              for s in cat_stats] if cat_stats else []

            for event in cat_events:
                eid = str(event.get("eventId", ""))
                stats_vals = event.get("stats", [])

                info = event_info.get(eid, {})
                game_date = info.get("date", "")
                if game_date and "T" in game_date:
                    game_date = game_date[:10]

                if not game_date:
                    continue

                # Build stat dict using labels (abbreviations)
                stat_dict = {}
                labels_to_use = cat_labels if cat_labels else top_labels
                for idx, val in enumerate(stats_vals):
                    if idx < len(labels_to_use):
                        stat_dict[labels_to_use[idx]] = val

                games.append({
                    "date": game_date,
                    "opponent": info.get("opponent", ""),
                    "stats": stat_dict,
                })

    return games

def compute_composite_nfl(stats):
    """NFL composite from ESPN gamelog stats."""
    def sf(key):
        v = stats.get(key, "0")
        try: return float(v)
        except: return 0.0

    # Try common ESPN stat abbreviations
    rush_yds = sf("RYDS") or sf("RushYds")
    rush_tds = sf("RTD") or sf("RushTD")
    rec_yds = sf("RECYDS") or sf("RecYds")
    rec_tds = sf("RECTD") or sf("RecTD")
    recs = sf("REC") or sf("Rec")
    pass_yds = sf("PYDS") or sf("PassYds") or sf("YDS")
    pass_tds = sf("PTD") or sf("PassTD") or sf("TD")
    ints = sf("INT")
    # Defensive
    tackles = sf("TACK") or sf("TOT") or sf("Tackles")
    sacks = sf("SACK") or sf("Sacks")
    def_ints = sf("DINT")

    if rush_yds or rec_yds or pass_yds or recs:
        return (rush_yds * 0.1 + rush_tds * 6 + rec_yds * 0.1 + rec_tds * 6 +
                recs * 1.0 + pass_yds * 0.04 + pass_tds * 4 - ints * 2)
    elif tackles or sacks or def_ints:
        return tackles * 1.0 + sacks * 4.0 + def_ints * 6.0
    return 0

def compute_composite_nba(stats):
    def sf(key):
        v = stats.get(key, "0")
        try: return float(v)
        except: return 0.0
    pts = sf("PTS")
    reb = sf("REB")
    ast = sf("AST")
    stl = sf("STL")
    blk = sf("BLK")
    return pts + reb * 1.2 + ast * 1.5 + stl * 3.0 + blk * 3.0

def compute_composite_nhl(stats):
    def sf(key):
        v = stats.get(key, "0")
        try: return float(v)
        except: return 0.0
    goals = sf("G")
    assists = sf("A")
    shots = sf("SOG")
    return goals * 6 + assists * 3 + shots * 0.5

def compute_composite_mlb(stats):
    def sf(key):
        v = stats.get(key, "0")
        try: return float(v)
        except: return 0.0
    hits = sf("H")
    hrs = sf("HR")
    rbis = sf("RBI")
    runs = sf("R")
    sb = sf("SB")
    bb = sf("BB")
    return hits + hrs * 4 + rbis + runs + sb * 2 + bb

def compute_composite_epl(stats):
    def sf(key):
        v = stats.get(key, "0")
        try: return float(v)
        except: return 0.0
    goals = sf("G") or sf("GLS")
    assists = sf("A") or sf("AST")
    return goals * 6 + assists * 3

COMPOSITE_FN = {
    "nfl": compute_composite_nfl,
    "nba": compute_composite_nba,
    "nhl": compute_composite_nhl,
    "mlb": compute_composite_mlb,
    "premier-league": compute_composite_epl,
}

# ─── Checkpoint ──────────────────────────────────────────────────────────────

def load_checkpoint(path):
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return {"done": []}

def save_checkpoint(path, cp):
    with open(path, "w") as f:
        json.dump(cp, f)

# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--league", required=True, help="nfl, nba, nhl, mlb, premier-league, or all")
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

        cfg = ESPN_LEAGUES[slug]
        print(f"\n{'='*60}", flush=True)
        print(f"Processing {slug}", flush=True)
        print(f"{'='*60}", flush=True)

        # Get league_id
        lgs = sb_get("back_in_play_leagues", "select=league_id&slug=eq." + slug)
        if not lgs:
            print(f"  League {slug} not found in DB")
            continue
        league_id = lgs[0]["league_id"]

        # Get players with ESPN IDs
        players_with_espn = []
        offset = 0
        while True:
            batch = sb_get("back_in_play_players",
                "select=player_id,espn_id&league_id=eq." + league_id +
                "&espn_id=not.is.null&limit=1000&offset=" + str(offset))
            if not batch: break
            players_with_espn.extend(batch)
            if len(batch) < 1000: break
            offset += 1000

        # Get players who already have game logs
        existing_log_pids = set()
        offset = 0
        while True:
            batch = sb_get("back_in_play_player_game_logs",
                "select=player_id&league_slug=eq." + slug + "&limit=1000&offset=" + str(offset))
            if not batch: break
            for r in batch: existing_log_pids.add(r["player_id"])
            if len(batch) < 1000: break
            offset += 1000

        # Filter to players needing logs
        need_logs = [p for p in players_with_espn if p["player_id"] not in existing_log_pids]
        print(f"  {len(players_with_espn)} players with ESPN IDs", flush=True)
        print(f"  {len(existing_log_pids)} already have logs", flush=True)
        print(f"  {len(need_logs)} need game logs", flush=True)

        # Checkpoint
        cp_path = os.path.join(os.path.dirname(__file__),
                               f"checkpoint_espn_gamelog_{slug}.json")
        cp = load_checkpoint(cp_path)
        done = set(cp["done"])

        need_logs = [p for p in need_logs if p["player_id"] not in done]
        print(f"  {len(need_logs)} after checkpoint filter", flush=True)

        composite_fn = COMPOSITE_FN.get(slug, compute_composite_nfl)
        total_logs = 0
        total_loaded = 0
        players_with_data = 0

        for i, p in enumerate(need_logs):
            pid = p["player_id"]
            espn_id = p["espn_id"]

            player_logs = []
            for season in cfg["seasons"]:
                games = fetch_espn_gamelog(cfg["sport"], cfg["league"], espn_id, season)
                if not games:
                    continue

                for g in games:
                    game_date = g["date"]
                    if not game_date or len(game_date) < 8:
                        continue

                    stats = g["stats"]
                    composite = composite_fn(stats)

                    db_row = {
                        "player_id": pid,
                        "league_slug": slug,
                        "season": season,
                        "game_date": game_date,
                        "opponent": g.get("opponent", ""),
                        "started": None,
                        "minutes": None,
                        "stat_goals": 0,
                        "stat_assists": 0,
                        "stat_sog": 0,
                        "composite": round(composite, 2),
                        "source_url": "espn_gamelog_api",
                    }
                    player_logs.append(db_row)

                time.sleep(0.1)  # Rate limit

            if player_logs:
                players_with_data += 1
                total_logs += len(player_logs)
                if not args.dry_run:
                    n = sb_upsert("back_in_play_player_game_logs", player_logs)
                    total_loaded += n
                else:
                    total_loaded += len(player_logs)

            done.add(pid)
            if (i + 1) % 50 == 0:
                print(f"  [{i+1}/{len(need_logs)}] {players_with_data} players with data, "
                      f"{total_logs} logs, {total_loaded} loaded", flush=True)
                cp["done"] = list(done)
                save_checkpoint(cp_path, cp)

            time.sleep(0.05)

        cp["done"] = list(done)
        save_checkpoint(cp_path, cp)

        print(f"\n  {slug} complete:", flush=True)
        print(f"    Players processed: {len(need_logs)}", flush=True)
        print(f"    Players with data: {players_with_data}", flush=True)
        print(f"    Game logs: {total_logs}", flush=True)
        print(f"    Loaded: {total_loaded}", flush=True)

if __name__ == "__main__":
    main()
