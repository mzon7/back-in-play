#!/usr/bin/env python3
"""
Build 3-way verified master CSV per league.

Joins:
  1. Odds API (game_date, teams, odds, scores)
  2. ESPN Box Scores (game_date, teams, players who played)
  3. Player Game Logs (game_date, player stats)

Output: One row per player per game, verified across all 3 sources.

Usage:
  python3 build_master_csv.py --league nba
  python3 build_master_csv.py --league nba --to-db    # also upsert to Supabase
  python3 build_master_csv.py --all
"""
import os, sys, json, csv, glob, argparse, unicodedata
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

SPORT_KEYS = {
    "nba": "basketball_nba",
    "nhl": "icehockey_nhl",
    "nfl": "americanfootball_nfl",
    "mlb": "baseball_mlb",
}

# Stat columns per league
STAT_COLS = {
    "nba": ["minutes", "stat_pts", "stat_reb", "stat_ast", "stat_stl", "stat_blk", "stat_3pm"],
    "nhl": ["stat_goals", "stat_assists", "stat_sog"],
    "nfl": ["stat_pass_yds", "stat_pass_td", "stat_rush_yds", "stat_rush_td", "stat_rec", "stat_rec_yds"],
    "mlb": ["stat_h", "stat_rbi", "stat_r", "stat_hr", "stat_sb", "stat_k", "stat_ip"],
}

ODDS_COLS = [
    "h2h_home_price", "h2h_away_price",
    "spread_home_line", "spread_home_price", "spread_away_line", "spread_away_price",
    "total_line", "total_over_price", "total_under_price",
    "close_h2h_home_price", "close_h2h_away_price",
    "close_spread_home_line", "close_spread_home_price",
    "close_total_line", "close_total_over_price", "close_total_under_price",
]


def normalize_name(name):
    nfkd = unicodedata.normalize("NFKD", name)
    ascii_name = "".join(c for c in nfkd if not unicodedata.combining(c))
    n = ascii_name.lower().strip()
    for suffix in [" jr.", " sr.", " ii", " iii", " iv", " jr", " sr", "."]:
        n = n.replace(suffix, "")
    return n.strip()


def normalize_team(name):
    """Normalize team name for matching (lowercase, strip common suffixes)."""
    return name.lower().strip()


def load_odds(league):
    """Load odds events from Supabase, deduplicated by event_id (prefer FanDuel)."""
    import psycopg2
    conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"])
    cur = conn.cursor()

    sport_key = SPORT_KEYS[league]
    cols = (
        "event_id, game_date, home_team, away_team, source, home_score, away_score, "
        + ", ".join(ODDS_COLS)
    )

    cur.execute(f"SELECT {cols} FROM back_in_play_game_odds WHERE sport_key = %s ORDER BY event_id", (sport_key,))
    rows = cur.fetchall()
    col_names = [d[0] for d in cur.description]
    conn.close()

    # Dedup by event_id (prefer fanduel)
    by_event = defaultdict(list)
    for row in rows:
        d = dict(zip(col_names, row))
        by_event[d["event_id"]].append(d)

    events = {}
    for eid, elist in by_event.items():
        best = None
        for pref in ["fanduel", "draftkings"]:
            for e in elist:
                if (e.get("source") or "").lower() == pref:
                    best = e
                    break
            if best:
                break
        if not best:
            best = elist[0]
        events[(str(best["game_date"]), normalize_team(best["home_team"]), normalize_team(best["away_team"]))] = best

    print(f"  Odds: {len(events):,} unique events")
    return events


def load_espn_box_scores(league):
    """Load ESPN box scores from cache. Returns {(date, home, away): [player_names]}."""
    games = {}  # (date, home_norm, away_norm) -> {players: [{name, espn_id, team}], home_team, away_team}

    summaries = sorted(glob.glob(f"{ESPN_CACHE}/summary_{league}_*.json"))
    all_box_scores = {}  # event_id -> box score data

    for sf in summaries:
        data = json.load(open(sf))
        team_name = data.get("team_name", "")
        team_id = data.get("team_id", "")

        for g in data.get("games", []):
            date = g.get("date", "")
            home = g.get("home_team", "")
            away = g.get("away_team", "")
            if not date or not home or not away:
                continue

            key = (date, normalize_team(home), normalize_team(away))
            if key not in games:
                games[key] = {"home_team": home, "away_team": away, "players": [],
                              "home_score": g.get("home_score"), "away_score": g.get("away_score")}

        # Get players from box scores for this team's games
        for eid, player in data.get("players", {}).items():
            player_name = player.get("name", "")
            game_dates = player.get("game_dates", [])
            teams = player.get("teams", []) if isinstance(player.get("teams"), list) else [player.get("team", "")]
            player_team = teams[0] if teams else team_name

            for gd in game_dates:
                # Find the matching game
                for key, game in games.items():
                    if key[0] == gd:
                        game["players"].append({
                            "name": player_name,
                            "espn_id": eid,
                            "team": player_team,
                        })
                        break

    print(f"  ESPN box scores: {len(games):,} games")
    return games


def load_player_game_logs(league):
    """Load player game logs from Supabase. Returns {(player_id, date): log_dict}."""
    import psycopg2
    conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"])
    cur = conn.cursor()

    stat_cols = STAT_COLS.get(league, [])
    select = "player_id, game_date, opponent, season, " + ", ".join(stat_cols)

    # Paginate
    logs = {}
    offset = 0
    PAGE = 5000
    while True:
        cur.execute(
            f"SELECT {select} FROM back_in_play_player_game_logs WHERE league_slug = %s ORDER BY player_id, game_date LIMIT %s OFFSET %s",
            (league, PAGE, offset)
        )
        rows = cur.fetchall()
        if not rows:
            break
        col_names = [d[0] for d in cur.description]
        for row in rows:
            d = dict(zip(col_names, row))
            key = (d["player_id"], str(d["game_date"]))
            logs[key] = d
        offset += PAGE

    # Also build player_id -> name mapping
    cur.execute("SELECT player_id, player_name, team_id FROM back_in_play_players WHERE league_id = (SELECT league_id FROM back_in_play_leagues WHERE slug = %s)", (league,))
    player_names = {r[0]: r[1] for r in cur.fetchall()}

    conn.close()
    print(f"  Player game logs: {len(logs):,} rows, {len(player_names):,} players")
    return logs, player_names


def build_master(league):
    print(f"\n{'='*60}")
    print(f"  BUILDING MASTER CSV — {league.upper()}")
    print(f"{'='*60}")

    # Load all 3 sources
    odds = load_odds(league)
    espn = load_espn_box_scores(league)
    logs, player_names = load_player_game_logs(league)

    # Build name -> player_id index
    name_to_pid = {}
    for pid, pname in player_names.items():
        norm = normalize_name(pname)
        name_to_pid[norm] = pid

    stat_cols = STAT_COLS.get(league, [])

    # Output columns
    out_cols = [
        "game_date", "season", "home_team", "away_team",
        "player_name", "player_id", "player_team",
    ] + stat_cols + ODDS_COLS + [
        "home_score", "away_score", "source_verified", "verification_notes",
    ]

    master_rows = []
    stats = {"matched_3_3": 0, "matched_2_3": 0, "no_stats": 0, "no_odds": 0, "no_boxscore": 0, "date_adjusted": 0}

    # For each odds event, try to match box score and player logs
    for (odds_date, odds_home, odds_away), odds_event in odds.items():
        # Find matching ESPN box score
        espn_game = espn.get((odds_date, odds_home, odds_away))

        # Try ±1 day if no exact match
        date_adjusted = False
        if not espn_game:
            dt = datetime.strptime(odds_date, "%Y-%m-%d")
            for delta in [1, -1]:
                alt_date = (dt + timedelta(days=delta)).strftime("%Y-%m-%d")
                espn_game = espn.get((alt_date, odds_home, odds_away))
                if espn_game:
                    date_adjusted = True
                    stats["date_adjusted"] += 1
                    break

        if not espn_game:
            stats["no_boxscore"] += 1
            continue  # No box score = can't know which players played

        # Compute season
        yr = int(odds_date[:4])
        mo = int(odds_date[5:7])
        season = yr if mo >= 7 else yr - 1

        # For each player in the ESPN box score
        for player in espn_game.get("players", []):
            player_name = player["name"]
            norm_name = normalize_name(player_name)
            player_id = name_to_pid.get(norm_name)

            # Find their game log for this date
            log = None
            notes = []

            if player_id:
                log = logs.get((player_id, odds_date))
                if not log and date_adjusted:
                    # Try the adjusted date too
                    for delta in [1, -1]:
                        alt = (datetime.strptime(odds_date, "%Y-%m-%d") + timedelta(days=delta)).strftime("%Y-%m-%d")
                        log = logs.get((player_id, alt))
                        if log:
                            notes.append(f"log_date_adjusted_{delta}d")
                            break

            # Build the row
            verified = "3/3"
            if not log:
                verified = "2/3"
                notes.append("no_stats")
                stats["no_stats"] += 1
            elif log and player_id:
                stats["matched_3_3"] += 1

            row = {
                "game_date": odds_date,
                "season": season,
                "home_team": odds_event["home_team"],
                "away_team": odds_event["away_team"],
                "player_name": player_name,
                "player_id": player_id or "",
                "player_team": player.get("team", ""),
            }

            # Stats from game log
            for col in stat_cols:
                row[col] = log.get(col) if log else None

            # Odds
            for col in ODDS_COLS:
                row[col] = odds_event.get(col)

            # Scores
            row["home_score"] = odds_event.get("home_score")
            row["away_score"] = odds_event.get("away_score")

            row["source_verified"] = verified
            row["verification_notes"] = "|".join(notes) if notes else ""

            if date_adjusted:
                row["verification_notes"] = "date_adjusted|" + row["verification_notes"]

            master_rows.append(row)

    # Sort by date, then player
    master_rows.sort(key=lambda r: (r["game_date"], r["player_name"]))

    # Write CSV
    out_file = os.path.join(DATA_DIR, f"master_{league}.csv")
    with open(out_file, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=out_cols, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(master_rows)

    print(f"\n  Output: {out_file}")
    print(f"  Total rows: {len(master_rows):,}")
    print(f"  3/3 verified: {stats['matched_3_3']:,}")
    print(f"  2/3 (no stats): {stats['no_stats']:,}")
    print(f"  No box score (skipped): {stats['no_boxscore']:,}")
    print(f"  Date adjusted: {stats['date_adjusted']:,}")

    return master_rows, stats


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--league", choices=["nba", "nhl", "nfl", "mlb"])
    parser.add_argument("--all", action="store_true")
    args = parser.parse_args()

    if args.all:
        for league in ["nba", "nhl", "nfl", "mlb"]:
            build_master(league)
    elif args.league:
        build_master(args.league)
    else:
        print("Specify --league or --all")


if __name__ == "__main__":
    main()
