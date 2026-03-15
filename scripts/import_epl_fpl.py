#!/usr/bin/env python3
"""
Import EPL player match stats from vaastav/Fantasy-Premier-League GitHub CSVs.

Source: https://github.com/vaastav/Fantasy-Premier-League
CSV per gameweek with: name, goals_scored, assists, minutes, opponent_team,
                       clean_sheets, saves, yellow_cards, red_cards, etc.
Coverage: 2016-17 through 2024-25

Usage:
  python3 import_epl_fpl.py
  python3 import_epl_fpl.py --dry-run
  python3 import_epl_fpl.py --start-season 2020 --end-season 2024
"""

import argparse
import csv
import io
import json
import os
import re
import sys
import time
import unicodedata
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
                    if line.startswith("export "):
                        line = line[7:]
                    key, _, val = line.partition("=")
                    os.environ.setdefault(key.strip(), val.strip().strip("'\""))

load_env()

SB_URL = os.environ.get("SUPABASE_URL", "")
SB_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
if not SB_URL or not SB_KEY:
    print("ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
    sys.exit(1)

# ─── Supabase REST helpers ───────────────────────────────────────────────────

def sb_get(table, params=""):
    url = SB_URL + "/rest/v1/" + table + "?" + params
    hdrs = {"apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY}
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=hdrs)
            resp = urllib.request.urlopen(req, timeout=30)
            return json.loads(resp.read().decode())
        except Exception as e:
            if attempt < 2:
                time.sleep(3)
                continue
            print(f"  [SB GET ERR] {table}: {e}", flush=True)
            return []

def sb_upsert(table, rows, conflict="player_id,game_date"):
    if not rows:
        return 0
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
        "apikey": SB_KEY,
        "Authorization": "Bearer " + SB_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=minimal,resolution=merge-duplicates",
    }
    url = SB_URL + "/rest/v1/" + table + "?on_conflict=" + conflict
    total = 0
    for i in range(0, len(rows), 200):
        batch = rows[i:i + 200]
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, data=json.dumps(batch).encode(),
                                            headers=hdrs, method="POST")
                urllib.request.urlopen(req, timeout=120).read()
                total += len(batch)
                break
            except Exception as e:
                if attempt < 2:
                    time.sleep(5 * (attempt + 1))
                    continue
                for j in range(0, len(batch), 20):
                    mini = batch[j:j + 20]
                    try:
                        req2 = urllib.request.Request(url, data=json.dumps(mini).encode(),
                                                     headers=hdrs, method="POST")
                        urllib.request.urlopen(req2, timeout=60).read()
                        total += len(mini)
                    except Exception as e2:
                        print(f"    [UPSERT ERR] {e2}", flush=True)
    return total

# ─── Name normalization ──────────────────────────────────────────────────────

SUFFIXES = {"jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"}

def normalize(name):
    nfkd = unicodedata.normalize("NFKD", name)
    stripped = "".join(c for c in nfkd if not unicodedata.combining(c))
    cleaned = stripped.replace("'", "").replace("\u2019", "").replace(".", "").replace("-", " ")
    parts = cleaned.lower().split()
    parts = [p for p in parts if p not in SUFFIXES]
    return " ".join(parts)

# Known FPL -> DB name aliases for players whose FPL name differs significantly
FPL_ALIASES = {
    "adrián san miguel del castillo": "adrian",
    "alisson ramses becker": "alisson",
    "anssumane fati vieira": "ansu fati",
    "bernardo veiga de carvalho e silva": "bernardo silva",
    "bruno borges fernandes": "bruno fernandes",
    "carlos henrique casimiro": "casemiro",
    "carlos vinícius alves morais": "carlos vinicius",
    "darwin núñez ribeiro": "darwin nunez",
    "danilo dos santos de oliveira": "danilo",
    "deivid washington de souza eugênio": "deivid washington",
    "ederson santana de moraes": "ederson",
    "emerson palmieri dos santos": "emerson palmieri",
    "emiliano martínez romero": "emiliano martinez",
    "fabio henrique tavares": "fabinho",
    "fernando luiz rosa": "fernandinho",
    "gabriel fernando de jesus": "gabriel jesus",
    "gabriel magalhães": "gabriel magalhaes",
    "gabriel teodoro martinelli silva": "gabriel martinelli",
    "heung-min son": "son heung min",
    "joão pedro junqueira de jesus": "joao pedro",
    "jorge luiz frello filho": "jorginho",
    "josé diogo dalot teixeira": "diogo dalot",
    "mateo kovačić": "mateo kovacic",
    "matheus santos carneiro da cunha": "matheus cunha",
    "pedro lomba neto": "pedro neto",
    "philippe coutinho correia": "philippe coutinho",
    "raphael dias belloli": "raphinha",
    "raúl jiménez rodríguez": "raul jimenez",
    "roberto firmino barbosa de oliveira": "roberto firmino",
    "rodrigo moreno machado": "rodrigo",
    "rúben diogo da silva neves": "ruben neves",
    "rúben dos santos gato alves dias": "ruben dias",
    "willian borges da silva": "willian",
    "andreas hoelgebaum pereira": "andreas pereira",
    "andré tavares gomes": "andre gomes",
    "arnaut danjuma groeneveld": "arnaut danjuma",
    "ben brereton": "ben brereton diaz",
    "bryan gil salvatierra": "bryan gil",
    "addji keaninkin marc-israel guehi": "marc guehi",
    "alexandre moreno lopera": "alex moreno",
    "braian ojeda rodríguez": "brian ojeda",
    "nélson cabral semedo": "nelson semedo",
    "diogo teixeira da silva": "diogo jota",
    "kepa arrizabalaga revuelta": "kepa arrizabalaga",
    "lucas tolentino coelho de lima": "lucas paqueta",
    "luis maximiano esteves": "luis maximiano",
    "pedro lomba neto": "pedro neto",
    "rayan aït-nouri": "rayan ait nouri",
    "sasa kalajdzic": "sasa kalajdzic",
    "toti antónio gomes": "toti gomes",
}

def build_fuzzy_index(name_map):
    """Build secondary lookup indexes for fuzzy matching."""
    # last_name -> list of (norm_name, player_id)
    last_name_index = {}
    for norm, pid in name_map.items():
        parts = norm.split()
        if len(parts) >= 2:
            last = parts[-1]
            if last not in last_name_index:
                last_name_index[last] = []
            last_name_index[last].append((norm, pid))
    return last_name_index

def fuzzy_match(name, name_map, last_name_index):
    """Try fuzzy matching: exact -> alias -> last+first_initial -> last_name_only (if unique)."""
    norm = normalize(name)

    # Exact match
    if norm in name_map:
        return name_map[norm]

    # Check known aliases
    alias = FPL_ALIASES.get(norm)
    if alias:
        alias_norm = normalize(alias)
        if alias_norm in name_map:
            return name_map[alias_norm]

    parts = norm.split()
    if len(parts) < 2:
        return None

    last = parts[-1]
    first_initial = parts[0][0] if parts[0] else ""

    candidates = last_name_index.get(last, [])
    if not candidates:
        return None

    # Last name + first initial match
    for cand_norm, cand_pid in candidates:
        cand_parts = cand_norm.split()
        if len(cand_parts) >= 2 and cand_parts[0][0] == first_initial:
            return cand_pid

    # Unique last name match (only if exactly 1 candidate)
    if len(candidates) == 1:
        return candidates[0][1]

    return None

def safe_float(val):
    if val is None or str(val).strip() in ("", "-", "None", "nan", "NA", "N/A"):
        return 0.0
    try:
        return float(val)
    except (ValueError, TypeError):
        return 0.0

def safe_int(val):
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return 0

# ─── GitHub CSV download ────────────────────────────────────────────────────

GITHUB_RAW = "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data"

def download_csv(url):
    """Download CSV from GitHub and return as list of dicts."""
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "BackInPlay/1.0"})
            resp = urllib.request.urlopen(req, timeout=30)
            raw = resp.read()
            # Try UTF-8 first, fall back to latin-1
            for enc in ("utf-8", "latin-1", "cp1252"):
                try:
                    text = raw.decode(enc)
                    break
                except UnicodeDecodeError:
                    continue
            else:
                text = raw.decode("utf-8", errors="replace")
            reader = csv.DictReader(io.StringIO(text))
            return list(reader)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if attempt < 2:
                time.sleep(2)
                continue
            print(f"  [DL ERR] {url}: {e}", flush=True)
            return None
        except Exception as e:
            if attempt < 2:
                time.sleep(2)
                continue
            print(f"  [DL ERR] {url}: {e}", flush=True)
            return None

def season_folder(year):
    """Convert year (e.g. 2023) to folder name (e.g. '2023-24')."""
    next_yr = str(year + 1)[-2:]
    return f"{year}-{next_yr}"

# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Import EPL player stats from FPL GitHub CSVs")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--start-season", type=int, default=2016)
    parser.add_argument("--end-season", type=int, default=2024)
    args = parser.parse_args()

    # Get EPL league_id from our DB
    leagues = sb_get("back_in_play_leagues", "select=league_id,slug&slug=eq.premier-league")
    if not leagues:
        print("ERROR: EPL league not found")
        sys.exit(1)
    league_id = leagues[0]["league_id"]
    print(f"EPL league_id: {league_id}", flush=True)

    # Build player name map from DB
    players = []
    offset = 0
    while True:
        batch = sb_get("back_in_play_players",
                       f"select=player_id,player_name&league_id=eq.{league_id}&limit=1000&offset={offset}")
        if not batch:
            break
        players.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000

    name_map = {}
    for p in players:
        raw = p.get("player_name", "").strip()
        if not raw:
            continue
        norm = normalize(raw)
        name_map[norm] = p["player_id"]
    print(f"Loaded {len(players)} EPL players, {len(name_map)} name variants", flush=True)

    last_name_index = build_fuzzy_index(name_map)
    print(f"Built fuzzy index with {len(last_name_index)} last names", flush=True)

    total_rows = 0
    total_matched = 0
    total_loaded = 0
    unmatched = set()
    lookup_cache = {}

    for season_year in range(args.start_season, args.end_season + 1):
        folder = season_folder(season_year)
        print(f"\n{'='*60}", flush=True)
        print(f"Season: {folder}", flush=True)

        # Try merged_gw.csv first (single file per season)
        merged_url = f"{GITHUB_RAW}/{folder}/gws/merged_gw.csv"
        rows = download_csv(merged_url)

        if rows is None:
            # Try individual gameweek files
            print(f"  merged_gw.csv not found, trying individual gw files...", flush=True)
            rows = []
            for gw in range(1, 39):
                gw_url = f"{GITHUB_RAW}/{folder}/gws/gw{gw}.csv"
                gw_rows = download_csv(gw_url)
                if gw_rows:
                    rows.extend(gw_rows)
                time.sleep(0.2)

        if not rows:
            print(f"  No data for {folder}", flush=True)
            continue

        print(f"  Got {len(rows)} gameweek rows", flush=True)

        db_rows = []
        for row in rows:
            total_rows += 1
            raw_name = (row.get("name") or "").strip().replace("_", " ")
            if not raw_name:
                continue
            # Older FPL CSVs embed element ID in name: "Aaron Cresswell 402"
            # Strip trailing number if present
            raw_name = re.sub(r'\s+\d+$', '', raw_name)

            if raw_name in lookup_cache:
                player_id = lookup_cache[raw_name]
            else:
                player_id = fuzzy_match(raw_name, name_map, last_name_index)
                lookup_cache[raw_name] = player_id
                if not player_id:
                    unmatched.add(raw_name)

            if not player_id:
                continue

            # Parse kickoff_time for game_date
            kickoff = row.get("kickoff_time", "")
            if kickoff and len(kickoff) >= 10:
                game_date = kickoff[:10]  # "2023-08-12T14:00:00Z" -> "2023-08-12"
            else:
                continue

            minutes = safe_float(row.get("minutes"))
            goals = safe_float(row.get("goals_scored"))
            assists = safe_float(row.get("assists"))
            clean_sheets = safe_float(row.get("clean_sheets"))
            saves = safe_float(row.get("saves"))

            # Skip if player didn't play
            if minutes == 0:
                continue

            opponent = row.get("team", "")  # FPL has team, not opponent directly
            # The 'opponent_team' field is a numeric ID in FPL data
            # We'll use what's available

            # EPL composite (FPL-style points approximation):
            # goals*6(mid/fwd) or *10(def/gk) + assists*3 + clean_sheet*4(def/gk) or *1(mid)
            # + saves/3 + minutes>=60: 2pts, minutes>0: 1pt
            position = row.get("position", "MID")
            if position in ("GK", "DEF"):
                composite = goals * 10 + assists * 3 + clean_sheets * 4 + saves * 0.33
            elif position == "MID":
                composite = goals * 6 + assists * 3 + clean_sheets * 1
            else:  # FWD
                composite = goals * 6 + assists * 3
            if minutes >= 60:
                composite += 2
            elif minutes > 0:
                composite += 1

            db_row = {
                "player_id": player_id,
                "league_slug": "premier-league",
                "season": season_year,
                "game_date": game_date,
                "opponent": opponent,
                "started": 1 if safe_int(row.get("starts", 0)) > 0 else 0,
                "minutes": round(minutes, 1),
                "stat_goals": goals,
                "stat_assists": assists,
                "stat_sog": clean_sheets,  # Using for clean sheets
                "composite": round(composite, 2),
                "source_url": "fpl_github_csv",
            }
            db_rows.append(db_row)
            total_matched += 1

        # Batch upsert for this season
        if db_rows:
            if not args.dry_run:
                n = sb_upsert("back_in_play_player_game_logs", db_rows)
                total_loaded += n
            else:
                total_loaded += len(db_rows)
            print(f"  Loaded: {len(db_rows)} rows ({total_loaded} total)", flush=True)

        time.sleep(1)  # Rate limit GitHub

    print(f"\n{'='*60}")
    print(f"EPL Players in DB:    {len(players)}")
    print(f"CSV rows processed:   {total_rows}")
    print(f"Matched rows:         {total_matched}")
    print(f"Loaded/upserted:      {total_loaded}")
    print(f"Unique names:         {len(lookup_cache)}")
    print(f"Matched players:      {len(lookup_cache) - len(unmatched)}")
    print(f"Unmatched:            {len(unmatched)}")
    if args.dry_run:
        print("(DRY RUN - no DB writes)")
    print(f"{'='*60}")

    if unmatched and len(unmatched) <= 40:
        print("\nUnmatched player names:")
        for name in sorted(unmatched):
            print(f"  {name}")
    elif unmatched:
        print(f"\nFirst 40 unmatched (of {len(unmatched)}):")
        for name in sorted(unmatched)[:40]:
            print(f"  {name}")

if __name__ == "__main__":
    main()
