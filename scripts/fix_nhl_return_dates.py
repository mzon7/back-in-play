#!/usr/bin/env python3
"""
Backfill return_date for NHL injuries using game log data.
For each NHL injury with status 'returned' but no return_date,
find the first game the player played after the injury date.
"""
import os, sys, requests
from datetime import datetime

SUPA_URL = os.environ.get("SUPABASE_URL", "https://pmjmcsrmxbhaukjgunfs.supabase.co")
SUPA_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

def sb_get(table, params):
    import time as _t
    for attempt in range(3):
        try:
            r = requests.get(f"{SUPA_URL}/rest/v1/{table}?{params}",
                headers={"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}",
                         "Accept": "application/json"}, timeout=30)
            r.raise_for_status()
            return r.json()
        except (requests.exceptions.HTTPError, requests.exceptions.ConnectionError) as e:
            if attempt < 2:
                _t.sleep(5 * (attempt + 1))
                continue
            raise

def sb_patch(table, filter_str, data):
    import time as _t
    for attempt in range(3):
        try:
            r = requests.patch(f"{SUPA_URL}/rest/v1/{table}?{filter_str}",
                json=data,
                headers={"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}",
                         "Content-Type": "application/json", "Prefer": "return=minimal"}, timeout=30)
            r.raise_for_status()
            return
        except (requests.exceptions.HTTPError, requests.exceptions.ConnectionError) as e:
            if attempt < 2:
                _t.sleep(5 * (attempt + 1))
                continue
            raise

def main():
    if not SUPA_KEY:
        print("Set SUPABASE_SERVICE_ROLE_KEY"); sys.exit(1)

    # Step 1: Get NHL league_id, then all NHL player IDs
    print("[NHL RETURN DATES] Loading NHL players...")
    leagues = sb_get("back_in_play_leagues", "select=league_id&slug=eq.nhl&limit=1")
    if not leagues:
        print("  ERROR: NHL league not found"); sys.exit(1)
    nhl_league_id = leagues[0]["league_id"]
    print(f"  NHL league_id: {nhl_league_id}")

    nhl_players = set()
    offset = 0
    while True:
        page = sb_get("back_in_play_players",
            f"select=player_id&league_id=eq.{nhl_league_id}&limit=1000&offset={offset}")
        if not page:
            break
        for p in page:
            nhl_players.add(p["player_id"])
        offset += 1000
        if len(page) < 1000:
            break
    print(f"  {len(nhl_players)} NHL players")

    # Step 2: Get injuries STILL missing return_date, filter to NHL players
    print("  Loading injuries missing return_date (skipping already fixed)...")
    all_injuries = []
    offset = 0
    while True:
        page = sb_get("back_in_play_injuries",
            f"select=injury_id,player_id,date_injured,status,return_date"
            f"&return_date=is.null&date_injured=not.is.null"
            f"&order=date_injured.desc&limit=1000&offset={offset}")
        if not page:
            break
        all_injuries.extend(page)
        offset += 1000
        if len(page) < 1000:
            break

    nhl_injuries = [i for i in all_injuries if i["player_id"] in nhl_players]
    print(f"  {len(all_injuries)} total missing return_date, {len(nhl_injuries)} are NHL")

    fixed = 0
    no_game_found = 0
    for idx, inj in enumerate(nhl_injuries):
        pid = inj["player_id"]
        d_inj = inj["date_injured"]

        # Find first game after injury
        games = sb_get("back_in_play_player_game_logs",
            f"select=game_date&player_id=eq.{pid}"
            f"&game_date=gt.{d_inj}"
            f"&order=game_date.asc&limit=1")

        if games and games[0].get("game_date"):
            return_date = games[0]["game_date"]
            try:
                d_ret = datetime.strptime(return_date, "%Y-%m-%d").date()
                d_injured = datetime.strptime(d_inj, "%Y-%m-%d").date()
                if (d_ret - d_injured).days > 365:
                    no_game_found += 1
                    continue
                recovery = (d_ret - d_injured).days
            except:
                no_game_found += 1
                continue

            sb_patch("back_in_play_injuries",
                f"injury_id=eq.{inj['injury_id']}",
                {"return_date": return_date, "recovery_days": recovery})
            fixed += 1
        else:
            no_game_found += 1

        if (idx + 1) % 100 == 0:
            print(f"  Processed {idx + 1}/{len(nhl_injuries)}, fixed {fixed}...", flush=True)

    print(f"\n[DONE] Fixed {fixed} NHL return dates, {no_game_found} had no game log after injury")

if __name__ == "__main__":
    main()
