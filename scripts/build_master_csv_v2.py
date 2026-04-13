#!/usr/bin/env python3
"""
Build master CSV v2 — ESPN box scores as the ONLY source for player stats.

For each league, reads:
  1. ESPN schedule cache → game dates, teams, event_ids
  2. ESPN box score cache → per-player per-game stats
  3. Odds API (from DB) → game odds for each event

Produces one row per player per game with:
  - Game info (date, teams, scores)
  - Player info (name, team, position, ESPN ID)
  - Player stats (from ESPN box score)
  - Odds (from DB, matched by date + teams)
  - Verification status

Usage:
  python3 build_master_csv_v2.py --league nba
  python3 build_master_csv_v2.py --all
"""
import os, sys, json, csv, glob, argparse
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

SPORT_PATHS = {
    "nba": "basketball_nba",
    "nhl": "hockey_nhl",
    "nfl": "football_nfl",
    "mlb": "baseball_mlb",
}

SPORT_KEYS = {
    "nba": "basketball_nba",
    "nhl": "icehockey_nhl",
    "nfl": "americanfootball_nfl",
    "mlb": "baseball_mlb",
}

# Map ESPN stat labels to our column names per sport
# Map ALL ESPN stat labels to column names per sport
# Includes skaters+goalies (NHL), batters+pitchers (MLB), all positions (NFL)
NBA_STAT_MAP = {
    "MIN": "minutes", "PTS": "stat_pts", "REB": "stat_reb", "AST": "stat_ast",
    "STL": "stat_stl", "BLK": "stat_blk", "3PT": "stat_3pm", "TO": "turnovers",
    "FG": "fg", "FT": "ft", "OREB": "stat_oreb", "DREB": "stat_dreb",
    "+/-": "plus_minus", "PF": "fouls",
}

NHL_STAT_MAP = {
    # Skater stats
    "G": "stat_goals", "A": "stat_assists", "SOG": "stat_sog", "+/-": "plus_minus",
    "TOI": "toi", "S": "stat_shots", "SM": "stat_shots_missed",
    "HT": "stat_hits", "BS": "stat_blocks", "TK": "stat_takeaways", "GV": "stat_giveaways",
    "PIM": "stat_pim", "PN": "stat_penalties",
    "FW": "faceoff_wins", "FL": "faceoff_losses", "FO%": "faceoff_pct",
    "SHFT": "stat_shifts",
    "PPTOI": "pp_toi", "SHTOI": "sh_toi", "ESTOI": "es_toi",
    "YTDG": "ytd_goals",
    # Goalie stats
    "GA": "stat_goals_against", "SA": "stat_shots_against",
    "SV": "stat_saves", "SV%": "stat_save_pct",
    "ESSV": "stat_es_saves", "PPSV": "stat_pp_saves", "SHSV": "stat_sh_saves",
    "SOS": "stat_shootout_saves", "SOSA": "stat_shootout_attempts",
}

NFL_STAT_MAP = {
    "C/ATT": "pass_catt", "YDS": "stat_pass_yds", "TD": "stat_pass_td",
    "INT": "stat_int", "SACKS": "stat_sacks", "QBR": "stat_qbr", "RTG": "stat_rtg",
    "CAR": "stat_rush_att", "AVG": "stat_avg",
    "REC": "stat_rec", "TGTS": "stat_targets", "LONG": "stat_long",
    # Additional NFL stats
    "FUM": "stat_fumbles", "LOST": "stat_fumbles_lost",
    "YAC": "stat_yac", "Y/R": "stat_yds_per_rec",
    "1DN": "stat_first_downs", "20+": "stat_20plus",
    "40+": "stat_40plus", "FL": "stat_fumbles_lost_2",
}

MLB_STAT_MAP = {
    # Batter stats
    "H": "stat_h", "R": "stat_r", "HR": "stat_hr", "RBI": "stat_rbi",
    "BB": "stat_bb", "K": "stat_k", "AB": "stat_ab", "SB": "stat_sb",
    "H-AB": "stat_h_ab", "#P": "stat_pitches_seen",
    "AVG": "stat_avg", "OBP": "stat_obp", "SLG": "stat_slg",
    # Pitcher stats
    "IP": "stat_ip", "ER": "stat_er", "SO": "stat_so",
    "PC": "stat_pitch_count", "PC-ST": "stat_pc_strikes",
    "ERA": "stat_era",
}

STAT_MAPS = {"nba": NBA_STAT_MAP, "nhl": NHL_STAT_MAP, "nfl": NFL_STAT_MAP, "mlb": MLB_STAT_MAP}

ODDS_COLS = [
    "h2h_home_price", "h2h_away_price",
    "spread_home_line", "spread_home_price", "spread_away_line", "spread_away_price",
    "total_line", "total_over_price", "total_under_price",
    "close_h2h_home_price", "close_h2h_away_price",
    "close_spread_home_line", "close_spread_home_price",
    "close_total_line", "close_total_over_price", "close_total_under_price",
]


def parse_stat_value(val):
    """Parse ESPN stat value. Handles '5-8' (FG), '19:23' (TOI), numbers, etc."""
    if val is None or val == "--" or val == "-" or val == "":
        return None
    # FG/FT format: "5-8" → take made (first number)
    if "-" in str(val) and not str(val).startswith("-"):
        parts = str(val).split("-")
        if len(parts) == 2:
            try:
                return float(parts[0])
            except:
                return str(val)
    # Time format: "19:23" → convert to decimal minutes
    if ":" in str(val):
        parts = str(val).split(":")
        try:
            return round(float(parts[0]) + float(parts[1]) / 60, 1)
        except:
            return str(val)
    try:
        return float(val)
    except:
        return str(val)


def normalize_team(name):
    return name.lower().strip()


def load_odds_by_date_teams(league):
    """Load odds indexed by (date, home_team_lower, away_team_lower)."""
    import psycopg2
    conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"])
    cur = conn.cursor()

    sport_key = SPORT_KEYS[league]
    cols = "event_id, game_date, home_team, away_team, source, home_score, away_score, " + ", ".join(ODDS_COLS)
    cur.execute(f"SELECT {cols} FROM back_in_play_game_odds WHERE sport_key = %s ORDER BY event_id", (sport_key,))
    rows = cur.fetchall()
    col_names = [d[0] for d in cur.description]
    conn.close()

    # Dedup by event_id (prefer fanduel)
    by_event = defaultdict(list)
    for row in rows:
        d = dict(zip(col_names, row))
        by_event[d["event_id"]].append(d)

    odds_index = {}
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
        key = (str(best["game_date"]), normalize_team(best["home_team"]), normalize_team(best["away_team"]))
        odds_index[key] = best

    print(f"  Odds: {len(odds_index):,} events loaded")
    return odds_index


def build_master(league):
    print(f"\n{'='*60}")
    print(f"  MASTER CSV v2 — {league.upper()} (ESPN box scores only)")
    print(f"{'='*60}")

    stat_map = STAT_MAPS[league]
    stat_cols = sorted(set(stat_map.values()))

    # Load odds
    odds_index = load_odds_by_date_teams(league)

    # Load all schedules to get event_id → (date, home, away) mapping
    print("  Loading schedules...")
    event_to_game = {}  # event_id → {date, home_team, away_team, home_score, away_score}
    schedule_files = sorted(glob.glob(f"{ESPN_CACHE}/schedule_*_{league}_*.json") +
                           glob.glob(f"{ESPN_CACHE}/schedule_{SPORT_PATHS.get(league, league)}_*.json"))
    for sf in schedule_files:
        sched = json.load(open(sf))
        for e in sched.get("events", []):
            eid = e.get("event_id")
            if eid:
                event_to_game[eid] = {
                    "date": e.get("date", ""),
                    "home_team": e.get("home_team", ""),
                    "away_team": e.get("away_team", ""),
                    "home_score": e.get("home_score"),
                    "away_score": e.get("away_score"),
                    "home_team_id": e.get("home_team_id"),
                    "away_team_id": e.get("away_team_id"),
                }
    print(f"  Schedules: {len(event_to_game):,} events")

    # Load all box scores and build rows
    print("  Loading box scores...")
    box_files = sorted(glob.glob(f"{ESPN_CACHE}/boxscore_*.json"))

    out_cols = (
        ["game_date", "season", "event_id", "home_team", "away_team", "home_score", "away_score",
         "player_name", "player_espn_id", "player_team", "player_position"]
        + stat_cols
        + ODDS_COLS
        + ["has_odds", "source", "raw_stats"]
    )

    master_rows = []
    events_processed = 0
    events_with_odds = 0
    events_no_schedule = 0
    players_total = 0

    for bf in box_files:
        eid = os.path.basename(bf).replace("boxscore_", "").replace(".json", "")
        game_info = event_to_game.get(eid)
        if not game_info:
            events_no_schedule += 1
            continue

        game_date = game_info["date"]
        if not game_date:
            continue

        home_team = game_info["home_team"]
        away_team = game_info["away_team"]

        # Compute season
        yr = int(game_date[:4])
        mo = int(game_date[5:7])
        if league in ("nba", "nhl", "nfl"):
            season = yr if mo >= 7 else yr - 1
        else:
            season = yr

        # Find matching odds (try exact, then ±1 day)
        odds = None
        for delta in [0, 1, -1]:
            try:
                dt = datetime.strptime(game_date, "%Y-%m-%d") + timedelta(days=delta)
                key = (dt.strftime("%Y-%m-%d"), normalize_team(home_team), normalize_team(away_team))
                odds = odds_index.get(key)
                if odds:
                    break
            except:
                pass

        has_odds = odds is not None
        if has_odds:
            events_with_odds += 1

        # Load box score
        try:
            box = json.load(open(bf))
        except:
            continue

        events_processed += 1

        for team_data in box.get("teams", []):
            team_name = team_data.get("team_name", "")
            for player in team_data.get("players", []):
                player_name = player.get("name", "")
                if not player_name:
                    continue

                espn_id = player.get("espn_id", "")
                position = player.get("position", "")
                raw_stats = player.get("stats", {})
                is_starter = player.get("starter", None)
                dnp_reason = player.get("dnp_reason", "") or ""

                row = {
                    "game_date": game_date,
                    "season": season,
                    "event_id": eid,
                    "home_team": home_team,
                    "away_team": away_team,
                    "home_score": game_info.get("home_score"),
                    "away_score": game_info.get("away_score"),
                    "player_name": player_name,
                    "player_espn_id": espn_id,
                    "player_team": team_name,
                    "player_position": position,
                    "has_odds": "Y" if has_odds else "N",
                    "source": "espn_boxscore",
                }

                # Parse stats — map known ones to typed columns
                for espn_label, col_name in stat_map.items():
                    if espn_label in raw_stats:
                        row[col_name] = parse_stat_value(raw_stats[espn_label])
                    else:
                        row[col_name] = None

                # Store ALL raw stats as JSON (captures goalie, pitcher, and any other stats)
                row["raw_stats"] = json.dumps(raw_stats) if raw_stats else None
                row["starter"] = is_starter
                row["dnp_reason"] = dnp_reason if dnp_reason else None

                # Add odds
                if odds:
                    for col in ODDS_COLS:
                        row[col] = odds.get(col)
                else:
                    for col in ODDS_COLS:
                        row[col] = None

                master_rows.append(row)
                players_total += 1

        if events_processed % 5000 == 0:
            print(f"    {events_processed:,} events, {players_total:,} player rows...")

    # Sort by date, player
    master_rows.sort(key=lambda r: (r["game_date"], r["player_name"]))

    # Write CSV
    out_file = os.path.join(DATA_DIR, f"master_{league}_v2.csv")
    with open(out_file, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=out_cols, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(master_rows)

    print(f"\n  Output: {out_file}")
    print(f"  Total rows: {len(master_rows):,}")
    print(f"  Events processed: {events_processed:,}")
    print(f"  Events with odds: {events_with_odds:,}")
    print(f"  Events no schedule match: {events_no_schedule:,}")
    print(f"  Unique players: {len(set(r['player_espn_id'] for r in master_rows)):,}")

    return out_file


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
