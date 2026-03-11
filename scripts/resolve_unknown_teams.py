#!/usr/bin/env python3
"""
Resolve players on "Unknown" teams by matching against ESPN rosters.
For each league, fetches all ESPN rosters and matches Unknown-team players
by normalized name to find their real team.
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
    import re
    # Strip leading slashes and known position prefixes
    name = re.sub(r'^/\s*', '', name.strip())
    name = re.sub(r'^(LWs|RWs|LW|RW|SS|CF|RF|LF|SP|RP|DH)\s+', '', name)
    name = name.lstrip('/ ')
    nfkd = unicodedata.normalize("NFKD", name)
    ascii_name = "".join(c for c in nfkd if not unicodedata.combining(c))
    n = ascii_name.lower().strip()
    # Strip apostrophes, hyphens, periods for matching
    n = n.replace("'", "").replace("'", "").replace("-", "").replace(".", "")
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
    url = ("https://site.api.espn.com/apis/site/v2/sports/%s/%s"
           "/teams/%s/roster" % (sport, league, espn_team_id))
    data = fetch_json(url)
    if not data:
        return []
    players = []
    for group in data.get("athletes", []):
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
    # Get leagues
    leagues = sb_get("back_in_play_leagues", "select=league_id,slug")
    league_map = {l["slug"]: l["league_id"] for l in (leagues or [])}

    # Get "Unknown" teams
    unknown_teams = sb_get("back_in_play_teams", "team_name=eq.Unknown&select=team_id,league_id")
    if not unknown_teams:
        print("No Unknown teams found")
        return
    unknown_team_ids = [t["team_id"] for t in unknown_teams]
    unknown_league_map = {t["team_id"]: t["league_id"] for t in unknown_teams}

    # Get players on Unknown teams
    unknown_players = []
    for tid in unknown_team_ids:
        players = sb_get("back_in_play_players",
                         "team_id=eq.%s&select=player_id,player_name,league_id" % tid)
        unknown_players.extend(players)
    print("Total players on Unknown teams: %d" % len(unknown_players), flush=True)

    # Get real teams with ESPN IDs, grouped by league
    real_teams = sb_get("back_in_play_teams",
                        "team_name=neq.Unknown&espn_team_id=not.is.null&select=team_id,team_name,league_id,espn_team_id")
    teams_by_league = {}
    for t in (real_teams or []):
        teams_by_league.setdefault(t["league_id"], []).append(t)

    slug_by_league = {v: k for k, v in league_map.items()}
    total_resolved = 0

    for league_id, teams in teams_by_league.items():
        slug = slug_by_league.get(league_id, "")
        cfg = LEAGUE_CFG.get(slug)
        if not cfg:
            continue

        # Get Unknown players for this league
        league_unknown = [p for p in unknown_players
                          if p.get("league_id") == league_id or
                          unknown_league_map.get(p.get("team_id_orig", "")) == league_id]
        # Actually filter by checking if their Unknown team's league matches
        league_unknown = []
        for p in unknown_players:
            for ut in unknown_teams:
                if ut["league_id"] == league_id:
                    # Check if this player is on this Unknown team
                    # We need to re-check — players have league_id set from backfill
                    if p.get("league_id") == league_id:
                        league_unknown.append(p)
                        break

        if not league_unknown:
            print("\n%s: no Unknown-team players" % slug.upper(), flush=True)
            continue

        print("\n%s: %d Unknown-team players to resolve" % (slug.upper(), len(league_unknown)), flush=True)

        # Build name index from all ESPN rosters in this league
        espn_name_index = {}  # normalized_name → {team_id, espn_id, headshot}
        for team in teams:
            roster = fetch_espn_roster(cfg["sport"], cfg["league"], team["espn_team_id"])
            for rp in roster:
                if rp["name"]:
                    norm = normalize_name(rp["name"])
                    espn_name_index[norm] = {
                        "team_id": team["team_id"],
                        "team_name": team["team_name"],
                        "espn_id": str(rp["id"]) if rp["id"] else None,
                        "headshot": rp.get("headshot"),
                    }
            time.sleep(0.2)

        print("  ESPN roster index: %d players" % len(espn_name_index), flush=True)

        resolved = 0
        for p in league_unknown:
            norm = normalize_name(p["player_name"])
            match = espn_name_index.get(norm)

            # Try last name + first initial fallback
            if not match and " " in p["player_name"]:
                last = normalize_name(p["player_name"].split()[-1])
                first_init = normalize_name(p["player_name"])[0] if p["player_name"] else ""
                candidates = [(k, v) for k, v in espn_name_index.items()
                              if k.split()[-1] == last and k[0] == first_init]
                if len(candidates) == 1:
                    match = candidates[0][1]

            if match:
                update = {"team_id": match["team_id"]}
                if match.get("espn_id"):
                    update["espn_id"] = match["espn_id"]
                if match.get("headshot"):
                    update["headshot_url"] = match["headshot"]
                sb_patch("back_in_play_players",
                         "player_id=eq.%s" % p["player_id"], update)
                resolved += 1

        print("  Resolved: %d / %d" % (resolved, len(league_unknown)), flush=True)
        total_resolved += resolved

    print("\nTotal resolved: %d" % total_resolved, flush=True)


if __name__ == "__main__":
    main()
