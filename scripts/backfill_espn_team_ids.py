#!/usr/bin/env python3
"""
Backfill espn_team_id on back_in_play_teams by fetching ESPN team lists
and matching by team name / abbreviation.
"""

import json, os, sys, time, urllib.request
from pathlib import Path

def load_env():
    for envfile in ["/root/.daemon-env", ".env", "../.env"]:
        p = Path(envfile)
        if p.exists():
            for line in p.read_text().splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, val = line.partition("=")
                    os.environ.setdefault(key.strip(), val.strip().strip("'\""))

load_env()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
    sys.exit(1)

USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

LEAGUE_CFG = {
    "nba": {"sport": "basketball", "league": "nba"},
    "nhl": {"sport": "hockey",     "league": "nhl"},
    "nfl": {"sport": "football",   "league": "nfl"},
    "mlb": {"sport": "baseball",   "league": "mlb"},
    "premier-league": {"sport": "soccer", "league": "eng.1"},
}


def fetch_json(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        resp = urllib.request.urlopen(req, timeout=15)
        return json.loads(resp.read().decode())
    except Exception as e:
        print("  [fetch err] %s" % e, flush=True)
        return None


def sb_get(table, params=""):
    url = SUPABASE_URL + "/rest/v1/" + table + "?" + params
    hdrs = {"apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY}
    try:
        req = urllib.request.Request(url, headers=hdrs)
        resp = urllib.request.urlopen(req, timeout=30)
        return json.loads(resp.read().decode())
    except Exception as e:
        print("  [GET err] %s: %s" % (table, e), flush=True)
        return []


def sb_patch(table, filter_params, body):
    url = SUPABASE_URL + "/rest/v1/" + table + "?" + filter_params
    data = json.dumps(body).encode()
    hdrs = {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    try:
        req = urllib.request.Request(url, data=data, headers=hdrs, method="PATCH")
        urllib.request.urlopen(req, timeout=30)
        return True
    except Exception as e:
        print("  [PATCH err] %s: %s" % (table, e), flush=True)
        return False


def normalize(name):
    """Normalize team name for matching."""
    return name.lower().strip().replace(".", "").replace("'", "")


def fetch_espn_teams(sport, league):
    """Fetch all teams from ESPN for a sport/league."""
    url = ("https://site.api.espn.com/apis/site/v2/sports/%s/%s/teams?limit=100"
           % (sport, league))
    data = fetch_json(url)
    if not data:
        return []
    teams = []
    for entry in data.get("sports", [{}])[0].get("leagues", [{}])[0].get("teams", []):
        team = entry.get("team", entry)
        teams.append({
            "id": team.get("id"),
            "name": team.get("name", ""),           # e.g. "Lakers"
            "displayName": team.get("displayName", ""),  # e.g. "Los Angeles Lakers"
            "abbreviation": team.get("abbreviation", ""),
            "shortDisplayName": team.get("shortDisplayName", ""),
            "location": team.get("location", ""),    # e.g. "Los Angeles"
        })
    return teams


def main():
    # Get our teams with their leagues
    our_teams = sb_get("back_in_play_teams",
                       "select=team_id,team_name,league_id,espn_team_id")
    leagues = sb_get("back_in_play_leagues", "select=league_id,slug")
    league_map = {l["league_id"]: l["slug"] for l in (leagues or [])}

    print("Our DB has %d teams" % len(our_teams), flush=True)

    # Group our teams by league
    by_league = {}
    for t in our_teams:
        slug = league_map.get(t["league_id"], "")
        if slug:
            by_league.setdefault(slug, []).append(t)

    total_matched = 0

    for slug, cfg in LEAGUE_CFG.items():
        our = by_league.get(slug, [])
        if not our:
            print("\n%s: no teams in our DB" % slug.upper(), flush=True)
            continue

        # Skip teams that already have espn_team_id
        need_match = [t for t in our if not t.get("espn_team_id")]
        if not need_match:
            print("\n%s: all %d teams already have espn_team_id" % (slug.upper(), len(our)), flush=True)
            continue

        print("\n%s: %d teams need ESPN IDs" % (slug.upper(), len(need_match)), flush=True)

        espn_teams = fetch_espn_teams(cfg["sport"], cfg["league"])
        if not espn_teams:
            print("  Could not fetch ESPN teams", flush=True)
            continue

        print("  ESPN has %d teams" % len(espn_teams), flush=True)

        # Build match index from ESPN teams
        espn_index = {}
        for et in espn_teams:
            for field in ["displayName", "name", "shortDisplayName", "location"]:
                val = normalize(et.get(field, ""))
                if val:
                    espn_index[val] = et["id"]
            # Also index by abbreviation
            abbr = et.get("abbreviation", "").lower()
            if abbr:
                espn_index[abbr] = et["id"]

        matched = 0
        for t in need_match:
            our_name = normalize(t["team_name"])
            if our_name == "unknown":
                continue

            espn_id = espn_index.get(our_name)

            # Try partial matching if exact match fails
            if not espn_id:
                for key, eid in espn_index.items():
                    if our_name in key or key in our_name:
                        espn_id = eid
                        break

            if espn_id:
                sb_patch("back_in_play_teams",
                         "team_id=eq.%s" % t["team_id"],
                         {"espn_team_id": str(espn_id)})
                print("    %s → ESPN ID %s" % (t["team_name"], espn_id), flush=True)
                matched += 1
            else:
                print("    %s → NO MATCH" % t["team_name"], flush=True)

        total_matched += matched
        print("  Matched %d / %d" % (matched, len(need_match)), flush=True)
        time.sleep(0.5)

    print("\nTotal matched: %d" % total_matched, flush=True)


if __name__ == "__main__":
    main()
