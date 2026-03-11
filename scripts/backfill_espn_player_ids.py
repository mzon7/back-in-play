#!/usr/bin/env python3
"""
Backfill espn_id on back_in_play_players by fetching ESPN team rosters
and matching players by name.
"""

import json, os, sys, time, urllib.request, unicodedata
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


def fetch_json(url):
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            resp = urllib.request.urlopen(req, timeout=15)
            return json.loads(resp.read().decode())
        except Exception as e:
            if attempt < 2:
                time.sleep(2 ** attempt)
            else:
                return None
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


def normalize_name(name):
    """Normalize player name for matching: lowercase, strip accents, punctuation, suffixes."""
    # Strip leading slashes and known position prefixes
    import re
    name = re.sub(r'^/\s*', '', name.strip())
    name = re.sub(r'^(LWs|RWs|LW|RW|SS|CF|RF|LF|SP|RP|DH)\s+', '', name)
    name = name.lstrip('/ ')
    # Remove accents
    nfkd = unicodedata.normalize("NFKD", name)
    ascii_name = "".join(c for c in nfkd if not unicodedata.combining(c))
    n = ascii_name.lower().strip()
    # Remove apostrophes, hyphens, periods for matching
    n = n.replace("'", "").replace("'", "").replace("-", "").replace(".", "")
    # Remove common suffixes
    for suffix in [" jr", " sr", " iii", " ii", " iv", " v"]:
        if n.endswith(suffix):
            n = n[:-len(suffix)].strip()
    return n


LEAGUE_CFG = {
    "nba": {"sport": "basketball", "league": "nba"},
    "nhl": {"sport": "hockey",     "league": "nhl"},
    "nfl": {"sport": "football",   "league": "nfl"},
    "mlb": {"sport": "baseball",   "league": "mlb"},
    "premier-league": {"sport": "soccer", "league": "eng.1"},
}


def fetch_espn_roster(sport, league, espn_team_id):
    """Fetch roster for a team, return list of {id, displayName, headshot}."""
    url = ("https://site.api.espn.com/apis/site/v2/sports/%s/%s"
           "/teams/%s/roster" % (sport, league, espn_team_id))
    data = fetch_json(url)
    if not data:
        return []

    players = []
    for group in data.get("athletes", []):
        # Some sports group by position (items array)
        if isinstance(group, dict) and "items" in group:
            for p in group["items"]:
                players.append({
                    "id": p.get("id"),
                    "name": p.get("displayName", p.get("fullName", "")),
                    "headshot": p.get("headshot", {}).get("href") if isinstance(p.get("headshot"), dict) else None,
                })
        elif isinstance(group, dict) and "id" in group:
            players.append({
                "id": group.get("id"),
                "name": group.get("displayName", group.get("fullName", "")),
                "headshot": group.get("headshot", {}).get("href") if isinstance(group.get("headshot"), dict) else None,
            })
    return players


def main():
    # Get teams with ESPN IDs
    teams = sb_get("back_in_play_teams",
                   "espn_team_id=not.is.null&select=team_id,team_name,espn_team_id,league_id")
    leagues = sb_get("back_in_play_leagues", "select=league_id,slug")
    league_map = {l["league_id"]: l["slug"] for l in (leagues or [])}

    # Get players without espn_id, grouped by team
    players_needing = sb_get("back_in_play_players",
                             "espn_id=is.null&select=player_id,player_name,team_id")
    print("Total players needing espn_id: %d" % len(players_needing), flush=True)

    # Group by team_id
    by_team = {}
    for p in players_needing:
        by_team.setdefault(p["team_id"], []).append(p)

    total_matched = 0
    teams_processed = 0

    # Only process major league teams (skip minor league etc)
    major_slugs = {"nba", "nhl", "nfl", "mlb", "premier-league"}

    for team in teams:
        slug = league_map.get(team["league_id"], "")
        if slug not in major_slugs:
            continue
        if team["team_name"] == "Unknown":
            continue

        our_players = by_team.get(team["team_id"], [])
        if not our_players:
            continue

        cfg = LEAGUE_CFG.get(slug)
        if not cfg:
            continue

        espn_roster = fetch_espn_roster(cfg["sport"], cfg["league"], team["espn_team_id"])
        if not espn_roster:
            continue

        # Build ESPN name → {id, headshot} index
        espn_index = {}
        for ep in espn_roster:
            if ep["id"] and ep["name"]:
                norm = normalize_name(ep["name"])
                espn_index[norm] = ep

        matched = 0
        for p in our_players:
            norm = normalize_name(p["player_name"])
            espn_player = espn_index.get(norm)

            # Try last name only if no exact match
            if not espn_player and " " in p["player_name"]:
                last = normalize_name(p["player_name"].split()[-1])
                first_initial = normalize_name(p["player_name"])[0] if p["player_name"] else ""
                candidates = [(k, v) for k, v in espn_index.items()
                              if k.split()[-1] == last and k[0] == first_initial]
                if len(candidates) == 1:
                    espn_player = candidates[0][1]

            if espn_player:
                update = {"espn_id": str(espn_player["id"])}
                if espn_player.get("headshot"):
                    update["headshot_url"] = espn_player["headshot"]
                sb_patch("back_in_play_players",
                         "player_id=eq.%s" % p["player_id"], update)
                matched += 1

        if matched > 0:
            print("  %s %s: %d/%d matched" % (slug.upper(), team["team_name"],
                                                matched, len(our_players)), flush=True)
        total_matched += matched
        teams_processed += 1
        time.sleep(0.3)

    print("\nProcessed %d teams, matched %d players" % (teams_processed, total_matched), flush=True)


if __name__ == "__main__":
    main()
