#!/usr/bin/env python3
"""
Fetch player props from The Odds API and upsert into back_in_play_player_props.
Designed to run every 15 minutes via cron.
Uses the free tier endpoints: /v4/sports/{sport}/events/{event}/odds
"""
import os
import sys
import json
import uuid
import requests
from datetime import datetime, timezone

from supabase import create_client

ODDS_API_KEY = os.environ.get("ODDS_API_KEY")
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not all([ODDS_API_KEY, SUPABASE_URL, SUPABASE_KEY]):
    print("Missing env vars: ODDS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY")
    sys.exit(1)

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# Odds API sport keys → our league slugs
SPORT_MAP = {
    "basketball_nba": "nba",
    "americanfootball_nfl": "nfl",
    "baseball_mlb": "mlb",
    "icehockey_nhl": "nhl",
    "soccer_epl": "premier-league",
}

# Player prop markets to fetch
PROP_MARKETS = [
    "player_points", "player_rebounds", "player_assists",
    "player_threes", "player_points_rebounds_assists",
    "player_pass_yds", "player_rush_yds", "player_reception_yds", "player_receptions",
    "player_goals", "player_shots_on_goal",
    "player_shots", "player_shots_on_target",
    "batter_hits", "batter_total_bases", "batter_rbis",
]

# Preferred bookmakers (in order)
BOOKMAKERS = ["fanduel", "draftkings", "betmgm", "pointsbet", "bovada"]

def resolve_player_id(player_name: str, league_slug: str) -> str | None:
    """Try to find our player_id by name match."""
    # Simple name match — could be improved with fuzzy matching
    r = supabase.table("back_in_play_players").select("player_id").ilike(
        "player_name", player_name
    ).execute()
    if r.data and len(r.data) == 1:
        return r.data[0]["player_id"]
    # Multiple matches — try with league filter
    if r.data and len(r.data) > 1:
        r2 = supabase.table("back_in_play_players").select(
            "player_id, league:back_in_play_leagues!back_in_play_players_league_id_fkey(slug)"
        ).ilike("player_name", player_name).execute()
        for p in r2.data:
            if p.get("league", {}).get("slug") == league_slug:
                return p["player_id"]
        # Fall back to first match
        return r.data[0]["player_id"]
    return None


def fetch_events(sport_key: str) -> list:
    """Get upcoming events for a sport."""
    url = f"https://api.the-odds-api.com/v4/sports/{sport_key}/events"
    r = requests.get(url, params={"apiKey": ODDS_API_KEY}, timeout=15)
    if r.status_code != 200:
        print(f"  Events API error {r.status_code} for {sport_key}")
        return []
    return r.json()


def fetch_props(sport_key: str, event_id: str, markets: list[str]) -> dict | None:
    """Get player prop odds for an event."""
    url = f"https://api.the-odds-api.com/v4/sports/{sport_key}/events/{event_id}/odds"
    params = {
        "apiKey": ODDS_API_KEY,
        "regions": "us",
        "markets": ",".join(markets),
        "oddsFormat": "american",
    }
    r = requests.get(url, params=params, timeout=15)
    if r.status_code != 200:
        return None
    return r.json()


def extract_props_from_odds(odds_data: dict, event_id: str, game_date: str, league_slug: str) -> list[dict]:
    """Extract player prop rows from Odds API response."""
    rows = []
    snapshot = datetime.now(timezone.utc).isoformat()

    # Find best bookmaker that has data
    bookmakers = odds_data.get("bookmakers", [])
    bk_by_key = {b["key"]: b for b in bookmakers}

    best_bk = None
    for pref in BOOKMAKERS:
        if pref in bk_by_key:
            best_bk = bk_by_key[pref]
            break
    if not best_bk and bookmakers:
        best_bk = bookmakers[0]
    if not best_bk:
        return rows

    source = best_bk["key"]

    for market_obj in best_bk.get("markets", []):
        market_key = market_obj.get("key", "")
        outcomes = market_obj.get("outcomes", [])

        # Group outcomes by player name (over/under pairs)
        by_player: dict[str, dict] = {}
        for o in outcomes:
            name = o.get("description", "")
            if not name:
                continue
            if name not in by_player:
                by_player[name] = {"line": None, "over": None, "under": None}
            point = o.get("point")
            price = o.get("price")
            label = o.get("name", "").lower()
            if point is not None:
                by_player[name]["line"] = point
            if label == "over" and price is not None:
                by_player[name]["over"] = str(price)
            elif label == "under" and price is not None:
                by_player[name]["under"] = str(price)

        for player_name, data in by_player.items():
            if data["line"] is None:
                continue
            player_id = resolve_player_id(player_name, league_slug)
            rows.append({
                "id": str(uuid.uuid4()),
                "player_id": player_id,
                "player_name": player_name,
                "market": market_key,
                "line": data["line"],
                "over_price": data["over"],
                "under_price": data["under"],
                "source": source,
                "event_id": event_id,
                "game_date": game_date,
                "snapshot_time": snapshot,
            })

    return rows


def main():
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    total_props = 0
    total_events = 0

    print(f"[{datetime.now(timezone.utc).isoformat()}] Fetching props for {today}")

    for sport_key, league_slug in SPORT_MAP.items():
        events = fetch_events(sport_key)
        today_events = [e for e in events if e.get("commence_time", "")[:10] == today]

        if not today_events:
            print(f"  {league_slug}: no events today")
            continue

        print(f"  {league_slug}: {len(today_events)} events today")

        # Determine which markets to fetch for this sport
        sport_markets = []
        if league_slug == "nba":
            sport_markets = ["player_points", "player_rebounds", "player_assists", "player_threes", "player_points_rebounds_assists"]
        elif league_slug == "nfl":
            sport_markets = ["player_pass_yds", "player_rush_yds", "player_reception_yds", "player_receptions"]
        elif league_slug == "mlb":
            sport_markets = ["batter_hits", "batter_total_bases", "batter_rbis"]
        elif league_slug == "nhl":
            sport_markets = ["player_goals", "player_shots_on_goal"]
        elif league_slug == "premier-league":
            sport_markets = ["player_shots", "player_shots_on_target", "player_goals"]

        for event in today_events:
            eid = event["id"]
            game_date = event.get("commence_time", "")[:10]
            odds = fetch_props(sport_key, eid, sport_markets)
            if not odds:
                continue

            rows = extract_props_from_odds(odds, eid, game_date, league_slug)
            if rows:
                # Delete old props for this event + today to avoid duplicates
                supabase.table("back_in_play_player_props").delete().eq(
                    "event_id", eid
                ).eq("game_date", today).execute()

                # Insert in batches
                for i in range(0, len(rows), 100):
                    batch = rows[i:i+100]
                    supabase.table("back_in_play_player_props").insert(batch).execute()

                total_props += len(rows)
                total_events += 1
                print(f"    {event.get('home_team', '?')} vs {event.get('away_team', '?')}: {len(rows)} props")

    print(f"Done: {total_props} props across {total_events} events")

    # Report API usage
    try:
        usage = requests.get(
            "https://api.the-odds-api.com/v4/sports",
            params={"apiKey": ODDS_API_KEY},
            timeout=10
        )
        remaining = usage.headers.get("x-requests-remaining", "?")
        used = usage.headers.get("x-requests-used", "?")
        print(f"API usage: {used} used, {remaining} remaining")
    except Exception:
        pass


if __name__ == "__main__":
    main()
