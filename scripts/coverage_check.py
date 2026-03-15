#!/usr/bin/env python3
"""Quick coverage check across all leagues."""
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

def sb_count(table, where=""):
    url = f"{SB_URL}/rest/v1/{table}?select=*&{where}"
    hdrs = {
        "apikey": SB_KEY,
        "Authorization": f"Bearer {SB_KEY}",
        "Prefer": "count=exact",
        "Range": "0-0",
    }
    req = urllib.request.Request(url, headers=hdrs)
    resp = urllib.request.urlopen(req, timeout=30)
    cr = resp.headers.get("Content-Range", "")
    if "/" in cr:
        return int(cr.split("/")[1])
    return 0

def sb_get(table, params=""):
    url = SB_URL + "/rest/v1/" + table + "?" + params
    hdrs = {"apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY}
    req = urllib.request.Request(url, headers=hdrs)
    resp = urllib.request.urlopen(req, timeout=30)
    return json.loads(resp.read().decode())

leagues = ["nba", "nfl", "nhl", "mlb", "premier-league"]
print(f"{'League':<20} {'Players':<10} {'w/ESPN':<10} {'ESPN%':<8} {'GameLogs':<12} {'Logs/Player':<12}")
print("-" * 72)

for slug in leagues:
    lgs = sb_get("back_in_play_leagues", f"select=league_id&slug=eq.{slug}")
    if not lgs:
        continue
    lid = lgs[0]["league_id"]

    total_p = sb_count("back_in_play_players", f"league_id=eq.{lid}")
    espn_p = sb_count("back_in_play_players", f"league_id=eq.{lid}&espn_id=not.is.null")
    logs = sb_count("back_in_play_player_game_logs", f"league_slug=eq.{slug}")

    pct = f"{espn_p*100//total_p}%" if total_p else "0%"
    lpp = f"{logs/total_p:.1f}" if total_p else "0"
    print(f"{slug:<20} {total_p:<10} {espn_p:<10} {pct:<8} {logs:<12} {lpp:<12}")
