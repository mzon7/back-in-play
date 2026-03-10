#!/usr/bin/env python3
"""
MLB Historical Injury Ingestion — 2015 to 2025
Source: MLB Official Transactions API (statsapi.mlb.com)
Data: All IL (Injured List) placements for 10 years
"""

import json, os, re, sys, time, urllib.request, urllib.parse, urllib.error
from datetime import date

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

# ── Supabase ───────────────────────────────────────────────────────────────────
def sb_request(method, path, body=None):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    data = json.dumps(body).encode() if body else None
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=representation",
    }
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        content = resp.read()
        return json.loads(content) if content else []
    except urllib.error.HTTPError as e:
        err = e.read().decode()[:300]
        print(f"  [SB ERR] {method} {path}: {e.code} - {err}")
        return None

def sb_upsert(table, rows, conflict=None):
    if not rows: return []
    path = f"{table}?on_conflict={conflict}" if conflict else table
    return sb_request("POST", path, rows)

def sb_get(table, params=""):
    return sb_request("GET", f"{table}?{params}") or []

def fetch_json(url, max_retries=3):
    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
            resp = urllib.request.urlopen(req, timeout=25)
            return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(5 * (attempt + 1))
            elif attempt == max_retries - 1:
                return None
            else:
                time.sleep(2)
        except Exception as e:
            if attempt == max_retries - 1:
                print(f"  Fetch error: {e} — {url}")
                return None
            time.sleep(2)
    return None

# ── Helpers ────────────────────────────────────────────────────────────────────
def slugify(text):
    t = text.lower().strip()
    t = re.sub(r"[^\w\s-]", "", t)
    t = re.sub(r"[\s_-]+", "-", t)
    return t.strip("-")

def injury_type_from_desc(desc):
    d = desc.lower()
    checks = [
        (["acl", "anterior cruciate"], "acl", "ACL Tear"),
        (["mcl"], "mcl", "MCL Injury"),
        (["hamstring"], "hamstring", "Hamstring"),
        (["quadricep", "quad "], "quadricep", "Quadricep"),
        (["calf"], "calf", "Calf"),
        (["groin", "adductor"], "groin", "Groin"),
        (["achilles"], "achilles", "Achilles"),
        (["acl"], "acl", "ACL Tear"),
        (["knee"], "knee", "Knee"),
        (["ankle"], "ankle", "Ankle"),
        (["foot", "plantar", "heel", "toe", "hamate"], "foot", "Foot"),
        (["shin", "tibia", "fibula"], "shin", "Shin/Leg"),
        (["hip"], "hip", "Hip"),
        (["shoulder", "rotator", "labrum", "clavicle", "collarbone"], "shoulder", "Shoulder"),
        (["elbow", "ulnar", "ucl", "tommy john"], "elbow", "Elbow"),
        (["wrist"], "wrist", "Wrist"),
        (["hand", "finger", "thumb", "hamate"], "hand", "Hand/Finger"),
        (["forearm"], "forearm", "Forearm"),
        (["oblique"], "oblique", "Oblique"),
        (["back", "lumbar", "spine", "disc"], "back", "Back/Spine"),
        (["neck", "cervical"], "neck", "Neck"),
        (["rib", "chest", "pectoral", "sternum"], "chest", "Chest/Ribs"),
        (["concussion", "head trauma"], "concussion", "Concussion"),
        (["abdominal", "abdomen", "hernia"], "abdominal", "Abdominal"),
        (["illness", "flu", "covid", "virus", "non-covid"], "illness", "Illness"),
        (["personal"], "personal", "Personal"),
        (["strain"], "strain", "Strain"),
        (["sprain"], "sprain", "Sprain"),
        (["fracture", "broken", "break"], "fracture", "Fracture"),
        (["torn", "tear"], "tear", "Tear"),
        (["bruise", "contusion"], "contusion", "Contusion"),
        (["surgery", "surgical", "post-op", "post op", "rehabilitation", "rehab"], "surgery", "Surgery/Rehab"),
    ]
    for keywords, slug, label in checks:
        if any(kw in d for kw in keywords):
            return slug, label
    return "other", "Other"

POSITION_MAP = {
    " C ": "C", " 1B ": "1B", " 2B ": "2B", " 3B ": "3B", " SS ": "SS",
    " LF ": "OF", " CF ": "OF", " RF ": "OF", " OF ": "OF",
    " SP ": "P", " RP ": "P", " RHP ": "P", " LHP ": "P",
    " DH ": "DH", " INF ": "IF", " UTL ": "OF",
}

def extract_position(desc):
    for abbr, pos in POSITION_MAP.items():
        if abbr in f" {desc} ":
            return pos
    # Check for common patterns like "placed RHP" or "placed OF"
    m = re.search(r"placed\s+(RHP|LHP|SP|RP|C|1B|2B|3B|SS|OF|LF|CF|RF|DH|INF|P)\s+", desc)
    if m:
        pos_abbr = m.group(1)
        return POSITION_MAP.get(f" {pos_abbr} ", pos_abbr)
    return "Unknown"

# ── DB Cache ───────────────────────────────────────────────────────────────────
LEAGUE_CACHE = {}
TEAM_CACHE = {}
PLAYER_CACHE = {}

def get_or_create_league(name, slug):
    if slug in LEAGUE_CACHE:
        return LEAGUE_CACHE[slug]
    result = sb_upsert("back_in_play_leagues", [{"league_name": name, "slug": slug}], "slug")
    if result:
        LEAGUE_CACHE[slug] = result[0]["league_id"]
        return LEAGUE_CACHE[slug]
    rows = sb_get("back_in_play_leagues", f"slug=eq.{slug}&select=league_id")
    if rows:
        LEAGUE_CACHE[slug] = rows[0]["league_id"]
        return LEAGUE_CACHE[slug]
    raise Exception(f"Cannot create league {slug}")

def get_or_create_team(team_name, league_id):
    key = f"{league_id}:{team_name}"
    if key in TEAM_CACHE:
        return TEAM_CACHE[key]
    result = sb_upsert("back_in_play_teams", [{"team_name": team_name, "league_id": league_id}], "team_name,league_id")
    if result:
        TEAM_CACHE[key] = result[0]["team_id"]
        return TEAM_CACHE[key]
    rows = sb_get("back_in_play_teams", f"team_name=eq.{urllib.parse.quote(team_name)}&league_id=eq.{league_id}&select=team_id")
    if rows:
        TEAM_CACHE[key] = rows[0]["team_id"]
        return TEAM_CACHE[key]
    raise Exception(f"Cannot create team {team_name}")

def get_or_create_player(player_name, team_id, position="Unknown"):
    key = f"{team_id}:{player_name}"
    if key in PLAYER_CACHE:
        return PLAYER_CACHE[key]
    base_slug = slugify(player_name)
    slug = f"{base_slug}-{team_id[:8]}"
    result = sb_upsert("back_in_play_players", [{
        "player_name": player_name,
        "team_id": team_id,
        "position": position or "Unknown",
        "slug": slug,
    }], "slug")
    if result:
        PLAYER_CACHE[key] = result[0]["player_id"]
        return PLAYER_CACHE[key]
    rows = sb_get("back_in_play_players", f"slug=eq.{slug}&select=player_id")
    if rows:
        PLAYER_CACHE[key] = rows[0]["player_id"]
        return PLAYER_CACHE[key]
    raise Exception(f"Cannot create player {player_name}")

def insert_injury(player_id, desc, date_injured, status="out", source=""):
    inj_slug, inj_type = injury_type_from_desc(desc)
    row = {
        "player_id": player_id,
        "injury_type": inj_type,
        "injury_type_slug": inj_slug,
        "injury_description": desc[:500],
        "date_injured": date_injured,
        "status": status,
        "source": source[:100],
    }
    return sb_upsert("back_in_play_injuries", [row], "player_id,date_injured,injury_type_slug")

# ── MLB Ingestion ──────────────────────────────────────────────────────────────
IL_KEYWORDS = ["injured list", "disabled list", "10-day il", "60-day il", "15-day dl", "10-day dl"]
SKIP_KEYWORDS = ["reinstated", "activated", "recalled", "returned", "transferred to 60-day"]

def is_il_placement(desc):
    dl = desc.lower()
    if any(kw in dl for kw in SKIP_KEYWORDS):
        return False
    return any(kw in dl for kw in IL_KEYWORDS)

def extract_injury_detail(desc):
    """Extract just the injury part from MLB transaction description."""
    # Format: "Team placed POS Player on the X-day injured list. Injury detail."
    parts = desc.split(". ", 1)
    if len(parts) > 1:
        detail = parts[1].strip().rstrip(".")
        if detail:
            return detail
    return desc

def ingest_month(league_id, year, month):
    """Ingest MLB IL transactions for a specific month (API works better with narrow date ranges)."""
    import calendar
    last_day = calendar.monthrange(year, month)[1]
    start = f"{year}-{month:02d}-01"
    end = f"{year}-{month:02d}-{last_day:02d}"

    url = f"https://statsapi.mlb.com/api/v1/transactions?sportId=1&startDate={start}&endDate={end}&limit=2000"
    data = fetch_json(url)
    if not data:
        return 0

    transactions = data.get("transactions", [])
    total = 0

    for tx in transactions:
        desc = tx.get("description", "")
        if not is_il_placement(desc):
            continue

        person = tx.get("person", {})
        team = tx.get("toTeam", {}) or tx.get("fromTeam", {}) or {}
        tx_date = tx.get("date", "")[:10]

        player_name = person.get("fullName", "")
        team_name = team.get("name", "")

        if not player_name or not tx_date or not team_name:
            continue

        position = extract_position(desc)
        injury_detail = extract_injury_detail(desc)

        try:
            tid = get_or_create_team(team_name, league_id)
            pid = get_or_create_player(player_name, tid, position)
            result = insert_injury(pid, injury_detail, tx_date, "out", f"mlb-transactions-{year}")
            if result:
                total += 1
        except Exception as e:
            print(f"    Error inserting {player_name}: {e}")

    return total

def ingest_year(league_id, year):
    print(f"\n  ── MLB {year} ──")
    total = 0
    for month in range(1, 13):
        count = ingest_month(league_id, year, month)
        total += count
        if count > 0:
            print(f"    {year}-{month:02d}: {count} IL placements")
        time.sleep(0.3)
    print(f"  MLB {year}: {total} IL placements ingested")
    return total

def main():
    print("=" * 55)
    print("MLB Historical Injury Ingestion (2015-2025)")
    print("=" * 55)

    league_id = get_or_create_league("MLB", "mlb")
    print(f"MLB league_id: {league_id}")

    total = 0
    for year in range(2015, 2026):
        count = ingest_year(league_id, year)
        total += count

    print(f"\n{'='*55}")
    print(f"MLB TOTAL: {total} injuries ingested")

    # Quick DB count
    rows = sb_get("back_in_play_injuries", "select=injury_id&limit=1")
    print(f"DB injuries table accessible: {rows is not None}")

if __name__ == "__main__":
    main()
