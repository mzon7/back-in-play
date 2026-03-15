#!/usr/bin/env python3
"""Check how many players with injuries have game logs, per league."""
import json, os, urllib.request
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
            import time; time.sleep(3)
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
            import time; time.sleep(3)
    return 0

leagues = ["nba", "nfl", "nhl", "mlb", "premier-league"]

print(f"{'League':<18} {'Total Plyr':<11} {'w/Injury':<11} {'Inj+Logs':<11} {'InjLogCov%':<11} {'Injuries':<10} {'GameLogs':<10}")
print("-" * 92)

for slug in leagues:
    lgs = sb_get("back_in_play_leagues", "select=league_id&slug=eq." + slug)
    if not lgs:
        continue
    lid = lgs[0]["league_id"]

    total_p = sb_count("back_in_play_players", "league_id=eq." + lid)
    total_injuries = sb_count("back_in_play_injuries", "league_slug=eq." + slug)
    total_logs = sb_count("back_in_play_player_game_logs", "league_slug=eq." + slug)

    # Get distinct player_ids that have injuries
    injured_pids = set()
    offset = 0
    while True:
        batch = sb_get("back_in_play_injuries",
            "select=player_id&league_slug=eq." + slug + "&limit=1000&offset=" + str(offset))
        if not batch:
            break
        for r in batch:
            injured_pids.add(r["player_id"])
        if len(batch) < 1000:
            break
        offset += 1000
        if offset > 100000:
            break

    # Get distinct player_ids that have game logs
    log_pids = set()
    offset = 0
    while True:
        batch = sb_get("back_in_play_player_game_logs",
            "select=player_id&league_slug=eq." + slug + "&limit=1000&offset=" + str(offset))
        if not batch:
            break
        for r in batch:
            log_pids.add(r["player_id"])
        if len(batch) < 1000:
            break
        offset += 1000
        if offset > 600000:
            break

    # Intersection: injured players who also have logs
    injured_with_logs = injured_pids & log_pids
    inj_count = len(injured_pids)
    both_count = len(injured_with_logs)
    cov_pct = (both_count * 100 // inj_count) if inj_count else 0

    print("{:<18} {:<11} {:<11} {:<11} {:<11} {:<10} {:<10}".format(
        slug, total_p, inj_count, both_count, str(cov_pct) + "%",
        total_injuries, total_logs))
