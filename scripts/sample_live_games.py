#!/usr/bin/env python3
"""
Back In Play — Live Game Sampler
=================================
Checks ESPN scoreboards for today's games across all leagues.
For each completed or in-progress game, checks boxscores to see
which players on our injury list actually played.

If a player marked as injured appears in a boxscore with real
minutes/stats, we:
  1. Update their injury status to "Active" (returned)
  2. Set their return_date to today
  3. Log a status_change record
  4. Upsert game log stats

Designed to run every 10-15 minutes via cron on the droplet.

Usage:
  python3 sample_live_games.py              # all leagues
  python3 sample_live_games.py nba nhl      # specific leagues
  python3 sample_live_games.py --dry-run    # preview without DB writes

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
"""

import json, os, re, sys, time, urllib.request, urllib.error
from datetime import date, datetime, timedelta
from pathlib import Path

from db_writer import pg_upsert, SB_URL as SUPABASE_URL, SB_KEY as SUPABASE_KEY

DRY_RUN = "--dry-run" in sys.argv
MAX_RETRIES = 3
USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


# -- ESPN league config -------------------------------------------------------
ESPN_LEAGUES = {
    "nba": {"sport": "basketball", "league": "nba",   "slug": "nba"},
    "nfl": {"sport": "football",   "league": "nfl",   "slug": "nfl"},
    "mlb": {"sport": "baseball",   "league": "mlb",   "slug": "mlb"},
    "nhl": {"sport": "hockey",     "league": "nhl",   "slug": "nhl"},
    "epl": {"sport": "soccer",     "league": "eng.1", "slug": "premier-league"},
}

# Map ESPN stat keys to our game log columns per sport
STAT_MAP = {
    "basketball": {
        "points": "stat_pts", "rebounds": "stat_reb", "assists": "stat_ast",
        "steals": "stat_stl", "blocks": "stat_blk",
    },
    "football": {
        "passingYards": "stat_pass_yds", "rushingYards": "stat_rush_yds",
        "receivingYards": "stat_rec_yds", "receptions": "stat_rec",
    },
    "hockey": {
        "goals": "stat_goals", "assists": "stat_assists",
        "shotsOnGoal": "stat_sog",
    },
    "baseball": {
        "hits": "stat_h", "homeRuns": "stat_hr", "RBIs": "stat_rbi",
        "runs": "stat_r", "stolenBases": "stat_sb", "totalBases": "stat_stl",
    },
    "soccer": {
        "goals": "stat_goals", "shotsOnTarget": "stat_sog",
    },
}


# -- HTTP helpers -------------------------------------------------------------
def fetch_json(url, timeout=30):
    hdrs = {"User-Agent": USER_AGENT}
    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(url, headers=hdrs)
            resp = urllib.request.urlopen(req, timeout=timeout)
            return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(5 * (attempt + 1))
            elif e.code >= 500:
                time.sleep(2 ** attempt)
            else:
                return None
        except Exception:
            if attempt < MAX_RETRIES - 1:
                time.sleep(2 ** attempt)
            else:
                return None
    return None


# -- Supabase helpers ---------------------------------------------------------
def sb_headers(prefer="return=representation"):
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json",
        "Prefer": prefer,
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

def sb_request(method, path, body=None):
    url = SUPABASE_URL + "/rest/v1/" + path
    data = json.dumps(body).encode() if body else None
    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(url, data=data, headers=sb_headers(), method=method)
            resp = urllib.request.urlopen(req, timeout=30)
            text = resp.read().decode()
            return json.loads(text) if text.strip() else []
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                time.sleep(2 ** attempt)
            else:
                print("    [SB FAIL] %s %s: %s" % (method, path, e), flush=True)
                return None

def slugify(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


# -- Core: Get injured players from DB ---------------------------------------
def get_injured_players(league_slug):
    """Fetch players currently marked as injured (last 90 days)."""
    cutoff = (date.today() - timedelta(days=90)).isoformat()

    # Step 1: Get league_id
    leagues = sb_get("back_in_play_leagues", "slug=eq.%s&select=league_id" % league_slug)
    if not leagues:
        return None
    league_id = leagues[0]["league_id"]

    # Step 2: Get players in this league with espn_id
    players = sb_get(
        "back_in_play_players",
        "league_id=eq.%s&select=player_id,player_name,slug,espn_id&limit=5000" % league_id
    )
    if not players:
        return None
    player_map = {p["player_id"]: p for p in players}
    player_ids = list(player_map.keys())

    # Step 3: Get active injuries for these players
    # Query in chunks to avoid URL length limits
    by_espn = {}
    by_name = {}

    for i in range(0, len(player_ids), 200):
        chunk = player_ids[i:i+200]
        ids_str = ",".join(str(pid) for pid in chunk)
        injuries = sb_get(
            "back_in_play_injuries",
            "player_id=in.(%s)"
            "&date_injured=gte.%s"
            "&select=injury_id,player_id,status,injury_type,date_injured"
            "&order=date_injured.desc" % (ids_str, cutoff)
        )
        if not injuries:
            continue
        # Filter out already-resolved injuries client-side
        injuries = [inj for inj in injuries
                    if inj.get("status") not in ("returned", "cleared")]

        for r in injuries:
            p = player_map.get(r["player_id"])
            if not p:
                continue
            espn_id = p.get("espn_id")
            pname = p.get("player_name", "")
            info = {
                "injury_id": r["injury_id"],
                "player_id": r["player_id"],
                "player_name": pname,
                "espn_id": espn_id,
                "status": r["status"],
                "injury_type": r.get("injury_type"),
            }
            if espn_id:
                by_espn[str(espn_id)] = info
            by_name[slugify(pname)] = info

    return by_espn, by_name


# -- Core: ESPN Scoreboard + Boxscore ----------------------------------------
def get_todays_games(sport, league):
    """Fetch today's scoreboard from ESPN."""
    today_str = date.today().strftime("%Y%m%d")
    url = (
        "https://site.api.espn.com/apis/site/v2/sports/"
        "%s/%s/scoreboard?dates=%s" % (sport, league, today_str)
    )
    data = fetch_json(url)
    if not data:
        return []

    events = data.get("events", [])
    games = []
    for ev in events:
        event_id = ev.get("id")
        status_type = ev.get("status", {}).get("type", {})
        state = status_type.get("state", "pre")  # pre, in, post
        completed = status_type.get("completed", False)

        if state == "pre":
            continue  # Skip games that haven't started

        games.append({
            "event_id": event_id,
            "state": state,
            "completed": completed,
            "name": ev.get("shortName", ""),
        })

    return games


def get_boxscore_players(sport, league, event_id):
    """Fetch boxscore for a game and return players who actually played."""
    url = (
        "https://site.api.espn.com/apis/site/v2/sports/"
        "%s/%s/summary?event=%s" % (sport, league, event_id)
    )
    data = fetch_json(url)
    if not data:
        return []

    players_who_played = []

    # Parse boxscore depending on sport
    boxscore = data.get("boxscore", {})
    players_list = boxscore.get("players", [])

    for team_box in players_list:
        team_info = team_box.get("team", {})
        team_name = team_info.get("displayName", "")

        statistics = team_box.get("statistics", [])
        for stat_group in statistics:
            athletes = stat_group.get("athletes", [])
            labels = stat_group.get("labels", [])

            for athlete in athletes:
                athlete_info = athlete.get("athlete", {})
                espn_id = str(athlete_info.get("id", ""))
                display_name = athlete_info.get("displayName", "")
                did_not_play = athlete.get("didNotPlay", False)
                starter = athlete.get("starter", False)

                if did_not_play:
                    continue

                # Parse stats into dict
                stats_vals = athlete.get("stats", [])
                stats_dict = {}
                minutes = None

                for i, label in enumerate(labels):
                    if i < len(stats_vals):
                        val = stats_vals[i]
                        if label.upper() == "MIN":
                            # Parse minutes (could be "32:10" or "32")
                            if isinstance(val, str) and ":" in val:
                                parts = val.split(":")
                                try:
                                    minutes = int(parts[0]) + int(parts[1]) / 60
                                except ValueError:
                                    minutes = 0
                            else:
                                try:
                                    minutes = float(val) if val else 0
                                except (ValueError, TypeError):
                                    minutes = 0
                        else:
                            try:
                                stats_dict[label] = float(val) if val and val != "--" else 0
                            except (ValueError, TypeError):
                                stats_dict[label] = 0

                # Only count players with actual playing time or stats
                if minutes is None or minutes <= 0:
                    # For sports without minutes (baseball, soccer), check if they have stats
                    has_stats = any(v > 0 for v in stats_dict.values() if isinstance(v, (int, float)))
                    if not has_stats and sport not in ("baseball", "soccer"):
                        continue

                players_who_played.append({
                    "espn_id": espn_id,
                    "name": display_name,
                    "team": team_name,
                    "minutes": minutes,
                    "starter": starter,
                    "stats": stats_dict,
                })

    # Also check roster/rosters data for sports where boxscore is structured differently
    rosters = data.get("rosters", [])
    for team_roster in rosters:
        team_info = team_roster.get("team", {})
        team_name = team_info.get("displayName", "")
        roster_entries = team_roster.get("roster", [])
        for entry in roster_entries:
            espn_id = str(entry.get("playerId", ""))
            display_name = entry.get("displayName", "")
            played = entry.get("played", False)
            stats = entry.get("stats", {})

            if played or (isinstance(stats, dict) and any(
                v not in (0, "0", None, "", "--") for v in stats.values()
            )):
                # Avoid duplicates
                if not any(p["espn_id"] == espn_id for p in players_who_played):
                    players_who_played.append({
                        "espn_id": espn_id,
                        "name": display_name,
                        "team": team_name,
                        "minutes": None,
                        "starter": False,
                        "stats": stats if isinstance(stats, dict) else {},
                    })

    return players_who_played


# -- Core: Process a league ---------------------------------------------------
def process_league(league_key):
    cfg = ESPN_LEAGUES[league_key]
    league_slug = cfg["slug"]
    sport = cfg["sport"]
    espn_league = cfg["league"]

    print("\n[%s] Checking live/finished games..." % league_key.upper(), flush=True)

    # 1. Get today's in-progress or completed games
    games = get_todays_games(sport, espn_league)
    if not games:
        print("  No active/finished games today", flush=True)
        return 0

    active_games = [g for g in games if g["state"] in ("in", "post")]
    print("  Found %d active/finished games" % len(active_games), flush=True)

    # 2. Get our injured players for this league
    result = get_injured_players(league_slug)
    if not result:
        print("  No injured players tracked for %s" % league_slug, flush=True)
        return 0

    by_espn, by_name = result
    if not by_espn and not by_name:
        print("  No injured players with ESPN IDs found", flush=True)
        return 0

    print("  Tracking %d injured players" % (len(by_espn) + len(by_name)), flush=True)

    # 3. Check each game's boxscore
    returned_players = []
    today_iso = date.today().isoformat()

    for game in active_games:
        print("  Checking %s [%s]..." % (game["name"], game["state"]), flush=True)
        time.sleep(0.5)  # Be nice to ESPN

        box_players = get_boxscore_players(sport, espn_league, game["event_id"])

        for bp in box_players:
            match = None
            if bp["espn_id"] and bp["espn_id"] in by_espn:
                match = by_espn[bp["espn_id"]]
            else:
                name_slug = slugify(bp["name"])
                if name_slug in by_name:
                    match = by_name[name_slug]

            if match:
                print("    FOUND: %s (was %s) — played in %s" % (
                    match["player_name"], match["status"], game["name"]
                ), flush=True)
                returned_players.append({
                    **match,
                    "game_event_id": game["event_id"],
                    "game_completed": game["completed"],
                    "minutes": bp.get("minutes"),
                    "stats": bp.get("stats", {}),
                })

    if not returned_players:
        print("  No injured players detected in today's games", flush=True)
        return 0

    print("\n  %d injured player(s) detected playing!" % len(returned_players), flush=True)

    if DRY_RUN:
        for rp in returned_players:
            print("    [DRY RUN] Would activate: %s (%s -> Active)" % (
                rp["player_name"], rp["status"]
            ), flush=True)
        return len(returned_players)

    # 4. Update injuries and log status changes
    activated = 0
    for rp in returned_players:
        # Update injury record: status -> Active, return_date -> today
        update = {
            "status": "returned",
            "return_date": today_iso,
        }
        result = sb_request(
            "PATCH",
            "back_in_play_injuries?injury_id=eq.%s" % rp["injury_id"],
            update
        )
        if result is not None:
            activated += 1
            print("    Updated: %s -> Active (injury_id=%s)" % (
                rp["player_name"], rp["injury_id"]
            ), flush=True)

        # Log status change
        change = {
            "player_id": rp["player_id"],
            "injury_id": rp["injury_id"],
            "old_status": rp["status"],
            "new_status": "returned",
            "change_type": "activated",
            "summary": "Detected in live game — %s returned from %s" % (
                rp["player_name"], rp.get("injury_type", "injury")
            ),
            "changed_at": datetime.now(tz=None).isoformat() + "Z",
        }
        sb_request("POST", "back_in_play_status_changes", change)

    print("\n  Activated %d player(s)" % activated, flush=True)
    return activated


# -- Also re-scrape ESPN injuries (picks up status changes from ESPN) ---------
def refresh_espn_injuries(league_key):
    """Quick refresh of ESPN injury statuses — catches players ESPN
    has already marked as active/returned before we see them in boxscores."""
    cfg = ESPN_LEAGUES[league_key]
    league_slug = cfg["slug"]

    url = (
        "https://site.api.espn.com/apis/site/v2/sports/"
        "%s/%s/injuries" % (cfg["sport"], cfg["league"])
    )
    data = fetch_json(url)
    if not data:
        return 0

    today_iso = date.today().isoformat()
    cutoff = (date.today() - timedelta(days=90)).isoformat()

    # Get our currently injured players
    result = get_injured_players(league_slug)
    if not result:
        return 0
    by_espn, by_name = result

    # ESPN shows teams with their current injury list
    # Players NOT on this list who are on ours may have been activated
    espn_injured_ids = set()
    teams_data = data.get("injuries", data.get("items", []))
    for team_entry in teams_data:
        entries = team_entry.get("injuries", [])
        for inj in entries:
            athlete = inj.get("athlete", {})
            eid = str(athlete.get("id", ""))
            if eid:
                espn_injured_ids.add(eid)
            # Also check if ESPN shows someone as "Active" who we have as injured
            status_raw = inj.get("status", "")
            if isinstance(status_raw, dict):
                status_raw = status_raw.get("type", "")
            if eid in by_espn and status_raw.lower() in ("active", "probable"):
                match = by_espn[eid]
                if match["status"] not in ("returned", "cleared"):
                    if not DRY_RUN:
                        sb_request(
                            "PATCH",
                            "back_in_play_injuries?injury_id=eq.%s" % match["injury_id"],
                            {"status": "returned", "return_date": today_iso}
                        )
                        sb_request("POST", "back_in_play_status_changes", {
                            "player_id": match["player_id"],
                            "injury_id": match["injury_id"],
                            "old_status": match["status"],
                            "new_status": "returned",
                            "change_type": "activated",
                            "summary": "ESPN status updated — %s cleared/active" % match["player_name"],
                            "changed_at": datetime.now(tz=None).isoformat() + "Z",
                        })
                    print("    ESPN cleared: %s (%s -> Active)" % (
                        match["player_name"], match["status"]
                    ), flush=True)

    return 0


# -- Main ---------------------------------------------------------------------
def main():
    leagues = [a for a in sys.argv[1:] if not a.startswith("-")]
    if not leagues:
        leagues = list(ESPN_LEAGUES.keys())

    print("=" * 60)
    print("Back In Play — Live Game Sampler")
    print("Time: %s" % datetime.now(tz=None).strftime("%Y-%m-%d %H:%M UTC"))
    print("Leagues: %s" % ", ".join(l.upper() for l in leagues))
    if DRY_RUN:
        print("MODE: DRY RUN (no DB writes)")
    print("=" * 60)

    total = 0
    for league in leagues:
        if league not in ESPN_LEAGUES:
            print("Unknown league: %s (skipping)" % league)
            continue
        # First refresh ESPN injury statuses
        refresh_espn_injuries(league)
        # Then check boxscores
        total += process_league(league)
        time.sleep(1)

    print("\n" + "=" * 60)
    print("Done. %d player(s) activated." % total)
    print("=" * 60)


if __name__ == "__main__":
    main()
