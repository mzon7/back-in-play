#!/usr/bin/env python3
"""
Bulk-populate ESPN IDs for all players in back_in_play_players.
Uses ESPN's public search API to match players by name + league.

Usage:
  python3 populate_espn_ids.py                    # all leagues
  python3 populate_espn_ids.py --league nba       # single league
  python3 populate_espn_ids.py --dry-run          # preview without updating
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# ─── Env & Supabase ──────────────────────────────────────────────────────────

def load_env():
    for envfile in ["/root/.daemon-env", ".env", "../.env"]:
        p = Path(envfile)
        if p.exists():
            for line in p.read_text().splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, val = line.partition("=")
                    os.environ.setdefault(key.strip(), val.strip().strip("'\""))

load_env()

SB_URL = os.environ.get("SUPABASE_URL", "")
SB_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
if not SB_URL or not SB_KEY:
    print("ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
    sys.exit(1)

USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

# ESPN league slug → ESPN sport/league for search matching
LEAGUE_TO_ESPN = {
    "nba": ("basketball", "nba"),
    "nfl": ("football", "nfl"),
    "nhl": ("hockey", "nhl"),
    "mlb": ("baseball", "mlb"),
    "premier-league": ("soccer", "eng.1"),
}

# ─── Supabase helpers ─────────────────────────────────────────────────────────

def sb_get(table, params=""):
    url = SB_URL + "/rest/v1/" + table + "?" + params
    hdrs = {"apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY}
    try:
        req = urllib.request.Request(url, headers=hdrs)
        resp = urllib.request.urlopen(req, timeout=30)
        return json.loads(resp.read().decode())
    except Exception as e:
        print(f"  [SB GET ERR] {table}: {e}", flush=True)
        return []

def sb_patch(table, filters, body):
    url = SB_URL + "/rest/v1/" + table + "?" + filters
    data = json.dumps(body).encode()
    hdrs = {
        "apikey": SB_KEY,
        "Authorization": "Bearer " + SB_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    try:
        req = urllib.request.Request(url, data=data, headers=hdrs, method="PATCH")
        urllib.request.urlopen(req, timeout=30).read()
    except Exception as e:
        print(f"  [PATCH ERR] {table}: {e}", flush=True)

# ─── ESPN search ──────────────────────────────────────────────────────────────

def _name_match(search_name, result_name):
    """Check if ESPN result name matches our player name."""
    s = search_name.lower().strip()
    r = result_name.lower().strip()
    if s == r:
        return True
    s_parts = s.split()
    r_parts = r.split()
    if len(s_parts) >= 2 and len(r_parts) >= 2:
        # First + last name match (handles middle names, suffixes)
        if s_parts[0] == r_parts[0] and s_parts[-1] == r_parts[-1]:
            return True
        # Handle Jr., III, etc. at end
        suffixes = {"jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"}
        s_clean = [p for p in s_parts if p.lower() not in suffixes]
        r_clean = [p for p in r_parts if p.lower() not in suffixes]
        if len(s_clean) >= 2 and len(r_clean) >= 2:
            if s_clean[0] == r_clean[0] and s_clean[-1] == r_clean[-1]:
                return True
    return False


def search_espn_id(player_name, league_slug):
    """Search ESPN for a player and return their ESPN ID."""
    espn_sport, espn_league = LEAGUE_TO_ESPN.get(league_slug, (None, None))
    if not espn_sport:
        return None

    encoded = urllib.parse.quote(player_name)
    url = f"https://site.api.espn.com/apis/common/v3/search?query={encoded}&limit=10&type=player"

    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        resp = urllib.request.urlopen(req, timeout=15)
        data = json.loads(resp.read().decode())
    except Exception as e:
        print(f"    Search error: {e}", flush=True)
        return None

    items = data.get("items", [])
    for item in items:
        item_sport = item.get("sport", "")
        item_league = item.get("league", "")
        item_name = item.get("displayName", "")
        item_id = item.get("id")

        # Match sport + league
        if item_sport != espn_sport:
            continue
        # For EPL, ESPN uses "eng.1" internally but search returns various league values
        if league_slug == "premier-league" and item_sport != "soccer":
            continue
        if league_slug != "premier-league" and item_league != espn_league:
            continue

        # Match name
        if _name_match(player_name, item_name):
            return str(item_id)

    return None


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Bulk-populate ESPN IDs for players")
    parser.add_argument("--league", type=str, help="Process single league slug")
    parser.add_argument("--dry-run", action="store_true", help="Preview without updating DB")
    parser.add_argument("--limit", type=int, default=0, help="Max players to process (0=all)")
    args = parser.parse_args()

    # Get league IDs
    leagues = sb_get("back_in_play_leagues", "select=league_id,slug")
    league_map = {l["slug"]: l["league_id"] for l in (leagues or [])}

    if args.league and args.league not in league_map:
        print(f"Unknown league: {args.league}. Available: {list(league_map.keys())}")
        sys.exit(1)

    leagues_to_process = [args.league] if args.league else list(LEAGUE_TO_ESPN.keys())

    total_found = 0
    total_missing = 0
    total_processed = 0

    for league_slug in leagues_to_process:
        league_id = league_map.get(league_slug)
        if not league_id:
            print(f"Skipping {league_slug} — not in DB")
            continue

        # Get players without espn_id
        params = f"select=player_id,player_name,espn_id&league_id=eq.{league_id}&espn_id=is.null"
        params += "&order=player_name.asc"
        if args.limit:
            params += f"&limit={args.limit}"
        else:
            params += "&limit=10000"

        players = sb_get("back_in_play_players", params)
        if not players:
            print(f"\n{league_slug.upper()}: All players already have espn_id")
            continue

        # Also count how many already have it
        existing = sb_get("back_in_play_players",
                          f"select=player_id&league_id=eq.{league_id}&espn_id=not.is.null&limit=1")
        # Use header for count
        print(f"\n{'=' * 50}")
        print(f"{league_slug.upper()}: {len(players)} players need ESPN ID")
        print(f"{'=' * 50}")

        found = 0
        for i, p in enumerate(players):
            name = p.get("player_name", "")
            if not name:
                continue

            espn_id = search_espn_id(name, league_slug)
            total_processed += 1

            if espn_id:
                found += 1
                total_found += 1
                if not args.dry_run:
                    sb_patch("back_in_play_players",
                             f"player_id=eq.{p['player_id']}",
                             {"espn_id": espn_id})
                action = "→" if not args.dry_run else "(dry)"
                print(f"  [{i + 1}/{len(players)}] {name} {action} {espn_id}", flush=True)
            else:
                total_missing += 1
                if (i + 1) % 100 == 0:
                    print(f"  [{i + 1}/{len(players)}] Progress: {found} found so far", flush=True)

            # Small delay to be respectful (ESPN API is fast, but don't hammer it)
            if (i + 1) % 20 == 0:
                time.sleep(0.5)

        print(f"\n  {league_slug.upper()} done: {found}/{len(players)} IDs found")

    print(f"\n{'=' * 50}")
    print(f"TOTAL: {total_found} found, {total_missing} not found, {total_processed} processed")
    if args.dry_run:
        print("(Dry run — no DB updates)")
    print(f"{'=' * 50}")


if __name__ == "__main__":
    main()
