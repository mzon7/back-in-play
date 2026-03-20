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
        # No league match — don't guess, skip this player
        return None
    return None


def fetch_events(sport_key: str) -> list:
    """Get upcoming events for a sport."""
    url = f"https://api.the-odds-api.com/v4/sports/{sport_key}/events"
    r = requests.get(url, params={"apiKey": ODDS_API_KEY}, timeout=15)
    if r.status_code != 200:
        print(f"  Events API error {r.status_code} for {sport_key}")
        return []
    return r.json()


def fetch_props(sport_key: str, event_id: str, markets: list[str], regions: str = "us") -> dict | None:
    """Get player prop odds for an event."""
    url = f"https://api.the-odds-api.com/v4/sports/{sport_key}/events/{event_id}/odds"
    params = {
        "apiKey": ODDS_API_KEY,
        "regions": regions,
        "markets": ",".join(markets),
        "oddsFormat": "american",
    }
    r = requests.get(url, params=params, timeout=15)
    if r.status_code != 200:
        return None
    return r.json()


def extract_props_from_odds(odds_data: dict, event_id: str, game_date: str, league_slug: str, commence_time: str | None = None, home_team: str | None = None, away_team: str | None = None) -> list[dict]:
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
            # Deterministic ID so upserts don't create duplicates
            row_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{event_id}:{player_name}:{market_key}:{source}"))
            rows.append({
                "id": row_id,
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
                "commence_time": commence_time,
                "home_team": home_team,
                "away_team": away_team,
            })

    return rows


def main():
    from datetime import timedelta
    from zoneinfo import ZoneInfo
    # Use Toronto/ET so "today" matches the local sports calendar
    et = ZoneInfo("America/Toronto")
    now_et = datetime.now(et)
    now = datetime.now(timezone.utc)
    today = now_et.strftime("%Y-%m-%d")
    tomorrow = (now_et + timedelta(days=1)).strftime("%Y-%m-%d")
    # Also include yesterday to catch games that started late and haven't been removed from the API
    yesterday = (now_et - timedelta(days=1)).strftime("%Y-%m-%d")
    target_dates = {yesterday, today, tomorrow}
    total_props = 0
    total_events = 0

    print(f"[{now.isoformat()}] Fetching props for {yesterday} + {today} + {tomorrow} (ET: {now_et.strftime('%Y-%m-%d %H:%M')})")

    for sport_key, league_slug in SPORT_MAP.items():
        events = fetch_events(sport_key)
        # Fetch events for today AND tomorrow
        target_events = [e for e in events if e.get("commence_time", "")[:10] in target_dates]

        if not target_events:
            print(f"  {league_slug}: no events today/tomorrow")
            continue

        print(f"  {league_slug}: {len(target_events)} events (today+tomorrow)")

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

        # Use UK region for EPL to get broader bookmaker coverage
        regions = "uk" if league_slug == "premier-league" else "us"

        for event in target_events:
            eid = event["id"]
            # Convert commence_time to ET date so 9pm ET March 18 = March 18, not March 19
            ct_str = event.get("commence_time", "")
            if ct_str:
                ct_utc = datetime.fromisoformat(ct_str.replace("Z", "+00:00"))
                game_date = ct_utc.astimezone(et).strftime("%Y-%m-%d")
            else:
                game_date = today
            odds = fetch_props(sport_key, eid, sport_markets, regions=regions)
            if not odds:
                continue

            rows = extract_props_from_odds(odds, eid, game_date, league_slug, commence_time=ct_str or None, home_team=event.get("home_team"), away_team=event.get("away_team"))
            if rows:
                # Upsert to preserve historical props while updating current ones
                for i in range(0, len(rows), 100):
                    batch = rows[i:i+100]
                    supabase.table("back_in_play_player_props").upsert(
                        batch,
                        on_conflict="event_id,player_name,market,source"
                    ).execute()

                total_props += len(rows)
                total_events += 1
                print(f"    {event.get('home_team', '?')} vs {event.get('away_team', '?')} ({game_date}): {len(rows)} props")

    print(f"Done: {total_props} props across {total_events} events")

    # Backfill missing commence_time/home_team/away_team from events data
    # Build event_id → metadata map from all fetched events
    print("\nBackfilling missing game times...")
    event_meta = {}
    for sport_key, league_slug in SPORT_MAP.items():
        events = fetch_events(sport_key)
        for e in events:
            eid = e.get("id", "")
            ct = e.get("commence_time", "")
            if eid and ct:
                event_meta[eid] = {
                    "commence_time": ct,
                    "home_team": e.get("home_team"),
                    "away_team": e.get("away_team"),
                }

    if event_meta:
        # Find props with null commence_time for today/tomorrow
        null_ct = supabase.table("back_in_play_player_props").select(
            "id, event_id"
        ).in_("game_date", [today, tomorrow]).is_("commence_time", "null").limit(2000).execute()

        updated = 0
        for row in null_ct.data or []:
            meta = event_meta.get(row["event_id"])
            if meta:
                supabase.table("back_in_play_player_props").update({
                    "commence_time": meta["commence_time"],
                    "home_team": meta["home_team"],
                    "away_team": meta["away_team"],
                }).eq("id", row["id"]).execute()
                updated += 1
        print(f"  Backfilled {updated} props with game times")
    else:
        print("  No event metadata available for backfill")

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
