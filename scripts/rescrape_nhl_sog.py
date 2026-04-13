#!/usr/bin/env python3
"""
Re-scrape NHL game logs from NHL API for players with stat_sog=0.
Uses the same name-matching logic as bulk_scrape_nhl_api.py but targets
only corrupted entries and runs in tmux-safe mode with progress tracking.
"""
import json
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import defaultdict

from db_writer import pg_upsert, SB_URL as SUPABASE_URL, SB_KEY as SUPABASE_KEY

PROGRESS_FILE = "/tmp/rescrape_nhl_progress.json"
SEASONS = ["20242025", "20252026"]


def sb_get(table, params):
    url = f"{SUPABASE_URL}/rest/v1/{table}?{params}"
    req = urllib.request.Request(url, headers={
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def fetch_json(url, retries=3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read())
        except Exception:
            if attempt < retries - 1:
                time.sleep(1)
    return None


def normalize_name(name):
    nfkd = unicodedata.normalize("NFKD", name)
    stripped = "".join(c for c in nfkd if not unicodedata.combining(c))
    cleaned = re.sub(r"[^a-z\s-]", "", stripped.lower())
    return re.sub(r"\s+", " ", cleaned).strip()


def names_match(db_name, api_name):
    n1 = normalize_name(db_name)
    n2 = normalize_name(api_name)
    if n1 == n2:
        return True
    parts1 = n1.split()
    parts2 = n2.split()
    if len(parts1) >= 2 and len(parts2) >= 2:
        if parts1[-1] == parts2[-1] and parts1[0][0] == parts2[0][0]:
            return True
    return False


def search_nhl_player(player_name):
    # Remove position prefixes
    clean = player_name
    for prefix in ["C ", "F ", "D ", "LW ", "RW ", "G ", "C/F ", "C/LW ", "C/RW "]:
        if clean.startswith(prefix):
            clean = clean[len(prefix):]
            break

    url = f"https://search.d3.nhle.com/api/v1/search/player?culture=en-us&limit=20&q={urllib.parse.quote(clean)}"
    results = fetch_json(url)
    if not results:
        return None

    for p in results:
        if names_match(clean, p.get("name", "")):
            if p.get("lastSeasonId") and int(p["lastSeasonId"][:4]) >= 2023:
                return p.get("playerId")

    # Fallback: last name match with recent activity
    db_last = normalize_name(clean).split()[-1] if clean.strip() else ""
    for p in results:
        api_last = normalize_name(p.get("name", "")).split()[-1] if p.get("name") else ""
        if db_last and db_last == api_last:
            if p.get("lastSeasonId") and int(p["lastSeasonId"][:4]) >= 2023:
                return p.get("playerId")

    return None


def main():
    # Load progress
    done_pids = set()
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE) as f:
            done_pids = set(json.load(f))
        print(f"Resuming: {len(done_pids)} players already processed")

    # Get all unique player_ids with SOG=0 in NHL
    print("Fetching players with SOG=0...", flush=True)
    all_pids = set()
    offset = 0
    while True:
        rows = sb_get(
            "back_in_play_player_game_logs",
            f"league_slug=eq.nhl&stat_sog=eq.0&game_date=gte.2024-10-01&select=player_id&limit=1000&offset={offset}"
        )
        for r in rows:
            all_pids.add(r["player_id"])
        if len(rows) < 1000:
            break
        offset += 1000
        time.sleep(0.2)

    remaining = all_pids - done_pids
    print(f"Total players with SOG=0: {len(all_pids)}, remaining: {len(remaining)}", flush=True)

    # Get player names
    player_names = {}
    for i, pid in enumerate(remaining):
        rows = sb_get("back_in_play_players", f"player_id=eq.{pid}&select=player_name")
        if rows:
            player_names[pid] = rows[0]["player_name"]
        if i % 100 == 0 and i > 0:
            print(f"  Loaded {i}/{len(remaining)} player names...", flush=True)
            time.sleep(0.2)

    print(f"Found names for {len(player_names)} players", flush=True)

    fixed_total = 0
    not_found = 0

    for idx, (pid, pname) in enumerate(player_names.items()):
        # Search NHL API for player
        nhl_pid = search_nhl_player(pname)
        time.sleep(0.15)

        if not nhl_pid:
            not_found += 1
            done_pids.add(pid)
            continue

        # Fetch game logs for recent seasons
        all_rows = []
        for season in SEASONS:
            url = f"https://api-web.nhle.com/v1/player/{nhl_pid}/game-log/{season}/2"
            data = fetch_json(url)
            if not data or "gameLog" not in data:
                continue
            for g in data["gameLog"]:
                game_date = g.get("gameDate", "")
                if not game_date:
                    continue
                opp = g.get("opponentAbbrev", {})
                opponent = opp.get("default", "") if isinstance(opp, dict) else str(opp)
                toi = g.get("toi", "")
                toi_mins = 0
                if toi:
                    try:
                        parts = toi.split(":")
                        toi_mins = int(parts[0]) + int(parts[1]) / 60 if len(parts) > 1 else int(parts[0])
                    except:
                        pass

                goals = g.get("goals", 0) or 0
                assists = g.get("assists", 0) or 0
                shots = g.get("shots", 0) or 0

                all_rows.append({
                    "player_id": pid,
                    "league_slug": "nhl",
                    "season": int(season[:4]),
                    "game_date": game_date,
                    "opponent": opponent,
                    "minutes": round(toi_mins, 1),
                    "stat_goals": goals,
                    "stat_assists": assists,
                    "stat_sog": shots,
                    "composite": 3.0 * goals + 2.0 * assists + 0.5 * shots,
                    "source_url": "nhl_api",
                })
            time.sleep(0.15)

        if all_rows:
            try:
                pg_upsert("back_in_play_player_game_logs", all_rows, conflict_cols=["player_id", "game_date"])
                sog_nonzero = sum(1 for r in all_rows if r["stat_sog"] > 0)
                fixed_total += sog_nonzero
                if idx < 50 or idx % 100 == 0:
                    print(f"  [{idx+1}/{len(player_names)}] {pname}: {len(all_rows)} logs, {sog_nonzero} with SOG>0 (NHL ID {nhl_pid})", flush=True)
            except Exception as e:
                print(f"  [{idx+1}] UPSERT ERR {pname}: {str(e)[:80]}", flush=True)

        done_pids.add(pid)

        # Save progress every 20 players
        if idx % 20 == 0:
            with open(PROGRESS_FILE, "w") as f:
                json.dump(list(done_pids), f)

    with open(PROGRESS_FILE, "w") as f:
        json.dump(list(done_pids), f)

    print(f"\n=== DONE ===", flush=True)
    print(f"Fixed SOG entries: {fixed_total}", flush=True)
    print(f"Players not found in NHL API: {not_found}", flush=True)


if __name__ == "__main__":
    main()
