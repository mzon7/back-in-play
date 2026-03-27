#!/usr/bin/env python3
"""
Import master CSV v2 files into back_in_play_master_games table.

Usage:
  python3 import_master_csv_to_db.py --league nba
  python3 import_master_csv_to_db.py --all
"""
import os, sys, csv, argparse, psycopg2

for f in ["/root/.daemon-env", ".env"]:
    if os.path.exists(f):
        with open(f) as fh:
            for line in fh:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")

# All columns in the master CSV mapped to DB columns
CSV_TO_DB = {
    "game_date": "game_date", "season": "season", "event_id": "event_id",
    "home_team": "home_team", "away_team": "away_team",
    "home_score": "home_score", "away_score": "away_score",
    "player_name": "player_name", "player_espn_id": "player_espn_id",
    "player_team": "player_team", "player_position": "player_position",
    "minutes": "minutes", "stat_pts": "stat_pts", "stat_reb": "stat_reb",
    "stat_ast": "stat_ast", "stat_stl": "stat_stl", "stat_blk": "stat_blk",
    "stat_3pm": "stat_3pm", "turnovers": "turnovers", "fg": "fg", "ft": "ft",
    "stat_oreb": "stat_oreb", "stat_dreb": "stat_dreb",
    "plus_minus": "plus_minus", "fouls": "fouls",
    "stat_goals": "stat_goals", "stat_assists": "stat_assists", "stat_sog": "stat_sog",
    "toi": "toi", "stat_shots": "stat_shots", "stat_hits": "stat_hits",
    "stat_blocks": "stat_blocks", "stat_pim": "stat_pim",
    "faceoff_wins": "faceoff_wins", "faceoff_losses": "faceoff_losses",
    "stat_giveaways": "stat_giveaways", "stat_takeaways": "stat_takeaways",
    "pass_catt": "pass_catt", "stat_pass_yds": "stat_pass_yds", "stat_pass_td": "stat_pass_td",
    "stat_int": "stat_int", "stat_sacks": "stat_sacks", "stat_qbr": "stat_qbr", "stat_rtg": "stat_rtg",
    "stat_rush_att": "stat_rush_att", "stat_avg": "stat_avg",
    "stat_rec": "stat_rec", "stat_targets": "stat_targets", "stat_long": "stat_long",
    "stat_h": "stat_h", "stat_r": "stat_r", "stat_hr": "stat_hr", "stat_rbi": "stat_rbi",
    "stat_bb": "stat_bb", "stat_k": "stat_k", "stat_ab": "stat_ab", "stat_sb": "stat_sb",
    "stat_ip": "stat_ip", "stat_er": "stat_er", "stat_so": "stat_so",
    "h2h_home_price": "h2h_home_price", "h2h_away_price": "h2h_away_price",
    "spread_home_line": "spread_home_line", "spread_home_price": "spread_home_price",
    "spread_away_line": "spread_away_line", "spread_away_price": "spread_away_price",
    "total_line": "total_line", "total_over_price": "total_over_price",
    "total_under_price": "total_under_price",
    "close_h2h_home_price": "close_h2h_home_price", "close_h2h_away_price": "close_h2h_away_price",
    "close_spread_home_line": "close_spread_home_line", "close_spread_home_price": "close_spread_home_price",
    "close_total_line": "close_total_line", "close_total_over_price": "close_total_over_price",
    "close_total_under_price": "close_total_under_price",
    "has_odds": "has_odds", "source": "source",
}


INT_COLS = {"season", "home_score", "away_score"}

# Dynamic: any CSV column that matches a DB column gets imported
# No need to maintain CSV_TO_DB manually — just use column names as-is

def clean_val(val, col_name=""):
    if val is None or val == "" or val == "None":
        return None
    # Integer columns: strip .0 from floats
    if col_name in INT_COLS:
        try:
            return int(float(val))
        except:
            return None
    return val


def import_league(league, conn):
    csv_file = os.path.join(DATA_DIR, f"master_{league}_v2.csv")
    if not os.path.exists(csv_file):
        print(f"  {csv_file} not found!")
        return

    print(f"\n  Importing {league.upper()} from {csv_file}...")
    cur = conn.cursor()

    # Clear existing
    cur.execute("DELETE FROM back_in_play_master_games WHERE league_slug = %s", (league,))
    conn.commit()
    print(f"    Cleared existing {league} rows")

    # Read CSV and insert in batches
    with open(csv_file, "r") as f:
        reader = csv.DictReader(f)
        csv_cols = reader.fieldnames

        # Get DB column names to know which CSV cols can be imported
        cur.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'back_in_play_master_games'")
        db_columns = {r[0] for r in cur.fetchall()}

        # Map CSV columns to DB columns — use CSV_TO_DB if mapped, else use column name directly
        db_cols = ["league_slug"]
        csv_keys = []
        for csv_col in csv_cols:
            mapped = CSV_TO_DB.get(csv_col, csv_col)  # try mapping, fallback to same name
            if mapped in db_columns:
                db_cols.append(mapped)
                csv_keys.append(csv_col)

        col_names = ", ".join(db_cols)
        placeholders = ", ".join(["%s"] * len(db_cols))

        CHUNK = 500
        batch = []
        inserted = 0

        for row in reader:
            values = [league]  # league_slug
            for csv_col in csv_keys:
                db_col = CSV_TO_DB[csv_col]
                values.append(clean_val(row.get(csv_col), db_col))
            batch.append(values)

            if len(batch) >= CHUNK:
                values_str = ",".join(
                    cur.mogrify(f"({placeholders})", v).decode() for v in batch
                )
                try:
                    cur.execute(f"INSERT INTO back_in_play_master_games ({col_names}) VALUES {values_str} ON CONFLICT DO NOTHING")
                    conn.commit()
                    inserted += len(batch)
                except Exception as e:
                    conn.rollback()
                    print(f"    Batch error at {inserted}: {e}")
                    # Try individual
                    for v in batch:
                        try:
                            cur.execute(f"INSERT INTO back_in_play_master_games ({col_names}) VALUES ({placeholders}) ON CONFLICT DO NOTHING", v)
                            conn.commit()
                            inserted += 1
                        except:
                            conn.rollback()
                batch = []

                if inserted % 50000 == 0:
                    print(f"    {inserted:,} rows...")

        # Final batch
        if batch:
            values_str = ",".join(
                cur.mogrify(f"({placeholders})", v).decode() for v in batch
            )
            try:
                cur.execute(f"INSERT INTO back_in_play_master_games ({col_names}) VALUES {values_str} ON CONFLICT DO NOTHING")
                conn.commit()
                inserted += len(batch)
            except:
                conn.rollback()

    print(f"    Done: {inserted:,} rows inserted")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--league", choices=["nba", "nhl", "nfl", "mlb"])
    parser.add_argument("--all", action="store_true")
    args = parser.parse_args()

    conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"])

    if args.all:
        for league in ["nba", "nhl", "nfl", "mlb"]:
            import_league(league, conn)
    elif args.league:
        import_league(args.league, conn)
    else:
        print("Specify --league or --all")

    conn.close()


if __name__ == "__main__":
    main()
