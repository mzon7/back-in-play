#!/usr/bin/env python3
"""
Scrape historical player props from The Odds API for EV model backtesting.

Multi-league, optimized to only fetch events for teams with returning players
who have game log data (needed for simulation).

Data is saved both to files (backup) and Supabase (queryable).
"""

import os
import sys
import json
import time
import pathlib
import requests
from datetime import datetime, timedelta
from collections import defaultdict

from supabase import create_client

ODDS_API_KEY = os.environ.get("ODDS_API_KEY")
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not all([ODDS_API_KEY, SUPABASE_URL, SUPABASE_KEY]):
    print("Missing env vars: ODDS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY")
    sys.exit(1)

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

BASE_URL = "https://api.the-odds-api.com/v4"
DATA_DIR = pathlib.Path("/workspace/back-in-play/data/historical_props")

# ── League configs ──
LEAGUES = {
    "nba": {
        "sport_key": "basketball_nba",
        "markets": ["player_points", "player_rebounds", "player_assists"],
        "start": "2023-10-24",
        "end": "2026-03-14",
        "league_id": "2aa180e9-a7c2-4d08-a1d8-a16152827b5d",
    },
    "nfl": {
        "sport_key": "americanfootball_nfl",
        "markets": ["player_pass_yds", "player_rush_yds", "player_receptions"],
        "start": "2023-09-07",
        "end": "2026-02-10",
        "league_id": "0fea41a7-250e-40bf-9220-97853a69b6d7",
    },
    "nhl": {
        "sport_key": "icehockey_nhl",
        "markets": ["player_points", "player_shots_on_goal"],
        "start": "2023-10-10",
        "end": "2026-03-14",
        "league_id": "0894f8ac-c744-4b58-9023-20c514f64fff",
    },
    "mlb": {
        "sport_key": "baseball_mlb",
        "markets": ["batter_hits", "batter_total_bases"],
        "start": "2024-03-28",
        "end": "2025-10-01",
        "league_id": "312485db-3c4a-4f83-b4b0-c761e114d870",
    },
    "premier-league": {
        "sport_key": "soccer_epl",
        "markets": ["player_shots", "player_shots_on_target", "player_goals"],
        "start": "2023-08-11",
        "end": "2026-03-14",
        "league_id": "759cf693-7e15-4ea5-a3ed-ff9fd7d6bbb0",
    },
}

REGION_DEFAULT = "us"
# EPL gets much better coverage from UK bookmakers
REGION_BY_LEAGUE = {"premier-league": "uk"}
MIN_GAME_LOGS = 5  # Player must have at least this many game logs


# ── Checkpoint ──

def load_checkpoint(league):
    cp_file = DATA_DIR / league / "checkpoint.json"
    if cp_file.exists():
        return json.loads(cp_file.read_text())
    return {"last_date": None, "total_props": 0, "total_credits": 0}


def save_checkpoint(league, cp):
    cp_file = DATA_DIR / league / "checkpoint.json"
    cp_file.parent.mkdir(parents=True, exist_ok=True)
    cp_file.write_text(json.dumps(cp, indent=2))


# ── Pre-compute which teams have returning players with game logs ──

def build_team_date_lookup(league_slug, league_id, start_date, end_date):
    """
    Build a dict: date → set of team_names that have a player returning
    from injury on or within 20 days before that date, who also has game logs.
    """
    print(f"  Building team/date lookup for {league_slug}...")

    # 1. Get all players for this league with their team names
    player_teams = {}  # player_id → team_name
    offset = 0
    while True:
        r = (sb.table("back_in_play_players")
             .select("player_id, player_name, team_id")
             .eq("league_id", league_id)
             .range(offset, offset + 999)
             .execute())
        if not r.data:
            break
        for p in r.data:
            player_teams[p["player_id"]] = p.get("team_id")
        offset += 1000
        if len(r.data) < 1000:
            break
    print(f"    {len(player_teams)} players")

    # Get team names
    team_names = {}
    r = sb.table("back_in_play_teams").select("team_id, team_name").eq("league_id", league_id).execute()
    for t in r.data:
        team_names[t["team_id"]] = t["team_name"]

    # 2. Get all injuries with return dates in range
    injuries = []
    offset = 0
    player_ids_list = list(player_teams.keys())

    # Fetch injuries in chunks of player_ids
    CHUNK = 50
    for i in range(0, len(player_ids_list), CHUNK):
        chunk_pids = player_ids_list[i:i + CHUNK]
        offset2 = 0
        while True:
            r = (sb.table("back_in_play_injuries")
                 .select("player_id, return_date")
                 .in_("player_id", chunk_pids)
                 .gte("return_date", start_date)
                 .lte("return_date", end_date)
                 .not_.is_("return_date", "null")
                 .range(offset2, offset2 + 999)
                 .execute())
            injuries.extend(r.data)
            if len(r.data) < 1000:
                break
            offset2 += 1000

    print(f"    {len(injuries)} injuries with return dates")

    # 3. Check which players have game logs (batch check)
    players_with_logs = set()
    checked = set()
    unique_pids = list(set(inj["player_id"] for inj in injuries))

    for i in range(0, len(unique_pids), CHUNK):
        chunk_pids = unique_pids[i:i + CHUNK]
        r = (sb.table("back_in_play_player_game_logs")
             .select("player_id")
             .in_("player_id", chunk_pids)
             .eq("league_slug", league_slug)
             .limit(1000)
             .execute())
        for row in r.data:
            players_with_logs.add(row["player_id"])

    print(f"    {len(players_with_logs)} players with game logs")

    # 4. Build date → teams lookup
    # For each injury return date, the player needs props for games 1-10 after return
    # That means we need to scrape props for ~20 days after return date
    date_teams = defaultdict(set)  # date → set of team names
    for inj in injuries:
        pid = inj["player_id"]
        if pid not in players_with_logs:
            continue
        team_id = player_teams.get(pid)
        if not team_id:
            continue
        tname = team_names.get(team_id, "")
        if not tname:
            continue

        ret_date = datetime.strptime(inj["return_date"], "%Y-%m-%d")
        # Need props for ~20 days after return (covers ~10 games)
        for d in range(0, 21):
            dt = ret_date + timedelta(days=d)
            date_teams[dt.strftime("%Y-%m-%d")].add(tname)

    print(f"    {len(date_teams)} dates need scraping")
    return date_teams


# ── Odds API calls ──

def get_historical_events(sport, date_str):
    date_param = f"{date_str}T12:00:00Z"
    url = f"{BASE_URL}/historical/sports/{sport}/events"
    params = {"apiKey": ODDS_API_KEY, "date": date_param}
    resp = requests.get(url, params=params, timeout=30)
    if resp.status_code in (422, 404):
        return [], 0
    resp.raise_for_status()
    remaining = int(resp.headers.get("x-requests-remaining", 0))
    if remaining <= 5_000_000:
        print(f"\n  SAFETY STOP: Credits ({remaining:,}) at or below 5M floor. Exiting.")
        import sys; sys.exit(1)
    return resp.json().get("data", []), remaining


def get_historical_event_odds(sport, event_id, date_str, markets, league=None):
    date_param = f"{date_str}T18:00:00Z"
    url = f"{BASE_URL}/historical/sports/{sport}/events/{event_id}/odds"
    region = REGION_BY_LEAGUE.get(league, REGION_DEFAULT)
    params = {
        "apiKey": ODDS_API_KEY,
        "date": date_param,
        "regions": region,
        "markets": ",".join(markets),
        "oddsFormat": "american",
    }
    resp = requests.get(url, params=params, timeout=30)
    if resp.status_code in (422, 404):
        return None, 0
    resp.raise_for_status()
    remaining = int(resp.headers.get("x-requests-remaining", 0))
    if remaining <= 5_000_000:
        print(f"\n  SAFETY STOP: Credits ({remaining:,}) at or below 5M floor. Exiting.")
        import sys; sys.exit(1)
    return resp.json(), remaining


def decimal_to_american(decimal_odds):
    if decimal_odds >= 2.0:
        return round((decimal_odds - 1) * 100)
    else:
        return round(-100 / (decimal_odds - 1))


def parse_props_from_event(event_odds, game_date, league):
    props = []
    if not event_odds or "data" not in event_odds:
        return props

    event = event_odds["data"]
    event_id = event.get("id", "")
    home_team = event.get("home_team", "")
    away_team = event.get("away_team", "")
    commence = event.get("commence_time", "")

    for bm in event.get("bookmakers", []):
        bm_key = bm.get("key", "")
        for market in bm.get("markets", []):
            market_key = market.get("key", "")
            outcomes = market.get("outcomes", [])

            player_outcomes = {}
            for o in outcomes:
                player = o.get("description", "")
                if not player:
                    continue
                name = o.get("name", "").lower()
                price = o.get("price", 0)
                point = o.get("point")
                if player not in player_outcomes:
                    player_outcomes[player] = {}
                player_outcomes[player][name] = {"price": price, "point": point}

            for player, sides in player_outcomes.items():
                over = sides.get("over", {})
                under = sides.get("under", {})
                line = over.get("point") or under.get("point")
                if line is None:
                    continue

                over_price = over.get("price")
                under_price = under.get("price")
                if over_price and 1.0 < over_price < 100.0:
                    over_price = decimal_to_american(over_price)
                if under_price and 1.0 < under_price < 100.0:
                    under_price = decimal_to_american(under_price)

                props.append({
                    "league": league,
                    "event_id": event_id,
                    "game_date": game_date,
                    "home_team": home_team,
                    "away_team": away_team,
                    "commence_time": commence,
                    "player_name": player,
                    "market": market_key,
                    "line": float(line),
                    "over_price": over_price,
                    "under_price": under_price,
                    "bookmaker": bm_key,
                    "snapshot_time": event_odds.get("timestamp", ""),
                })

    return props


def upsert_to_supabase(all_props):
    if not all_props:
        return
    rows = [{
        "event_id": p["event_id"],
        "game_date": p["game_date"],
        "league": p["league"],
        "home_team": p["home_team"],
        "away_team": p["away_team"],
        "player_name": p["player_name"],
        "market": p["market"],
        "line": p["line"],
        "over_price": p["over_price"],
        "under_price": p["under_price"],
        "bookmaker": p["bookmaker"],
        "snapshot_time": p["snapshot_time"],
    } for p in all_props]

    CHUNK = 500
    for i in range(0, len(rows), CHUNK):
        try:
            sb.table("back_in_play_historical_props").upsert(
                rows[i:i + CHUNK],
                on_conflict="event_id,player_name,market,bookmaker"
            ).execute()
        except Exception as e:
            if i == 0:
                print(f"  Warning: Supabase upsert failed: {e}")
            break


def generate_dates(start, end):
    current = datetime.strptime(start, "%Y-%m-%d")
    end_dt = datetime.strptime(end, "%Y-%m-%d")
    dates = []
    while current <= end_dt:
        dates.append(current.strftime("%Y-%m-%d"))
        current += timedelta(days=1)
    return dates


def scrape_league(league_slug):
    cfg = LEAGUES[league_slug]
    sport_key = cfg["sport_key"]
    markets = cfg["markets"]
    start = cfg["start"]
    end = cfg["end"]
    league_id = cfg["league_id"]

    print(f"\n{'='*60}")
    print(f"SCRAPING: {league_slug.upper()}")
    print(f"Sport: {sport_key}")
    print(f"Markets: {', '.join(markets)}")
    print(f"Date range: {start} to {end}")
    print(f"{'='*60}")

    # Build lookup of which dates/teams need scraping
    date_teams = build_team_date_lookup(league_slug, league_id, start, end)

    cp = load_checkpoint(league_slug)
    all_dates = sorted(date_teams.keys())

    # Filter to date range
    all_dates = [d for d in all_dates if start <= d <= end]

    # Skip already-processed dates
    if cp["last_date"]:
        all_dates = [d for d in all_dates if d > cp["last_date"]]
        print(f"Resuming from {cp['last_date']} ({len(all_dates)} dates remaining)")

    total_props = cp["total_props"]
    total_credits = cp["total_credits"]
    total_skipped = 0

    for date_idx, date_str in enumerate(all_dates):
        needed_teams = date_teams.get(date_str, set())
        if not needed_teams:
            cp["last_date"] = date_str
            save_checkpoint(league_slug, cp)
            continue

        # Get events for this date
        try:
            events, remaining = get_historical_events(sport_key, date_str)
        except Exception as e:
            print(f"  {date_str}: Error fetching events: {e}")
            time.sleep(2)
            continue

        if not events:
            cp["last_date"] = date_str
            save_checkpoint(league_slug, cp)
            continue

        # Filter events to only those involving needed teams
        relevant_events = []
        for ev in events:
            home = ev.get("home_team", "")
            away = ev.get("away_team", "")
            # Check if either team matches (fuzzy: team name substring)
            if any(t in home or t in away or home in t or away in t for t in needed_teams):
                relevant_events.append(ev)

        total_skipped += len(events) - len(relevant_events)

        day_props = []
        credits_used = 0

        for event in relevant_events:
            event_id = event.get("id", "")
            if not event_id:
                continue

            # Skip if already scraped
            file_path = DATA_DIR / league_slug / date_str / f"{event_id}.json"
            if file_path.exists():
                continue

            try:
                odds_data, remaining = get_historical_event_odds(
                    sport_key, event_id, date_str, markets, league=league
                )
                credits_used += len(markets) * 10
            except Exception as e:
                print(f"  {date_str}/{event_id}: Error: {e}")
                time.sleep(1)
                continue

            if not odds_data:
                continue

            props = parse_props_from_event(odds_data, date_str, league_slug)
            if props:
                file_path.parent.mkdir(parents=True, exist_ok=True)
                file_path.write_text(json.dumps(props, indent=2))
                day_props.extend(props)

            time.sleep(0.3)

        # Backup to Supabase
        if day_props:
            upsert_to_supabase(day_props)

        total_props += len(day_props)
        total_credits += credits_used

        pct = (date_idx + 1) / len(all_dates) * 100 if all_dates else 0
        if day_props or date_idx % 20 == 0:
            print(f"  {date_str}: {len(relevant_events)}/{len(events)} events, "
                  f"{len(day_props)} props [{pct:.1f}% | {total_credits:,} cr | "
                  f"{remaining:,} left | {total_skipped} skipped]")

        cp["last_date"] = date_str
        cp["total_props"] = total_props
        cp["total_credits"] = total_credits
        save_checkpoint(league_slug, cp)

        # Safety net: stop at 5M floor
        if isinstance(remaining, int) and remaining <= 5_000_000:
            print(f"\n  SAFETY STOP: Credits ({remaining:,}) at or below 5M floor. Stopping.")
            return False

    print(f"\n{league_slug.upper()} done! Props: {total_props:,}, Credits: {total_credits:,}")
    return True


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--league", default=None, help="Single league to scrape (default: all)")
    args = parser.parse_args()

    print("=" * 60)
    print("HISTORICAL PLAYER PROPS SCRAPER (Multi-League)")
    print("=" * 60)

    # Check quota
    resp = requests.head(f"{BASE_URL}/sports/?apiKey={ODDS_API_KEY}")
    remaining = int(resp.headers.get("x-requests-remaining", 0))
    print(f"API credits remaining: {remaining:,}")
    if remaining <= 5_000_000:
        print(f"SAFETY STOP: Credits at or below 5M floor. Exiting.")
        sys.exit(1)
    print()

    if args.league:
        if args.league not in LEAGUES:
            print(f"Unknown league: {args.league}. Options: {list(LEAGUES.keys())}")
            sys.exit(1)
        scrape_league(args.league)
    else:
        # Scrape in order: NBA first (most valuable for backtest), then others
        for league in ["nba", "nfl", "nhl", "mlb", "premier-league"]:
            ok = scrape_league(league)
            if not ok:
                print("Stopping due to low credits.")
                break

    print("\nAll done!")


if __name__ == "__main__":
    main()
