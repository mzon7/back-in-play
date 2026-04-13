#!/usr/bin/env python3
"""Analyze why NFL injured players are missing game logs."""
import json, os, time, urllib.request, unicodedata
from pathlib import Path
from collections import Counter

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
            time.sleep(2)
    return []

# Get NFL league
lgs = sb_get("back_in_play_leagues", "select=league_id&slug=eq.nfl")
lid = lgs[0]["league_id"]

# Get ALL NFL player_ids
all_nfl = set()
offset = 0
while True:
    batch = sb_get("back_in_play_players", "select=player_id&league_id=eq." + lid + "&limit=1000&offset=" + str(offset))
    if not batch: break
    for r in batch: all_nfl.add(r["player_id"])
    if len(batch) < 1000: break
    offset += 1000

# Get injured player_ids
injured = set()
offset = 0
while True:
    batch = sb_get("back_in_play_injuries", "select=player_id&limit=1000&offset=" + str(offset))
    if not batch: break
    for r in batch: injured.add(r["player_id"])
    if len(batch) < 1000: break
    offset += 1000

nfl_injured = injured & all_nfl

# Get player_ids with game logs
log_pids = set()
offset = 0
while True:
    batch = sb_get("back_in_play_player_game_logs", "select=player_id&league_slug=eq.nfl&limit=1000&offset=" + str(offset))
    if not batch: break
    for r in batch: log_pids.add(r["player_id"])
    if len(batch) < 1000: break
    offset += 1000

missing = nfl_injured - log_pids
print(f"NFL injured players: {len(nfl_injured)}")
print(f"With game logs: {len(nfl_injured & log_pids)}")
print(f"Missing game logs: {len(missing)}")

# Sample 100 missing players - get their positions
positions = Counter()
sample_names = []
missing_list = list(missing)[:200]

for pid in missing_list:
    players = sb_get("back_in_play_players", "select=player_name,position&player_id=eq." + pid + "&limit=1")
    if players:
        p = players[0]
        pos = p.get("position", "Unknown")
        name = p.get("player_name", "?")
        positions[pos] += 1
        if len(sample_names) < 40:
            sample_names.append(f"{name} ({pos})")
    time.sleep(0.02)

print(f"\nPositions of missing players (sample of {len(missing_list)}):")
for pos, cnt in positions.most_common():
    print(f"  {pos}: {cnt}")

print(f"\nSample missing player names:")
for name in sorted(sample_names):
    print(f"  {name}")
