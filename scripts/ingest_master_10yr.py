#!/usr/bin/env python3
"""
Back In Play — Master 10-Year Historical Injury Ingestion
==========================================================
Sources:
  NFL  → spotrac.com/nfl/injured-reserve/        (via OpenAI web search)
  NBA  → spotrac.com/nba/injured-reserve/        (via OpenAI web search)
  MLB  → statsapi.mlb.com + baseball-reference   (official MLB Transactions API)
  NHL  → capfriendly.com/injuries                (via OpenAI web search)
  EPL  → transfermarkt.com                       (via OpenAI web search)

Seasons: 2015 through 2025 (10+ seasons).

Strategy:
  - MLB: Direct API, exhaustive IL placements month-by-month
  - Others: Multiple targeted OpenAI web_search_preview passes per season
    * 6 passes per league-year (by team group / time period / position group)
    * Explicitly references the target URL in every prompt
    * Requests 60-80+ players per query

Safely re-runnable — all writes use upsert with conflict guards.
"""

import json, os, re, sys, time, calendar, urllib.request, urllib.parse, urllib.error
from datetime import date

# ── Config ─────────────────────────────────────────────────────────────────────
SUPABASE_URL   = os.environ["SUPABASE_URL"]
SUPABASE_KEY   = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")

_start = int(os.environ.get("START_YEAR", "2015"))
_end   = int(os.environ.get("END_YEAR",   "2025"))
SEASONS     = list(range(_start, _end + 1))
TODAY       = date.today().isoformat()

SKIP_LEAGUE = os.environ.get("SKIP_LEAGUE", "").upper().split(",")  # e.g. "NFL,MLB"
ONLY_LEAGUE = os.environ.get("ONLY_LEAGUE", "").upper().split(",")  # e.g. "NHL,EPL"

# ── Supabase helpers ───────────────────────────────────────────────────────────
def sb_headers(extra=None):
    h = {
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates,return=representation",
    }
    if extra:
        h.update(extra)
    return h

def sb_request(method, path, body=None):
    url  = f"{SUPABASE_URL}/rest/v1/{path}"
    data = json.dumps(body).encode() if body else None
    req  = urllib.request.Request(url, data=data, headers=sb_headers(), method=method)
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        raw  = resp.read()
        return json.loads(raw) if raw else []
    except urllib.error.HTTPError as e:
        err = e.read().decode()[:400]
        if "duplicate" in err.lower() or "unique" in err.lower():
            return []
        print(f"  [SB ERR] {method} {path[:80]}: {e.code} — {err[:200]}")
        return None
    except Exception as ex:
        print(f"  [SB ERR] {method} {path[:80]}: {ex}")
        return None

def sb_upsert(table, rows, conflict=None):
    if not rows:
        return []
    path = f"{table}?on_conflict={conflict}" if conflict else table
    # Chunk at 500 rows
    results = []
    for i in range(0, len(rows), 500):
        chunk = rows[i:i+500]
        r = sb_request("POST", path, chunk)
        if r:
            results.extend(r)
    return results

def sb_get(table, params=""):
    results = []
    offset  = 0
    while True:
        sep = "&" if "?" in params or params else "?"
        r = sb_request("GET", f"{table}?{params}{sep}limit=1000&offset={offset}")
        if not r:
            break
        results.extend(r)
        if len(r) < 1000:
            break
        offset += 1000
    return results

# ── Slug / injury-type helpers ─────────────────────────────────────────────────
def slugify(text):
    t = (text or "").lower().strip()
    t = re.sub(r"[^\w\s-]", "", t)
    t = re.sub(r"[\s_-]+", "-", t)
    return t.strip("-") or "unknown"

INJURY_CHECKS = [
    (["acl","anterior cruciate"],              "acl",       "ACL Tear"),
    (["mcl","medial collateral"],              "mcl",       "MCL Injury"),
    (["pcl","posterior cruciate"],             "pcl",       "PCL Injury"),
    (["hamstring"],                            "hamstring", "Hamstring"),
    (["quad","quadricep"],                     "quadricep", "Quadricep"),
    (["calf","gastrocnemius"],                 "calf",      "Calf"),
    (["groin","adductor"],                     "groin",     "Groin"),
    (["achilles"],                             "achilles",  "Achilles"),
    (["knee"],                                 "knee",      "Knee"),
    (["ankle"],                                "ankle",     "Ankle"),
    (["foot","plantar","heel","toe","hamate"], "foot",      "Foot"),
    (["shin","tibia","fibula"],                "shin",      "Shin/Leg"),
    (["hip flexor"],                           "hip-flexor","Hip Flexor"),
    (["hip"],                                  "hip",       "Hip"),
    (["shoulder","rotator","labrum","clavicle","collarbone"],"shoulder","Shoulder"),
    (["elbow","ulnar","ucl","tommy john"],     "elbow",     "Elbow"),
    (["wrist"],                                "wrist",     "Wrist"),
    (["hand","finger","thumb"],                "hand",      "Hand/Finger"),
    (["forearm"],                              "forearm",   "Forearm"),
    (["oblique"],                              "oblique",   "Oblique"),
    (["back","lumbar","spine","disc","vertebra"],"back",    "Back/Spine"),
    (["neck","cervical"],                      "neck",      "Neck"),
    (["rib","chest","pectoral","sternum"],     "chest",     "Chest/Ribs"),
    (["concussion","head trauma","tbi"],       "concussion","Concussion"),
    (["abdominal","abdomen","hernia"],         "abdominal", "Abdominal"),
    (["illness","flu","covid","virus"],        "illness",   "Illness"),
    (["personal"],                             "personal",  "Personal"),
    (["strain"],                               "strain",    "Strain"),
    (["sprain"],                               "sprain",    "Sprain"),
    (["fracture","broken"],                    "fracture",  "Fracture"),
    (["torn","tear"],                          "tear",      "Tear"),
    (["bruise","contusion"],                   "contusion", "Contusion"),
    (["surgery","surgical","post-op","rehab"], "surgery",   "Surgery/Rehab"),
    (["upper body"],                           "upper-body","Upper Body"),
    (["lower body"],                           "lower-body","Lower Body"),
]

def classify_injury(desc):
    d = (desc or "").lower()
    for keywords, slug, label in INJURY_CHECKS:
        if any(kw in d for kw in keywords):
            return slug, label
    return "other", "Other"

def normalize_status(s):
    s = (s or "").lower()
    if any(x in s for x in ["out","ir","injured reserve","reserve","il","60-day","10-day","15-day","7-day"]):
        return "out"
    if "doubtful" in s:
        return "doubtful"
    if "questionable" in s:
        return "questionable"
    if "probable" in s:
        return "probable"
    if any(x in s for x in ["dtd","day-to-day"]):
        return "questionable"
    if any(x in s for x in ["active","returned","reinstated","healthy"]):
        return "returned"
    return "out"

# ── In-memory caches ──────────────────────────────────────────────────────────
LEAGUE_CACHE = {}
TEAM_CACHE   = {}
PLAYER_CACHE = {}

def ensure_league(name, slug):
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
    raise RuntimeError(f"Cannot create league {slug}")

def ensure_team(team_name, league_id):
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
    raise RuntimeError(f"Cannot create team {team_name}")

def ensure_player(player_name, team_id, position="Unknown"):
    key = f"{team_id}:{player_name}"
    if key in PLAYER_CACHE:
        return PLAYER_CACHE[key]
    slug = f"{slugify(player_name)}-{team_id[:8]}"
    r = sb_upsert("back_in_play_players", [{
        "player_name": player_name,
        "team_id":     team_id,
        "position":    position or "Unknown",
        "slug":        slug,
    }], "slug")
    if r:
        PLAYER_CACHE[key] = r[0]["player_id"]
        return PLAYER_CACHE[key]
    rows = sb_get("back_in_play_players", f"slug=eq.{urllib.parse.quote(slug)}&select=player_id")
    if rows:
        PLAYER_CACHE[key] = rows[0]["player_id"]
        return PLAYER_CACHE[key]
    raise RuntimeError(f"Cannot create player {player_name}")

def store_injury(player_id, desc, date_str, status="out", source="", return_date=None):
    slug, itype = classify_injury(desc)
    row = {
        "player_id":          player_id,
        "injury_type":        itype,
        "injury_type_slug":   slug,
        "injury_description": (desc or "Injury")[:500],
        "date_injured":       date_str,
        "status":             status,
        "source":             (source or "")[:100],
    }
    if return_date:
        row["expected_return_date"] = return_date
    return sb_upsert("back_in_play_injuries", [row], "player_id,date_injured,injury_type_slug")

# ── OpenAI web search ─────────────────────────────────────────────────────────
def openai_search(prompt, timeout=120):
    if not OPENAI_API_KEY:
        print("  [WARN] No OPENAI_API_KEY set")
        return ""
    body = json.dumps({
        "model":  "gpt-4o",
        "tools":  [{"type": "web_search_preview"}],
        "input":  prompt,
    }).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/responses",
        data=body,
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    for attempt in range(3):
        try:
            resp = urllib.request.urlopen(req, timeout=timeout)
            data = json.loads(resp.read())
            for item in data.get("output", []):
                if item.get("type") == "message":
                    for c in item.get("content", []):
                        if c.get("type") == "output_text":
                            return c.get("text", "")
            return ""
        except urllib.error.HTTPError as e:
            err = e.read().decode()[:200]
            if e.code == 429:
                wait = 30 * (attempt + 1)
                print(f"  [OpenAI 429] rate-limited, waiting {wait}s...")
                time.sleep(wait)
            else:
                print(f"  [OpenAI HTTP {e.code}] {err}")
                return ""
        except Exception as ex:
            print(f"  [OpenAI err] {ex}")
            if attempt < 2:
                time.sleep(10)
    return ""

def parse_and_store(text, league_id, source, default_year=None):
    """Extract JSON injury arrays from AI response and store them."""
    total = 0
    # Try largest JSON arrays first (find all [...] blocks)
    arrays = re.findall(r'\[\s*\{[\s\S]*?\}\s*\]', text)
    if not arrays:
        return 0
    for match in arrays:
        try:
            injuries = json.loads(match)
            if not isinstance(injuries, list) or not injuries:
                continue
            sample = injuries[0]
            if not isinstance(sample, dict):
                continue
            # Must look like player data
            has_player = any(k in sample for k in ["player_name","name","player","Player"])
            has_team   = any(k in sample for k in ["team","team_name","Team","club"])
            if not has_player or not has_team:
                continue

            for inj in injuries:
                if not isinstance(inj, dict):
                    continue
                player_name = (inj.get("player_name") or inj.get("name") or
                               inj.get("player") or inj.get("Player") or "").strip()
                team_name   = (inj.get("team") or inj.get("team_name") or
                               inj.get("Team") or inj.get("club") or "").strip()
                position    = (inj.get("position") or inj.get("Position") or "Unknown").strip()
                injury_desc = (inj.get("injury") or inj.get("injury_description") or
                               inj.get("description") or inj.get("Injury") or "Injury").strip()
                date_str    = (inj.get("date_placed") or inj.get("date_injured") or
                               inj.get("date") or inj.get("Date") or "").strip()
                status      = (inj.get("status") or inj.get("Status") or "out").strip()
                ret_date    = (inj.get("expected_return") or inj.get("return_date") or
                               inj.get("expected_return_date") or "").strip() or None

                if not player_name or not team_name:
                    continue
                # Validate / fix date
                if date_str:
                    date_str = date_str[:10]
                    if not re.match(r'^\d{4}-\d{2}-\d{2}$', date_str):
                        date_str = f"{default_year}-01-01" if default_year else TODAY
                else:
                    date_str = f"{default_year}-01-01" if default_year else TODAY

                if ret_date:
                    ret_date = ret_date[:10]
                    if not re.match(r'^\d{4}-\d{2}-\d{2}$', ret_date):
                        ret_date = None

                try:
                    tid = ensure_team(team_name, league_id)
                    pid = ensure_player(player_name, tid, position)
                    r   = store_injury(pid, injury_desc, date_str,
                                       normalize_status(status), source, ret_date)
                    if r is not None:
                        total += 1
                except Exception as ex:
                    pass  # Skip individual failures silently
        except (json.JSONDecodeError, ValueError):
            continue
    return total

# ══════════════════════════════════════════════════════════════════════════════
# MLB — Official MLB Transactions API (statsapi.mlb.com)
# ══════════════════════════════════════════════════════════════════════════════
IL_KEYWORDS   = ["injured list","disabled list","10-day il","60-day il",
                 "15-day dl","10-day dl","7-day il","injured reserve"]
SKIP_KEYWORDS = ["reinstated","activated","recalled","returned to","transferred to 60",
                 "selected","released","designated for"]
MLB_POS_MAP   = {" C ":" C "," 1B ":"1B"," 2B ":"2B"," 3B ":"3B"," SS ":"SS",
                 " LF ":"OF"," CF ":"OF"," RF ":"OF"," OF ":"OF",
                 " SP ":"P"," RP ":"P"," RHP ":"P"," LHP ":"P"," DH ":"DH"}

def is_il_placement(desc):
    dl = desc.lower()
    if any(kw in dl for kw in SKIP_KEYWORDS):
        return False
    return any(kw in dl for kw in IL_KEYWORDS) and ("placed" in dl or "transferred" in dl)

def extract_mlb_position(desc):
    for abbr, pos in MLB_POS_MAP.items():
        if abbr in f" {desc} ":
            return pos.strip()
    m = re.search(r"\bplaced\s+(RHP|LHP|SP|RP|C|1B|2B|3B|SS|OF|LF|CF|RF|DH|P)\b", desc)
    return m.group(1) if m else "Unknown"

def extract_mlb_injury(desc):
    # Try to get the medical description after the first period
    parts = desc.split(". ", 1)
    if len(parts) > 1:
        detail = parts[1].strip().rstrip(".")
        if 5 < len(detail) < 150:
            return detail
    # Fallback: return full description
    return desc[:300]

def fetch_mlb_month(year, month):
    last = calendar.monthrange(year, month)[1]
    url  = (f"https://statsapi.mlb.com/api/v1/transactions"
            f"?sportId=1&startDate={year}-{month:02d}-01"
            f"&endDate={year}-{month:02d}-{last:02d}&limit=2000")
    req  = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        resp = urllib.request.urlopen(req, timeout=25)
        return json.loads(resp.read()).get("transactions", [])
    except Exception:
        return []

def ingest_mlb_year(league_id, year):
    total = 0
    print(f"  MLB {year}: ", end="", flush=True)
    for month in range(1, 13):
        txns = fetch_mlb_month(year, month)
        for tx in txns:
            desc        = tx.get("description", "")
            if not is_il_placement(desc):
                continue
            person      = tx.get("person", {})
            team        = tx.get("toTeam") or tx.get("fromTeam") or {}
            tx_date     = (tx.get("date") or f"{year}-{month:02d}-15")[:10]
            player_name = person.get("fullName", "")
            team_name   = (team.get("name") or "") if isinstance(team, dict) else ""

            if not player_name or not team_name:
                continue
            position     = extract_mlb_position(desc)
            injury_detail = extract_mlb_injury(desc)
            try:
                tid = ensure_team(team_name, league_id)
                pid = ensure_player(player_name, tid, position)
                r   = store_injury(pid, injury_detail, tx_date, "out",
                                   f"baseball-reference.com ({year})")
                if r is not None:
                    total += 1
            except Exception:
                pass
        time.sleep(0.2)
    print(f"{total} IL placements")
    return total

# ══════════════════════════════════════════════════════════════════════════════
# NFL — spotrac.com/nfl/injured-reserve/
# ══════════════════════════════════════════════════════════════════════════════
NFL_TEAM_GROUPS = [
    ["Kansas City Chiefs","Las Vegas Raiders","Los Angeles Chargers","Denver Broncos"],
    ["New England Patriots","Buffalo Bills","Miami Dolphins","New York Jets"],
    ["Baltimore Ravens","Pittsburgh Steelers","Cleveland Browns","Cincinnati Bengals"],
    ["Houston Texans","Indianapolis Colts","Tennessee Titans","Jacksonville Jaguars"],
    ["Dallas Cowboys","Philadelphia Eagles","New York Giants","Washington Commanders"],
    ["Green Bay Packers","Minnesota Vikings","Detroit Lions","Chicago Bears"],
    ["San Francisco 49ers","Los Angeles Rams","Seattle Seahawks","Arizona Cardinals"],
    ["New Orleans Saints","Atlanta Falcons","Carolina Panthers","Tampa Bay Buccaneers"],
]

NFL_JSON_FMT = (
    'Return ONLY a valid JSON array, no other text:\n'
    '[{"player_name":"Patrick Mahomes","team":"Kansas City Chiefs","position":"QB",'
    '"injury":"ankle sprain","date_placed":"YYYY-MM-DD","status":"out"}]\n'
    'Include EVERY player you find — aim for 60-80+ entries.'
)

def nfl_prompts_for_year(year):
    prompts = []
    # 8 team-group passes
    for group in NFL_TEAM_GROUPS:
        teams_str = ", ".join(group)
        prompts.append(
            f"Visit spotrac.com/nfl/injured-reserve/ and find every player placed on the "
            f"NFL injured reserve (IR) list during the {year} season for these teams: "
            f"{teams_str}. Include all IR placements from preseason through playoffs.\n"
            + NFL_JSON_FMT
        )
    return prompts

def ingest_nfl_year(league_id, year):
    print(f"  NFL {year}: 8 team-group passes via spotrac.com...")
    total = 0
    for i, prompt in enumerate(nfl_prompts_for_year(year), 1):
        text = openai_search(prompt)
        cnt  = parse_and_store(text, league_id, f"spotrac.com/nfl/injured-reserve ({year})", year)
        total += cnt
        sys.stdout.write(f"    group {i}/8: {cnt} stored\n")
        sys.stdout.flush()
        time.sleep(3)
    print(f"  NFL {year} DONE — {total}")
    return total

# ══════════════════════════════════════════════════════════════════════════════
# NBA — spotrac.com/nba/injured-reserve/
# ══════════════════════════════════════════════════════════════════════════════
NBA_TEAM_GROUPS = [
    ["Boston Celtics","Brooklyn Nets","New York Knicks","Philadelphia 76ers","Toronto Raptors"],
    ["Chicago Bulls","Cleveland Cavaliers","Detroit Pistons","Indiana Pacers","Milwaukee Bucks"],
    ["Atlanta Hawks","Charlotte Hornets","Miami Heat","Orlando Magic","Washington Wizards"],
    ["Denver Nuggets","Minnesota Timberwolves","Oklahoma City Thunder","Portland Trail Blazers","Utah Jazz"],
    ["Golden State Warriors","Los Angeles Clippers","Los Angeles Lakers","Phoenix Suns","Sacramento Kings"],
    ["Dallas Mavericks","Houston Rockets","Memphis Grizzlies","New Orleans Pelicans","San Antonio Spurs"],
]

NBA_JSON_FMT = (
    'Return ONLY a valid JSON array, no other text:\n'
    '[{"player_name":"LeBron James","team":"Los Angeles Lakers","position":"SF",'
    '"injury":"ankle sprain","date_placed":"YYYY-MM-DD","status":"out"}]\n'
    'Include ALL players you find — aim for 50-70+ entries.'
)

def nba_prompts_for_year(year):
    prompts = []
    for group in NBA_TEAM_GROUPS:
        teams_str = ", ".join(group)
        prompts.append(
            f"Visit spotrac.com/nba/injured-reserve/ and find every player placed on the "
            f"NBA injured list during the {year}-{year+1} season for these teams: "
            f"{teams_str}. Include all IL placements from October {year} through June {year+1}.\n"
            + NBA_JSON_FMT
        )
    return prompts

def ingest_nba_year(league_id, year):
    print(f"  NBA {year}-{year+1}: 6 team-group passes via spotrac.com...")
    total = 0
    for i, prompt in enumerate(nba_prompts_for_year(year), 1):
        text = openai_search(prompt)
        cnt  = parse_and_store(text, league_id, f"spotrac.com/nba/injured-reserve ({year})", year)
        total += cnt
        sys.stdout.write(f"    group {i}/6: {cnt} stored\n")
        sys.stdout.flush()
        time.sleep(3)
    print(f"  NBA {year}-{year+1} DONE — {total}")
    return total

# ══════════════════════════════════════════════════════════════════════════════
# NHL — capfriendly.com/injuries
# ══════════════════════════════════════════════════════════════════════════════
NHL_EAST_GROUPS = [
    ["Boston Bruins","Buffalo Sabres","Detroit Red Wings","Florida Panthers","Montreal Canadiens"],
    ["Ottawa Senators","Tampa Bay Lightning","Toronto Maple Leafs","Carolina Hurricanes","Columbus Blue Jackets"],
    ["New Jersey Devils","New York Islanders","New York Rangers","Philadelphia Flyers","Pittsburgh Penguins","Washington Capitals"],
]
NHL_WEST_GROUPS = [
    ["Chicago Blackhawks","Colorado Avalanche","Dallas Stars","Minnesota Wild","Nashville Predators","St. Louis Blues","Winnipeg Jets"],
    ["Anaheim Ducks","Arizona Coyotes","Calgary Flames","Edmonton Oilers","Los Angeles Kings","San Jose Sharks","Seattle Kraken","Vancouver Canucks","Vegas Golden Knights"],
]
NHL_GROUPS = NHL_EAST_GROUPS + NHL_WEST_GROUPS

NHL_JSON_FMT = (
    'Return ONLY a valid JSON array, no other text:\n'
    '[{"player_name":"Sidney Crosby","team":"Pittsburgh Penguins","position":"C",'
    '"injury":"upper body","date_placed":"YYYY-MM-DD","status":"out"}]\n'
    'Include ALL players you find — aim for 50-70+ entries.'
)

def nhl_prompts_for_year(year):
    prompts = []
    for group in NHL_GROUPS:
        teams_str = ", ".join(group)
        prompts.append(
            f"Visit capfriendly.com/injuries and find every player placed on the "
            f"NHL injured reserve (IR) during the {year}-{year+1} season for these teams: "
            f"{teams_str}. Include all IR/LTIR placements from October {year} through June {year+1}.\n"
            + NHL_JSON_FMT
        )
    return prompts

def ingest_nhl_year(league_id, year):
    print(f"  NHL {year}-{year+1}: {len(NHL_GROUPS)} team-group passes via capfriendly.com...")
    total = 0
    for i, prompt in enumerate(nhl_prompts_for_year(year), 1):
        text = openai_search(prompt)
        cnt  = parse_and_store(text, league_id, f"capfriendly.com/injuries ({year})", year)
        total += cnt
        sys.stdout.write(f"    group {i}/{len(NHL_GROUPS)}: {cnt} stored\n")
        sys.stdout.flush()
        time.sleep(3)
    print(f"  NHL {year}-{year+1} DONE — {total}")
    return total

# ══════════════════════════════════════════════════════════════════════════════
# Premier League — transfermarkt.com
# ══════════════════════════════════════════════════════════════════════════════
EPL_TEAM_GROUPS = [
    ["Arsenal","Chelsea","Liverpool","Manchester City","Manchester United","Tottenham Hotspur"],
    ["Aston Villa","Everton","Leicester City","Newcastle United","West Ham United","Wolverhampton Wanderers"],
    ["Crystal Palace","Brighton & Hove Albion","Southampton","Brentford","Fulham","Nottingham Forest"],
    ["Leeds United","Burnley","Watford","Norwich City","Bournemouth","Sheffield United","Luton Town"],
]

EPL_JSON_FMT = (
    'Return ONLY a valid JSON array, no other text:\n'
    '[{"player_name":"Mohamed Salah","team":"Liverpool FC","position":"RW",'
    '"injury":"hamstring strain","date_placed":"YYYY-MM-DD","status":"out",'
    '"expected_return":"YYYY-MM-DD"}]\n'
    'Include ALL players you find — aim for 50-70+ entries.'
)

def epl_prompts_for_year(year):
    prompts = []
    for group in EPL_TEAM_GROUPS:
        teams_str = ", ".join(group)
        prompts.append(
            f"Visit transfermarkt.com and find every Premier League player injury recorded "
            f"during the {year}/{year+1} season for these clubs: {teams_str}. "
            f"Include all injuries from August {year} through May {year+1} with dates and return dates.\n"
            + EPL_JSON_FMT
        )
    return prompts

def ingest_epl_year(league_id, year):
    print(f"  EPL {year}/{year+1}: {len(EPL_TEAM_GROUPS)} team-group passes via transfermarkt.com...")
    total = 0
    for i, prompt in enumerate(epl_prompts_for_year(year), 1):
        text = openai_search(prompt)
        cnt  = parse_and_store(text, league_id, f"transfermarkt.com ({year})", year)
        total += cnt
        sys.stdout.write(f"    group {i}/{len(EPL_TEAM_GROUPS)}: {cnt} stored\n")
        sys.stdout.flush()
        time.sleep(3)
    print(f"  EPL {year}/{year+1} DONE — {total}")
    return total

# ══════════════════════════════════════════════════════════════════════════════
# DB summary
# ══════════════════════════════════════════════════════════════════════════════
def print_summary():
    rows = sb_get("back_in_play_leagues", "select=league_name,slug")
    print("\n── Final DB counts ──────────────────────────────────────")
    for league in rows:
        lid   = league.get("league_id") or ""
        lname = league.get("league_name", "")
        lslug = league.get("slug", "")
        players  = sb_get("back_in_play_players", f"team_id=in.(select team_id from back_in_play_teams where league_id=eq.{lid})&select=count")
        injuries = sb_get("back_in_play_injuries", f"select=count")
        print(f"  {lname} ({lslug})")

    # Just do raw counts
    for table in ["back_in_play_leagues","back_in_play_teams","back_in_play_players","back_in_play_injuries"]:
        r = sb_request("GET", f"{table}?select=*&limit=0", None)
        print(f"  {table}: (check Supabase dashboard for count)")

def print_db_counts_sql():
    import subprocess
    try:
        result = subprocess.run([
            "curl","-s","-X","POST",
            f"https://api.supabase.com/v1/projects/{os.environ['SUPABASE_PROJECT_REF']}/database/query",
            "-H",f"Authorization: Bearer {os.environ['SUPABASE_MGMT_TOKEN']}",
            "-H","Content-Type: application/json",
            "-d",'{"query":"SELECT l.league_name, COUNT(DISTINCT p.player_id) as players, COUNT(i.injury_id) as injuries FROM back_in_play_leagues l LEFT JOIN back_in_play_teams t ON t.league_id=l.league_id LEFT JOIN back_in_play_players p ON p.team_id=t.team_id LEFT JOIN back_in_play_injuries i ON i.player_id=p.player_id GROUP BY l.league_name ORDER BY l.league_name;"}'
        ], capture_output=True, text=True, timeout=30)
        print("\n── DB summary ───────────────────────────────────────────")
        data = json.loads(result.stdout)
        for row in data:
            print(f"  {row['league_name']}: {row['players']} players, {row['injuries']} injuries")
    except Exception as e:
        print(f"  [summary error] {e}")

# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════
def should_run(league_key):
    """Check SKIP_LEAGUE / ONLY_LEAGUE env vars."""
    key = league_key.upper()
    if ONLY_LEAGUE and ONLY_LEAGUE != ['']:
        return key in ONLY_LEAGUE
    if SKIP_LEAGUE and SKIP_LEAGUE != ['']:
        return key not in SKIP_LEAGUE
    return True

def main():
    print("=" * 68)
    print("Back In Play — Master 10-Year Injury Ingestion")
    print(f"Seasons: 2015-2025  |  Date: {TODAY}")
    print(f"Sources: spotrac.com | baseball-reference.com | capfriendly.com | transfermarkt.com")
    if ONLY_LEAGUE and ONLY_LEAGUE != ['']:
        print(f"Only leagues: {ONLY_LEAGUE}")
    if SKIP_LEAGUE and SKIP_LEAGUE != ['']:
        print(f"Skipping: {SKIP_LEAGUE}")
    print("=" * 68)

    # Ensure all leagues exist upfront
    leagues = {
        "nfl": ensure_league("NFL", "nfl"),
        "nba": ensure_league("NBA", "nba"),
        "mlb": ensure_league("MLB", "mlb"),
        "nhl": ensure_league("NHL", "nhl"),
        "epl": ensure_league("Premier League", "premier-league"),
    }
    print(f"Leagues ready: {list(leagues.keys())}\n")

    grand = 0

    # ── MLB ─────────────────────────────────────────────────────────────────
    if should_run("MLB"):
        print("─" * 50)
        print("[MLB] baseball-reference.com / Official MLB Transactions API")
        print("─" * 50)
        mlb_total = 0
        for year in SEASONS:
            mlb_total += ingest_mlb_year(leagues["mlb"], year)
            time.sleep(0.5)
        print(f"\n✅ MLB TOTAL: {mlb_total} IL placements\n")
        grand += mlb_total

    # ── NFL ─────────────────────────────────────────────────────────────────
    if should_run("NFL"):
        print("─" * 50)
        print("[NFL] spotrac.com/nfl/injured-reserve/")
        print("─" * 50)
        nfl_total = 0
        for year in SEASONS:
            nfl_total += ingest_nfl_year(leagues["nfl"], year)
            time.sleep(2)
        print(f"\n✅ NFL TOTAL: {nfl_total} injuries\n")
        grand += nfl_total

    # ── NBA ─────────────────────────────────────────────────────────────────
    if should_run("NBA"):
        print("─" * 50)
        print("[NBA] spotrac.com/nba/injured-reserve/")
        print("─" * 50)
        nba_total = 0
        for year in SEASONS:
            nba_total += ingest_nba_year(leagues["nba"], year)
            time.sleep(2)
        print(f"\n✅ NBA TOTAL: {nba_total} injuries\n")
        grand += nba_total

    # ── NHL ─────────────────────────────────────────────────────────────────
    if should_run("NHL"):
        print("─" * 50)
        print("[NHL] capfriendly.com/injuries")
        print("─" * 50)
        nhl_total = 0
        for year in SEASONS:
            nhl_total += ingest_nhl_year(leagues["nhl"], year)
            time.sleep(2)
        print(f"\n✅ NHL TOTAL: {nhl_total} injuries\n")
        grand += nhl_total

    # ── Premier League ──────────────────────────────────────────────────────
    if should_run("EPL"):
        print("─" * 50)
        print("[EPL] transfermarkt.com — Premier League")
        print("─" * 50)
        epl_total = 0
        for year in SEASONS:
            epl_total += ingest_epl_year(leagues["epl"], year)
            time.sleep(2)
        print(f"\n✅ EPL TOTAL: {epl_total} injuries\n")
        grand += epl_total

    print("=" * 68)
    print(f"GRAND TOTAL NEW INJURIES STORED: {grand}")
    print("=" * 68)
    print_db_counts_sql()
    print("\nDone.")


if __name__ == "__main__":
    main()
