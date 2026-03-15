#!/usr/bin/env python3
"""
Bulk-scrape NHL game logs from api-web.nhle.com for all NHL players in Supabase.

Usage:
  python3 bulk_scrape_nhl_api.py
  nohup python3 bulk_scrape_nhl_api.py > nhl_scrape.log 2>&1 &

Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
"""

import json
import os
import re
import sys
import time
import unicodedata
from pathlib import Path

import requests

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

SUPA_URL = os.environ.get("SUPABASE_URL", "")
SUPA_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
if not SUPA_URL or not SUPA_KEY:
    print("ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY", flush=True)
    sys.exit(1)

SB_HEADERS = {
    "apikey": SUPA_KEY,
    "Authorization": f"Bearer {SUPA_KEY}",
}

SEASONS = [
    "20182019", "20192020", "20202021", "20212022",
    "20222023", "20232024", "20242025",
]

# ─── Supabase helpers ─────────────────────────────────────────────────────────

def sb_get(table, params=""):
    url = f"{SUPA_URL}/rest/v1/{table}?{params}"
    for attempt in range(3):
        try:
            r = requests.get(url, headers=SB_HEADERS, timeout=30)
            r.raise_for_status()
            return r.json()
        except requests.exceptions.HTTPError as e:
            if r.status_code in (502, 503, 429) and attempt < 2:
                time.sleep(5 * (attempt + 1))
                continue
            raise


def sb_get_all(table, params=""):
    """Paginate through all rows using Range header."""
    rows = []
    page_size = 1000
    offset = 0
    while True:
        hdrs = {**SB_HEADERS, "Range": f"{offset}-{offset + page_size - 1}"}
        url = f"{SUPA_URL}/rest/v1/{table}?{params}"
        r = requests.get(url, headers=hdrs, timeout=30)
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        rows.extend(batch)
        if len(batch) < page_size:
            break
        offset += page_size
    return rows


def sb_upsert(table, rows, conflict="player_id,game_date"):
    if not rows:
        return
    # Dedup by conflict keys
    keys = conflict.split(",")
    seen = set()
    unique = []
    for r in rows:
        k = tuple(r.get(c) for c in keys)
        if k not in seen:
            seen.add(k)
            unique.append(r)
    rows = unique

    hdrs = {
        **SB_HEADERS,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    url = f"{SUPA_URL}/rest/v1/{table}?on_conflict={conflict}"
    # Batch in chunks of 200
    for i in range(0, len(rows), 200):
        batch = rows[i:i + 200]
        for attempt in range(3):
            try:
                r = requests.post(url, json=batch, headers=hdrs, timeout=120)
                r.raise_for_status()
                break
            except requests.exceptions.HTTPError:
                if r.status_code in (502, 503, 429) and attempt < 2:
                    time.sleep(5 * (attempt + 1))
                    continue
                raise


# ─── Name normalization ───────────────────────────────────────────────────────

def normalize_name(name):
    """Strip accents, lowercase, remove punctuation, collapse whitespace."""
    # Decompose unicode and strip combining chars (accents)
    nfkd = unicodedata.normalize("NFKD", name)
    stripped = "".join(c for c in nfkd if not unicodedata.combining(c))
    # Lowercase, remove punctuation except spaces/hyphens
    cleaned = re.sub(r"[^a-z\s-]", "", stripped.lower())
    # Collapse whitespace
    return re.sub(r"\s+", " ", cleaned).strip()


def names_match(db_name, api_name):
    """Fuzzy match: normalized exact match, or last-name + first-initial match."""
    n1 = normalize_name(db_name)
    n2 = normalize_name(api_name)
    if n1 == n2:
        return True
    # Try last name match + first letter of first name
    parts1 = n1.split()
    parts2 = n2.split()
    if len(parts1) >= 2 and len(parts2) >= 2:
        if parts1[-1] == parts2[-1] and parts1[0][0] == parts2[0][0]:
            return True
    return False


# ─── NHL API helpers ──────────────────────────────────────────────────────────

NHL_SEARCH_URL = "https://search.d3.nhle.com/api/v1/search/player"
NHL_GAMELOG_URL = "https://api-web.nhle.com/v1/player/{pid}/game-log/{season}/2"

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "Mozilla/5.0 (compatible; BIPBot/1.0)"})


def search_nhl_player(player_name):
    """Search NHL API for a player, return best-matching NHL player ID or None."""
    try:
        r = SESSION.get(NHL_SEARCH_URL, params={
            "culture": "en-us",
            "limit": 20,
            "q": player_name,
        }, timeout=15)
        r.raise_for_status()
        results = r.json()
    except Exception as e:
        print(f"    [SEARCH ERR] {player_name}: {e}", flush=True)
        return None

    if not results:
        return None

    # Try exact normalized match first
    for p in results:
        api_name = p.get("name", "")
        if names_match(player_name, api_name):
            return p.get("playerId")

    # Fallback: return first result if last name matches
    db_last = normalize_name(player_name).split()[-1] if player_name.strip() else ""
    for p in results:
        api_last = normalize_name(p.get("name", "")).split()[-1] if p.get("name") else ""
        if db_last and db_last == api_last:
            return p.get("playerId")

    return None


def parse_toi_minutes(toi_str):
    """Parse time-on-ice string like '20:15' to float minutes."""
    if not toi_str:
        return 0.0
    try:
        parts = toi_str.split(":")
        mins = int(parts[0])
        secs = int(parts[1]) if len(parts) > 1 else 0
        return mins + secs / 60.0
    except (ValueError, IndexError):
        return 0.0


def fetch_game_logs(nhl_pid, season):
    """Fetch game logs for a player+season. Returns list of dicts or []."""
    url = NHL_GAMELOG_URL.format(pid=nhl_pid, season=season)
    try:
        r = SESSION.get(url, timeout=15)
        if r.status_code == 404:
            return []
        r.raise_for_status()
        data = r.json()
        return data.get("gameLog", [])
    except Exception:
        return []


def compute_composite(g):
    """Compute composite score from a game log entry."""
    goals = g.get("goals", 0) or 0
    assists = g.get("assists", 0) or 0
    shots = g.get("shots", 0) or 0
    hits = g.get("hits", 0) or 0
    blocked = g.get("blockedShots", 0) or 0
    toi_str = g.get("toi", "") or ""
    toi_mins = parse_toi_minutes(toi_str)

    # goals*6 + assists*3 + shots*0.5 + hits*0.5 + blocked*0.5 + (toi_mins/20)*2
    composite = (
        goals * 6
        + assists * 3
        + shots * 0.5
        + hits * 0.5
        + blocked * 0.5
        + (toi_mins / 20.0) * 2
    )
    return round(composite, 2)


def season_str_to_int(season_str):
    """Convert '20232024' to 2023 (the start year)."""
    return int(season_str[:4])


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    print("=== NHL Bulk Game Log Scraper ===", flush=True)
    print(f"Supabase: {SUPA_URL}", flush=True)

    # 1. Get NHL league_id
    leagues = sb_get("back_in_play_leagues", "slug=eq.nhl&select=league_id")
    if not leagues:
        print("ERROR: No league with slug='nhl' found", flush=True)
        sys.exit(1)
    nhl_league_id = leagues[0]["league_id"]
    print(f"NHL league_id: {nhl_league_id}", flush=True)

    # 2. Get all NHL players
    players = sb_get_all(
        "back_in_play_players",
        f"league_id=eq.{nhl_league_id}&select=player_id,player_name"
    )
    print(f"Total NHL players in DB: {len(players)}", flush=True)

    # 3. Get player_ids that already have game logs
    existing = sb_get_all(
        "back_in_play_player_game_logs",
        "league_slug=eq.nhl&select=player_id"
    )
    existing_ids = set(r["player_id"] for r in existing)
    print(f"Players with existing game logs: {len(existing_ids)}", flush=True)

    # Filter to players without logs
    todo = [p for p in players if p["player_id"] not in existing_ids]
    print(f"Players to scrape: {len(todo)}", flush=True)

    # 4. Process each player
    total_logs = 0
    skipped = 0
    not_found = 0

    for idx, player in enumerate(todo):
        pid = player["player_id"]
        pname = player["player_name"]

        if (idx + 1) % 50 == 0 or idx == 0:
            print(f"\n--- Progress: {idx + 1}/{len(todo)} | "
                  f"Logs inserted: {total_logs} | "
                  f"Not found: {not_found} ---", flush=True)

        # Search NHL API for player
        nhl_pid = search_nhl_player(pname)
        if not nhl_pid:
            not_found += 1
            if not_found <= 20 or not_found % 50 == 0:
                print(f"  [{idx+1}] NOT FOUND: {pname}", flush=True)
            continue

        # Scrape all seasons
        all_rows = []
        for season in SEASONS:
            games = fetch_game_logs(nhl_pid, season)
            if not games:
                continue
            season_int = season_str_to_int(season)
            for g in games:
                game_date = g.get("gameDate", "")
                if not game_date:
                    continue
                opp = g.get("opponentAbbrev", {})
                opponent = opp.get("default", "") if isinstance(opp, dict) else str(opp)
                toi_mins = parse_toi_minutes(g.get("toi", "") or "")
                composite = compute_composite(g)

                all_rows.append({
                    "player_id": pid,
                    "league_slug": "nhl",
                    "season": season_int,
                    "game_date": game_date,
                    "opponent": opponent,
                    "minutes": round(toi_mins, 1),
                    "stat_goals": g.get("goals", 0) or 0,
                    "stat_assists": g.get("assists", 0) or 0,
                    "stat_sog": g.get("shots", 0) or 0,
                    "composite": composite,
                    "started": None,
                    "source_url": "nhl_api",
                })

        if all_rows:
            try:
                sb_upsert("back_in_play_player_game_logs", all_rows)
                total_logs += len(all_rows)
                print(f"  [{idx+1}] {pname}: {len(all_rows)} logs (NHL ID {nhl_pid})", flush=True)
            except Exception as e:
                print(f"  [{idx+1}] UPSERT ERR {pname}: {e}", flush=True)
        else:
            skipped += 1

        # Small delay to be polite (even though no rate limit)
        time.sleep(0.1)

    print(f"\n=== DONE ===", flush=True)
    print(f"Total logs inserted: {total_logs}", flush=True)
    print(f"Players not found: {not_found}", flush=True)
    print(f"Players with no game data: {skipped}", flush=True)


if __name__ == "__main__":
    main()
