#!/usr/bin/env python3
"""
ESPN Injury Ingestion for NFL, NBA, Premier League (current season)
+ OpenAI web search for historical data (2015-2025)
Sources:
  - site.api.espn.com/apis/site/v2/sports/{sport}/{league}/injuries
  - OpenAI responses API with web_search_preview tool
"""

import json, os, re, sys, time, urllib.request, urllib.parse, urllib.error
from datetime import date

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")

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
        err = e.read().decode()[:200]
        print(f"  [SB ERR] {method} {path}: {e.code} - {err}")
        return None

def sb_upsert(table, rows, conflict=None):
    if not rows: return []
    path = f"{table}?on_conflict={conflict}" if conflict else table
    return sb_request("POST", path, rows)

def sb_get(table, params=""):
    return sb_request("GET", f"{table}?{params}") or []

def fetch_json(url, retries=3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
                "Accept": "application/json",
            })
            resp = urllib.request.urlopen(req, timeout=20)
            return json.loads(resp.read())
        except Exception as e:
            if attempt == retries - 1:
                return None
            time.sleep(2)
    return None

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
        (["knee"], "knee", "Knee"),
        (["ankle"], "ankle", "Ankle"),
        (["foot", "plantar", "heel", "toe", "hamate"], "foot", "Foot"),
        (["hip"], "hip", "Hip"),
        (["shoulder", "rotator", "labrum", "clavicle"], "shoulder", "Shoulder"),
        (["elbow", "ulnar", "ucl", "tommy john"], "elbow", "Elbow"),
        (["wrist"], "wrist", "Wrist"),
        (["hand", "finger", "thumb"], "hand", "Hand/Finger"),
        (["forearm"], "forearm", "Forearm"),
        (["oblique"], "oblique", "Oblique"),
        (["back", "lumbar", "spine", "disc"], "back", "Back/Spine"),
        (["neck", "cervical"], "neck", "Neck"),
        (["rib", "chest", "pectoral"], "chest", "Chest/Ribs"),
        (["concussion"], "concussion", "Concussion"),
        (["abdominal", "abdomen", "hernia"], "abdominal", "Abdominal"),
        (["illness", "flu", "covid", "virus", "sick"], "illness", "Illness"),
        (["personal"], "personal", "Personal"),
        (["strain"], "strain", "Strain"),
        (["sprain"], "sprain", "Sprain"),
        (["fracture", "broken", "break"], "fracture", "Fracture"),
        (["torn", "tear"], "tear", "Tear"),
        (["bruise", "contusion"], "contusion", "Contusion"),
        (["surgery", "surgical", "rehab", "recovery"], "surgery", "Surgery/Rehab"),
    ]
    for keywords, slug, label in checks:
        if any(kw in d for kw in keywords):
            return slug, label
    return "other", "Other"

def espn_status_map(status):
    s = status.lower()
    if any(x in s for x in ["out", "ir", "injured reserve", "reserve"]):
        return "out"
    if "doubtful" in s:
        return "doubtful"
    if "questionable" in s:
        return "questionable"
    if "probable" in s:
        return "probable"
    if any(x in s for x in ["day-to-day", "dtd"]):
        return "questionable"
    if any(x in s for x in ["active", "return", "healthy"]):
        return "returned"
    return "out"

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

# ── ESPN Current Injuries ──────────────────────────────────────────────────────
def ingest_espn_current(league_slug, league_id, sport, league_code):
    url = f"https://site.api.espn.com/apis/site/v2/sports/{sport}/{league_code}/injuries"
    data = fetch_json(url)
    if not data:
        print(f"  {league_slug.upper()}: No ESPN data")
        return 0

    season_year = data.get("season", {}).get("year", date.today().year)
    total = 0

    for team_group in data.get("injuries", []):
        team_name = team_group.get("displayName", "")
        if not team_name:
            continue

        try:
            tid = get_or_create_team(team_name, league_id)
        except Exception as e:
            print(f"  Team error {team_name}: {e}")
            continue

        for inj in team_group.get("injuries", []):
            athlete = inj.get("athlete", {})
            player_name = athlete.get("displayName", "")
            if not player_name:
                continue

            pos_obj = athlete.get("position", {})
            position = pos_obj.get("abbreviation", "") if isinstance(pos_obj, dict) else str(pos_obj)

            status = espn_status_map(inj.get("status", ""))
            inj_date = inj.get("date", "")[:10] if inj.get("date") else date.today().isoformat()
            desc = inj.get("shortComment", "") or inj.get("longComment", "") or "Injury"

            try:
                pid = get_or_create_player(player_name, tid, position)
                result = insert_injury(pid, desc, inj_date, status, f"espn-{league_code}-{season_year}")
                if result:
                    total += 1
            except Exception as e:
                print(f"  Player error {player_name}: {e}")

    print(f"  {league_slug.upper()} current ({season_year}): {total} injuries")
    return total

# ── OpenAI Web Search ──────────────────────────────────────────────────────────
def openai_web_search(prompt):
    if not OPENAI_API_KEY:
        return ""
    body = json.dumps({
        "model": "gpt-4o-mini",
        "tools": [{"type": "web_search_preview"}],
        "input": prompt,
    }).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/responses",
        data=body,
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
        method="POST"
    )
    try:
        resp = urllib.request.urlopen(req, timeout=90)
        data = json.loads(resp.read())
        for item in data.get("output", []):
            if item.get("type") == "message":
                for content in item.get("content", []):
                    if content.get("type") == "output_text":
                        return content.get("text", "")
        return ""
    except Exception as e:
        print(f"  OpenAI error: {e}")
        return ""

def parse_json_injuries(text, league_id, source, default_status="out"):
    """Extract and insert injury data from AI text containing JSON."""
    total = 0
    # Find JSON array in text
    for match in re.finditer(r'\[[\s\S]*?\]', text):
        try:
            injuries = json.loads(match.group())
            if not isinstance(injuries, list):
                continue
            for inj in injuries:
                if not isinstance(inj, dict):
                    continue
                player_name = (inj.get("player_name") or inj.get("name") or inj.get("player") or "").strip()
                team_name = (inj.get("team") or inj.get("team_name") or "").strip()
                position = (inj.get("position") or "").strip()
                injury_desc = (inj.get("injury") or inj.get("injury_description") or inj.get("description") or "Injury").strip()
                date_str = (inj.get("date_placed") or inj.get("date_injured") or inj.get("date") or "").strip()
                status = (inj.get("status") or default_status).strip()

                if not player_name or not team_name:
                    continue

                # Normalize date
                if date_str:
                    date_str = date_str[:10]
                    # Validate date format
                    if not re.match(r'^\d{4}-\d{2}-\d{2}$', date_str):
                        date_str = date.today().isoformat()
                else:
                    date_str = date.today().isoformat()

                try:
                    tid = get_or_create_team(team_name, league_id)
                    pid = get_or_create_player(player_name, tid, position)
                    result = insert_injury(pid, injury_desc, date_str, espn_status_map(status), source)
                    if result:
                        total += 1
                except Exception as e:
                    pass
        except json.JSONDecodeError:
            continue
    return total

def ingest_historical_via_search(league_slug, league_id, start_year, end_year):
    """Collect historical injury data via OpenAI web search."""
    PROMPTS = {
        "nfl": lambda y: f"""Search for NFL players on the injured reserve (IR) list during the {y} NFL season.
I need data from spotrac.com/nfl/injured-reserve or similar NFL injury tracking sites.
Return ONLY a valid JSON array (no other text) with this exact format:
[{{"player_name": "Patrick Mahomes", "team": "Kansas City Chiefs", "position": "QB", "injury": "ankle sprain", "date_placed": "{y}-09-15", "status": "out"}}]
Include 25-40 real NFL players who were injured/on IR during the {y} season. Use real player names, teams, and injuries.""",

        "nba": lambda y: f"""Search for NBA players on the injured list during the {y}-{y+1} NBA season.
I need data from spotrac.com/nba/injured-reserve or espn.com NBA injury reports.
Return ONLY a valid JSON array (no other text) with this exact format:
[{{"player_name": "LeBron James", "team": "Los Angeles Lakers", "position": "SF", "injury": "ankle sprain", "date_placed": "{y}-10-20", "status": "out"}}]
Include 25-40 real NBA players who were injured during the {y}-{y+1} season. Use real player names, teams, and injuries.""",

        "nhl": lambda y: f"""Search for NHL players on injured reserve during the {y}-{y+1} NHL season.
I need data from capfriendly.com or hockey-reference.com injury data.
Return ONLY a valid JSON array (no other text) with this exact format:
[{{"player_name": "Sidney Crosby", "team": "Pittsburgh Penguins", "position": "C", "injury": "concussion", "date_placed": "{y}-10-15", "status": "out"}}]
Include 25-40 real NHL players who were injured during the {y}-{y+1} season. Use real player names, teams, and injuries.""",

        "epl": lambda y: f"""Search for Premier League players injured during the {y}/{y+1} season.
I need data from transfermarkt.com or premierinjuries.com or physioroom.com.
Return ONLY a valid JSON array (no other text) with this exact format:
[{{"player_name": "Mohamed Salah", "team": "Liverpool FC", "position": "RW", "injury": "hamstring strain", "date_placed": "{y}-09-20", "status": "out"}}]
Include 25-40 real Premier League players who were injured during the {y}/{y+1} season. Use real player names, teams, and injuries.""",
    }

    if league_slug not in PROMPTS:
        return 0

    total = 0
    for year in range(start_year, end_year + 1):
        prompt = PROMPTS[league_slug](year)
        print(f"  {league_slug.upper()} {year}: Querying web search...")
        text = openai_web_search(prompt)

        if text:
            count = parse_json_injuries(text, league_id, f"openai-{league_slug}-{year}")
            total += count
            print(f"    → {count} injuries stored")
        else:
            print(f"    → No data returned")

        time.sleep(3)  # Rate limit

    return total

# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    print("=" * 55)
    print("ESPN + OpenAI Injury Ingestion (NFL, NBA, NHL, EPL)")
    print("=" * 55)

    # Set up leagues
    leagues = {
        "nfl": get_or_create_league("NFL", "nfl"),
        "nba": get_or_create_league("NBA", "nba"),
        "nhl": get_or_create_league("NHL", "nhl"),
        "epl": get_or_create_league("Premier League", "epl"),
    }
    print(f"Leagues: {list(leagues.keys())}")

    grand_total = 0

    # ── Current season from ESPN ────────────────────────────────────────────
    print("\n[A] ESPN Current Season Injuries")
    grand_total += ingest_espn_current("nfl", leagues["nfl"], "football", "nfl")
    grand_total += ingest_espn_current("nba", leagues["nba"], "basketball", "nba")
    grand_total += ingest_espn_current("mlb", get_or_create_league("MLB", "mlb"), "baseball", "mlb")
    grand_total += ingest_espn_current("epl", leagues["epl"], "soccer", "eng.1")

    # ── Historical via OpenAI web search ───────────────────────────────────
    print("\n[B] Historical Injuries via OpenAI Web Search (2015-2024)")
    START, END = 2015, 2024

    print("\n  NFL historical:")
    count = ingest_historical_via_search("nfl", leagues["nfl"], START, END)
    grand_total += count
    print(f"  NFL historical total: {count}")

    print("\n  NBA historical:")
    count = ingest_historical_via_search("nba", leagues["nba"], START, END)
    grand_total += count
    print(f"  NBA historical total: {count}")

    print("\n  NHL historical:")
    count = ingest_historical_via_search("nhl", leagues["nhl"], START, END)
    grand_total += count
    print(f"  NHL historical total: {count}")

    print("\n  Premier League historical:")
    count = ingest_historical_via_search("epl", leagues["epl"], START, END)
    grand_total += count
    print(f"  EPL historical total: {count}")

    print(f"\n{'='*55}")
    print(f"ESPN+OpenAI TOTAL: {grand_total} injuries ingested")

if __name__ == "__main__":
    main()
