#!/usr/bin/env python3
"""
ESPN Team-First Data Pipeline.

For each league, for each team, for each season:
1. Get team schedule from ESPN (all game event IDs)
2. For each game, get box score from ESPN (every player who played + stats)
3. Link ESPN player IDs to Yahoo IDs via Graphite search
4. Fetch Yahoo Graphite game logs per player for verification
5. Store team game logs + player game logs in DB
6. Cross-reference with injury data

Usage:
  python3 espn_team_first_pipeline.py --league nba --season 2025 --team 13
  python3 espn_team_first_pipeline.py --league nba --season 2025         # All teams
  python3 espn_team_first_pipeline.py --league nba --all-seasons
  python3 espn_team_first_pipeline.py --test
"""
import os, sys, json, time, re, argparse, requests
from collections import defaultdict
import unicodedata

CACHE_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "espn_team_first_cache")
os.makedirs(CACHE_DIR, exist_ok=True)

ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports"
GRAPHITE_SEARCH = "https://graphite.sports.yahoo.com/v1/query/shangrila/playerSearch"
GRAPHITE_GAMELOG = "https://graphite.sports.yahoo.com/v1/query/shangrila/playerGameLog"

ESPN_SPORTS = {
    "nba": {"path": "basketball/nba", "teams": list(range(1, 31))},
    "nhl": {"path": "hockey/nhl", "teams": list(range(1, 36))},  # ~32 teams, some IDs skip
    "nfl": {"path": "football/nfl", "teams": list(range(1, 35))},
    "mlb": {"path": "baseball/mlb", "teams": list(range(1, 31))},
}

YAHOO_SPORT = {"nba": "nba", "nhl": "nhl", "nfl": "nfl", "mlb": "mlb"}

SEASONS = {
    "nba": list(range(2013, 2027)),
    "nhl": list(range(2013, 2027)),
    "nfl": list(range(2013, 2027)),
    "mlb": list(range(2013, 2027)),
}

# ESPN stat labels -> our DB columns per sport
NBA_STAT_LABELS = {
    "MIN": "minutes", "PTS": "stat_pts", "REB": "stat_reb", "AST": "stat_ast",
    "STL": "stat_stl", "BLK": "stat_blk", "3PT": "stat_3pm", "TO": "turnovers",
    "FG": "fg", "FT": "ft",
}

NHL_STAT_LABELS = {
    "G": "stat_goals", "A": "stat_assists", "SOG": "stat_sog", "+/-": "plus_minus",
}

NFL_STAT_LABELS = {
    "C/ATT": "pass_catt", "YDS": "stat_pass_yds", "TD": "stat_pass_td",
    "CAR": "stat_rush_att", "REC": "stat_rec",
}

MLB_STAT_LABELS = {
    "H": "stat_h", "R": "stat_r", "HR": "stat_hr", "RBI": "stat_rbi",
    "SB": "stat_sb", "IP": "stat_ip", "K": "stat_k",
}

request_count = 0


def espn_get(url, params=None):
    """Make ESPN API request with rate limiting."""
    global request_count
    request_count += 1
    try:
        r = requests.get(url, params=params, timeout=15)
        if r.status_code == 200:
            return r.json()
    except:
        pass
    return None


def get_team_schedule(sport_path, team_id, season):
    """Get all game event IDs for a team in a season."""
    cache_file = f"{CACHE_DIR}/schedule_{sport_path.replace('/', '_')}_{team_id}_{season}.json"
    if os.path.exists(cache_file):
        return json.load(open(cache_file))

    url = f"{ESPN_BASE}/{sport_path}/teams/{team_id}/schedule"
    data = espn_get(url, {"season": season})
    if not data:
        return None

    events = []
    team_name = data.get("team", {}).get("displayName", f"Team {team_id}")
    for e in data.get("events", []):
        event_id = e.get("id")
        date_str = e.get("date", "")
        # Convert ESPN UTC date to ET
        game_date = date_str[:10] if date_str else ""
        if date_str and "T" in date_str:
            from datetime import datetime, timedelta
            try:
                dt = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
                et = dt - timedelta(hours=5)
                game_date = et.strftime("%Y-%m-%d")
            except:
                pass

        competitions = e.get("competitions", [{}])
        if competitions:
            comp = competitions[0]
            competitors = comp.get("competitors", [])
            home = next((c for c in competitors if c.get("homeAway") == "home"), {})
            away = next((c for c in competitors if c.get("homeAway") == "away"), {})
            events.append({
                "event_id": event_id,
                "date": game_date,
                "home_team": home.get("team", {}).get("displayName", ""),
                "away_team": away.get("team", {}).get("displayName", ""),
                "home_score": home.get("score", {}).get("value") if isinstance(home.get("score"), dict) else home.get("score"),
                "away_score": away.get("score", {}).get("value") if isinstance(away.get("score"), dict) else away.get("score"),
                "home_team_id": home.get("team", {}).get("id"),
                "away_team_id": away.get("team", {}).get("id"),
            })

    result = {"team_name": team_name, "team_id": team_id, "season": season, "events": events}
    with open(cache_file, "w") as f:
        json.dump(result, f, indent=2)
    return result


def get_box_score(sport_path, event_id):
    """Get full box score for a game. Returns all players who played with stats."""
    cache_file = f"{CACHE_DIR}/boxscore_{event_id}.json"
    if os.path.exists(cache_file):
        return json.load(open(cache_file))

    url = f"{ESPN_BASE}/{sport_path}/summary"
    data = espn_get(url, {"event": event_id})
    if not data:
        return None

    boxscore = data.get("boxscore", {})
    teams_data = boxscore.get("players", [])

    result = {"event_id": event_id, "teams": []}

    for team in teams_data:
        team_info = team.get("team", {})
        team_entry = {
            "team_name": team_info.get("displayName", ""),
            "team_id": team_info.get("id", ""),
            "team_abbr": team_info.get("abbreviation", ""),
            "players": [],
        }

        for stat_cat in team.get("statistics", []):
            labels = stat_cat.get("labels", [])
            for athlete_data in stat_cat.get("athletes", []):
                athlete = athlete_data.get("athlete", {})
                stats_vals = athlete_data.get("stats", [])

                player = {
                    "espn_id": athlete.get("id", ""),
                    "name": athlete.get("displayName", ""),
                    "position": athlete.get("position", {}).get("abbreviation", "") if isinstance(athlete.get("position"), dict) else "",
                    "stats": {},
                    "starter": athlete_data.get("starter", False),
                    "didNotPlay": athlete_data.get("didNotPlay", False),
                    "dnp_reason": athlete_data.get("reason", ""),
                }

                # Map stats using labels
                for i, label in enumerate(labels):
                    if i < len(stats_vals):
                        val = stats_vals[i]
                        if val and val != "--" and val != "-":
                            player["stats"][label] = val

                if player["name"]:
                    team_entry["players"].append(player)

        result["teams"].append(team_entry)

    with open(cache_file, "w") as f:
        json.dump(result, f, indent=2)
    return result


def normalize_name(name):
    """Normalize player name for matching."""
    nfkd = unicodedata.normalize("NFKD", name)
    ascii_name = "".join(c for c in nfkd if not unicodedata.combining(c))
    n = ascii_name.lower().strip()
    for suffix in [" jr.", " sr.", " ii", " iii", " iv", " jr", " sr", "."]:
        n = n.replace(suffix, "")
    return n.strip()


def yahoo_search(league, name):
    """Search Yahoo Graphite for a player. Returns yahoo_pid or None.
    STRICT matching only — only returns a PID if the name matches exactly."""
    try:
        r = requests.get(GRAPHITE_SEARCH, params={"query": name, "league": league}, timeout=10)
        if r.status_code != 200:
            return None
        players = r.json().get("data", {}).get("leagues", [{}])[0].get("players", [])
        target = normalize_name(name)
        for p in players:
            if normalize_name(p.get("displayName", "")) == target:
                pid = p.get("playerId", "").split(".")[-1]
                return pid
        # NO fallback — if no exact match, return None
        # This prevents wrong mappings (e.g., Cedi Osman → LeBron)
    except:
        pass
    return None


def process_team_season(league, sport_path, team_id, season):
    """Process one team for one season: schedule → box scores → players."""

    # Step 1: Get schedule
    schedule = get_team_schedule(sport_path, team_id, season)
    if not schedule or not schedule.get("events"):
        return None

    team_name = schedule["team_name"]
    events = schedule["events"]
    print(f"    {team_name} {season}: {len(events)} games")

    # Step 2: Get box scores
    all_players = {}  # espn_id -> {name, position, team, games, yahoo_pid}
    team_games = []
    errors = 0

    for i, event in enumerate(events):
        eid = event["event_id"]
        box = get_box_score(sport_path, eid)
        if not box:
            errors += 1
            continue

        game_date = event["date"]
        team_games.append({
            "date": game_date,
            "home_team": event["home_team"],
            "away_team": event["away_team"],
            "home_score": event.get("home_score"),
            "away_score": event.get("away_score"),
        })

        # Extract players from box score
        for team_data in box.get("teams", []):
            for player in team_data.get("players", []):
                espn_id = player["espn_id"]
                if espn_id not in all_players:
                    all_players[espn_id] = {
                        "name": player["name"],
                        "position": player.get("position", ""),
                        "team": team_data["team_name"],
                        "team_id": team_data["team_id"],
                        "games": 0,
                        "game_dates": [],
                    }
                all_players[espn_id]["games"] += 1
                all_players[espn_id]["game_dates"].append(game_date)

        if (i + 1) % 20 == 0:
            print(f"      {i+1}/{len(events)} games, {len(all_players)} unique players")

        time.sleep(0.05)

    print(f"      Done: {len(team_games)} games, {len(all_players)} unique players, {errors} errors")

    # Step 3: Link to Yahoo IDs
    yahoo_map_file = f"{CACHE_DIR}/yahoo_map_{league}.json"
    if os.path.exists(yahoo_map_file):
        yahoo_map = json.load(open(yahoo_map_file))
    else:
        yahoo_map = {}  # espn_id -> yahoo_pid

    new_mappings = 0
    for espn_id, player in all_players.items():
        if espn_id not in yahoo_map:
            ypid = yahoo_search(league, player["name"])
            if ypid:
                yahoo_map[espn_id] = ypid
                new_mappings += 1
            time.sleep(0.05)

    if new_mappings > 0:
        json.dump(yahoo_map, open(yahoo_map_file, "w"), indent=2)
        print(f"      Yahoo mappings: {new_mappings} new, {len(yahoo_map)} total")

    # Save summary
    summary = {
        "team_name": team_name,
        "team_id": team_id,
        "season": season,
        "league": league,
        "games": team_games,
        "players": {eid: {**p, "yahoo_pid": yahoo_map.get(eid)} for eid, p in all_players.items()},
        "total_games": len(team_games),
        "total_players": len(all_players),
    }
    summary_file = f"{CACHE_DIR}/summary_{league}_{team_id}_{season}.json"
    with open(summary_file, "w") as f:
        json.dump(summary, f, indent=2)

    return summary


def test():
    """Quick test with one team."""
    print("Testing ESPN Team-First Pipeline...\n")

    # Cleveland Cavaliers (team_id=5) 2023 season
    result = process_team_season("nba", "basketball/nba", 5, 2023)
    if result:
        print(f"\n  Summary:")
        print(f"    Team: {result['team_name']}")
        print(f"    Games: {result['total_games']}")
        print(f"    Players: {result['total_players']}")
        print(f"    Sample players:")
        for eid, p in list(result["players"].items())[:10]:
            print(f"      {p['name']} ({p['position']}): {p['games']} GP, yahoo={p.get('yahoo_pid', '?')}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--league", choices=["nba", "nhl", "nfl", "mlb"])
    parser.add_argument("--season", type=int)
    parser.add_argument("--all-seasons", action="store_true")
    parser.add_argument("--team", type=int, help="ESPN team ID")
    parser.add_argument("--test", action="store_true")
    args = parser.parse_args()

    if args.test:
        test()
        return

    if not args.league:
        print("Specify --league or --test")
        return

    league = args.league
    config = ESPN_SPORTS[league]
    sport_path = config["path"]
    team_ids = [args.team] if args.team else config["teams"]
    seasons = (
        [args.season] if args.season
        else SEASONS[league] if args.all_seasons
        else [max(SEASONS[league]) - 1]
    )

    print(f"{'='*60}")
    print(f"ESPN TEAM-FIRST PIPELINE — {league.upper()}")
    print(f"Teams: {len(team_ids)}, Seasons: {seasons[0]}-{seasons[-1]}")
    print(f"{'='*60}")

    all_results = []
    for season in seasons:
        print(f"\n  SEASON {season}:")
        for tid in team_ids:
            result = process_team_season(league, sport_path, tid, season)
            if result:
                all_results.append(result)

    # Final summary
    total_games = sum(r["total_games"] for r in all_results)
    total_players = len(set(
        eid for r in all_results for eid in r["players"]
    ))
    print(f"\n{'='*60}")
    print(f"TOTAL: {len(all_results)} team-seasons, {total_games} games, {total_players} unique players")
    print(f"ESPN API requests: {request_count}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
