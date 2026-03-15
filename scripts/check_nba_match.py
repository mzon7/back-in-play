#!/usr/bin/env python3
"""Quick check: which unmatched CSV names exist in DB?"""
import json, os, csv, unicodedata, re
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

import requests
SB_URL = os.environ["SUPABASE_URL"]
SB_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
SB_H = {"apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY}

SUFFIXES = {"jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"}

def normalize(name):
    nfkd = unicodedata.normalize("NFKD", name)
    stripped = "".join(c for c in nfkd if not unicodedata.combining(c))
    cleaned = stripped.replace("'", "").replace("\u2019", "").replace(".", "").replace("-", " ")
    parts = cleaned.lower().split()
    parts = [p for p in parts if p not in SUFFIXES]
    return " ".join(parts)

# Get DB names
lgs = requests.get(SB_URL + "/rest/v1/back_in_play_leagues?select=league_id&slug=eq.nba&limit=1", headers=SB_H).json()
lid = lgs[0]["league_id"]
players = []
offset = 0
while True:
    batch = requests.get(SB_URL + f"/rest/v1/back_in_play_players?select=player_name&league_id=eq.{lid}&limit=1000&offset={offset}", headers=SB_H).json()
    if not batch: break
    players.extend(batch)
    if len(batch) < 1000: break
    offset += 1000

db_norms = {}
for p in players:
    n = p.get("player_name", "").strip()
    if n:
        db_norms[normalize(n)] = n

# Get all CSV names
csv_names = set()
for f in ["scripts/nba_data/part1.csv", "scripts/nba_data/part2.csv", "scripts/nba_data/part3.csv"]:
    if not os.path.exists(f): continue
    with open(f) as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            n = (row.get("personName") or "").strip()
            if n:
                csv_names.add(n)

# Check matches
matched = 0
csv_in_db_but_not_matching = []
csv_not_in_db = []

for cn in sorted(csv_names):
    norm_cn = normalize(cn)
    if norm_cn in db_norms:
        matched += 1
    else:
        # Check if any DB name contains the same last name + first letter
        cn_parts = norm_cn.split()
        if len(cn_parts) >= 2:
            found = False
            for db_norm, db_raw in db_norms.items():
                db_parts = db_norm.split()
                if len(db_parts) >= 2 and cn_parts[-1] == db_parts[-1] and cn_parts[0][0] == db_parts[0][0]:
                    csv_in_db_but_not_matching.append(f"CSV: {cn} -> DB: {db_raw}")
                    found = True
                    break
            if not found:
                csv_not_in_db.append(cn)
        else:
            csv_not_in_db.append(cn)

print(f"CSV players: {len(csv_names)}")
print(f"Direct match: {matched}")
print(f"Fuzzy matchable (last name+initial): {len(csv_in_db_but_not_matching)}")
print(f"Not in DB: {len(csv_not_in_db)}")
print()
print("Fuzzy matchable (first 20):")
for x in csv_in_db_but_not_matching[:20]:
    print(f"  {x}")
