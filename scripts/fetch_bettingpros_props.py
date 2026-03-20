#!/usr/bin/env python3
"""
Fetch player props from BettingPros API (consensus lines across multiple books).
Upserts into back_in_play_player_props with source='consensus'.
Designed to run every 15 minutes via cron alongside or instead of fetch_player_props.py.
"""
import os
import sys
import uuid
import time
import requests
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo

from supabase import create_client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not all([SUPABASE_URL, SUPABASE_KEY]):
    print("Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY")
    sys.exit(1)

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

BASE_URL = "https://api.bettingpros.com/v3/props"

# BettingPros sport keys → our league slugs
# BettingPros market_id → our market key (use specific IDs to avoid cross-contamination)
# NBA: 156=points, 157=rebounds, 151=assists, 162=threes, 338=PRA
# NHL: 318=goals, 321=shots
SPORT_MARKETS = {
    "nba": [
        {"bp_market": "points", "bp_market_id": 156, "our_market": "player_points"},
        {"bp_market": "rebounds", "bp_market_id": 157, "our_market": "player_rebounds"},
        {"bp_market": "assists", "bp_market_id": 151, "our_market": "player_assists"},
        {"bp_market": "threes", "bp_market_id": 162, "our_market": "player_threes"},
        {"bp_market": "points-assists-rebounds", "bp_market_id": 338, "our_market": "player_points_rebounds_assists"},
    ],
    "nhl": [
        {"bp_market": "goals", "bp_market_id": 318, "our_market": "player_goals"},
        {"bp_market": "shots", "bp_market_id": 321, "our_market": "player_shots_on_goal"},
    ],
}

# League slug mapping
LEAGUE_SLUGS = {
    "nba": "nba",
    "nhl": "nhl",
}

# Pre-loaded player name → player_id cache (avoids per-player Supabase queries)
_player_cache: dict[str, str | None] = {}


def load_player_cache():
    """Pre-load all players from DB into memory for fast name lookups."""
    global _player_cache
    print("Loading player cache...")
    offset = 0
    limit = 1000
    while True:
        r = supabase.table("back_in_play_players").select(
            "player_id, player_name, league:back_in_play_leagues!back_in_play_players_league_id_fkey(slug)"
        ).range(offset, offset + limit - 1).execute()
        if not r.data:
            break
        for p in r.data:
            name = p.get("player_name", "")
            slug = (p.get("league") or {}).get("slug", "")
            if name:
                # Store as lowercase for case-insensitive matching
                key = f"{name.lower()}|{slug}"
                _player_cache[key] = p["player_id"]
                # Also store without league for single-match fallback
                name_key = name.lower()
                if name_key not in _player_cache:
                    _player_cache[name_key] = p["player_id"]
                else:
                    # Multiple players with same name — mark as ambiguous
                    _player_cache[name_key] = "__ambiguous__"
        if len(r.data) < limit:
            break
        offset += limit
        time.sleep(0.2)
    print(f"  Cached {len(_player_cache)} player entries")


def resolve_player_id(player_name: str, league_slug: str) -> str | None:
    """Look up player_id from pre-loaded cache."""
    # Try exact name + league first
    key = f"{player_name.lower()}|{league_slug}"
    pid = _player_cache.get(key)
    if pid:
        return pid
    # Try name-only (if unambiguous)
    name_key = player_name.lower()
    pid = _player_cache.get(name_key)
    if pid and pid != "__ambiguous__":
        return pid
    return None


def fetch_props_page(sport: str, market: str, date: str, page: int = 1, limit: int = 50) -> dict | None:
    """Fetch a page of props from BettingPros."""
    params = {
        "sport": sport,
        "market": market,
        "date": date,
        "page": page,
        "limit": limit,
        "include_events": "true",
    }
    try:
        r = requests.get(BASE_URL, params=params, timeout=20)
        if r.status_code != 200:
            print(f"  BettingPros API error {r.status_code} for {sport}/{market} page {page}")
            return None
        return r.json()
    except Exception as e:
        print(f"  Request error: {e}")
        return None


def fetch_all_props(sport: str, market: str, date: str) -> list[dict]:
    """Fetch all pages of props for a sport/market/date."""
    all_props = []
    page = 1
    while True:
        data = fetch_props_page(sport, market, date, page=page)
        if not data:
            break
        props = data.get("props", [])
        if not props:
            break
        all_props.extend(props)
        pagination = data.get("_pagination", {})
        total_pages = pagination.get("total_pages", 1)
        if page >= total_pages:
            break
        page += 1
        time.sleep(0.3)  # Be polite
    return all_props


def extract_rows(props: list[dict], our_market: str, target_market_id: int, league_slug: str, game_date: str) -> list[dict]:
    """Convert BettingPros props to our DB rows."""
    rows = []
    seen_keys: set[str] = set()  # Deduplicate by conflict key
    snapshot = datetime.now(timezone.utc).isoformat()

    for prop in props:
        # Only include props matching our target market_id
        if prop.get("market_id") != target_market_id:
            continue

        participant = prop.get("participant", {})
        player_name = participant.get("name", "")
        if not player_name:
            continue

        # Deduplicate by conflict key (event_id, player_name, market, source)
        dedup_key = f"{player_name}|{our_market}"
        if dedup_key in seen_keys:
            continue
        seen_keys.add(dedup_key)

        over = prop.get("over", {})
        under = prop.get("under", {})

        consensus_line = over.get("consensus_line") or under.get("consensus_line")
        if consensus_line is None:
            # Fall back to best book line
            consensus_line = over.get("line") or under.get("line")
        if consensus_line is None:
            continue

        over_odds = over.get("consensus_odds") or over.get("odds")
        under_odds = under.get("consensus_odds") or under.get("odds")

        player_id = resolve_player_id(player_name, league_slug)

        # Build a deterministic ID
        row_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"bp:{player_name}:{our_market}:{game_date}:consensus"))

        rows.append({
            "id": row_id,
            "player_id": player_id,
            "player_name": player_name,
            "market": our_market,
            "line": consensus_line,
            "over_price": str(over_odds) if over_odds is not None else None,
            "under_price": str(under_odds) if under_odds is not None else None,
            "source": "consensus",
            "event_id": f"bp_{prop.get('event_id', '')}",
            "game_date": game_date,
            "snapshot_time": snapshot,
            "commence_time": None,  # Will be enriched below
            "home_team": None,
            "away_team": None,
        })

    return rows


def enrich_game_times(rows: list[dict], game_date: str):
    """Cross-reference with existing props to fill commence_time and teams."""
    if not rows:
        return
    # Get all existing props for this date that have commence_time
    existing = supabase.table("back_in_play_player_props").select(
        "player_name, commence_time, home_team, away_team"
    ).eq("game_date", game_date).not_.is_("commence_time", "null").limit(2000).execute()

    # Build player_name → {commence_time, home_team, away_team}
    time_map: dict[str, dict] = {}
    for e in existing.data or []:
        pn = e.get("player_name", "")
        if pn and e.get("commence_time"):
            time_map[pn] = {
                "commence_time": e["commence_time"],
                "home_team": e.get("home_team"),
                "away_team": e.get("away_team"),
            }

    enriched = 0
    for row in rows:
        meta = time_map.get(row["player_name"])
        if meta:
            row["commence_time"] = meta["commence_time"]
            row["home_team"] = meta["home_team"]
            row["away_team"] = meta["away_team"]
            enriched += 1
    if enriched:
        print(f"    Enriched {enriched}/{len(rows)} with game times from existing props")


def main():
    et = ZoneInfo("America/Toronto")
    now_et = datetime.now(et)
    now = datetime.now(timezone.utc)
    today = now_et.strftime("%Y-%m-%d")
    tomorrow = (now_et + timedelta(days=1)).strftime("%Y-%m-%d")

    print(f"[{now.isoformat()}] BettingPros: Fetching consensus props for {today} + {tomorrow}")

    load_player_cache()
    total_props = 0

    for sport, market_defs in SPORT_MARKETS.items():
        league_slug = LEAGUE_SLUGS[sport]

        for mdef in market_defs:
            bp_market = mdef["bp_market"]
            bp_market_id = mdef["bp_market_id"]
            our_market = mdef["our_market"]

            for target_date in [today, tomorrow]:
                label = "today" if target_date == today else "tomorrow"
                props = fetch_all_props(sport, bp_market, target_date)

                if not props:
                    continue

                rows = extract_rows(props, our_market, bp_market_id, league_slug, target_date)
                if not rows:
                    continue

                # Enrich with game times from existing Odds API props
                enrich_game_times(rows, target_date)

                # Upsert in batches with retry
                for i in range(0, len(rows), 100):
                    batch = rows[i:i + 100]
                    for attempt in range(3):
                        try:
                            supabase.table("back_in_play_player_props").upsert(
                                batch,
                                on_conflict="event_id,player_name,market,source"
                            ).execute()
                            break
                        except Exception as e:
                            if attempt < 2:
                                print(f"    Retry {attempt+1} after error: {e}")
                                time.sleep(2)
                            else:
                                print(f"    Failed batch after 3 attempts: {e}")
                    time.sleep(0.2)

                total_props += len(rows)
                print(f"  {sport}/{bp_market} ({label}): {len(rows)} consensus props")

    print(f"\nDone: {total_props} consensus props total")


if __name__ == "__main__":
    main()
