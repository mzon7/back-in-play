#!/usr/bin/env python3
"""
Import MLB game logs via the free MLB Stats API into Supabase.

API endpoints:
  /api/v1/people/search?names=...&sportIds=1  → find MLB player ID
  /api/v1/people/{id}/stats?stats=gameLog&season=YYYY&group=hitting → game logs

Usage:
  python3 import_mlb_api.py
  python3 import_mlb_api.py --dry-run
  python3 import_mlb_api.py --start-season 2020 --end-season 2024
"""

import argparse
import json
import os
import sys
import time
import unicodedata
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

MLB_API = "https://statsapi.mlb.com/api/v1"

# ─── HTTP helpers ────────────────────────────────────────────────────────────

def http_get_json(url, timeout=30, retries=3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "BackInPlay/1.0"})
            resp = urllib.request.urlopen(req, timeout=timeout)
            return json.loads(resp.read().decode())
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
                continue
            return None

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

# ─── MLB API helpers ─────────────────────────────────────────────────────────

def search_mlb_player(name):
    """Search MLB Stats API for a player by name. Returns (mlb_id, fullName) or (None, None)."""
    encoded = urllib.parse.quote(name)
    url = f"{MLB_API}/people/search?names={encoded}&sportIds=1"
    data = http_get_json(url)
    if not data or not data.get("people"):
        return None, None
    # Return first result
    p = data["people"][0]
    return p["id"], p.get("fullName", name)

def get_game_logs(mlb_id, season, group="hitting"):
    """Get game-by-game stats for a player in a season."""
    url = f"{MLB_API}/people/{mlb_id}/stats?stats=gameLog&season={season}&group={group}"
    data = http_get_json(url)
    if not data or not data.get("stats"):
        return []
    stats = data["stats"]
    if not stats or not stats[0].get("splits"):
        return []
    return stats[0]["splits"]

def compute_composite(hits, hrs, rbis, runs, sb, bb):
    """MLB composite: hits*1 + hrs*4 + rbis*1 + runs*1 + sb*2 + bb*1"""
    return hits + hrs * 4 + rbis + runs + sb * 2 + bb

# ─── Checkpoint ──────────────────────────────────────────────────────────────

def load_checkpoint(path):
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return {"matched_players": {}, "done_players": [], "failed_searches": []}

def save_checkpoint(path, cp):
    with open(path, "w") as f:
        json.dump(cp, f)

# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Import MLB game logs via Stats API")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--start-season", type=int, default=2010)
    parser.add_argument("--end-season", type=int, default=2024)
    parser.add_argument("--checkpoint", type=str,
                        default=os.path.join(os.path.dirname(__file__), "checkpoint_mlb_import.json"))
    args = parser.parse_args()

    # Get MLB league_id from our DB
    leagues = sb_get("back_in_play_leagues", "select=league_id,slug&slug=eq.mlb")
    if not leagues:
        print("ERROR: MLB league not found")
        sys.exit(1)
    league_id = leagues[0]["league_id"]
    print(f"MLB league_id: {league_id}", flush=True)

    # Load all MLB players from our DB
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
    print(f"Loaded {len(players)} MLB players from DB", flush=True)

    # Load checkpoint
    cp = load_checkpoint(args.checkpoint)
    matched_players = cp["matched_players"]  # db_player_id -> mlb_api_id
    done_players = set(cp["done_players"])  # db_player_ids fully imported
    failed_searches = set(cp.get("failed_searches", []))

    # Phase 1: Match DB players to MLB API IDs
    print(f"\n{'='*60}", flush=True)
    print("Phase 1: Matching DB players to MLB Stats API", flush=True)
    print(f"{'='*60}", flush=True)

    unmatched = []
    newly_matched = 0
    for i, p in enumerate(players):
        pid = p["player_id"]
        name = p.get("player_name", "").strip()
        if not name:
            continue
        if pid in matched_players or pid in failed_searches:
            continue

        mlb_id, mlb_name = search_mlb_player(name)
        if mlb_id:
            # Verify name similarity
            norm_db = normalize(name)
            norm_mlb = normalize(mlb_name)
            if norm_db == norm_mlb or norm_db.split()[-1] == norm_mlb.split()[-1]:
                matched_players[pid] = mlb_id
                newly_matched += 1
            else:
                # Check first initial + last name
                db_parts = norm_db.split()
                mlb_parts = norm_mlb.split()
                if (len(db_parts) >= 2 and len(mlb_parts) >= 2 and
                    db_parts[-1] == mlb_parts[-1] and db_parts[0][0] == mlb_parts[0][0]):
                    matched_players[pid] = mlb_id
                    newly_matched += 1
                else:
                    failed_searches.add(pid)
                    unmatched.append(f"{name} -> API: {mlb_name} (rejected)")
        else:
            failed_searches.add(pid)
            unmatched.append(name)

        if (i + 1) % 100 == 0:
            print(f"  Searched {i+1}/{len(players)}, matched: {len(matched_players)}, "
                  f"new: {newly_matched}, failed: {len(failed_searches)}", flush=True)
            cp["matched_players"] = matched_players
            cp["done_players"] = list(done_players)
            cp["failed_searches"] = list(failed_searches)
            save_checkpoint(args.checkpoint, cp)
            time.sleep(0.2)  # Be nice to the API

        # Small delay between searches
        if newly_matched > 0 and (i + 1) % 10 == 0:
            time.sleep(0.1)

    print(f"\nPhase 1 complete: {len(matched_players)} matched, {len(failed_searches)} not found", flush=True)
    cp["matched_players"] = matched_players
    cp["done_players"] = list(done_players)
    cp["failed_searches"] = list(failed_searches)
    save_checkpoint(args.checkpoint, cp)

    if unmatched and len(unmatched) <= 30:
        print("\nUnmatched players:")
        for n in sorted(unmatched)[:30]:
            print(f"  {n}")

    # Phase 2: Pull game logs for matched players
    print(f"\n{'='*60}", flush=True)
    print("Phase 2: Importing game logs", flush=True)
    print(f"{'='*60}", flush=True)

    total_logs = 0
    total_loaded = 0
    db_rows = []
    players_done_this_run = 0

    for pid, mlb_id in sorted(matched_players.items()):
        if pid in done_players:
            continue

        player_logs = 0
        for season in range(args.start_season, args.end_season + 1):
            splits = get_game_logs(mlb_id, season)
            for s in splits:
                stat = s.get("stat", {})
                game_date = s.get("date")
                if not game_date:
                    continue

                # Only regular season
                if s.get("gameType", "R") != "R":
                    continue

                opponent_name = s.get("opponent", {}).get("name", "")
                # Try to get abbreviation from team link
                opp_id = s.get("opponent", {}).get("id", "")

                hits = stat.get("hits", 0) or 0
                hrs = stat.get("homeRuns", 0) or 0
                rbis = stat.get("rbi", 0) or 0
                runs = stat.get("runs", 0) or 0
                sb = stat.get("stolenBases", 0) or 0
                bb = stat.get("baseOnBalls", 0) or 0
                ab = stat.get("atBats", 0) or 0

                if ab == 0 and hits == 0 and bb == 0:
                    continue

                composite = compute_composite(hits, hrs, rbis, runs, sb, bb)

                db_row = {
                    "player_id": pid,
                    "league_slug": "mlb",
                    "season": season,
                    "game_date": game_date,
                    "opponent": opponent_name,
                    "started": None,
                    "minutes": None,
                    "stat_goals": hrs,  # Using stat_goals for HRs
                    "stat_assists": rbis,  # Using stat_assists for RBIs
                    "stat_sog": hits,  # Using stat_sog for hits
                    "composite": round(composite, 2),
                    "source_url": "mlb_stats_api",
                }
                db_rows.append(db_row)
                player_logs += 1

            time.sleep(0.05)  # Rate limit: ~20 req/sec

        total_logs += player_logs
        done_players.add(pid)
        players_done_this_run += 1

        # Batch upsert every 500 rows
        if len(db_rows) >= 500:
            if not args.dry_run:
                n = sb_upsert("back_in_play_player_game_logs", db_rows)
                total_loaded += n
            else:
                total_loaded += len(db_rows)
            db_rows = []

        if players_done_this_run % 50 == 0:
            print(f"  Players: {players_done_this_run}/{len(matched_players) - len(cp['done_players'])}, "
                  f"logs: {total_logs}, loaded: {total_loaded}", flush=True)
            cp["done_players"] = list(done_players)
            save_checkpoint(args.checkpoint, cp)

    # Final batch
    if db_rows:
        if not args.dry_run:
            n = sb_upsert("back_in_play_player_game_logs", db_rows)
            total_loaded += n
        else:
            total_loaded += len(db_rows)

    cp["done_players"] = list(done_players)
    save_checkpoint(args.checkpoint, cp)

    print(f"\n{'='*60}")
    print(f"MLB Players in DB:     {len(players)}")
    print(f"Matched to MLB API:    {len(matched_players)}")
    print(f"Not found:             {len(failed_searches)}")
    print(f"Game logs fetched:     {total_logs}")
    print(f"Loaded/upserted:       {total_loaded}")
    if args.dry_run:
        print("(DRY RUN - no DB writes)")
    print(f"{'='*60}")

if __name__ == "__main__":
    main()
