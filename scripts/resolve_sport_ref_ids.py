#!/usr/bin/env python3
"""
Resolve sport_ref_id for players by searching *-Reference sites.
Designed to run from a LOCAL machine to avoid rate-limiting on the server.

For each league, searches the corresponding reference site:
  NBA: basketball-reference.com
  NFL: pro-football-reference.com
  NHL: hockey-reference.com
  MLB: baseball-reference.com
  EPL: fbref.com

Usage:
  python3 resolve_sport_ref_ids.py --league nba
  python3 resolve_sport_ref_ids.py --league nhl
  python3 resolve_sport_ref_ids.py --league nfl --limit 50
  python3 resolve_sport_ref_ids.py --league mlb --dry-run
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

# ─── Env ─────────────────────────────────────────────────────────────────────

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

# ─── League config ───────────────────────────────────────────────────────────

SEARCH_URLS = {
    "nba": "https://www.basketball-reference.com/search/search.fcgi?search={}",
    "nfl": "https://www.pro-football-reference.com/search/search.fcgi?search={}",
    "nhl": "https://www.hockey-reference.com/search/search.fcgi?search={}",
    "mlb": "https://www.baseball-reference.com/search/search.fcgi?search={}",
    "premier-league": "https://fbref.com/search/search.fcgi?search={}",
}

# Regex to extract sport_ref_id from player page URLs
PLAYER_URL_PATTERNS = {
    "nba": re.compile(r"/players/[a-z]/([a-z]+\d+)\.html"),
    "nfl": re.compile(r"/players/[A-Z]/([A-Za-z]+\d+)\.htm"),
    "nhl": re.compile(r"/players/[a-z]/([a-z]+\d+)\.html"),
    "mlb": re.compile(r"/players/[a-z]/([a-z]+\d+)\.shtml"),
    "premier-league": re.compile(r"/en/players/([a-f0-9]+)/"),
}

RATE_LIMIT_SECS = float(os.environ.get("RATE_LIMIT", "3.0"))

# ─── Supabase REST helpers ───────────────────────────────────────────────────

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

# ─── HTML fetcher ────────────────────────────────────────────────────────────

def fetch_html(url):
    """Fetch a URL, following redirects, and return the final URL + HTML body."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        resp = urllib.request.urlopen(req, timeout=20)
        final_url = resp.geturl()
        html = resp.read().decode("utf-8", errors="replace")
        return final_url, html
    except urllib.error.HTTPError as e:
        if e.code == 429:
            print("    Rate limited! Waiting 30s...", flush=True)
            time.sleep(30)
            return None, None
        print(f"    HTTP {e.code}: {e.reason}", flush=True)
        return None, None
    except Exception as e:
        print(f"    Fetch error: {e}", flush=True)
        return None, None

# ─── Name matching ───────────────────────────────────────────────────────────

def _name_match(search_name, result_name):
    """Fuzzy name match: first + last name match (ignoring suffixes)."""
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
        s_clean = [p for p in s_parts if p not in suffixes]
        r_clean = [p for p in r_parts if p not in suffixes]
        if len(s_clean) >= 2 and len(r_clean) >= 2:
            if s_clean[0] == r_clean[0] and s_clean[-1] == r_clean[-1]:
                return True
    return False

# ─── Resolve sport_ref_id ───────────────────────────────────────────────────

def resolve_sport_ref_id(player_name, league):
    """Search the *-Reference site for a player and extract their ID."""
    search_url_tpl = SEARCH_URLS.get(league)
    pattern = PLAYER_URL_PATTERNS.get(league)
    if not search_url_tpl or not pattern:
        return None

    encoded = urllib.parse.quote(player_name)
    search_url = search_url_tpl.format(encoded)

    final_url, html = fetch_html(search_url)
    if not html:
        return None

    # Case 1: Exact match redirected directly to the player page
    m = pattern.search(final_url)
    if m:
        return m.group(1)

    # Case 2: Parse the HTML for player links matching name
    link_pattern = re.compile(r'<a\s+href="([^"]*)"[^>]*>([^<]*)</a>', re.IGNORECASE)
    candidates = []
    for match in link_pattern.finditer(html):
        href = match.group(1)
        link_text = match.group(2).strip()
        m = pattern.search(href)
        if m:
            candidates.append((m.group(1), link_text, href))

    if not candidates:
        return None

    # Try exact name match first
    for ref_id, link_text, href in candidates:
        if _name_match(player_name, link_text):
            return ref_id

    # Fall back to last-name match (avoid returning unrelated popular players)
    last_name = player_name.split()[-1].lower() if player_name.split() else ""
    if last_name and len(last_name) > 2:
        for ref_id, link_text, href in candidates:
            if last_name in link_text.lower():
                return ref_id

    return None

# ─── Checkpoint ──────────────────────────────────────────────────────────────

def checkpoint_path(league):
    return Path(os.path.dirname(__file__)) / f"checkpoint_sport_ref_{league}.json"

def load_checkpoint(league):
    cp = checkpoint_path(league)
    if cp.exists():
        try:
            data = json.loads(cp.read_text())
            print(f"  Loaded checkpoint: {len(data.get('resolved', {}))} resolved, {len(data.get('failed', []))} failed", flush=True)
            return data
        except Exception:
            pass
    return {"resolved": {}, "failed": []}

def save_checkpoint(league, data):
    cp = checkpoint_path(league)
    cp.write_text(json.dumps(data, indent=2))

# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Resolve sport_ref_id from *-Reference sites")
    parser.add_argument("--league", type=str, required=True,
                        choices=["nba", "nfl", "nhl", "mlb", "premier-league"],
                        help="League to process")
    parser.add_argument("--limit", type=int, default=0, help="Max players to process (0=all)")
    parser.add_argument("--dry-run", action="store_true", help="Search but don't update DB")
    parser.add_argument("--reset", action="store_true", help="Ignore checkpoint, start fresh")
    args = parser.parse_args()

    league = args.league

    # Get league_id
    leagues = sb_get("back_in_play_leagues", f"select=league_id,slug&slug=eq.{league}")
    if not leagues:
        print(f"ERROR: League '{league}' not found in DB")
        sys.exit(1)
    league_id = leagues[0]["league_id"]
    print(f"{league.upper()} league_id: {league_id}", flush=True)

    # Get all players without sport_ref_id
    print("Fetching players without sport_ref_id...", flush=True)
    players = []
    offset = 0
    while True:
        batch = sb_get("back_in_play_players",
                       f"select=player_id,player_name&league_id=eq.{league_id}&sport_ref_id=is.null&limit=1000&offset={offset}")
        if not batch:
            break
        players.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000

    print(f"  {len(players)} players need sport_ref_id", flush=True)
    if not players:
        print("All players already have sport_ref_id!")
        return

    # Load checkpoint
    cp = {"resolved": {}, "failed": []} if args.reset else load_checkpoint(league)
    already_done = set(cp["resolved"].keys()) | set(cp["failed"])

    # Filter out already-processed players
    todo = [p for p in players if p["player_id"] not in already_done]
    print(f"  {len(todo)} remaining after checkpoint ({len(already_done)} already processed)", flush=True)

    if args.limit > 0:
        todo = todo[:args.limit]
        print(f"  Limited to {len(todo)} players", flush=True)

    if not todo:
        print("Nothing to do!")
        return

    # Process
    found = 0
    not_found = 0

    print(f"\n{'=' * 60}")
    print(f"Resolving sport_ref_id for {len(todo)} {league.upper()} players")
    print(f"Rate limit: {RATE_LIMIT_SECS}s between requests")
    print(f"{'=' * 60}\n")

    for i, p in enumerate(todo):
        player_id = p["player_id"]
        name = p.get("player_name", "").strip()
        if not name:
            continue

        # Strip position prefixes common in some DB entries
        clean_name = name
        for prefix in ("F ", "C ", "D ", "G ", "LW ", "RW "):
            if name.startswith(prefix) and len(name) > len(prefix) + 2:
                clean_name = name[len(prefix):]
                break

        ref_id = resolve_sport_ref_id(clean_name, league)

        if ref_id:
            found += 1
            cp["resolved"][player_id] = ref_id
            if not args.dry_run:
                sb_patch("back_in_play_players",
                         f"player_id=eq.{player_id}",
                         {"sport_ref_id": ref_id})
            tag = "->" if not args.dry_run else "(dry)"
            print(f"  [{i+1}/{len(todo)}] {clean_name} {tag} {ref_id}", flush=True)
        else:
            not_found += 1
            cp["failed"].append(player_id)
            if (i + 1) % 10 == 0:
                print(f"  [{i+1}/{len(todo)}] {clean_name} -- NOT FOUND  (running: {found} found, {not_found} failed)",
                      flush=True)

        # Save checkpoint every 10 players
        if (i + 1) % 10 == 0:
            save_checkpoint(league, cp)

        # Rate limit
        time.sleep(RATE_LIMIT_SECS)

    # Final checkpoint save
    save_checkpoint(league, cp)

    # Summary
    print(f"\n{'=' * 60}")
    print(f"DONE: {found} resolved, {not_found} not found, {len(todo)} processed")
    print(f"Total in checkpoint: {len(cp['resolved'])} resolved, {len(cp['failed'])} failed")
    print(f"Checkpoint: {checkpoint_path(league)}")
    if args.dry_run:
        print("(DRY RUN - no DB updates)")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
