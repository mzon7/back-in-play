#!/usr/bin/env python3
"""Debug why NFL injured players are missing game logs."""
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
            time.sleep(3)
    return []

lgs = sb_get("back_in_play_leagues", "select=league_id&slug=eq.nfl")
lid = lgs[0]["league_id"]

# Get all NFL players
players = []
offset = 0
while True:
    batch = sb_get("back_in_play_players",
        "select=player_id,player_name,position,espn_id&league_id=eq." + lid + "&limit=1000&offset=" + str(offset))
    if not batch: break
    players.extend(batch)
    if len(batch) < 1000: break
    offset += 1000

player_map = {p["player_id"]: p for p in players}
all_nfl = set(p["player_id"] for p in players)

# Get injured
injured = set()
offset = 0
while True:
    batch = sb_get("back_in_play_injuries", "select=player_id&limit=1000&offset=" + str(offset))
    if not batch: break
    for r in batch: injured.add(r["player_id"])
    if len(batch) < 1000: break
    offset += 1000
nfl_injured = injured & all_nfl

# Get those with logs
log_pids = set()
offset = 0
while True:
    batch = sb_get("back_in_play_player_game_logs",
        "select=player_id&league_slug=eq.nfl&limit=1000&offset=" + str(offset))
    if not batch: break
    for r in batch: log_pids.add(r["player_id"])
    if len(batch) < 1000: break
    offset += 1000

missing = nfl_injured - log_pids

# For missing players, get their earliest injury date
print(f"Total missing injured players: {len(missing)}")
print(f"\nAnalyzing earliest injury dates for missing players...")

injury_years = Counter()
has_espn = 0
no_espn = 0
sample_names = []

for i, pid in enumerate(list(missing)[:500]):
    p = player_map.get(pid, {})

    # Check ESPN ID
    if p.get("espn_id"):
        has_espn += 1
    else:
        no_espn += 1

    # Get earliest injury date
    injs = sb_get("back_in_play_injuries",
        "select=date_injured&player_id=eq." + pid + "&order=date_injured.asc&limit=1")
    if injs and injs[0].get("date_injured"):
        year = injs[0]["date_injured"][:4]
        injury_years[year] += 1

    if len(sample_names) < 30:
        name = p.get("player_name", "?")
        pos = p.get("position", "?")
        espn = "ESPN" if p.get("espn_id") else "no-ESPN"
        yr = injs[0]["date_injured"][:4] if injs and injs[0].get("date_injured") else "?"
        sample_names.append(f"{name} ({pos}, {espn}, inj:{yr})")

    if (i+1) % 100 == 0:
        print(f"  Checked {i+1}/500...", flush=True)
    time.sleep(0.02)

print(f"\nOf {min(500, len(missing))} sampled missing players:")
print(f"  Has ESPN ID: {has_espn} ({has_espn*100//(has_espn+no_espn)}%)")
print(f"  No ESPN ID: {no_espn} ({no_espn*100//(has_espn+no_espn)}%)")

print(f"\nEarliest injury year distribution:")
for year in sorted(injury_years.keys()):
    bar = "#" * (injury_years[year] // 2)
    print(f"  {year}: {injury_years[year]:>4}  {bar}")

print(f"\nSample missing players:")
for s in sorted(sample_names):
    print(f"  {s}")

# Key insight: how many have ESPN IDs (meaning we COULD get their data from ESPN API)?
print(f"\n--- KEY INSIGHT ---")
print(f"Missing players with ESPN IDs: {has_espn}")
print(f"These could potentially be filled via ESPN gamelog API")
print(f"Missing players WITHOUT ESPN IDs: {no_espn}")
print(f"These need name-based CSV matching improvement")
