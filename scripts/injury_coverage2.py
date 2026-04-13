#!/usr/bin/env python3
"""Check how many injured players have game logs, per league."""
import json, os, time, urllib.request
from pathlib import Path

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

SB_URL = os.environ["SUPABASE_URL"]
SB_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

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

def sb_count(table, where=""):
    url = SB_URL + "/rest/v1/" + table + "?select=*&" + where
    hdrs = {"apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY, "Prefer": "count=exact", "Range": "0-0"}
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=hdrs)
            resp = urllib.request.urlopen(req, timeout=30)
            cr = resp.headers.get("Content-Range", "")
            return int(cr.split("/")[1]) if "/" in cr else 0
        except Exception:
            time.sleep(3)
    return 0

leagues = ["nba", "nfl", "nhl", "mlb", "premier-league"]

# Step 1: Get all player_ids per league
league_players = {}
for slug in leagues:
    lgs = sb_get("back_in_play_leagues", "select=league_id&slug=eq." + slug)
    if not lgs:
        continue
    lid = lgs[0]["league_id"]
    pids = set()
    offset = 0
    while True:
        batch = sb_get("back_in_play_players",
            "select=player_id&league_id=eq." + lid + "&limit=1000&offset=" + str(offset))
        if not batch:
            break
        for r in batch:
            pids.add(r["player_id"])
        if len(batch) < 1000:
            break
        offset += 1000
    league_players[slug] = pids
    print(f"  {slug}: {len(pids)} players", flush=True)

# Step 2: Get all distinct player_ids from injuries
print("\nLoading injury player_ids...", flush=True)
injured_pids = set()
offset = 0
while True:
    batch = sb_get("back_in_play_injuries",
        "select=player_id&limit=1000&offset=" + str(offset))
    if not batch:
        break
    for r in batch:
        injured_pids.add(r["player_id"])
    if len(batch) < 1000:
        break
    offset += 1000
    if offset > 200000:
        break
print(f"  Total injured player_ids: {len(injured_pids)}", flush=True)

# Step 3: Get all distinct player_ids from game logs per league
print("\nLoading game log player_ids...", flush=True)
log_pids_by_league = {}
for slug in leagues:
    pids = set()
    offset = 0
    while True:
        batch = sb_get("back_in_play_player_game_logs",
            "select=player_id&league_slug=eq." + slug + "&limit=1000&offset=" + str(offset))
        if not batch:
            break
        for r in batch:
            pids.add(r["player_id"])
        if len(batch) < 1000:
            break
        offset += 1000
        if offset > 600000:
            break
    log_pids_by_league[slug] = pids
    print(f"  {slug}: {len(pids)} players with logs", flush=True)

# Step 4: Compute intersection per league
total_injuries = sb_count("back_in_play_injuries", "")

print(f"\n{'League':<18} {'Players':<9} {'Injured':<9} {'Inj+Logs':<9} {'Coverage':<9} {'No Logs':<9} {'Injuries':<10} {'GameLogs':<10}")
print("-" * 96)

for slug in leagues:
    all_pids = league_players.get(slug, set())
    log_pids = log_pids_by_league.get(slug, set())

    # Injured players in this league
    league_injured = injured_pids & all_pids
    # Injured players who also have game logs
    injured_with_logs = league_injured & log_pids
    # Injured players missing game logs
    injured_no_logs = league_injured - log_pids

    inj_count = len(league_injured)
    both_count = len(injured_with_logs)
    cov_pct = (both_count * 100 // inj_count) if inj_count else 0

    total_p = len(all_pids)
    total_l = sb_count("back_in_play_player_game_logs", "league_slug=eq." + slug)

    print("{:<18} {:<9} {:<9} {:<9} {:<9} {:<9} {:<10}".format(
        slug, total_p, inj_count, both_count, str(cov_pct) + "%",
        len(injured_no_logs), total_l))
