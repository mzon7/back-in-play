#!/usr/bin/env python3
"""
Populate ESPN IDs for players who have injury return cases.
Only looks up players the performance curves pipeline actually needs.

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
        if s_parts[0] == r_parts[0] and s_parts[-1] == r_parts[-1]:
            return True
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

        if item_sport != espn_sport:
            continue
        if league_slug == "premier-league" and item_sport != "soccer":
            continue
        if league_slug != "premier-league" and item_league != espn_league:
            continue

        if _name_match(player_name, item_name):
            return str(item_id)

    return None


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Populate ESPN IDs for players with return cases")
    parser.add_argument("--league", type=str, help="Process single league slug")
    parser.add_argument("--dry-run", action="store_true", help="Preview without updating DB")
    args = parser.parse_args()

    # Step 1: Get all player_ids from returned injuries
    print("Finding players with injury return cases...", flush=True)
    injuries = sb_get("back_in_play_injuries",
                      "select=player_id&status=eq.returned&return_date=not.is.null&limit=10000")
    if not injuries:
        print("No return cases found.")
        return

    player_ids = list(set(i["player_id"] for i in injuries))
    print(f"  {len(player_ids)} unique players with return cases", flush=True)

    # Step 2: Get player details, filter to those missing espn_id
    print("Checking which need ESPN IDs...", flush=True)
    players_to_lookup = []
    league_map = {}

    # Get league slugs
    leagues = sb_get("back_in_play_leagues", "select=league_id,slug")
    lid_to_slug = {l["league_id"]: l["slug"] for l in (leagues or [])}

    # Fetch player details in batches
    for i in range(0, len(player_ids), 50):
        batch = player_ids[i:i + 50]
        ids_str = ",".join(batch)
        params = f"select=player_id,player_name,league_id,espn_id&player_id=in.({ids_str})"
        for p in sb_get("back_in_play_players", params) or []:
            slug = lid_to_slug.get(p.get("league_id", ""), "")
            if not slug:
                continue
            if args.league and slug != args.league:
                continue
            # Only need lookup if espn_id is missing
            if not p.get("espn_id"):
                players_to_lookup.append({
                    "player_id": p["player_id"],
                    "player_name": p.get("player_name", ""),
                    "league_slug": slug,
                })

    # Deduplicate by player_id
    seen = set()
    unique = []
    for p in players_to_lookup:
        if p["player_id"] not in seen:
            seen.add(p["player_id"])
            unique.append(p)
    players_to_lookup = unique

    if not players_to_lookup:
        print("All players with return cases already have ESPN IDs!")
        return

    # Group by league for display
    by_league = {}
    for p in players_to_lookup:
        by_league.setdefault(p["league_slug"], []).append(p)

    print(f"\n  {len(players_to_lookup)} players need ESPN ID lookup:")
    for slug, plist in sorted(by_league.items()):
        print(f"    {slug.upper()}: {len(plist)}")

    # Step 3: Look up ESPN IDs
    print(f"\n{'=' * 50}")
    print(f"Looking up {len(players_to_lookup)} ESPN IDs...")
    print(f"{'=' * 50}\n")

    found = 0
    not_found = 0

    for i, p in enumerate(players_to_lookup):
        name = p["player_name"]
        slug = p["league_slug"]
        if not name:
            continue

        espn_id = search_espn_id(name, slug)

        if espn_id:
            found += 1
            if not args.dry_run:
                sb_patch("back_in_play_players",
                         f"player_id=eq.{p['player_id']}",
                         {"espn_id": espn_id})
            action = "→" if not args.dry_run else "(dry)"
            print(f"  [{i + 1}/{len(players_to_lookup)}] [{slug}] {name} {action} {espn_id}", flush=True)
        else:
            not_found += 1
            if (i + 1) % 50 == 0 or (i + 1) == len(players_to_lookup):
                print(f"  [{i + 1}/{len(players_to_lookup)}] Progress: {found} found, {not_found} not found", flush=True)

        # Small delay every 20 requests
        if (i + 1) % 20 == 0:
            time.sleep(0.5)

    print(f"\n{'=' * 50}")
    print(f"DONE: {found} found, {not_found} not found, {len(players_to_lookup)} processed")
    if args.dry_run:
        print("(Dry run — no DB updates)")
    print(f"{'=' * 50}")


if __name__ == "__main__":
    main()
