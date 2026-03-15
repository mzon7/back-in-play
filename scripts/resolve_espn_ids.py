#!/usr/bin/env python3
"""
Resolve espn_id for all players using ESPN's Core API athlete catalog.

Strategy:
  1. Fetch ALL athlete IDs from ESPN's core API (paginated, includes active+inactive)
  2. Fetch each athlete's name from the core API detail endpoint
  3. Match against our Supabase DB using fuzzy name matching
  4. Write matches to DB

The core API has massive catalogs:
  NBA: ~835 | NFL: ~19,543 | NHL: ~11,699 | MLB: ~37,457 | EPL: ~1,341

Usage:
  python3 resolve_espn_ids.py                    # all leagues
  python3 resolve_espn_ids.py --league nba       # single league
  python3 resolve_espn_ids.py --league nfl --batch-size 5000
  python3 resolve_espn_ids.py --roster-only      # just do team rosters (fast)

Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
"""

import argparse
import json
import os
import re
import sys
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests

# ─── Env ─────────────────────────────────────────────────────────────────────

def load_env():
    for envfile in ["/root/.daemon-env", ".env", "../.env"]:
        p = Path(envfile)
        if p.exists():
            for line in p.read_text().splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    if line.startswith("export "):
                        line = line[7:]
                    key, _, val = line.partition("=")
                    os.environ.setdefault(key.strip(), val.strip().strip("'\""))

load_env()

SUPA_URL = os.environ.get("SUPABASE_URL", "")
SUPA_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
if not SUPA_URL or not SUPA_KEY:
    print("ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
    sys.exit(1)

SB_HEADERS = {"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}"}

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
})

# ─── League config ───────────────────────────────────────────────────────────

LEAGUE_CONFIG = {
    "nba": {"sport": "basketball", "espn_league": "nba"},
    "nfl": {"sport": "football", "espn_league": "nfl"},
    "nhl": {"sport": "hockey", "espn_league": "nhl"},
    "mlb": {"sport": "baseball", "espn_league": "mlb"},
    "premier-league": {"sport": "soccer", "espn_league": "eng.1"},
}

# ─── Supabase helpers ────────────────────────────────────────────────────────

def sb_get(table, params=""):
    for attempt in range(3):
        try:
            r = requests.get(f"{SUPA_URL}/rest/v1/{table}?{params}",
                             headers=SB_HEADERS, timeout=30)
            r.raise_for_status()
            return r.json()
        except requests.exceptions.HTTPError:
            if r.status_code in (502, 503, 429) and attempt < 2:
                time.sleep(5 * (attempt + 1))
                continue
            raise

def sb_patch(table, filter_str, data):
    for attempt in range(3):
        try:
            r = requests.patch(f"{SUPA_URL}/rest/v1/{table}?{filter_str}",
                               json=data,
                               headers={**SB_HEADERS, "Content-Type": "application/json",
                                        "Prefer": "return=minimal"},
                               timeout=30)
            r.raise_for_status()
            return
        except requests.exceptions.HTTPError:
            if r.status_code in (502, 503, 429) and attempt < 2:
                time.sleep(5 * (attempt + 1))
                continue
            raise

def sb_patch_batch(player_updates):
    """Batch update espn_id for multiple players."""
    for pid, eid in player_updates:
        sb_patch("back_in_play_players", f"player_id=eq.{pid}", {"espn_id": eid})

# ─── Name normalization & matching ───────────────────────────────────────────

SUFFIXES = {"jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v", "senior", "junior"}

def normalize(name):
    """Strip accents, apostrophes, hyphens, periods, suffixes. Lowercase."""
    nfkd = unicodedata.normalize("NFKD", name)
    stripped = "".join(c for c in nfkd if not unicodedata.combining(c))
    cleaned = stripped.replace("'", "").replace("\u2019", "").replace(".", "").replace("-", " ")
    parts = cleaned.lower().split()
    parts = [p for p in parts if p not in SUFFIXES]
    return " ".join(parts)

def fuzzy_score(name_a, name_b):
    """Score how well two normalized names match. 0-100."""
    if name_a == name_b:
        return 100
    a = name_a.split()
    b = name_b.split()
    if not a or not b:
        return 0

    a_first, a_last = a[0], a[-1] if len(a) >= 2 else ""
    b_first, b_last = b[0], b[-1] if len(b) >= 2 else ""

    # First + last exact
    if len(a) >= 2 and len(b) >= 2 and a_first == b_first and a_last == b_last:
        return 95
    # Last exact + first initial
    if a_last and b_last and a_last == b_last and a_first and b_first and a_first[0] == b_first[0]:
        return 80
    # Last exact + first substring
    if a_last and b_last and a_last == b_last:
        if a_first in b_first or b_first in a_first:
            return 75
        return 55
    # First exact + last substring
    if a_first == b_first and a_last and b_last:
        if a_last in b_last or b_last in a_last:
            return 70
    # Mononyms
    if len(a) == 1 and len(b) == 1 and a[0] == b[0]:
        return 90
    return 0

def build_db_lookup(players):
    """Build normalized name → list of player_ids for matching."""
    lookup = {}
    for p in players:
        name = p.get("player_name", "").strip()
        if not name:
            continue
        norm = normalize(name)
        if norm not in lookup:
            lookup[norm] = []
        lookup[norm].append(p["player_id"])
        # Also add without position prefixes
        for prefix in ("f ", "c ", "d ", "g ", "lw ", "rw ", "cb ", "gk ", "st ",
                        "lb ", "rb ", "cm ", "lm ", "rm ", "cdm ", "cam ", "cf ",
                        "ds ", "c/f ", "f/c ", "d/f ", "c/w ", "w "):
            if norm.startswith(prefix) and len(norm) > len(prefix) + 2:
                clean = norm[len(prefix):]
                if clean not in lookup:
                    lookup[clean] = []
                lookup[clean].append(p["player_id"])
                break
    return lookup

def match_espn_name(espn_name, db_lookup, already_resolved, min_score=70):
    """Match an ESPN name against DB lookup. Returns list of (player_id, score)."""
    norm = normalize(espn_name)

    # Exact match first (O(1))
    if norm in db_lookup:
        return [(pid, 100) for pid in db_lookup[norm] if pid not in already_resolved]

    # Fuzzy match (slower)
    matches = []
    for db_norm, pids in db_lookup.items():
        score = fuzzy_score(norm, db_norm)
        if score >= min_score:
            for pid in pids:
                if pid not in already_resolved:
                    matches.append((pid, score))
    matches.sort(key=lambda x: -x[1])
    return matches

# ─── Phase 1: Team rosters ──────────────────────────────────────────────────

def fetch_all_teams(sport, espn_league):
    url = f"https://site.api.espn.com/apis/site/v2/sports/{sport}/{espn_league}/teams"
    try:
        r = SESSION.get(url, timeout=20)
        r.raise_for_status()
        data = r.json()
        teams = []
        for entry in data.get("sports", [{}])[0].get("leagues", [{}])[0].get("teams", []):
            team = entry.get("team", entry)
            teams.append({"id": team.get("id", ""), "name": team.get("displayName", "")})
        return teams
    except Exception as e:
        print(f"    [ERR] fetch_teams: {e}", flush=True)
        return []

def fetch_team_roster(sport, espn_league, team_id):
    url = f"https://site.api.espn.com/apis/site/v2/sports/{sport}/{espn_league}/teams/{team_id}/roster"
    try:
        r = SESSION.get(url, timeout=20)
        if r.status_code == 404:
            return []
        r.raise_for_status()
        data = r.json()
        players = []
        for athlete in data.get("athletes", []):
            if isinstance(athlete, dict) and "items" in athlete:
                for item in athlete["items"]:
                    players.append({
                        "id": str(item.get("id", "")),
                        "name": item.get("fullName", "") or item.get("displayName", ""),
                    })
            elif isinstance(athlete, dict) and "id" in athlete:
                players.append({
                    "id": str(athlete.get("id", "")),
                    "name": athlete.get("fullName", "") or athlete.get("displayName", ""),
                })
        return players
    except Exception as e:
        print(f"    [ERR] roster(team {team_id}): {e}", flush=True)
        return []

def phase1_rosters(league, config, db_lookup, already_resolved):
    """Phase 1: Fetch current team rosters."""
    sport, espn_league = config["sport"], config["espn_league"]
    print(f"\n  Phase 1: Team rosters for {league.upper()}...", flush=True)

    teams = fetch_all_teams(sport, espn_league)
    if not teams:
        print("    No teams found", flush=True)
        return {}

    print(f"    {len(teams)} teams", flush=True)
    matched = {}
    total = 0

    for team in teams:
        roster = fetch_team_roster(sport, espn_league, team["id"])
        total += len(roster)
        for rp in roster:
            eid = rp.get("id", "")
            ename = rp.get("name", "")
            if not eid or not ename:
                continue
            results = match_espn_name(ename, db_lookup, already_resolved, min_score=75)
            for pid, score in results:
                if pid not in matched:
                    matched[pid] = eid
        time.sleep(0.05)

    print(f"    Scanned {total} roster athletes, matched {len(matched)}", flush=True)
    return matched

# ─── Phase 2: Core API catalog ──────────────────────────────────────────────

def get_all_athlete_ids(sport, espn_league):
    """Paginate ALL athlete IDs from ESPN core API."""
    base = f"http://sports.core.api.espn.com/v2/sports/{sport}/leagues/{espn_league}/athletes"
    all_ids = []
    page = 1
    page_size = 500

    while True:
        try:
            r = SESSION.get(base, params={"limit": page_size, "page": page}, timeout=20)
            if r.status_code != 200:
                print(f"    [WARN] core API page {page}: HTTP {r.status_code}", flush=True)
                break
            data = r.json()
            items = data.get("items", [])
            if not items:
                break
            for item in items:
                ref = item.get("$ref", "")
                m = re.search(r"/athletes/(\d+)", ref)
                if m:
                    all_ids.append(m.group(1))
            total = data.get("count", 0)
            page_count = data.get("pageCount", 1)
            if page == 1:
                print(f"    Core API: {total} total athletes, {page_count} pages", flush=True)
            if page >= page_count:
                break
            page += 1
        except Exception as e:
            print(f"    [ERR] core API page {page}: {e}", flush=True)
            break

    return all_ids

def fetch_athlete_name(sport, espn_league, athlete_id):
    """Fetch athlete's displayName from core API."""
    url = f"http://sports.core.api.espn.com/v2/sports/{sport}/leagues/{espn_league}/athletes/{athlete_id}"
    try:
        r = SESSION.get(url, timeout=10)
        if r.status_code != 200:
            return None
        data = r.json()
        return data.get("displayName", "") or data.get("fullName", "")
    except Exception:
        return None

def fetch_athlete_names_batch(sport, espn_league, athlete_ids, max_workers=5):
    """Fetch names for multiple athletes concurrently."""
    results = {}

    def _fetch(aid):
        name = fetch_athlete_name(sport, espn_league, aid)
        return (aid, name)

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(_fetch, aid): aid for aid in athlete_ids}
        for future in as_completed(futures):
            aid, name = future.result()
            if name:
                results[aid] = name

    return results

def phase2_catalog(league, config, db_lookup, already_resolved, checkpoint, batch_size=2000):
    """Phase 2: Paginate ALL ESPN athletes, fetch names, match to DB."""
    sport, espn_league = config["sport"], config["espn_league"]
    print(f"\n  Phase 2: Core API catalog for {league.upper()}...", flush=True)

    # Get all athlete IDs
    all_ids = get_all_athlete_ids(sport, espn_league)
    print(f"    Got {len(all_ids)} athlete IDs", flush=True)

    if not all_ids:
        return {}

    # Filter out IDs we already have
    existing_eids = set(str(v) for v in already_resolved.values())
    # Also skip IDs we already checked in the checkpoint
    checked_eids = set(checkpoint.get("checked_eids", []))
    todo_ids = [aid for aid in all_ids if aid not in existing_eids and aid not in checked_eids]
    print(f"    Need to check {len(todo_ids)} ({len(all_ids) - len(todo_ids)} already known/checked)", flush=True)

    if not todo_ids:
        return {}

    # Process in batches
    matched = {}
    total_fetched = 0
    total_matched = 0

    for batch_start in range(0, len(todo_ids), batch_size):
        batch = todo_ids[batch_start:batch_start + batch_size]
        print(f"    Batch {batch_start//batch_size + 1}: fetching {len(batch)} athlete names...", flush=True)

        # Concurrent fetch with 5 workers
        names = fetch_athlete_names_batch(sport, espn_league, batch, max_workers=5)
        total_fetched += len(batch)

        # Match against DB
        for aid, name in names.items():
            results = match_espn_name(name, db_lookup, {**already_resolved, **matched}, min_score=70)
            if results:
                pid, score = results[0]  # Best match
                matched[pid] = aid
                total_matched += 1
                if total_matched <= 30 or total_matched % 100 == 0:
                    print(f"      {name} -> DB match (score={score}, espn_id={aid})", flush=True)

        # Track checked IDs
        checkpoint.setdefault("checked_eids", []).extend(batch)

        print(f"    Progress: {total_fetched}/{len(todo_ids)} fetched, {total_matched} matched", flush=True)

    return matched

# ─── Checkpoint ──────────────────────────────────────────────────────────────

def checkpoint_path(league):
    return Path(os.path.dirname(os.path.abspath(__file__))) / f"checkpoint_espn_{league}.json"

def load_checkpoint(league):
    cp = checkpoint_path(league)
    if cp.exists():
        try:
            data = json.loads(cp.read_text())
            resolved = data.get("resolved", {})
            checked = data.get("checked_eids", [])
            print(f"  Checkpoint: {len(resolved)} resolved, {len(checked)} checked", flush=True)
            return data
        except Exception:
            pass
    return {"resolved": {}, "failed": [], "checked_eids": []}

def save_checkpoint(league, data):
    # Don't save the full checked_eids list every time (can be huge)
    # Just save resolved and failed
    save_data = {
        "resolved": data.get("resolved", {}),
        "failed": data.get("failed", []),
        "checked_eids": data.get("checked_eids", []),
    }
    checkpoint_path(league).write_text(json.dumps(save_data))

# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Resolve ESPN IDs for all players")
    parser.add_argument("--league", type=str, help="Single league: nba, nfl, nhl, mlb, premier-league")
    parser.add_argument("--reset", action="store_true", help="Clear checkpoint")
    parser.add_argument("--roster-only", action="store_true", help="Only do team roster phase")
    parser.add_argument("--batch-size", type=int, default=2000, help="Batch size for catalog fetch")
    args = parser.parse_args()

    leagues_to_process = [args.league] if args.league else list(LEAGUE_CONFIG.keys())

    for league in leagues_to_process:
        config = LEAGUE_CONFIG.get(league)
        if not config:
            print(f"Unknown league: {league}")
            continue

        print(f"\n{'=' * 60}", flush=True)
        print(f"Resolving ESPN IDs for {league.upper()}", flush=True)
        print(f"{'=' * 60}", flush=True)

        # Get league_id
        lgs = sb_get("back_in_play_leagues", f"select=league_id&slug=eq.{league}&limit=1")
        if not lgs:
            print(f"  League {league} not found in DB", flush=True)
            continue
        league_id = lgs[0]["league_id"]

        # Get ALL players
        all_players = []
        offset = 0
        while True:
            batch = sb_get("back_in_play_players",
                           f"select=player_id,player_name,espn_id&league_id=eq.{league_id}"
                           f"&limit=1000&offset={offset}")
            if not batch:
                break
            all_players.extend(batch)
            if len(batch) < 1000:
                break
            offset += 1000

        already_have = {p["player_id"]: p["espn_id"] for p in all_players if p.get("espn_id")}
        needs_id = [p for p in all_players if not p.get("espn_id")]

        print(f"  Total: {len(all_players)} | Have: {len(already_have)} | Need: {len(needs_id)}", flush=True)

        if not needs_id:
            print("  All done!", flush=True)
            continue

        # Load checkpoint
        cp = {"resolved": {}, "failed": [], "checked_eids": []} if args.reset else load_checkpoint(league)
        already_resolved = {**already_have, **cp.get("resolved", {})}

        # Build DB lookup from players needing espn_id
        db_lookup = build_db_lookup(needs_id)

        def write_matches(matches, phase_name):
            written = 0
            for pid, eid in matches.items():
                if pid not in already_resolved:
                    try:
                        sb_patch("back_in_play_players", f"player_id=eq.{pid}", {"espn_id": eid})
                        cp.setdefault("resolved", {})[pid] = eid
                        already_resolved[pid] = eid
                        written += 1
                    except Exception as e:
                        print(f"    [PATCH ERR] {pid}: {e}", flush=True)
            save_checkpoint(league, cp)
            print(f"  {phase_name}: wrote {written} to DB", flush=True)
            return written

        total_new = 0

        # Phase 1: Rosters
        matches = phase1_rosters(league, config, db_lookup, already_resolved)
        total_new += write_matches(matches, "Phase 1 (rosters)")

        if args.roster_only:
            print(f"\n  {league.upper()} DONE (roster-only): {total_new} new", flush=True)
            continue

        # Phase 2: Core API catalog
        matches = phase2_catalog(league, config, db_lookup, already_resolved, cp,
                                 batch_size=args.batch_size)
        total_new += write_matches(matches, "Phase 2 (catalog)")

        # Summary
        final_resolved = len(already_resolved)
        still_missing = len([p for p in needs_id if p["player_id"] not in already_resolved])
        print(f"\n  {league.upper()} DONE: {total_new} new, {final_resolved} total, {still_missing} missing",
              flush=True)

    print("\n=== ALL DONE ===", flush=True)

if __name__ == "__main__":
    main()
