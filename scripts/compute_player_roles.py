#!/usr/bin/env python3
"""
Back In Play — Star & Starter Tagger
======================================
Fetches ESPN league leaders + team depth/stats to tag players as stars/starters.

Stars:
  NBA  — top 30 PPG
  NHL  — top 30 goals OR top 30 points
  NFL  — top 30 passing yds + rushing yds + receiving yds
  MLB  — top 30 hits (hitters) + top 15 ERA (pitchers, lowest = best)
  EPL  — uses existing league_rank/preseason_rank (no ESPN leaders endpoint)

Starters:
  NBA  — top 5 by minutes/game per team
  NHL  — top 6 skaters by TOI + starting goalie per team
  NFL  — depth chart API, athletes[0] per position
  MLB  — top 9 position players by plate appearances + top 5 pitchers by starts
  EPL  — top 11 by minutes per team

Usage:
  python3 compute_player_roles.py          # run once
  python3 compute_player_roles.py --watch  # daily at 6 AM UTC
"""

import json, os, re, sys, time, urllib.request, urllib.error
from datetime import datetime, timedelta
from pathlib import Path

# -- Load env -----------------------------------------------------------------
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


# -- HTTP helpers -------------------------------------------------------------
def fetch_json(url, timeout=15):
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            resp = urllib.request.urlopen(req, timeout=timeout)
            return json.loads(resp.read().decode())
        except Exception as e:
            if attempt < 2:
                time.sleep(2 ** attempt)
            else:
                print("    [fetch err] %s: %s" % (url.split("/")[-1], e), flush=True)
                return None
    return None


def sb_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }


def sb_get(table, params=""):
    url = SUPABASE_URL + "/rest/v1/" + table + "?" + params
    hdrs = {"apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY}
    try:
        req = urllib.request.Request(url, headers=hdrs)
        resp = urllib.request.urlopen(req, timeout=30)
        return json.loads(resp.read().decode())
    except Exception as e:
        print("    [GET err] %s: %s" % (table, e), flush=True)
        return []


def sb_patch(table, filter_params, body):
    url = SUPABASE_URL + "/rest/v1/" + table + "?" + filter_params
    data = json.dumps(body).encode()
    try:
        req = urllib.request.Request(url, data=data, headers=sb_headers(), method="PATCH")
        urllib.request.urlopen(req, timeout=30)
        return True
    except Exception as e:
        print("    [PATCH err] %s: %s" % (table, e), flush=True)
        return False


def parse_minutes(val):
    if not val or val in ("--", "DNP", "0"):
        return 0.0
    m = re.match(r"(\d+):(\d+)", str(val))
    if m:
        return int(m.group(1)) + int(m.group(2)) / 60.0
    try:
        return float(val)
    except (ValueError, TypeError):
        return 0.0


# -- Build espn_id → player_id map -------------------------------------------
def build_espn_to_player_map():
    """Get all players with espn_id → {player_id, team_id}."""
    players = sb_get("back_in_play_players",
                     "espn_id=not.is.null&select=player_id,espn_id,team_id")
    return {p["espn_id"]: p for p in (players or [])}


def get_team_espn_ids():
    """Get team_id → espn_team_id mapping from our teams table."""
    teams = sb_get("back_in_play_teams", "select=team_id,espn_team_id,team_name,league_id")
    return teams or []


# -- ESPN League IDs ----------------------------------------------------------
LEAGUE_CFG = {
    "nba":            {"sport": "basketball", "league": "nba"},
    "nhl":            {"sport": "hockey",     "league": "nhl"},
    "nfl":            {"sport": "football",   "league": "nfl"},
    "mlb":            {"sport": "baseball",   "league": "mlb"},
    "premier-league": {"sport": "soccer",     "league": "eng.1"},
}


# -- Step 1: Fetch Stars via League Leaders -----------------------------------
def fetch_league_stars():
    """Fetch star player ESPN IDs from league leaders endpoints."""
    star_espn_ids = set()

    # NBA: top 30 PPG (v3 endpoint)
    print("  Fetching NBA leaders...", flush=True)
    data = fetch_json("https://site.api.espn.com/apis/site/v3/sports/basketball/nba/leaders")
    if data:
        for cat in data.get("leaders", {}).get("categories", []):
            if cat.get("name") == "pointsPerGame":
                for leader in cat.get("leaders", [])[:30]:
                    eid = leader.get("athlete", {}).get("id")
                    if eid:
                        star_espn_ids.add(str(eid))
                break
    time.sleep(0.5)

    # NHL: top 30 goals + top 30 points
    print("  Fetching NHL leaders...", flush=True)
    data = fetch_json("https://site.api.espn.com/apis/site/v3/sports/hockey/nhl/leaders")
    if data:
        for cat in data.get("leaders", {}).get("categories", []):
            if cat.get("name") in ("goals", "points"):
                for leader in cat.get("leaders", [])[:30]:
                    eid = leader.get("athlete", {}).get("id")
                    if eid:
                        star_espn_ids.add(str(eid))
    time.sleep(0.5)

    # NFL: top 30 in passing, rushing, receiving yards
    print("  Fetching NFL leaders...", flush=True)
    data = fetch_json("https://site.api.espn.com/apis/site/v3/sports/football/nfl/leaders")
    if data:
        target_cats = {"passingYards", "rushingYards", "receivingYards"}
        for cat in data.get("leaders", {}).get("categories", []):
            if cat.get("name") in target_cats:
                for leader in cat.get("leaders", [])[:30]:
                    eid = leader.get("athlete", {}).get("id")
                    if eid:
                        star_espn_ids.add(str(eid))
    time.sleep(0.5)

    # MLB: top 30 hits + top 15 ERA (lowest)
    print("  Fetching MLB leaders...", flush=True)
    data = fetch_json("https://site.api.espn.com/apis/site/v3/sports/baseball/mlb/leaders")
    if data:
        for cat in data.get("leaders", {}).get("categories", []):
            if cat.get("name") == "hits":
                for leader in cat.get("leaders", [])[:30]:
                    eid = leader.get("athlete", {}).get("id")
                    if eid:
                        star_espn_ids.add(str(eid))
            elif cat.get("name") == "ERA":
                # ERA is sorted ascending (lowest = best), take top 15
                for leader in cat.get("leaders", [])[:15]:
                    eid = leader.get("athlete", {}).get("id")
                    if eid:
                        star_espn_ids.add(str(eid))
    time.sleep(0.5)

    # EPL: no leaders endpoint, use existing league_rank <= 30
    print("  EPL: using existing league_rank for stars", flush=True)

    print("  Found %d star ESPN IDs across NBA/NHL/NFL/MLB" % len(star_espn_ids), flush=True)
    return star_espn_ids


# -- Step 2: Fetch Starters --------------------------------------------------
def fetch_nfl_starters_for_team(espn_team_id):
    """Fetch NFL starters from depth chart API. athletes[0] = starter."""
    url = ("https://site.api.espn.com/apis/site/v2/sports/football/nfl"
           "/teams/%s/depthcharts" % espn_team_id)
    data = fetch_json(url)
    if not data:
        return set()

    starter_ids = set()
    # Use the first formation (usually base offense/defense)
    for formation in data.get("depthchart", data.get("items", [])):
        positions = formation.get("positions", {})
        for pos_key, pos_data in positions.items():
            athletes = pos_data.get("athletes", [])
            if athletes:
                eid = athletes[0].get("id")
                if eid:
                    starter_ids.add(str(eid))
    return starter_ids


def fetch_team_starters_by_stats(espn_team_id, sport, league, num_starters, stat_label="MIN"):
    """Fetch starters for a team by looking at per-player season stats (minutes/TOI).
    Returns set of ESPN athlete IDs for the top N players by the stat."""
    url = ("https://site.api.espn.com/apis/site/v2/sports/%s/%s"
           "/teams/%s/statistics" % (sport, league, espn_team_id))
    data = fetch_json(url)
    if not data:
        return set()

    # Try to find per-player stats
    starter_ids = set()
    splits = data.get("splits", data.get("results", {}).get("splits", []))

    # Alternative: use roster + individual athlete stats
    # For team stats endpoint, structure varies by sport
    # Let's try the athletes within categories
    for cat in data.get("results", {}).get("categories", data.get("categories", [])):
        labels = cat.get("labels", [])
        if stat_label not in labels:
            continue
        stat_idx = labels.index(stat_label)
        athletes_stats = []
        for athlete_entry in cat.get("athletes", []):
            eid = athlete_entry.get("id", athlete_entry.get("athlete", {}).get("id"))
            stats = athlete_entry.get("stats", athlete_entry.get("statistics", []))
            if eid and stats and stat_idx < len(stats):
                val = parse_minutes(stats[stat_idx])
                athletes_stats.append((str(eid), val))
        athletes_stats.sort(key=lambda x: -x[1])
        for eid, _ in athletes_stats[:num_starters]:
            starter_ids.add(eid)
        break

    return starter_ids


def fetch_mlb_starters_for_team(espn_team_id):
    """MLB: top 9 position players by at-bats + top 5 pitchers by games started."""
    starter_ids = set()

    # Hitting stats
    url = ("https://site.api.espn.com/apis/site/v2/sports/baseball/mlb"
           "/teams/%s/statistics" % espn_team_id)
    data = fetch_json(url)
    if data:
        for cat in data.get("results", {}).get("categories", data.get("categories", [])):
            cat_name = cat.get("name", "")
            labels = cat.get("labels", [])

            if cat_name == "hitting" or "AB" in labels:
                ab_idx = labels.index("AB") if "AB" in labels else None
                if ab_idx is not None:
                    athletes_stats = []
                    for ae in cat.get("athletes", []):
                        eid = ae.get("id", ae.get("athlete", {}).get("id"))
                        stats = ae.get("stats", [])
                        if eid and stats and ab_idx < len(stats):
                            try:
                                val = float(stats[ab_idx])
                            except (ValueError, TypeError):
                                val = 0
                            athletes_stats.append((str(eid), val))
                    athletes_stats.sort(key=lambda x: -x[1])
                    for eid, _ in athletes_stats[:9]:
                        starter_ids.add(eid)

            elif cat_name == "pitching" or "GS" in labels:
                gs_idx = labels.index("GS") if "GS" in labels else None
                if gs_idx is not None:
                    athletes_stats = []
                    for ae in cat.get("athletes", []):
                        eid = ae.get("id", ae.get("athlete", {}).get("id"))
                        stats = ae.get("stats", [])
                        if eid and stats and gs_idx < len(stats):
                            try:
                                val = float(stats[gs_idx])
                            except (ValueError, TypeError):
                                val = 0
                            athletes_stats.append((str(eid), val))
                    athletes_stats.sort(key=lambda x: -x[1])
                    for eid, _ in athletes_stats[:5]:
                        starter_ids.add(eid)

    return starter_ids


def fetch_all_starters(teams_data, league_map):
    """Fetch starters for all teams across all leagues."""
    starter_espn_ids = set()

    for team in teams_data:
        espn_tid = team.get("espn_team_id")
        if not espn_tid:
            continue

        league_id = team.get("league_id", "")
        slug = league_map.get(league_id, "")
        team_name = team.get("team_name", "Unknown")

        if slug == "nfl":
            ids = fetch_nfl_starters_for_team(espn_tid)
            starter_espn_ids.update(ids)
            if ids:
                print("    NFL %s: %d starters" % (team_name, len(ids)), flush=True)

        elif slug == "nba":
            ids = fetch_team_starters_by_stats(espn_tid, "basketball", "nba", 5, "MIN")
            starter_espn_ids.update(ids)
            if ids:
                print("    NBA %s: %d starters" % (team_name, len(ids)), flush=True)

        elif slug == "nhl":
            # 6 skaters + goalie = look for top 7 by TOI
            ids = fetch_team_starters_by_stats(espn_tid, "hockey", "nhl", 7, "TOI")
            starter_espn_ids.update(ids)
            if ids:
                print("    NHL %s: %d starters" % (team_name, len(ids)), flush=True)

        elif slug == "mlb":
            ids = fetch_mlb_starters_for_team(espn_tid)
            starter_espn_ids.update(ids)
            if ids:
                print("    MLB %s: %d starters" % (team_name, len(ids)), flush=True)

        elif slug == "premier-league":
            ids = fetch_team_starters_by_stats(espn_tid, "soccer", "eng.1", 11, "MIN")
            starter_espn_ids.update(ids)
            if ids:
                print("    EPL %s: %d starters" % (team_name, len(ids)), flush=True)

        time.sleep(0.3)  # Rate limit

    print("  Found %d starter ESPN IDs across all teams" % len(starter_espn_ids), flush=True)
    return starter_espn_ids


# -- Step 3: Apply to DB -----------------------------------------------------
def apply_roles(star_espn_ids, starter_espn_ids, espn_map):
    """Update is_star and is_starter in the DB."""
    # First, reset all to false
    sb_patch("back_in_play_players", "is_star=eq.true", {"is_star": False})
    sb_patch("back_in_play_players", "is_starter=eq.true", {"is_starter": False})

    # EPL stars: mark league_rank <= 30 as star (no ESPN leaders endpoint)
    leagues = sb_get("back_in_play_leagues", "slug=eq.premier-league&select=league_id")
    if leagues:
        epl_league_id = leagues[0]["league_id"]
        epl_teams = sb_get("back_in_play_teams",
                           "league_id=eq.%s&select=team_id" % epl_league_id)
        if epl_teams:
            epl_team_ids = ",".join(t["team_id"] for t in epl_teams)
            sb_patch("back_in_play_players",
                     "team_id=in.(%s)&league_rank=lte.30" % epl_team_ids,
                     {"is_star": True})
            print("  EPL: marked league_rank <= 30 as stars", flush=True)

    # Apply stars from ESPN leaders
    star_count = 0
    for espn_id in star_espn_ids:
        player = espn_map.get(espn_id)
        if player:
            sb_patch("back_in_play_players",
                     "player_id=eq.%s" % player["player_id"],
                     {"is_star": True})
            star_count += 1

    # Apply starters
    starter_count = 0
    for espn_id in starter_espn_ids:
        player = espn_map.get(espn_id)
        if player:
            sb_patch("back_in_play_players",
                     "player_id=eq.%s" % player["player_id"],
                     {"is_starter": True})
            starter_count += 1

    print("  Applied: %d stars, %d starters (matched to our DB)" % (
        star_count, starter_count), flush=True)


# -- Main ---------------------------------------------------------------------
def run_once():
    print("=" * 60, flush=True)
    print("Back In Play — Star & Starter Tagger", flush=True)
    print("Time: %s" % datetime.now().strftime("%Y-%m-%d %H:%M"), flush=True)
    print("=" * 60, flush=True)

    # Build lookup maps
    print("[1/4] Building ESPN → player map...", flush=True)
    espn_map = build_espn_to_player_map()
    print("  %d players with espn_id" % len(espn_map), flush=True)

    # Get teams with ESPN IDs
    print("[2/4] Fetching star players from ESPN leaders...", flush=True)
    star_ids = fetch_league_stars()

    print("[3/4] Fetching starters from ESPN team data...", flush=True)
    teams_data = get_team_espn_ids()
    leagues = sb_get("back_in_play_leagues", "select=league_id,slug")
    league_map = {l["league_id"]: l["slug"] for l in (leagues or [])}

    # Filter to teams that have espn_team_id
    teams_with_espn = [t for t in teams_data if t.get("espn_team_id")]
    print("  %d teams with ESPN IDs (of %d total)" % (len(teams_with_espn), len(teams_data)), flush=True)

    starter_ids = set()
    if teams_with_espn:
        starter_ids = fetch_all_starters(teams_with_espn, league_map)
    else:
        print("  WARNING: No teams have espn_team_id set. Run team ID backfill first.", flush=True)

    print("[4/4] Applying roles to DB...", flush=True)
    apply_roles(star_ids, starter_ids, espn_map)

    print("\nDone!", flush=True)


def main():
    args = [a.lower() for a in sys.argv[1:]]

    if "--watch" in args:
        print("Running in daily watch mode (6 AM UTC)", flush=True)
        while True:
            now = datetime.utcnow()
            # Run at 6 AM UTC
            if now.hour == 6 and now.minute < 5:
                try:
                    run_once()
                except Exception as e:
                    print("[ERROR] %s" % e, flush=True)
                time.sleep(300)  # Sleep 5 min to avoid re-triggering
            else:
                time.sleep(60)
    else:
        run_once()


if __name__ == "__main__":
    main()
