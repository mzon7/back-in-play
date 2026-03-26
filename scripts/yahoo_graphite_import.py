#!/usr/bin/env python3
"""
Yahoo Graphite Game Log Import — Step 2 of the team-first pipeline.

Reads the ESPN team-first cache (player discovery), then for each player:
1. Fetches full game logs from Yahoo Graphite API (primary data source)
2. Upserts to back_in_play_player_game_logs with source_url='yahoo_graphite_api'
3. Maps ESPN IDs to our DB player_ids
4. Tracks unmatched players for manual review

Usage:
  python3 yahoo_graphite_import.py --league nba
  python3 yahoo_graphite_import.py --league nba --dry-run    # Don't write to DB
  python3 yahoo_graphite_import.py --league nba --compare     # Compare Yahoo vs ESPN dates
  python3 yahoo_graphite_import.py --all
"""
import os, sys, json, time, re, argparse, requests, unicodedata
from collections import defaultdict
from datetime import datetime

for f in ["/root/.daemon-env", ".env"]:
    if os.path.exists(f):
        with open(f) as fh:
            for line in fh:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

GRAPHITE_URL = "https://graphite.sports.yahoo.com/v1/query/shangrila/playerGameLog"

ESPN_CACHE = os.environ.get(
    "ESPN_CACHE_DIR",
    os.path.join(os.path.dirname(__file__), "..", "data", "espn_team_first_cache"),
)
YAHOO_CACHE = os.path.join(os.path.dirname(__file__), "..", "data", "yahoo_graphite_gamelogs")
os.makedirs(YAHOO_CACHE, exist_ok=True)

YAHOO_SPORT = {"nba": "nba", "nhl": "nhl", "nfl": "nfl", "mlb": "mlb"}

SEASONS = {
    "nba": list(range(2013, 2027)),
    "nhl": list(range(2013, 2027)),
    "nfl": list(range(2013, 2027)),
    "mlb": list(range(2013, 2027)),
}

# Yahoo stat ID -> our DB column
NBA_STAT_MAP = {
    "POINTS": "stat_pts", "TOTAL_REBOUNDS": "stat_reb", "ASSISTS": "stat_ast",
    "STEALS": "stat_stl", "BLOCKED_SHOTS": "stat_blk", "THREE_POINTS_MADE": "stat_3pm",
    "MINUTES": "minutes", "TURNOVERS": "turnovers",
    "FIELD_GOALS_MADE": "fgm", "FIELD_GOALS_ATTEMPTED": "fga",
    "FREE_THROWS_MADE": "ftm", "FREE_THROWS_ATTEMPTED": "fta",
    "THREE_POINT_ATTEMPTS": "tpa",
}

NHL_STAT_MAP = {
    "GOALS": "stat_goals", "ASSISTS": "stat_assists", "SHOTS_ON_GOAL": "stat_sog",
    "PLUS_MINUS": "plus_minus", "PENALTY_MINUTES": "pim",
    "TIME_ON_ICE": "minutes",
}

NFL_STAT_MAP = {
    "PASSING_YARDS": "stat_pass_yds", "PASSING_TOUCHDOWNS": "stat_pass_td",
    "PASSING_ATTEMPTS": "stat_pass_att", "PASSING_COMPLETIONS": "stat_pass_comp",
    "RUSHING_YARDS": "stat_rush_yds", "RUSHING_TOUCHDOWNS": "stat_rush_td",
    "RUSHING_ATTEMPTS": "stat_rush_att",
    "RECEPTIONS": "stat_rec", "RECEIVING_YARDS": "stat_rec_yds",
    "RECEIVING_TOUCHDOWNS": "stat_rec_td",
    "INTERCEPTIONS_THROWN": "stat_int",
}

MLB_STAT_MAP = {
    "HITS": "stat_h", "RUNS_BATTED_IN": "stat_rbi", "RUNS": "stat_r",
    "HOME_RUNS": "stat_hr", "STOLEN_BASES": "stat_sb",
    "STRIKEOUTS": "stat_k", "INNINGS_PITCHED": "stat_ip",
    "AT_BATS": "stat_ab", "WALKS": "stat_bb",
}

STAT_MAPS = {"nba": NBA_STAT_MAP, "nhl": NHL_STAT_MAP, "nfl": NFL_STAT_MAP, "mlb": MLB_STAT_MAP}

LEAGUE_IDS = {
    "nba": "2aa180e9-a7c2-4d08-a1d8-a16152827b5d",
    "nhl": "0894f8ac-c744-4b58-9023-20c514f64fff",
    "nfl": "0fea41a7-250e-40bf-9220-97853a69b6d7",
    "mlb": "312485db-3c4a-4f83-b4b0-c761e114d870",
}

api_requests = 0


def normalize_name(name):
    nfkd = unicodedata.normalize("NFKD", name)
    ascii_name = "".join(c for c in nfkd if not unicodedata.combining(c))
    n = ascii_name.lower().strip()
    for suffix in [" jr.", " sr.", " ii", " iii", " iv", " jr", " sr", "."]:
        n = n.replace(suffix, "")
    return n.strip()


def fetch_yahoo_gamelog(sport, yahoo_pid, season):
    """Fetch game log from Yahoo Graphite API. Returns list of games or None."""
    global api_requests
    cache_file = f"{YAHOO_CACHE}/{sport}_{yahoo_pid}_{season}.json"
    if os.path.exists(cache_file):
        return json.load(open(cache_file))

    api_requests += 1
    player_id = f"{sport}.p.{yahoo_pid}"
    try:
        r = requests.get(GRAPHITE_URL, params={
            "playerId": player_id,
            "seasons": str(season),
            "seasonPhases": "REGULAR_SEASON",
        }, timeout=15)
        if r.status_code != 200:
            return None
        players = r.json().get("data", {}).get("players", [])
        if not players:
            with open(cache_file, "w") as f:
                json.dump([], f)
            return []
        games = players[0].get("playerGameStats", [])
        with open(cache_file, "w") as f:
            json.dump(games, f)
        return games
    except:
        return None


def parse_yahoo_game(game, stat_map):
    """Parse a Yahoo Graphite game entry into a DB-ready dict."""
    date_str = game.get("date", "")[:10]
    if not date_str:
        return None

    team = game.get("team", {})
    opponent = game.get("opponent", {})

    row = {
        "game_date": date_str,
        "opponent": opponent.get("abbreviation", ""),
        "yahoo_team": team.get("fullName", ""),
        "yahoo_team_abbr": team.get("abbreviation", ""),
        "season": game.get("season", 0),
    }

    for stat in game.get("stats", []):
        stat_id = stat.get("statId", "")
        value = stat.get("value")
        db_col = stat_map.get(stat_id)
        if db_col and value is not None:
            s = str(value).strip()
            if s == "-" or s == "":
                continue
            # Handle X-Y format (e.g., "3-7" for made-attempted)
            if "-" in s and not s.startswith("-"):
                try:
                    row[db_col] = float(s.split("-")[0])
                except:
                    pass
            else:
                try:
                    row[db_col] = float(s)
                except:
                    pass

    return row


def load_espn_players(league):
    """Load all players discovered by the ESPN pipeline. Returns dict: espn_id -> {name, yahoo_pid, games, ...}"""
    yahoo_map_file = f"{ESPN_CACHE}/yahoo_map_{league}.json"
    if not os.path.exists(yahoo_map_file):
        print(f"  No Yahoo map file found at {yahoo_map_file}")
        return {}, {}

    yahoo_map = json.load(open(yahoo_map_file))  # espn_id -> yahoo_pid

    # Also collect all players from summary files
    all_players = {}  # espn_id -> {name, yahoo_pid, total_games, teams}
    import glob
    for f in glob.glob(f"{ESPN_CACHE}/summary_{league}_*.json"):
        summary = json.load(open(f))
        for espn_id, pdata in summary.get("players", {}).items():
            if espn_id not in all_players:
                all_players[espn_id] = {
                    "name": pdata["name"],
                    "yahoo_pid": pdata.get("yahoo_pid") or yahoo_map.get(espn_id),
                    "total_games": 0,
                    "teams": set(),
                    "position": pdata.get("position", ""),
                }
            all_players[espn_id]["total_games"] += pdata.get("games", 0)
            all_players[espn_id]["teams"].add(pdata.get("team", ""))

    # Convert sets to lists for JSON
    for p in all_players.values():
        p["teams"] = list(p["teams"])

    return all_players, yahoo_map


def map_to_db_player(conn, player_name, league):
    """Find our DB player_id for a player name. Returns player_id or None."""
    cur = conn.cursor()
    target = normalize_name(player_name)

    # Exact match
    cur.execute(
        "SELECT player_id FROM back_in_play_players WHERE league_id = %s AND player_name = %s LIMIT 1",
        (LEAGUE_IDS[league], player_name),
    )
    row = cur.fetchone()
    if row:
        return row[0]

    # Normalized match
    cur.execute(
        "SELECT player_id, player_name FROM back_in_play_players WHERE league_id = %s",
        (LEAGUE_IDS[league],),
    )
    for pid, pname in cur.fetchall():
        if normalize_name(pname) == target:
            return pid

    return None


def run_import(league, dry_run=False, compare_mode=False):
    """Main import: fetch Yahoo game logs for all ESPN-discovered players and upsert to DB."""
    print(f"\n{'='*60}")
    print(f"YAHOO GRAPHITE IMPORT — {league.upper()}")
    print(f"{'='*60}\n")

    stat_map = STAT_MAPS[league]
    sport = YAHOO_SPORT[league]

    # Load ESPN-discovered players
    all_players, yahoo_map = load_espn_players(league)
    print(f"ESPN discovered: {len(all_players)} unique players")

    # Filter to those with Yahoo PIDs
    with_yahoo = {eid: p for eid, p in all_players.items() if p.get("yahoo_pid")}
    without_yahoo = {eid: p for eid, p in all_players.items() if not p.get("yahoo_pid")}
    print(f"  With Yahoo PID: {len(with_yahoo)}")
    print(f"  Without Yahoo PID: {len(without_yahoo)} (unmatched)")

    # Save unmatched for manual review
    unmatched_file = f"{ESPN_CACHE}/unmatched_{league}.json"
    unmatched_list = [{"espn_id": eid, "name": p["name"], "games": p["total_games"], "teams": p["teams"]}
                      for eid, p in without_yahoo.items()]
    unmatched_list.sort(key=lambda x: -x["games"])
    json.dump(unmatched_list, open(unmatched_file, "w"), indent=2)
    print(f"  Saved unmatched to {unmatched_file}")

    # Connect to DB
    conn = None
    import psycopg2

    def get_conn():
        return psycopg2.connect(os.environ["SUPABASE_DB_URL"])

    if not dry_run:
        try:
            conn = get_conn()
        except Exception as e:
            print(f"  DB connection failed: {e}")
            print(f"  Running in dry-run mode")
            dry_run = True

    # Track which players are already done (for restart)
    done_file = f"{ESPN_CACHE}/import_done_{league}.json"
    done_players = set()
    if os.path.exists(done_file):
        done_players = set(json.load(open(done_file)))

    # Process each player with a Yahoo PID
    total_games_fetched = 0
    total_upserted = 0
    players_processed = 0
    players_no_data = 0
    comparison_results = []

    for espn_id, player in with_yahoo.items():
        if espn_id in done_players:
            players_processed += 1
            continue

        yahoo_pid = player["yahoo_pid"]
        player_name = player["name"]

        # Find DB player_id — reconnect if needed
        db_pid = None
        if conn:
            try:
                db_pid = map_to_db_player(conn, player_name, league)
            except:
                try:
                    conn = get_conn()
                    db_pid = map_to_db_player(conn, player_name, league)
                except:
                    pass

        # Fetch Yahoo game logs for all seasons — collect all rows first
        player_rows = []
        for season in SEASONS[league]:
            games = fetch_yahoo_gamelog(sport, yahoo_pid, season)
            if not games:
                continue

            for game in games:
                parsed = parse_yahoo_game(game, stat_map)
                if not parsed:
                    continue

                total_games_fetched += 1

                if db_pid:
                    row = {
                        "player_id": db_pid,
                        "league_slug": league,
                        "game_date": parsed["game_date"],
                        "opponent": parsed.get("opponent", ""),
                        "season": parsed.get("season", 0),
                        "source_url": "yahoo_graphite_api",
                    }
                    for key in ["minutes", "stat_pts", "stat_reb", "stat_ast", "stat_stl", "stat_blk",
                                "stat_3pm", "stat_goals", "stat_assists", "stat_sog",
                                "stat_pass_yds", "stat_pass_td", "stat_pass_att", "stat_pass_comp",
                                "stat_rush_yds", "stat_rush_td", "stat_rush_att",
                                "stat_rec", "stat_rec_yds", "stat_h", "stat_rbi", "stat_r",
                                "stat_hr", "stat_sb", "stat_k", "stat_ip"]:
                        if key in parsed:
                            row[key] = parsed[key]
                    player_rows.append(row)

            time.sleep(0.03)

        player_total = len(player_rows)

        # Batch upsert all rows for this player using multi-value INSERT
        if player_rows and not dry_run:
            if not conn:
                try:
                    conn = get_conn()
                except:
                    continue
            try:
                cur = conn.cursor()
            except:
                try:
                    conn = get_conn()
                    cur = conn.cursor()
                except:
                    continue
            # Use consistent columns across all rows
            all_cols = ["player_id", "league_slug", "game_date", "opponent", "season", "source_url",
                        "minutes", "stat_pts", "stat_reb", "stat_ast", "stat_stl", "stat_blk",
                        "stat_3pm", "stat_goals", "stat_assists", "stat_sog",
                        "stat_pass_yds", "stat_pass_td", "stat_pass_att", "stat_pass_comp",
                        "stat_rush_yds", "stat_rush_td", "stat_rush_att",
                        "stat_rec", "stat_rec_yds", "stat_h", "stat_rbi", "stat_r",
                        "stat_hr", "stat_sb", "stat_k", "stat_ip"]
            update_cols = [c for c in all_cols if c not in ("player_id", "game_date")]
            update_clause = ", ".join(f"{c} = EXCLUDED.{c}" for c in update_cols)
            col_names = ", ".join(all_cols)

            # Build values in chunks of 100 rows
            for chunk_start in range(0, len(player_rows), 100):
                chunk = player_rows[chunk_start:chunk_start + 100]
                values_list = []
                params = []
                for row in chunk:
                    placeholders = []
                    for col in all_cols:
                        params.append(row.get(col))
                        placeholders.append("%s")
                    values_list.append(f"({', '.join(placeholders)})")

                sql = (
                    f"INSERT INTO back_in_play_player_game_logs ({col_names}) "
                    f"VALUES {', '.join(values_list)} "
                    f"ON CONFLICT (player_id, game_date) DO UPDATE SET {update_clause}"
                )
                try:
                    cur.execute(sql, params)
                    total_upserted += len(chunk)
                except Exception as e:
                    conn.rollback()
                    # Fall back to one-by-one for this chunk
                    for row in chunk:
                        vals = [row.get(col) for col in all_cols]
                        try:
                            cur.execute(
                                f"INSERT INTO back_in_play_player_game_logs ({col_names}) "
                                f"VALUES ({', '.join(['%s'] * len(all_cols))}) "
                                f"ON CONFLICT (player_id, game_date) DO UPDATE SET {update_clause}",
                                vals,
                            )
                            total_upserted += 1
                        except:
                            conn.rollback()
            conn.commit()

        players_processed += 1
        if player_total == 0:
            players_no_data += 1

        # Mark player as done
        done_players.add(espn_id)

        if players_processed % 10 == 0:
            if conn:
                try:
                    conn.commit()
                except:
                    try:
                        conn = get_conn()
                    except:
                        pass
            json.dump(list(done_players), open(done_file, "w"))
            print(f"  {players_processed}/{len(with_yahoo)} players, "
                  f"{total_games_fetched} games fetched, {total_upserted} upserted, "
                  f"API calls: {api_requests}", flush=True)

    if conn:
        conn.commit()
        conn.close()

    print(f"\n{'='*60}")
    print(f"DONE: {players_processed} players processed")
    print(f"  Games fetched from Yahoo: {total_games_fetched}")
    print(f"  Games upserted to DB: {total_upserted}")
    print(f"  Players with no Yahoo data: {players_no_data}")
    print(f"  Unmatched (no Yahoo PID): {len(without_yahoo)}")
    print(f"  Yahoo API requests: {api_requests}")
    print(f"{'='*60}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--league", choices=["nba", "nhl", "nfl", "mlb"])
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--dry-run", action="store_true", help="Fetch Yahoo data but don't write to DB")
    parser.add_argument("--compare", action="store_true", help="Compare Yahoo vs ESPN dates")
    args = parser.parse_args()

    leagues = ["nba", "nhl", "nfl", "mlb"] if args.all else [args.league] if args.league else []
    if not leagues:
        print("Specify --league or --all")
        return

    for league in leagues:
        run_import(league, dry_run=args.dry_run, compare_mode=args.compare)


if __name__ == "__main__":
    main()
