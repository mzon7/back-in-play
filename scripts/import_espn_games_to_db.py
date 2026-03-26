#!/usr/bin/env python3
"""
Import ESPN team-first pipeline game data into back_in_play_games table.
Reads summary JSON files from the ESPN cache and upserts unique games.

Usage:
  python3 import_espn_games_to_db.py          # All leagues
  python3 import_espn_games_to_db.py --league nba
"""
import os, sys, json, glob, argparse, psycopg2, uuid
from collections import defaultdict

for f in ["/root/.daemon-env", ".env"]:
    if os.path.exists(f):
        with open(f) as fh:
            for line in fh:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

ESPN_CACHE = os.path.join(os.path.dirname(__file__), "..", "data", "espn_team_first_cache")

LEAGUE_SLUG = {"nba": "nba", "nhl": "nhl", "nfl": "nfl", "mlb": "mlb"}


def get_conn():
    return psycopg2.connect(os.environ["SUPABASE_DB_URL"])


def compute_season(game_date, league):
    """Compute season year from game date. NBA/NHL/NFL use fall-start seasons."""
    yr = int(game_date[:4])
    mo = int(game_date[5:7])
    if league in ("nba", "nhl"):
        return yr if mo >= 7 else yr - 1
    elif league == "nfl":
        return yr if mo >= 7 else yr - 1
    else:  # mlb
        return yr


def import_league(league, conn):
    print(f"\n{'='*60}")
    print(f"  Importing {league.upper()} games")
    print(f"{'='*60}")

    summaries = sorted(glob.glob(f"{ESPN_CACHE}/summary_{league}_*.json"))
    print(f"  Found {len(summaries)} summary files")

    # Collect all unique games (deduplicate by date+home+away)
    all_games = {}  # key = (date, home, away) -> game dict
    for sf in summaries:
        data = json.load(open(sf))
        season_yr = data.get("season", 0)
        for g in data.get("games", []):
            date = g.get("date", "")
            home = g.get("home_team", "")
            away = g.get("away_team", "")
            if not date or not home or not away:
                continue
            key = (date, home, away)
            if key not in all_games:
                season = compute_season(date, league) if not season_yr else season_yr
                home_score = g.get("home_score")
                away_score = g.get("away_score")
                winner = None
                if home_score is not None and away_score is not None:
                    try:
                        hs, aws = float(home_score), float(away_score)
                        winner = home if hs > aws else away if aws > hs else "TIE"
                    except:
                        pass
                all_games[key] = {
                    "league_slug": league,
                    "season": season,
                    "game_date": date,
                    "home_team": home,
                    "away_team": away,
                    "home_score": int(home_score) if home_score is not None else None,
                    "away_score": int(away_score) if away_score is not None else None,
                    "winner": winner,
                }

    print(f"  Unique games: {len(all_games):,}")

    # Check what's already in DB
    cur = conn.cursor()
    cur.execute("SELECT game_date, home_team, away_team FROM back_in_play_games WHERE league_slug = %s", (league,))
    existing = {(str(r[0]), r[1], r[2]) for r in cur.fetchall()}
    print(f"  Already in DB: {len(existing):,}")

    new_games = [g for k, g in all_games.items() if k not in existing]
    print(f"  New to insert: {len(new_games):,}")

    if not new_games:
        print("  Nothing to insert.")
        return

    # Batch insert
    cols = ["league_slug", "season", "game_date", "home_team", "away_team", "home_score", "away_score", "winner"]
    values_list = []
    params = []
    for g in new_games:
        placeholders = []
        for col in cols:
            params.append(g.get(col))
            placeholders.append("%s")
        values_list.append(f"({', '.join(placeholders)})")

    # Insert in chunks of 500
    CHUNK = 500
    inserted = 0
    for i in range(0, len(values_list), CHUNK):
        chunk_vals = values_list[i:i + CHUNK]
        chunk_params = params[i * len(cols):(i + CHUNK) * len(cols)]
        sql = f"INSERT INTO back_in_play_games ({', '.join(cols)}) VALUES {', '.join(chunk_vals)} ON CONFLICT DO NOTHING"
        try:
            cur.execute(sql, chunk_params)
            conn.commit()
            inserted += len(chunk_vals)
            print(f"    Inserted {inserted:,}/{len(new_games):,}")
        except Exception as e:
            conn.rollback()
            print(f"    Error: {e}")
            # Try one by one
            for j, v in enumerate(chunk_vals):
                single_params = chunk_params[j * len(cols):(j + 1) * len(cols)]
                try:
                    cur.execute(f"INSERT INTO back_in_play_games ({', '.join(cols)}) VALUES {v} ON CONFLICT DO NOTHING", single_params)
                    conn.commit()
                    inserted += 1
                except:
                    conn.rollback()

    print(f"  Done: {inserted:,} games inserted")

    # Show per-season summary
    cur.execute("""
        SELECT season, COUNT(*) as games,
               COUNT(DISTINCT home_team) + COUNT(DISTINCT away_team) as teams_seen
        FROM back_in_play_games WHERE league_slug = %s
        GROUP BY season ORDER BY season
    """, (league,))
    print(f"\n  Season  Games  Teams")
    for season, games, teams in cur.fetchall():
        print(f"  {season}    {games}     {teams}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--league", help="Single league (nba/nhl/nfl/mlb)")
    args = parser.parse_args()

    conn = get_conn()

    if args.league:
        import_league(args.league, conn)
    else:
        for league in ["nba", "nhl", "nfl", "mlb"]:
            import_league(league, conn)

    conn.close()
    print("\nDone!")


if __name__ == "__main__":
    main()
