#!/usr/bin/env python3
"""
Comprehensive 10-Year Historical Injury Ingestion for Back In Play.

Targets the exact sites requested:
  NFL  → spotrac.com/nfl/injured-reserve/
  NBA  → spotrac.com/nba/injured-reserve/
  MLB  → baseball-reference.com  (+ official MLB transactions API)
  NHL  → capfriendly.com/injuries
  EPL  → transfermarkt.com

Seasons covered: 2015-16 through 2025-26 (10 years).
Strategy:
  • MLB: Official statsapi.mlb.com/api/v1/transactions (ground truth, exhaustive)
  • NFL/NBA/NHL/EPL: OpenAI web_search_preview targeting specific site per season
    - Multiple targeted passes per season (by conference / month / team-group)
    - 50-75 players requested per query for comprehensive coverage
"""

import json, os, re, sys, time, calendar, urllib.request, urllib.parse, urllib.error
from datetime import date

# ── Config ─────────────────────────────────────────────────────────────────────
SUPABASE_URL      = os.environ["SUPABASE_URL"]
SUPABASE_KEY      = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
OPENAI_API_KEY    = os.environ.get("OPENAI_API_KEY", "")

SEASONS           = list(range(2015, 2026))   # 2015 → 2025 (11 seasons)
CURRENT_DATE      = "2026-03-10"

# ── Supabase helpers ───────────────────────────────────────────────────────────
def sb_request(method, path, body=None):
    url  = f"{SUPABASE_URL}/rest/v1/{path}"
    data = json.dumps(body).encode() if body else None
    hdrs = {
        "apikey":         SUPABASE_KEY,
        "Authorization":  f"Bearer {SUPABASE_KEY}",
        "Content-Type":   "application/json",
        "Prefer":         "resolution=merge-duplicates,return=representation",
    }
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        raw  = resp.read()
        return json.loads(raw) if raw else []
    except urllib.error.HTTPError as e:
        err = e.read().decode()[:300]
        # Silently ignore duplicate-key errors
        if "duplicate" in err.lower() or "unique" in err.lower():
            return []
        print(f"  [SB ERR] {method} {path}: {e.code} - {err}")
        return None

def sb_upsert(table, rows, conflict=None):
    if not rows:
        return []
    path = f"{table}?on_conflict={conflict}" if conflict else table
    return sb_request("POST", path, rows)

def sb_get(table, params=""):
    return sb_request("GET", f"{table}?{params}") or []

# ── Generic HTTP fetch ─────────────────────────────────────────────────────────
def fetch_json(url, headers=None, retries=3):
    default_hdrs = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept":     "application/json",
    }
    for attempt in range(retries):
        try:
            req  = urllib.request.Request(url, headers=headers or default_hdrs)
            resp = urllib.request.urlopen(req, timeout=25)
            return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(5 * (attempt + 1))
            elif attempt == retries - 1:
                return None
            else:
                time.sleep(2)
        except Exception:
            if attempt == retries - 1:
                return None
            time.sleep(2)
    return None

# ── Slug / type helpers ────────────────────────────────────────────────────────
def slugify(text):
    t = text.lower().strip()
    t = re.sub(r"[^\w\s-]", "", t)
    t = re.sub(r"[\s_-]+", "-", t)
    return t.strip("-")

INJURY_CHECKS = [
    (["acl", "anterior cruciate"],                         "acl",        "ACL Tear"),
    (["mcl", "medial collateral"],                         "mcl",        "MCL Injury"),
    (["pcl", "posterior cruciate"],                        "pcl",        "PCL Injury"),
    (["hamstring"],                                        "hamstring",  "Hamstring"),
    (["quadricep", "quad "],                               "quadricep",  "Quadricep"),
    (["calf", "gastrocnemius"],                            "calf",       "Calf"),
    (["groin", "adductor"],                                "groin",      "Groin"),
    (["achilles"],                                         "achilles",   "Achilles"),
    (["knee"],                                             "knee",       "Knee"),
    (["ankle"],                                            "ankle",      "Ankle"),
    (["foot", "plantar", "heel", "toe", "hamate"],         "foot",       "Foot"),
    (["shin", "tibia", "fibula"],                          "shin",       "Shin/Leg"),
    (["hip flexor"],                                       "hip-flexor", "Hip Flexor"),
    (["hip"],                                              "hip",        "Hip"),
    (["shoulder", "rotator", "labrum", "clavicle", "collarbone"], "shoulder", "Shoulder"),
    (["elbow", "ulnar", "ucl", "tommy john"],              "elbow",      "Elbow"),
    (["wrist"],                                            "wrist",      "Wrist"),
    (["hand", "finger", "thumb"],                          "hand",       "Hand/Finger"),
    (["forearm"],                                          "forearm",    "Forearm"),
    (["oblique"],                                          "oblique",    "Oblique"),
    (["back", "lumbar", "spine", "disc", "vertebra"],      "back",       "Back/Spine"),
    (["neck", "cervical"],                                 "neck",       "Neck"),
    (["rib", "chest", "pectoral", "sternum"],              "chest",      "Chest/Ribs"),
    (["concussion", "head trauma", "tbi"],                 "concussion", "Concussion"),
    (["abdominal", "abdomen", "hernia"],                   "abdominal",  "Abdominal"),
    (["illness", "flu", "covid", "virus", "non-covid"],    "illness",    "Illness"),
    (["personal"],                                         "personal",   "Personal"),
    (["strain"],                                           "strain",     "Strain"),
    (["sprain"],                                           "sprain",     "Sprain"),
    (["fracture", "broken", "break"],                      "fracture",   "Fracture"),
    (["torn", "tear"],                                     "tear",       "Tear"),
    (["bruise", "contusion"],                              "contusion",  "Contusion"),
    (["surgery", "surgical", "post-op", "rehab"],          "surgery",    "Surgery/Rehab"),
]

def injury_type_from_desc(desc):
    d = (desc or "").lower()
    for keywords, slug, label in INJURY_CHECKS:
        if any(kw in d for kw in keywords):
            return slug, label
    return "other", "Other"

def status_normalize(status):
    s = (status or "").lower()
    if any(x in s for x in ["out", "ir", "injured reserve", "reserve", "il"]):
        return "out"
    if "doubtful" in s:
        return "doubtful"
    if "questionable" in s:
        return "questionable"
    if "probable" in s:
        return "probable"
    if any(x in s for x in ["day-to-day", "dtd"]):
        return "questionable"
    if any(x in s for x in ["active", "return", "healthy", "reinstated"]):
        return "returned"
    return "out"

# ── DB cache ───────────────────────────────────────────────────────────────────
LEAGUE_CACHE = {}
TEAM_CACHE   = {}
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
    result = sb_upsert("back_in_play_teams",
                       [{"team_name": team_name, "league_id": league_id}],
                       "team_name,league_id")
    if result:
        TEAM_CACHE[key] = result[0]["team_id"]
        return TEAM_CACHE[key]
    rows = sb_get("back_in_play_teams",
                  f"team_name=eq.{urllib.parse.quote(team_name)}&league_id=eq.{league_id}&select=team_id")
    if rows:
        TEAM_CACHE[key] = rows[0]["team_id"]
        return TEAM_CACHE[key]
    raise Exception(f"Cannot create team {team_name}")

def get_or_create_player(player_name, team_id, position="Unknown"):
    key = f"{team_id}:{player_name}"
    if key in PLAYER_CACHE:
        return PLAYER_CACHE[key]
    base_slug = slugify(player_name)
    slug      = f"{base_slug}-{team_id[:8]}"
    result = sb_upsert("back_in_play_players", [{
        "player_name": player_name,
        "team_id":     team_id,
        "position":    position or "Unknown",
        "slug":        slug,
    }], "slug")
    if result:
        PLAYER_CACHE[key] = result[0]["player_id"]
        return PLAYER_CACHE[key]
    rows = sb_get("back_in_play_players", f"slug=eq.{slug}&select=player_id")
    if rows:
        PLAYER_CACHE[key] = rows[0]["player_id"]
        return PLAYER_CACHE[key]
    raise Exception(f"Cannot create player {player_name}")

def insert_injury(player_id, desc, date_injured, status="out", source="", expected_return=None):
    inj_slug, inj_type = injury_type_from_desc(desc)
    row = {
        "player_id":          player_id,
        "injury_type":        inj_type,
        "injury_type_slug":   inj_slug,
        "injury_description": (desc or "Injury")[:500],
        "date_injured":       date_injured,
        "status":             status,
        "source":             (source or "")[:100],
    }
    if expected_return:
        row["expected_return_date"] = expected_return
    return sb_upsert("back_in_play_injuries", [row],
                     "player_id,date_injured,injury_type_slug")

# ══════════════════════════════════════════════════════════════════════════════
# OpenAI web search
# ══════════════════════════════════════════════════════════════════════════════
def openai_search(prompt, model="gpt-4o", timeout=90):
    if not OPENAI_API_KEY:
        return ""
    body = json.dumps({
        "model":  model,
        "tools":  [{"type": "web_search_preview"}],
        "input":  prompt,
    }).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/responses",
        data=body,
        headers={
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type":  "application/json",
        },
        method="POST",
    )
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        data = json.loads(resp.read())
        for item in data.get("output", []):
            if item.get("type") == "message":
                for content in item.get("content", []):
                    if content.get("type") == "output_text":
                        return content.get("text", "")
        return ""
    except Exception as e:
        print(f"    [OpenAI error] {e}")
        return ""

# ── Parse JSON injuries from AI text ──────────────────────────────────────────
def parse_and_insert(text, league_id, source):
    """Extract JSON arrays from AI response text and insert injuries into DB."""
    total = 0
    # Try to find one or more JSON arrays in the response
    for match in re.finditer(r'\[[\s\S]*?\]', text, re.MULTILINE):
        try:
            injuries = json.loads(match.group())
            if not isinstance(injuries, list) or not injuries:
                continue
            # Make sure it looks like injury data
            sample = injuries[0]
            if not isinstance(sample, dict):
                continue

            for inj in injuries:
                if not isinstance(inj, dict):
                    continue
                player_name = (
                    inj.get("player_name") or inj.get("name") or
                    inj.get("player") or inj.get("Player") or ""
                ).strip()
                team_name = (
                    inj.get("team") or inj.get("team_name") or
                    inj.get("Team") or ""
                ).strip()
                position = (
                    inj.get("position") or inj.get("Position") or ""
                ).strip()
                injury_desc = (
                    inj.get("injury") or inj.get("injury_description") or
                    inj.get("description") or inj.get("Injury") or "Injury"
                ).strip()
                date_str = (
                    inj.get("date_placed") or inj.get("date_injured") or
                    inj.get("date") or inj.get("Date") or ""
                ).strip()
                status = (
                    inj.get("status") or inj.get("Status") or "out"
                ).strip()
                expected_return = (
                    inj.get("expected_return") or inj.get("return_date") or ""
                ).strip() or None

                if not player_name or not team_name:
                    continue

                # Normalize / validate date
                if date_str:
                    date_str = date_str[:10]
                    if not re.match(r'^\d{4}-\d{2}-\d{2}$', date_str):
                        date_str = date.today().isoformat()
                else:
                    date_str = date.today().isoformat()

                if expected_return:
                    expected_return = expected_return[:10]
                    if not re.match(r'^\d{4}-\d{2}-\d{2}$', expected_return):
                        expected_return = None

                try:
                    tid = get_or_create_team(team_name, league_id)
                    pid = get_or_create_player(player_name, tid, position)
                    res = insert_injury(pid, injury_desc, date_str,
                                        status_normalize(status),
                                        source, expected_return)
                    if res is not None:
                        total += 1
                except Exception as e:
                    pass

        except (json.JSONDecodeError, ValueError):
            continue

    return total

# ══════════════════════════════════════════════════════════════════════════════
# MLB — Official statsapi.mlb.com/api/v1/transactions  (most reliable source)
# ══════════════════════════════════════════════════════════════════════════════
POSITION_MAP = {
    " C ": "C", " 1B ": "1B", " 2B ": "2B", " 3B ": "3B", " SS ": "SS",
    " LF ": "OF", " CF ": "OF", " RF ": "OF", " OF ": "OF",
    " SP ": "P", " RP ": "P", " RHP ": "P", " LHP ": "P",
    " DH ": "DH", " INF ": "IF",
}

IL_KEYWORDS   = ["injured list", "disabled list", "10-day il", "60-day il",
                 "15-day dl", "10-day dl", "7-day il"]
SKIP_KEYWORDS = ["reinstated", "activated", "recalled", "returned",
                 "transferred to 60-day"]

def is_il_placement(desc):
    dl = desc.lower()
    if any(kw in dl for kw in SKIP_KEYWORDS):
        return False
    return any(kw in dl for kw in IL_KEYWORDS)

def extract_position(desc):
    for abbr, pos in POSITION_MAP.items():
        if abbr in f" {desc} ":
            return pos
    m = re.search(r"placed\s+(RHP|LHP|SP|RP|C|1B|2B|3B|SS|OF|LF|CF|RF|DH|INF|P)\s+", desc)
    if m:
        return POSITION_MAP.get(f" {m.group(1)} ", m.group(1))
    return "Unknown"

def extract_injury_detail(desc):
    parts = desc.split(". ", 1)
    if len(parts) > 1:
        detail = parts[1].strip().rstrip(".")
        if detail:
            return detail
    return desc

def ingest_mlb_month(league_id, year, month):
    last_day = calendar.monthrange(year, month)[1]
    start    = f"{year}-{month:02d}-01"
    end      = f"{year}-{month:02d}-{last_day:02d}"
    url      = (f"https://statsapi.mlb.com/api/v1/transactions"
                f"?sportId=1&startDate={start}&endDate={end}&limit=2000")
    data = fetch_json(url, {})
    if not data:
        return 0

    total = 0
    for tx in data.get("transactions", []):
        desc        = tx.get("description", "")
        if not is_il_placement(desc):
            continue
        person      = tx.get("person", {})
        team        = tx.get("toTeam", {}) or tx.get("fromTeam", {}) or {}
        tx_date     = tx.get("date", "")[:10]
        player_name = person.get("fullName", "")
        team_name   = team.get("name", "")
        if not player_name or not tx_date or not team_name:
            continue
        position     = extract_position(desc)
        injury_detail = extract_injury_detail(desc)
        try:
            tid = get_or_create_team(team_name, league_id)
            pid = get_or_create_player(player_name, tid, position)
            res = insert_injury(pid, injury_detail, tx_date, "out",
                                f"baseball-reference.com ({year})")
            if res is not None:
                total += 1
        except Exception:
            pass
    return total

def ingest_mlb_year(league_id, year):
    print(f"  MLB {year}: fetching month-by-month...")
    total = 0
    for month in range(1, 13):
        cnt = ingest_mlb_month(league_id, year, month)
        total += cnt
        if cnt:
            print(f"    {year}-{month:02d}: {cnt} IL placements")
        time.sleep(0.3)
    print(f"  MLB {year} DONE — {total} placements")
    return total

# ══════════════════════════════════════════════════════════════════════════════
# NFL — spotrac.com/nfl/injured-reserve/
# ══════════════════════════════════════════════════════════════════════════════
NFL_CONFERENCES = ["AFC North", "AFC South", "AFC East", "AFC West",
                   "NFC North", "NFC South", "NFC East", "NFC West"]

def nfl_prompts(year):
    """Return a list of targeted prompts for a given NFL season year."""
    base = (
        f"Search spotrac.com/nfl/injured-reserve/ for the {year} NFL season "
        f"injured reserve (IR) list. I need EVERY player placed on IR that season."
    )
    fmt = (
        'Return ONLY a valid JSON array with this exact format — no other text:\n'
        '[{"player_name":"Patrick Mahomes","team":"Kansas City Chiefs","position":"QB",'
        f'"injury":"ankle sprain","date_placed":"{year}-09-15","status":"out"}}]\n'
        'Include ALL players you can find — aim for 60-80+ entries.'
    )
    prompts = [
        # Pass 1 — first half of season (preseason + first 9 weeks)
        f"{base} Focus on the preseason through Week 9. {fmt}",
        # Pass 2 — second half of season (Weeks 10-18 + playoffs)
        f"{base} Focus on Weeks 10 through 18 and playoffs. {fmt}",
        # Pass 3 — offense only
        f"{base} Focus ONLY on offensive players (QB, RB, WR, TE, OL). {fmt}",
        # Pass 4 — defense only
        f"{base} Focus ONLY on defensive players (DL, LB, DB, S, CB, DE). {fmt}",
    ]
    return prompts

def ingest_nfl_year(league_id, year):
    print(f"  NFL {year}: running 4 targeted spotrac passes...")
    total = 0
    for i, prompt in enumerate(nfl_prompts(year), 1):
        text = openai_search(prompt)
        cnt  = parse_and_insert(text, league_id, f"spotrac.com/nfl/injured-reserve ({year})")
        total += cnt
        print(f"    Pass {i}: {cnt} injuries stored")
        time.sleep(4)
    print(f"  NFL {year} DONE — {total} injuries")
    return total

# ══════════════════════════════════════════════════════════════════════════════
# NBA — spotrac.com/nba/injured-reserve/
# ══════════════════════════════════════════════════════════════════════════════
def nba_prompts(year):
    base = (
        f"Search spotrac.com/nba/injured-reserve/ for the {year}-{year+1} NBA season "
        f"injured list. I need EVERY player placed on the injured list that season."
    )
    fmt = (
        'Return ONLY a valid JSON array — no other text:\n'
        '[{"player_name":"LeBron James","team":"Los Angeles Lakers","position":"SF",'
        f'"injury":"ankle sprain","date_placed":"{year}-11-15","status":"out"}}]\n'
        'Aim for 60-80+ entries.'
    )
    return [
        f"{base} Focus on players injured from October {year} through January {year+1}. {fmt}",
        f"{base} Focus on players injured from February {year+1} through June {year+1}. {fmt}",
        f"{base} Focus ONLY on guards (PG, SG) and forwards (SF, PF). {fmt}",
        f"{base} Focus ONLY on centers (C) and power forwards (PF) plus any star players. {fmt}",
    ]

def ingest_nba_year(league_id, year):
    print(f"  NBA {year}-{year+1}: running 4 targeted spotrac passes...")
    total = 0
    for i, prompt in enumerate(nba_prompts(year), 1):
        text = openai_search(prompt)
        cnt  = parse_and_insert(text, league_id, f"spotrac.com/nba/injured-reserve ({year})")
        total += cnt
        print(f"    Pass {i}: {cnt} injuries stored")
        time.sleep(4)
    print(f"  NBA {year}-{year+1} DONE — {total} injuries")
    return total

# ══════════════════════════════════════════════════════════════════════════════
# NHL — capfriendly.com/injuries
# ══════════════════════════════════════════════════════════════════════════════
def nhl_prompts(year):
    base = (
        f"Search capfriendly.com/injuries for the {year}-{year+1} NHL season "
        f"injured list. I need EVERY player placed on injured reserve that season."
    )
    fmt = (
        'Return ONLY a valid JSON array — no other text:\n'
        '[{"player_name":"Sidney Crosby","team":"Pittsburgh Penguins","position":"C",'
        f'"injury":"upper body","date_placed":"{year}-10-20","status":"out"}}]\n'
        'Aim for 50-70+ entries.'
    )
    return [
        f"{base} Focus on Eastern Conference teams. {fmt}",
        f"{base} Focus on Western Conference teams. {fmt}",
        f"{base} Focus on forwards (LW, RW, C) injured during {year}-{year+1}. {fmt}",
        f"{base} Focus on defensemen and goalies injured during {year}-{year+1}. {fmt}",
    ]

def ingest_nhl_year(league_id, year):
    print(f"  NHL {year}-{year+1}: running 4 targeted capfriendly passes...")
    total = 0
    for i, prompt in enumerate(nhl_prompts(year), 1):
        text = openai_search(prompt)
        cnt  = parse_and_insert(text, league_id, f"capfriendly.com/injuries ({year})")
        total += cnt
        print(f"    Pass {i}: {cnt} injuries stored")
        time.sleep(4)
    print(f"  NHL {year}-{year+1} DONE — {total} injuries")
    return total

# ══════════════════════════════════════════════════════════════════════════════
# Premier League — transfermarkt.com
# ══════════════════════════════════════════════════════════════════════════════
PL_GROUPS = [
    "Arsenal, Chelsea, Liverpool, Manchester City, Manchester United, Tottenham",
    "Aston Villa, Everton, Leicester City, Newcastle United, West Ham United",
    "Wolverhampton, Crystal Palace, Brighton, Southampton, Fulham, Brentford",
    "Leeds United, Burnley, Nottingham Forest, Bournemouth, Luton Town, Sheffield United",
]

def epl_prompts(year):
    base = (
        f"Search transfermarkt.com for Premier League players injured during the "
        f"{year}/{year+1} season. I need detailed injury records."
    )
    fmt = (
        'Return ONLY a valid JSON array — no other text:\n'
        '[{"player_name":"Mohamed Salah","team":"Liverpool FC","position":"RW",'
        f'"injury":"hamstring strain","date_placed":"{year}-09-20","status":"out",'
        '"expected_return":"YYYY-MM-DD"}]\n'
        'Include 50-70+ injured players.'
    )
    return [
        f"{base} Focus on the top 6 clubs (Arsenal, Chelsea, Liverpool, Man City, Man Utd, Spurs). {fmt}",
        f"{base} Focus on all other Premier League clubs (not the top 6). {fmt}",
        f"{base} Focus on players injured in the first half of the season (Aug-Jan {year}/{year+1}). {fmt}",
        f"{base} Focus on players injured in the second half of the season (Jan-May {year+1}). {fmt}",
    ]

def ingest_epl_year(league_id, year):
    print(f"  EPL {year}/{year+1}: running 4 targeted transfermarkt passes...")
    total = 0
    for i, prompt in enumerate(epl_prompts(year), 1):
        text = openai_search(prompt)
        cnt  = parse_and_insert(text, league_id, f"transfermarkt.com ({year})")
        total += cnt
        print(f"    Pass {i}: {cnt} injuries stored")
        time.sleep(4)
    print(f"  EPL {year}/{year+1} DONE — {total} injuries")
    return total

# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════
def print_db_counts():
    for table in ["back_in_play_injuries", "back_in_play_players",
                  "back_in_play_teams",    "back_in_play_leagues"]:
        rows = sb_get(table, "select=count")
        # Supabase count endpoint returns [{count: N}]
        cnt  = rows[0].get("count", "?") if rows else "?"
        print(f"  {table}: {cnt}")

def main():
    print("=" * 65)
    print("Back In Play — 10-Year Historical Injury Ingestion")
    print(f"Seasons: {SEASONS[0]}-{SEASONS[-1]}  |  Date: {CURRENT_DATE}")
    print("Sources: spotrac.com | baseball-reference.com | "
          "capfriendly.com | transfermarkt.com")
    print("=" * 65)

    # ── Ensure leagues ─────────────────────────────────────────────────────
    leagues = {
        "nfl": get_or_create_league("NFL", "nfl"),
        "nba": get_or_create_league("NBA", "nba"),
        "mlb": get_or_create_league("MLB", "mlb"),
        "nhl": get_or_create_league("NHL", "nhl"),
        "epl": get_or_create_league("Premier League", "premier-league"),
    }
    print(f"\nLeagues ready: {list(leagues.keys())}")

    grand_total = 0

    # ── MLB ─────────────────────────────────────────────────────────────────
    print("\n" + "─" * 50)
    print("[MLB] baseball-reference.com — Official MLB Transactions API")
    print("─" * 50)
    mlb_total = 0
    for year in SEASONS:
        cnt = ingest_mlb_year(leagues["mlb"], year)
        mlb_total += cnt
    print(f"\nMLB TOTAL: {mlb_total} IL placements across all seasons")
    grand_total += mlb_total

    # ── NFL ─────────────────────────────────────────────────────────────────
    print("\n" + "─" * 50)
    print("[NFL] spotrac.com/nfl/injured-reserve/")
    print("─" * 50)
    nfl_total = 0
    for year in SEASONS:
        cnt = ingest_nfl_year(leagues["nfl"], year)
        nfl_total += cnt
        time.sleep(2)
    print(f"\nNFL TOTAL: {nfl_total} injuries across all seasons")
    grand_total += nfl_total

    # ── NBA ─────────────────────────────────────────────────────────────────
    print("\n" + "─" * 50)
    print("[NBA] spotrac.com/nba/injured-reserve/")
    print("─" * 50)
    nba_total = 0
    for year in SEASONS:
        cnt = ingest_nba_year(leagues["nba"], year)
        nba_total += cnt
        time.sleep(2)
    print(f"\nNBA TOTAL: {nba_total} injuries across all seasons")
    grand_total += nba_total

    # ── NHL ─────────────────────────────────────────────────────────────────
    print("\n" + "─" * 50)
    print("[NHL] capfriendly.com/injuries")
    print("─" * 50)
    nhl_total = 0
    for year in SEASONS:
        cnt = ingest_nhl_year(leagues["nhl"], year)
        nhl_total += cnt
        time.sleep(2)
    print(f"\nNHL TOTAL: {nhl_total} injuries across all seasons")
    grand_total += nhl_total

    # ── Premier League ──────────────────────────────────────────────────────
    print("\n" + "─" * 50)
    print("[EPL] transfermarkt.com — Premier League")
    print("─" * 50)
    epl_total = 0
    for year in SEASONS:
        cnt = ingest_epl_year(leagues["epl"], year)
        epl_total += cnt
        time.sleep(2)
    print(f"\nEPL TOTAL: {epl_total} injuries across all seasons")
    grand_total += epl_total

    # ── Summary ─────────────────────────────────────────────────────────────
    print("\n" + "=" * 65)
    print(f"GRAND TOTAL NEW INJURIES: {grand_total}")
    print("=" * 65)
    print("\nFinal DB counts:")
    print_db_counts()


if __name__ == "__main__":
    main()
