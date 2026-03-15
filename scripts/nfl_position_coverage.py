#!/usr/bin/env python3
"""NFL injury coverage by position group."""
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

lgs = sb_get("back_in_play_leagues", "select=league_id&slug=eq.nfl")
lid = lgs[0]["league_id"]

offense_positions = {"QB", "Quarterback", "RB", "Running Back", "WR", "Wide Receiver",
    "TE", "Tight End", "FB", "Fullback", "HB"}
defense_positions = {"CB", "Cornerback", "S", "Safety", "FS", "SS", "LB", "Linebacker",
    "ILB", "OLB", "MLB", "DE", "Defensive End", "DT", "Defensive Tackle", "NT", "DL",
    "DB", "Edge"}
oline_positions = {"OL", "G", "Guard", "C", "Center", "T", "OT", "Offensive Tackle",
    "LG", "RG", "LT", "RT", "Offensive Line"}
special_positions = {"K", "Kicker", "P", "Punter", "LS", "Long Snapper"}

players = []
offset = 0
while True:
    batch = sb_get("back_in_play_players", "select=player_id,position&league_id=eq." + lid + "&limit=1000&offset=" + str(offset))
    if not batch: break
    players.extend(batch)
    if len(batch) < 1000: break
    offset += 1000

off_pids = set()
def_pids = set()
ol_pids = set()
spec_pids = set()
other_pids = set()
for p in players:
    pos = (p.get("position") or "").strip()
    pid = p["player_id"]
    if pos in offense_positions:
        off_pids.add(pid)
    elif pos in defense_positions:
        def_pids.add(pid)
    elif pos in oline_positions:
        ol_pids.add(pid)
    elif pos in special_positions:
        spec_pids.add(pid)
    else:
        other_pids.add(pid)

injured = set()
offset = 0
while True:
    batch = sb_get("back_in_play_injuries", "select=player_id&limit=1000&offset=" + str(offset))
    if not batch: break
    for r in batch: injured.add(r["player_id"])
    if len(batch) < 1000: break
    offset += 1000

all_nfl = set(p["player_id"] for p in players)
nfl_injured = injured & all_nfl

log_pids = set()
offset = 0
while True:
    batch = sb_get("back_in_play_player_game_logs", "select=player_id&league_slug=eq.nfl&limit=1000&offset=" + str(offset))
    if not batch: break
    for r in batch: log_pids.add(r["player_id"])
    if len(batch) < 1000: break
    offset += 1000

header = "{:<15} {:<9} {:<9} {:<9} {:<10} {:<9}".format(
    "Group", "Players", "Injured", "w/Logs", "Coverage", "Missing")
print(header)
print("-" * 62)

for name, pids in [("Offense", off_pids), ("Defense", def_pids), ("O-Line", ol_pids),
                    ("Special", spec_pids), ("Unknown/None", other_pids)]:
    inj = pids & nfl_injured
    with_logs = inj & log_pids
    missing = inj - log_pids
    cov = str(len(with_logs) * 100 // len(inj)) + "%" if inj else "N/A"
    print("{:<15} {:<9} {:<9} {:<9} {:<10} {:<9}".format(
        name, len(pids), len(inj), len(with_logs), cov, len(missing)))

total_inj = len(nfl_injured)
total_with = len(nfl_injured & log_pids)
total_miss = total_inj - total_with
cov_str = str(total_with * 100 // total_inj) + "%"
print("-" * 62)
print("{:<15} {:<9} {:<9} {:<9} {:<10} {:<9}".format(
    "TOTAL", len(all_nfl), total_inj, total_with, cov_str, total_miss))
