#!/usr/bin/env python3
"""
Audit injuries against ESPN box scores.

For each injury in back_in_play_injuries:
1. Check if the player PLAYED during their injury window (date_injured → return_date)
   - If yes → injury dates are wrong or injury was minor
2. Check if the player is MISSING from box scores before the return_date
   - If not missing → injury may be fake/inaccurate
3. Check if the player appears in box scores after return_date
   - If not → return date may be wrong or player was cut

Usage:
  python3 audit_injuries_vs_boxscores.py --league nba
  python3 audit_injuries_vs_boxscores.py --all
  python3 audit_injuries_vs_boxscores.py --league nba --player "LeBron James"
"""
import os, sys, json, glob, argparse, csv
from collections import defaultdict
from datetime import datetime, timedelta

for f in ["/root/.daemon-env", ".env"]:
    if os.path.exists(f):
        with open(f) as fh:
            for line in fh:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

ESPN_CACHE = os.path.join(os.path.dirname(__file__), "..", "data", "espn_team_first_cache")
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")


def load_player_game_dates_from_espn(league):
    """From ESPN box scores, build {espn_id: set of game_dates} and {espn_id: name}."""
    print("  Loading ESPN box scores...")
    summaries = sorted(glob.glob(f"{ESPN_CACHE}/summary_{league}_*.json"))

    player_dates = defaultdict(set)  # espn_id → set of game dates
    player_names = {}  # espn_id → name

    for sf in summaries:
        data = json.load(open(sf))
        for espn_id, player in data.get("players", {}).items():
            name = player.get("name", "")
            game_dates = player.get("game_dates", [])
            player_names[espn_id] = name
            for gd in game_dates:
                player_dates[espn_id].add(gd)

    print(f"    {len(player_names):,} players, {sum(len(v) for v in player_dates.values()):,} total game appearances")
    return player_dates, player_names


def load_team_schedule_dates(league):
    """From ESPN schedules, build {team_name_lower: set of game_dates}."""
    schedules = sorted(glob.glob(f"{ESPN_CACHE}/schedule_*_{league}_*.json") +
                       glob.glob(f"{ESPN_CACHE}/schedule_*{league}*.json"))
    team_dates = defaultdict(set)
    for sf in schedules:
        try:
            sched = json.load(open(sf))
        except:
            continue
        team_name = sched.get("team_name", "")
        for e in sched.get("events", []):
            d = e.get("date", "")
            if d:
                team_dates[team_name.lower()].add(d)
                if e.get("home_team"):
                    team_dates[e["home_team"].lower()].add(d)
                if e.get("away_team"):
                    team_dates[e["away_team"].lower()].add(d)
    return team_dates


def load_injuries(league):
    """Load injuries from Supabase."""
    import psycopg2
    conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"])
    cur = conn.cursor()

    league_ids = {
        "nba": "2aa180e9-a7c2-4d08-a1d8-a16152827b5d",
        "nhl": "0894f8ac-c744-4b58-9023-20c514f64fff",
        "nfl": "0fea41a7-250e-40bf-9220-97853a69b6d7",
        "mlb": "312485db-3c4a-4f83-b4b0-c761e114d870",
    }
    league_id = league_ids.get(league)
    if not league_id:
        return [], {}

    # Get injuries with player info
    cur.execute("""
        SELECT i.player_id, i.date_injured, i.return_date, i.injury_type, i.games_missed,
               i.status, p.player_name, p.espn_id
        FROM back_in_play_injuries i
        JOIN back_in_play_players p ON i.player_id = p.player_id
        WHERE p.league_id = %s
          AND i.date_injured IS NOT NULL
        ORDER BY i.date_injured DESC
    """, (league_id,))
    rows = cur.fetchall()
    cols = [d[0] for d in cur.description]
    injuries = [dict(zip(cols, r)) for r in rows]

    conn.close()
    print(f"  Injuries: {len(injuries):,}")
    return injuries


def audit(league, player_filter=None):
    print(f"\n{'='*60}")
    print(f"  INJURY AUDIT — {league.upper()}")
    print(f"{'='*60}")

    player_dates, player_names = load_player_game_dates_from_espn(league)
    team_dates = load_team_schedule_dates(league)
    injuries = load_injuries(league)

    if player_filter:
        injuries = [inj for inj in injuries if player_filter.lower() in (inj.get("player_name") or "").lower()]
        print(f"  Filtered to {len(injuries)} injuries for '{player_filter}'")

    # Build espn_id lookup by name (fallback if espn_id not in injuries)
    name_to_espn = {}
    for eid, name in player_names.items():
        name_to_espn[name.lower()] = eid

    results = {
        "played_during_injury": [],  # Player played games during their injury window
        "no_games_missed": [],       # Injury recorded but 0 games actually missed
        "confirmed_missed": [],      # Injury confirmed — player missed expected games
        "no_return_date": [],        # Injury has no return date
        "player_not_found": [],      # Can't find player in ESPN box scores
        "return_date_wrong": [],     # Player didn't play near return date
    }

    for inj in injuries:
        player_name = inj.get("player_name", "")
        espn_id = str(inj.get("espn_id") or "")
        date_injured = str(inj.get("date_injured", ""))
        return_date = str(inj.get("return_date") or "")
        injury_type = inj.get("injury_type", "")
        games_missed = inj.get("games_missed")

        if not date_injured:
            continue

        # Find this player's ESPN game dates
        dates = player_dates.get(espn_id)
        if not dates:
            # Try by name
            alt_eid = name_to_espn.get(player_name.lower())
            if alt_eid:
                dates = player_dates.get(alt_eid)

        if not dates:
            results["player_not_found"].append({
                "player": player_name, "date_injured": date_injured,
                "injury": injury_type, "note": "Not found in ESPN box scores"
            })
            continue

        if not return_date or return_date == "None":
            results["no_return_date"].append({
                "player": player_name, "date_injured": date_injured,
                "injury": injury_type, "note": "No return date"
            })
            continue

        # Check: did the player play any games during the injury window?
        try:
            inj_start = datetime.strptime(date_injured, "%Y-%m-%d")
            inj_end = datetime.strptime(return_date, "%Y-%m-%d")
        except:
            continue

        games_during_injury = sorted([d for d in dates if date_injured < d < return_date])

        if games_during_injury:
            results["played_during_injury"].append({
                "player": player_name,
                "date_injured": date_injured,
                "return_date": return_date,
                "injury": injury_type,
                "games_played_during": len(games_during_injury),
                "dates": games_during_injury[:5],
                "note": f"Played {len(games_during_injury)} games during supposed injury"
            })
        else:
            # Count how many team games happened during the window
            # that this player SHOULD have played but didn't
            # For now, just confirm they were absent
            results["confirmed_missed"].append({
                "player": player_name,
                "date_injured": date_injured,
                "return_date": return_date,
                "injury": injury_type,
                "reported_missed": games_missed,
            })

        # Check: did the player play on or near the return date?
        games_after_return = sorted([d for d in dates if d >= return_date])
        if not games_after_return:
            results["return_date_wrong"].append({
                "player": player_name,
                "return_date": return_date,
                "injury": injury_type,
                "note": "No games found after return date"
            })
        elif games_after_return[0] > (inj_end + timedelta(days=14)).strftime("%Y-%m-%d"):
            results["return_date_wrong"].append({
                "player": player_name,
                "return_date": return_date,
                "injury": injury_type,
                "first_game_after": games_after_return[0],
                "note": f"First game after return: {games_after_return[0]} (14+ days late)"
            })

    # Print summary
    print(f"\n  SUMMARY:")
    print(f"    Confirmed missed (injury real):  {len(results['confirmed_missed']):,}")
    print(f"    Played DURING injury:            {len(results['played_during_injury']):,}  ← BAD DATA")
    print(f"    Return date seems wrong:         {len(results['return_date_wrong']):,}")
    print(f"    No return date:                  {len(results['no_return_date']):,}")
    print(f"    Player not in box scores:        {len(results['player_not_found']):,}")

    if results["played_during_injury"]:
        print(f"\n  TOP 20 PLAYED DURING INJURY:")
        for r in sorted(results["played_during_injury"], key=lambda x: -x["games_played_during"])[:20]:
            print(f"    {r['player']}: injured {r['date_injured']} → {r['return_date']}, "
                  f"but played {r['games_played_during']} games (e.g. {r['dates'][:3]})")

    # Save full results
    out_file = os.path.join(DATA_DIR, f"injury_audit_{league}.json")
    with open(out_file, "w") as f:
        json.dump(results, f, indent=2, default=str)
    print(f"\n  Full results: {out_file}")

    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--league", choices=["nba", "nhl", "nfl", "mlb"])
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--player", help="Filter to specific player name")
    args = parser.parse_args()

    if args.all:
        for league in ["nba", "nhl", "nfl", "mlb"]:
            audit(league)
    elif args.league:
        audit(args.league, args.player)
    else:
        print("Specify --league or --all")


if __name__ == "__main__":
    main()
