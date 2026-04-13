#!/usr/bin/env python3
"""Comprehensive coverage check: players with game logs, sources, per league."""
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
    req = urllib.request.Request(url, headers=hdrs)
    resp = urllib.request.urlopen(req, timeout=60)
    return json.loads(resp.read().decode())

def sb_count(table, where=""):
    url = SB_URL + "/rest/v1/" + table + "?select=*&" + where
    hdrs = {"apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY, "Prefer": "count=exact", "Range": "0-0"}
    req = urllib.request.Request(url, headers=hdrs)
    resp = urllib.request.urlopen(req, timeout=30)
    cr = resp.headers.get("Content-Range", "")
    return int(cr.split("/")[1]) if "/" in cr else 0

leagues = ["nba", "nfl", "nhl", "mlb", "premier-league"]

print(f"{'League':<18} {'Players':<9} {'w/ESPN':<9} {'w/Logs':<9} {'LogCov%':<9} {'GameLogs':<10} {'Logs/Plyr':<10} {'Sources'}")
print("-" * 110)

for slug in leagues:
    lgs = sb_get("back_in_play_leagues", "select=league_id&slug=eq." + slug)
    if not lgs:
        continue
    lid = lgs[0]["league_id"]

    total_p = sb_count("back_in_play_players", "league_id=eq." + lid)
    espn_p = sb_count("back_in_play_players", "league_id=eq." + lid + "&espn_id=not.is.null")
    total_logs = sb_count("back_in_play_player_game_logs", "league_slug=eq." + slug)

    # Count distinct players with game logs
    players_with_logs = set()
    offset = 0
    while True:
        batch = sb_get("back_in_play_player_game_logs",
            "select=player_id&league_slug=eq." + slug + "&limit=1000&offset=" + str(offset))
        if not batch:
            break
        for r in batch:
            players_with_logs.add(r["player_id"])
        if len(batch) < 1000:
            break
        offset += 1000
        if offset > 600000:
            break

    wl = len(players_with_logs)
    log_cov_pct = (wl * 100 // total_p) if total_p else 0
    lpp = "{:.1f}".format(total_logs / wl) if wl else "0"

    # Get distinct source_url values
    sources = set()
    src_batch = sb_get("back_in_play_player_game_logs",
        "select=source_url&league_slug=eq." + slug + "&limit=5000")
    for r in src_batch:
        s = r.get("source_url", "")
        if s:
            sources.add(s)

    src_str = ", ".join(sorted(sources))
    print("{:<18} {:<9} {:<9} {:<9} {:<9} {:<10} {:<10} {}".format(
        slug, total_p, espn_p, wl, str(log_cov_pct) + "%", total_logs, lpp, src_str))
