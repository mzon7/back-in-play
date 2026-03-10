#!/usr/bin/env python3
"""
COMPREHENSIVE 10-Year Injury Ingestion — Back In Play
======================================================
Strategy: Team-by-team targeted OpenAI web searches pointing at the exact
user-specified sources:
  NFL  → spotrac.com/nfl/injured-reserve/
  NBA  → spotrac.com/nba/injured-reserve/
  MLB  → statsapi.mlb.com (official MLB transactions — exhaustive)
  NHL  → capfriendly.com/injuries
  EPL  → transfermarkt.com

Seasons: 2015 through 2025-26 (10 full years).

Key improvement over previous scripts:
  • Queries by TEAM (4-team groups) — much more targeted than time/position passes
  • Each query explicitly references the target URL
  • Requests 40-60+ players per group query
  • Uses upserts — safe to re-run (no duplicates)
"""

import json, os, re, sys, time, calendar, urllib.request, urllib.parse, urllib.error
from datetime import date

# ── Config ────────────────────────────────────────────────────────────────────
SUPABASE_URL   = os.environ["SUPABASE_URL"]
SUPABASE_KEY   = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")

SEASONS      = list(range(2015, 2026))   # 2015 → 2025 (11 seasons)
TODAY        = "2026-03-10"

# ── NFL Teams ─────────────────────────────────────────────────────────────────
NFL_TEAM_GROUPS = [
    ["Kansas City Chiefs", "Las Vegas Raiders", "Los Angeles Chargers", "Denver Broncos"],
    ["New England Patriots", "Buffalo Bills", "Miami Dolphins", "New York Jets"],
    ["Baltimore Ravens", "Pittsburgh Steelers", "Cleveland Browns", "Cincinnati Bengals"],
    ["Houston Texans", "Indianapolis Colts", "Tennessee Titans", "Jacksonville Jaguars"],
    ["Dallas Cowboys", "Philadelphia Eagles", "New York Giants", "Washington Commanders"],
    ["Green Bay Packers", "Minnesota Vikings", "Detroit Lions", "Chicago Bears"],
    ["San Francisco 49ers", "Los Angeles Rams", "Seattle Seahawks", "Arizona Cardinals"],
    ["New Orleans Saints", "Atlanta Falcons", "Carolina Panthers", "Tampa Bay Buccaneers"],
]

# ── NBA Teams ─────────────────────────────────────────────────────────────────
NBA_TEAM_GROUPS = [
    ["Boston Celtics", "Brooklyn Nets", "New York Knicks", "Philadelphia 76ers", "Toronto Raptors"],
    ["Chicago Bulls", "Cleveland Cavaliers", "Detroit Pistons", "Indiana Pacers", "Milwaukee Bucks"],
    ["Atlanta Hawks", "Charlotte Hornets", "Miami Heat", "Orlando Magic", "Washington Wizards"],
    ["Denver Nuggets", "Minnesota Timberwolves", "Oklahoma City Thunder", "Portland Trail Blazers", "Utah Jazz"],
    ["Golden State Warriors", "Los Angeles Clippers", "Los Angeles Lakers", "Phoenix Suns", "Sacramento Kings"],
    ["Dallas Mavericks", "Houston Rockets", "Memphis Grizzlies", "New Orleans Pelicans", "San Antonio Spurs"],
]

# ── NHL Teams ─────────────────────────────────────────────────────────────────
NHL_TEAM_GROUPS = [
    ["Boston Bruins", "Buffalo Sabres", "Detroit Red Wings", "Florida Panthers"],
    ["Montreal Canadiens", "Ottawa Senators", "Tampa Bay Lightning", "Toronto Maple Leafs"],
    ["Carolina Hurricanes", "Columbus Blue Jackets", "New Jersey Devils", "New York Islanders"],
    ["New York Rangers", "Philadelphia Flyers", "Pittsburgh Penguins", "Washington Capitals"],
    ["Anaheim Ducks", "Arizona Coyotes", "Calgary Flames", "Colorado Avalanche"],
    ["Edmonton Oilers", "Los Angeles Kings", "Minnesota Wild", "Nashville Predators"],
    ["San Jose Sharks", "Seattle Kraken", "St. Louis Blues", "Vancouver Canucks"],
    ["Vegas Golden Knights", "Winnipeg Jets", "Dallas Stars", "Chicago Blackhawks"],
]

# ── Premier League Clubs ──────────────────────────────────────────────────────
EPL_TEAM_GROUPS = [
    ["Arsenal", "Chelsea", "Liverpool", "Manchester City"],
    ["Manchester United", "Tottenham Hotspur", "Aston Villa", "Newcastle United"],
    ["Everton", "Leicester City", "Leeds United", "West Ham United"],
    ["Wolverhampton Wanderers", "Crystal Palace", "Brighton & Hove Albion", "Southampton"],
    ["Fulham", "Brentford", "Nottingham Forest", "Bournemouth"],
]

# ── MLB Position/Injury helpers ──────────────────────────────────────────────
IL_KEYWORDS   = ["injured list", "disabled list", "10-day il", "60-day il",
                 "15-day dl", "10-day dl", "7-day il"]
SKIP_KEYWORDS = ["reinstated", "activated", "recalled", "returned",
                 "transferred to 60-day"]

POSITION_MAP = {
    " C ": "C", " 1B ": "1B", " 2B ": "2B", " 3B ": "3B", " SS ": "SS",
    " LF ": "OF", " CF ": "OF", " RF ": "OF", " OF ": "OF",
    " SP ": "P", " RP ": "P", " RHP ": "P", " LHP ": "P",
    " DH ": "DH", " INF ": "IF",
}

INJURY_CHECKS = [
    (["acl", "anterior cruciate"],                          "acl",        "ACL Tear"),
    (["mcl", "medial collateral"],                          "mcl",        "MCL Injury"),
    (["pcl", "posterior cruciate"],                         "pcl",        "PCL Injury"),
    (["hamstring"],                                         "hamstring",  "Hamstring"),
    (["quadricep", "quad "],                                "quadricep",  "Quadricep"),
    (["calf", "gastrocnemius"],                             "calf",       "Calf"),
    (["groin", "adductor"],                                 "groin",      "Groin"),
    (["achilles"],                                          "achilles",   "Achilles"),
    (["knee"],                                              "knee",       "Knee"),
    (["ankle"],                                             "ankle",      "Ankle"),
    (["foot", "plantar", "heel", "toe", "hamate"],          "foot",       "Foot"),
    (["shin", "tibia", "fibula"],                           "shin",       "Shin/Leg"),
    (["hip flexor"],                                        "hip-flexor", "Hip Flexor"),
    (["hip"],                                               "hip",        "Hip"),
    (["shoulder", "rotator", "labrum", "clavicle", "collarbone"], "shoulder", "Shoulder"),
    (["elbow", "ulnar", "ucl", "tommy john"],               "elbow",      "Elbow"),
    (["wrist"],                                             "wrist",      "Wrist"),
    (["hand", "finger", "thumb"],                           "hand",       "Hand/Finger"),
    (["forearm"],                                           "forearm",    "Forearm"),
    (["oblique"],                                           "oblique",    "Oblique"),
    (["back", "lumbar", "spine", "disc", "vertebra"],       "back",       "Back/Spine"),
    (["neck", "cervical"],                                  "neck",       "Neck"),
    (["rib", "chest", "pectoral", "sternum"],               "chest",      "Chest/Ribs"),
    (["concussion", "head trauma", "tbi"],                  "concussion", "Concussion"),
    (["abdominal", "abdomen", "hernia"],                    "abdominal",  "Abdominal"),
    (["illness", "flu", "covid", "virus", "non-covid"],     "illness",    "Illness"),
    (["personal"],                                          "personal",   "Personal"),
    (["upper body"],                                        "upper-body", "Upper Body"),
    (["lower body"],                                        "lower-body", "Lower Body"),
    (["strain"],                                            "strain",     "Strain"),
    (["sprain"],                                            "sprain",     "Sprain"),
    (["fracture", "broken", "break"],                       "fracture",   "Fracture"),
    (["torn", "tear"],                                      "tear",       "Tear"),
    (["bruise", "contusion"],                               "contusion",  "Contusion"),
    (["surgery", "surgical", "post-op", "rehab"],           "surgery",    "Surgery/Rehab"),
]

def injury_type_from_desc(desc):
    d = (desc or "").lower()
    for keywords, slug, label in INJURY_CHECKS:
        if any(kw in d for kw in keywords):
            return slug, label
    return "other", "Other"

def status_normalize(status):
    s = (status or "").lower()
    if any(x in s for x in ["out", "ir", "injured reserve", "reserve", "il", "day-to-day", "dtd"]):
        return "out"
    if "doubtful" in s:
        return "doubtful"
    if "questionable" in s:
        return "questionable"
    if "probable" in s:
        return "probable"
    if any(x in s for x in ["active", "return", "healthy", "reinstated"]):
        return "returned"
    return "out"

# ── Supabase ──────────────────────────────────────────────────────────────────
def sb_request(method, path, body=None):
    # Encode URL with proper handling of non-ASCII characters
    url  = f"{SUPABASE_URL}/rest/v1/{path}".encode("utf-8").decode("ascii", errors="replace")
    try:
        url = f"{SUPABASE_URL}/rest/v1/{urllib.parse.quote(path, safe='=&?/,.:@!$\'()*+;')}"
    except Exception:
        url = f"{SUPABASE_URL}/rest/v1/{path}"
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body else None
    hdrs = {
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type":  "application/json; charset=utf-8",
        "Prefer":        "resolution=merge-duplicates,return=representation",
    }
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        raw  = resp.read()
        return json.loads(raw) if raw else []
    except urllib.error.HTTPError as e:
        err = e.read().decode()[:300]
        if "duplicate" in err.lower() or "unique" in err.lower():
            return []
        print(f"  [SB ERR] {method} {path[:80]}: {e.code} - {err[:100]}", flush=True)
        return None
    except Exception as e:
        print(f"  [SB ERR] {e}", flush=True)
        return None

def sb_upsert(table, rows, conflict=None):
    if not rows:
        return []
    path = f"{table}?on_conflict={conflict}" if conflict else table
    return sb_request("POST", path, rows)

def sb_get(table, params=""):
    return sb_request("GET", f"{table}?{params}") or []

# ── DB caches ─────────────────────────────────────────────────────────────────
LEAGUE_CACHE = {}
TEAM_CACHE   = {}
PLAYER_CACHE = {}

def get_or_create_league(name, slug):
    if slug in LEAGUE_CACHE:
        return LEAGUE_CACHE[slug]
    r = sb_upsert("back_in_play_leagues", [{"league_name": name, "slug": slug}], "slug")
    if r:
        LEAGUE_CACHE[slug] = r[0]["league_id"]
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
    r = sb_upsert("back_in_play_teams",
                  [{"team_name": team_name, "league_id": league_id}],
                  "team_name,league_id")
    if r:
        TEAM_CACHE[key] = r[0]["team_id"]
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
    r = sb_upsert("back_in_play_players", [{
        "player_name": player_name,
        "team_id":     team_id,
        "position":    position or "Unknown",
        "slug":        slug,
    }], "slug")
    if r:
        PLAYER_CACHE[key] = r[0]["player_id"]
        return PLAYER_CACHE[key]
    rows = sb_get("back_in_play_players", f"slug=eq.{slug}&select=player_id")
    if rows:
        PLAYER_CACHE[key] = rows[0]["player_id"]
        return PLAYER_CACHE[key]
    raise Exception(f"Cannot create player {player_name}")

def insert_injury(player_id, desc, date_injured, status="out",
                  source="", expected_return=None):
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

def slugify(text):
    t = text.lower().strip()
    t = re.sub(r"[^\w\s-]", "", t)
    t = re.sub(r"[\s_-]+", "-", t)
    return t.strip("-")

# ── OpenAI web search ─────────────────────────────────────────────────────────
def openai_search(prompt, timeout=120):
    if not OPENAI_API_KEY:
        return ""
    body = json.dumps({
        "model":  "gpt-4o",
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
        print(f"    [OpenAI err] {e}", flush=True)
        return ""

# ── Parse and insert ──────────────────────────────────────────────────────────
def parse_and_insert(text, league_id, source):
    total = 0
    for match in re.finditer(r'\[[\s\S]*?\]', text, re.MULTILINE):
        try:
            injuries = json.loads(match.group())
            if not isinstance(injuries, list) or not injuries:
                continue
            if not isinstance(injuries[0], dict):
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
                position = (inj.get("position") or inj.get("Position") or "").strip()
                injury_desc = (
                    inj.get("injury") or inj.get("injury_description") or
                    inj.get("description") or inj.get("Injury") or "Injury"
                ).strip()
                date_str = (
                    inj.get("date_placed") or inj.get("date_injured") or
                    inj.get("date") or inj.get("Date") or ""
                ).strip()
                status = (inj.get("status") or inj.get("Status") or "out").strip()
                expected_return = (
                    inj.get("expected_return") or inj.get("return_date") or ""
                ).strip() or None

                if not player_name or not team_name:
                    continue

                # Validate/normalize date
                date_str = date_str[:10] if date_str else ""
                if not re.match(r'^\d{4}-\d{2}-\d{2}$', date_str):
                    date_str = date.today().isoformat()
                if expected_return:
                    expected_return = expected_return[:10]
                    if not re.match(r'^\d{4}-\d{2}-\d{2}$', expected_return):
                        expected_return = None

                try:
                    tid = get_or_create_team(team_name, league_id)
                    pid = get_or_create_player(player_name, tid, position)
                    r   = insert_injury(pid, injury_desc, date_str,
                                        status_normalize(status), source,
                                        expected_return)
                    if r is not None:
                        total += 1
                except Exception:
                    pass
        except (json.JSONDecodeError, ValueError):
            continue
    return total

# ══════════════════════════════════════════════════════════════════════════════
# MLB — Official statsapi.mlb.com (exhaustive ground-truth data)
# ══════════════════════════════════════════════════════════════════════════════
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
    try:
        req  = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        resp = urllib.request.urlopen(req, timeout=25)
        data = json.loads(resp.read())
    except Exception:
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
            r   = insert_injury(pid, injury_detail, tx_date, "out",
                                f"statsapi.mlb.com ({year})")
            if r is not None:
                total += 1
        except Exception:
            pass
    return total

def ingest_mlb_year(league_id, year):
    print(f"  MLB {year}: fetching month-by-month from statsapi.mlb.com...", flush=True)
    total = 0
    for month in range(1, 13):
        cnt    = ingest_mlb_month(league_id, year, month)
        total += cnt
        if cnt:
            print(f"    {year}-{month:02d}: {cnt} IL placements", flush=True)
        time.sleep(0.3)
    print(f"  MLB {year} DONE — {total} placements", flush=True)
    return total

# ══════════════════════════════════════════════════════════════════════════════
# NFL — spotrac.com/nfl/injured-reserve/ (team-by-team)
# ══════════════════════════════════════════════════════════════════════════════
def nfl_team_group_prompt(year, teams):
    team_list = ", ".join(teams)
    return (
        f"Search spotrac.com/nfl/injured-reserve/ for ALL players placed on the "
        f"NFL injured reserve (IR) list during the {year} NFL season for these teams: "
        f"{team_list}. "
        f"Include EVERY player placed on IR regardless of when in the season. "
        f"Return ONLY a valid JSON array — no other text:\n"
        f'[{{"player_name":"Patrick Mahomes","team":"Kansas City Chiefs","position":"QB",'
        f'"injury":"ankle sprain","date_placed":"{year}-09-15","status":"out"}}]\n'
        f"Include ALL players you can find for these teams (aim for 15-25 per team)."
    )

def ingest_nfl_year(league_id, year):
    print(f"  NFL {year}: team-by-team spotrac queries ({len(NFL_TEAM_GROUPS)} groups)...", flush=True)
    total = 0
    for i, teams in enumerate(NFL_TEAM_GROUPS, 1):
        prompt = nfl_team_group_prompt(year, teams)
        text   = openai_search(prompt)
        cnt    = parse_and_insert(text, league_id, f"spotrac.com/nfl/injured-reserve ({year})")
        total += cnt
        print(f"    Group {i} ({teams[0]} div): {cnt} injuries", flush=True)
        time.sleep(3)
    print(f"  NFL {year} DONE — {total} injuries", flush=True)
    return total

# ══════════════════════════════════════════════════════════════════════════════
# NBA — spotrac.com/nba/injured-reserve/ (team-by-team)
# ══════════════════════════════════════════════════════════════════════════════
def nba_team_group_prompt(year, teams):
    team_list = ", ".join(teams)
    return (
        f"Search spotrac.com/nba/injured-reserve/ for ALL players on the NBA injured "
        f"list during the {year}-{year+1} NBA season for these teams: {team_list}. "
        f"Include every player who appeared on the injury report that season. "
        f"Return ONLY a valid JSON array — no other text:\n"
        f'[{{"player_name":"LeBron James","team":"Los Angeles Lakers","position":"SF",'
        f'"injury":"ankle sprain","date_placed":"{year}-11-05","status":"out"}}]\n'
        f"Aim for 10-20 players per team listed."
    )

def ingest_nba_year(league_id, year):
    print(f"  NBA {year}-{year+1}: team-by-team spotrac queries ({len(NBA_TEAM_GROUPS)} groups)...", flush=True)
    total = 0
    for i, teams in enumerate(NBA_TEAM_GROUPS, 1):
        prompt = nba_team_group_prompt(year, teams)
        text   = openai_search(prompt)
        cnt    = parse_and_insert(text, league_id, f"spotrac.com/nba/injured-reserve ({year})")
        total += cnt
        print(f"    Group {i} ({teams[0]} conf): {cnt} injuries", flush=True)
        time.sleep(3)
    print(f"  NBA {year}-{year+1} DONE — {total} injuries", flush=True)
    return total

# ══════════════════════════════════════════════════════════════════════════════
# NHL — capfriendly.com/injuries (team-by-team)
# ══════════════════════════════════════════════════════════════════════════════
def nhl_team_group_prompt(year, teams):
    team_list = ", ".join(teams)
    return (
        f"Search capfriendly.com/injuries for ALL NHL players on injured reserve "
        f"during the {year}-{year+1} NHL season for these teams: {team_list}. "
        f"Include every player who was placed on IR/LTIR that season. "
        f"Return ONLY a valid JSON array — no other text:\n"
        f'[{{"player_name":"Sidney Crosby","team":"Pittsburgh Penguins","position":"C",'
        f'"injury":"concussion","date_placed":"{year}-10-15","status":"out"}}]\n'
        f"Aim for 8-15 players per team listed."
    )

def ingest_nhl_year(league_id, year):
    print(f"  NHL {year}-{year+1}: team-by-team capfriendly queries ({len(NHL_TEAM_GROUPS)} groups)...", flush=True)
    total = 0
    for i, teams in enumerate(NHL_TEAM_GROUPS, 1):
        prompt = nhl_team_group_prompt(year, teams)
        text   = openai_search(prompt)
        cnt    = parse_and_insert(text, league_id, f"capfriendly.com/injuries ({year})")
        total += cnt
        print(f"    Group {i} ({teams[0]} div): {cnt} injuries", flush=True)
        time.sleep(3)
    print(f"  NHL {year}-{year+1} DONE — {total} injuries", flush=True)
    return total

# ══════════════════════════════════════════════════════════════════════════════
# Premier League — transfermarkt.com (club-by-club)
# ══════════════════════════════════════════════════════════════════════════════
def epl_club_group_prompt(year, clubs):
    club_list = ", ".join(clubs)
    return (
        f"Search transfermarkt.com for ALL Premier League players injured during "
        f"the {year}/{year+1} season for these clubs: {club_list}. "
        f"Use transfermarkt.com injury history pages for each club. "
        f"Include every player who missed matches due to injury that season. "
        f"Return ONLY a valid JSON array — no other text:\n"
        f'[{{"player_name":"Mohamed Salah","team":"Liverpool","position":"RW",'
        f'"injury":"hamstring strain","date_placed":"{year}-10-05","status":"out",'
        f'"expected_return":"{year+1}-01-15"}}]\n'
        f"Aim for 10-20 players per club listed."
    )

def ingest_epl_year(league_id, year):
    print(f"  EPL {year}/{year+1}: club-by-club transfermarkt queries ({len(EPL_TEAM_GROUPS)} groups)...", flush=True)
    total = 0
    for i, clubs in enumerate(EPL_TEAM_GROUPS, 1):
        prompt = epl_club_group_prompt(year, clubs)
        text   = openai_search(prompt)
        cnt    = parse_and_insert(text, league_id, f"transfermarkt.com ({year})")
        total += cnt
        print(f"    Group {i} ({clubs[0]} group): {cnt} injuries", flush=True)
        time.sleep(3)
    print(f"  EPL {year}/{year+1} DONE — {total} injuries", flush=True)
    return total

# ══════════════════════════════════════════════════════════════════════════════
# DB counts helper
# ══════════════════════════════════════════════════════════════════════════════
def print_db_counts():
    for table in ["back_in_play_injuries", "back_in_play_players",
                  "back_in_play_teams",    "back_in_play_leagues"]:
        rows = sb_get(table, "select=count")
        cnt  = rows[0].get("count", "?") if rows else "?"
        print(f"  {table}: {cnt}", flush=True)

# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════
def main():
    # Allow overriding which league to run via CLI arg: python3 script.py nfl
    target = sys.argv[1].lower() if len(sys.argv) > 1 else "all"

    print("=" * 70, flush=True)
    print("Back In Play — Comprehensive 10-Year Injury Ingestion (Team-by-Team)", flush=True)
    print(f"Seasons: {SEASONS[0]}–{SEASONS[-1]}  |  Target: {target}  |  Date: {TODAY}", flush=True)
    print("Sources: spotrac.com | statsapi.mlb.com | capfriendly.com | transfermarkt.com", flush=True)
    print("=" * 70, flush=True)

    leagues = {
        "nfl": get_or_create_league("NFL", "nfl"),
        "nba": get_or_create_league("NBA", "nba"),
        "mlb": get_or_create_league("MLB", "mlb"),
        "nhl": get_or_create_league("NHL", "nhl"),
        "epl": get_or_create_league("Premier League", "premier-league"),
    }
    print(f"Leagues ready: {list(leagues.keys())}", flush=True)

    grand_total = 0

    # ── MLB ───────────────────────────────────────────────────────────────────
    if target in ("all", "mlb"):
        print("\n" + "─" * 60, flush=True)
        print("[MLB] statsapi.mlb.com — official transactions (exhaustive)", flush=True)
        mlb_total = 0
        for year in SEASONS:
            mlb_total += ingest_mlb_year(leagues["mlb"], year)
        print(f"\nMLB TOTAL: {mlb_total} IL placements", flush=True)
        grand_total += mlb_total

    # ── NFL ───────────────────────────────────────────────────────────────────
    if target in ("all", "nfl"):
        print("\n" + "─" * 60, flush=True)
        print("[NFL] spotrac.com/nfl/injured-reserve/ — team-by-team", flush=True)
        nfl_total = 0
        for year in SEASONS:
            nfl_total += ingest_nfl_year(leagues["nfl"], year)
            time.sleep(2)
        print(f"\nNFL TOTAL: {nfl_total} injuries", flush=True)
        grand_total += nfl_total

    # ── NBA ───────────────────────────────────────────────────────────────────
    if target in ("all", "nba"):
        print("\n" + "─" * 60, flush=True)
        print("[NBA] spotrac.com/nba/injured-reserve/ — team-by-team", flush=True)
        nba_total = 0
        for year in SEASONS:
            nba_total += ingest_nba_year(leagues["nba"], year)
            time.sleep(2)
        print(f"\nNBA TOTAL: {nba_total} injuries", flush=True)
        grand_total += nba_total

    # ── NHL ───────────────────────────────────────────────────────────────────
    if target in ("all", "nhl"):
        print("\n" + "─" * 60, flush=True)
        print("[NHL] capfriendly.com/injuries — team-by-team", flush=True)
        nhl_total = 0
        for year in SEASONS:
            nhl_total += ingest_nhl_year(leagues["nhl"], year)
            time.sleep(2)
        print(f"\nNHL TOTAL: {nhl_total} injuries", flush=True)
        grand_total += nhl_total

    # ── EPL ───────────────────────────────────────────────────────────────────
    if target in ("all", "epl"):
        print("\n" + "─" * 60, flush=True)
        print("[EPL] transfermarkt.com — club-by-club", flush=True)
        epl_total = 0
        for year in SEASONS:
            epl_total += ingest_epl_year(leagues["epl"], year)
            time.sleep(2)
        print(f"\nEPL TOTAL: {epl_total} injuries", flush=True)
        grand_total += epl_total

    # ── Final summary ─────────────────────────────────────────────────────────
    print("\n" + "=" * 70, flush=True)
    print(f"GRAND TOTAL NEW INJURIES ADDED: {grand_total}", flush=True)
    print("=" * 70, flush=True)
    print("\nFinal DB counts:", flush=True)
    print_db_counts()


if __name__ == "__main__":
    main()
