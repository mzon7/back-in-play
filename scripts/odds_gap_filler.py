#!/usr/bin/env python3
"""
Smart odds gap filler — only fetches what's missing.

Checks the DB for:
1. Events with open odds but no close odds → fetch close only
2. Missing date ranges per sport → fetch open+close
3. Fake data (MLB) → delete and refetch

Avoids re-fetching anything we already have.

Usage:
  python3 odds_gap_filler.py --report         # Just show what's missing
  python3 odds_gap_filler.py --fill nba       # Fill gaps for NBA
  python3 odds_gap_filler.py --fill all       # Fill all leagues
  python3 odds_gap_filler.py --delete-fake    # Delete fake MLB data
"""
import os, sys, json, time, argparse, requests, psycopg2
from datetime import datetime, timedelta

for f in ["/root/.daemon-env", ".env"]:
    if os.path.exists(f):
        with open(f) as fh:
            for line in fh:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

API_KEY = os.environ.get("ODDS_API_KEY")
BASE = "https://api.the-odds-api.com/v4/historical/sports"

SPORT_CONFIGS = {
    "basketball_nba": {"start": "2020-09-01", "end": "2026-03-25", "regions": "us",
                        "markets": "h2h,spreads,totals"},
    "icehockey_nhl": {"start": "2020-09-01", "end": "2026-03-25", "regions": "us",
                       "markets": "h2h,spreads,totals"},
    "americanfootball_nfl": {"start": "2020-09-01", "end": "2026-03-25", "regions": "us",
                              "markets": "h2h,spreads,totals"},
    "baseball_mlb": {"start": "2020-09-01", "end": "2026-03-25", "regions": "us",
                      "markets": "h2h,spreads,totals"},
    "soccer_epl": {"start": "2020-09-01", "end": "2026-03-25", "regions": "uk,us",
                    "markets": "h2h,spreads,totals,btts,h2h_3_way,draw_no_bet"},
}

PREFERRED_BOOKS = ["fanduel", "draftkings", "betmgm", "pointsbetus", "bovada"]


def get_conn():
    return psycopg2.connect(os.environ["SUPABASE_DB_URL"])


def report():
    """Show what data we have and what's missing."""
    conn = get_conn()
    cur = conn.cursor()

    expected_games = {
        "basketball_nba": {2020: 500, 2021: 1230, 2022: 1230, 2023: 1230, 2024: 1230, 2025: 1230, 2026: 900},
        "icehockey_nhl": {2020: 500, 2021: 1312, 2022: 1312, 2023: 1312, 2024: 1312, 2025: 1312, 2026: 900},
        "americanfootball_nfl": {2020: 272, 2021: 285, 2022: 285, 2023: 285, 2024: 285, 2025: 285},
        "baseball_mlb": {2020: 900, 2021: 2430, 2022: 2430, 2023: 2430, 2024: 2430, 2025: 2430},
        "soccer_epl": {2020: 380, 2021: 380, 2022: 380, 2023: 380, 2024: 380, 2025: 380, 2026: 300},
    }

    for sport, config in SPORT_CONFIGS.items():
        label = sport.split("_")[-1].upper()
        print(f"\n{'='*60}")
        print(f"  {label}")
        print(f"{'='*60}")

        cur.execute("""
            SELECT EXTRACT(YEAR FROM game_date)::int as yr,
                   COUNT(DISTINCT event_id) as events,
                   COUNT(CASE WHEN close_h2h_home_price IS NOT NULL THEN 1 END) as with_close,
                   COUNT(CASE WHEN source = 'fake_test' THEN 1 END) as fake
            FROM back_in_play_game_odds
            WHERE sport_key = %s
            GROUP BY yr ORDER BY yr
        """, (sport,))
        rows = cur.fetchall()

        year_data = {int(r[0]): {"events": r[1], "with_close": r[2], "fake": r[3]} for r in rows}

        print(f"  {'Year':<6} {'Have':<8} {'Expected':<10} {'Close':<8} {'Fake':<6} {'Gap'}")
        print(f"  {'-'*55}")

        total_gap = 0
        total_close_gap = 0
        for yr in sorted(expected_games.get(sport, {}).keys()):
            exp = expected_games[sport][yr]
            have = year_data.get(yr, {}).get("events", 0)
            close = year_data.get(yr, {}).get("with_close", 0)
            fake = year_data.get(yr, {}).get("fake", 0)
            gap = max(0, exp - have)
            close_gap = have - close
            total_gap += gap
            total_close_gap += close_gap

            status = []
            if fake > 0:
                status.append(f"FAKE:{fake}")
            if gap > 0:
                status.append(f"MISSING:{gap}")
            if close_gap > 0 and have > 0:
                status.append(f"NO_CLOSE:{close_gap}")
            if not status:
                status.append("OK")

            print(f"  {yr:<6} {have:<8} {exp:<10} {close:<8} {fake:<6} {', '.join(status)}")

        print(f"  Total gaps: {total_gap} missing events, {total_close_gap} without close")

    # Show API credits
    try:
        r = requests.get("https://api.the-odds-api.com/v4/sports", params={"apiKey": API_KEY})
        used = r.headers.get("x-requests-used", "?")
        remaining = r.headers.get("x-requests-remaining", "?")
        print(f"\n  Odds API credits: {used} used, {remaining} remaining")
    except:
        pass

    conn.close()


def delete_fake(sport="baseball_mlb"):
    """Delete fake test data."""
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("DELETE FROM back_in_play_game_odds WHERE sport_key = %s AND source = 'fake_test'", (sport,))
    print(f"Deleted {cur.rowcount} fake {sport} rows")
    conn.commit()
    conn.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", action="store_true")
    parser.add_argument("--fill", help="Fill gaps for a sport (or 'all')")
    parser.add_argument("--delete-fake", action="store_true")
    args = parser.parse_args()

    if args.report:
        report()
    elif args.delete_fake:
        delete_fake()
    elif args.fill:
        print("Gap filling not yet implemented — use --report to see what's needed")
    else:
        print("Use --report, --fill, or --delete-fake")


if __name__ == "__main__":
    main()
