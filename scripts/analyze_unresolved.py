#!/usr/bin/env python3
"""Analyze unresolved players across all leagues."""
import json, os, sys
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

def sb_get(table, params=""):
    r = requests.get(f"{SB_URL}/rest/v1/{table}?{params}", headers=SB_H, timeout=30)
    r.raise_for_status()
    return r.json()

leagues = sb_get("back_in_play_leagues", "select=league_id,slug")

for lg in leagues:
    slug = lg["slug"]
    lid = lg["league_id"]

    # Count total and unresolved
    total = sb_get("back_in_play_players", f"select=player_id&league_id=eq.{lid}&limit=1")
    # Use head count
    r = requests.get(f"{SB_URL}/rest/v1/back_in_play_players?select=player_id&league_id=eq.{lid}",
                     headers={**SB_H, "Prefer": "count=exact", "Range": "0-0"}, timeout=30)
    total_count = int(r.headers.get("Content-Range", "0-0/0").split("/")[1])

    r2 = requests.get(f"{SB_URL}/rest/v1/back_in_play_players?select=player_id&league_id=eq.{lid}&espn_id=is.null",
                      headers={**SB_H, "Prefer": "count=exact", "Range": "0-0"}, timeout=30)
    missing = int(r2.headers.get("Content-Range", "0-0/0").split("/")[1])

    have = total_count - missing
    pct = round(100 * have / total_count, 1) if total_count > 0 else 0
    print(f"{slug:20s}: {have:5d}/{total_count:5d} have espn_id ({pct}%) -- {missing} missing")

# NBA detail analysis
print("\n--- NBA Unresolved Detail ---")
lgs = sb_get("back_in_play_leagues", "select=league_id&slug=eq.nba&limit=1")
lid = lgs[0]["league_id"]

players = []
offset = 0
while True:
    batch = sb_get("back_in_play_players",
                   f"select=player_name&league_id=eq.{lid}&espn_id=is.null&limit=1000&offset={offset}")
    if not batch:
        break
    players.extend(batch)
    if len(batch) < 1000:
        break
    offset += 1000

names = sorted([p["player_name"] for p in players if p.get("player_name")])
print(f"Unresolved: {len(names)}")
print("\nFirst 40:")
for n in names[:40]:
    print(f"  {n}")

# Check which have sport_ref_id (could use that for game logs instead)
r3 = requests.get(f"{SB_URL}/rest/v1/back_in_play_players?select=player_id&league_id=eq.{lid}&espn_id=is.null&sport_ref_id=not.is.null",
                  headers={**SB_H, "Prefer": "count=exact", "Range": "0-0"}, timeout=30)
have_ref = int(r3.headers.get("Content-Range", "0-0/0").split("/")[1])
print(f"\nOf unresolved: {have_ref} have sport_ref_id (can use basketball-reference for game logs)")
