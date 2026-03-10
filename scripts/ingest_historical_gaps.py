#!/usr/bin/env python3
"""
Back In Play — Historical Gap Filler
=====================================
Fills missing injury data for NBA, NHL, EPL (2015-2025) and MLB (2024-2025).
NFL already complete (14,940 injuries).

Strategy:
  - MLB: Official statsapi.mlb.com  (reliable, official data)
  - NBA: GPT-4o knowledge for 2015-2023 + web_search for 2024-2025
         Sources referenced: basketball-reference.com, ESPN, spotrac.com/nba
  - NHL: GPT-4o knowledge for 2015-2023 + web_search for 2024-2025
         Sources referenced: capfriendly.com, nhl.com
  - EPL: GPT-4o knowledge for 2015-2023 + web_search for 2024-2025
         Sources referenced: transfermarkt.com, premierinjuries.com

Usage:
  ONLY_LEAGUE=NBA python3 ingest_historical_gaps.py
  ONLY_LEAGUE=NHL,EPL python3 ingest_historical_gaps.py
  ONLY_LEAGUE=MLB START_YEAR=2024 python3 ingest_historical_gaps.py
"""

import json, os, re, sys, time, calendar, urllib.request, urllib.parse, urllib.error
from datetime import date

# ── Config ───────────────────────────────────────────────────────────────────
SUPABASE_URL   = os.environ["SUPABASE_URL"]
SUPABASE_KEY   = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
GROK_API_KEY   = os.environ.get("GROK_API_KEY", "")

_start = int(os.environ.get("START_YEAR", "2015"))
_end   = int(os.environ.get("END_YEAR",   "2025"))
SEASONS     = list(range(_start, _end + 1))
TODAY       = date.today().isoformat()

SKIP_LEAGUE = os.environ.get("SKIP_LEAGUE", "").upper().split(",")
ONLY_LEAGUE = os.environ.get("ONLY_LEAGUE", "").upper().split(",")

def should_run(key):
    k = key.upper()
    if ONLY_LEAGUE and ONLY_LEAGUE != [""]:
        return k in ONLY_LEAGUE
    if SKIP_LEAGUE and SKIP_LEAGUE != [""]:
        return k not in SKIP_LEAGUE
    return True

# ── Supabase helpers ──────────────────────────────────────────────────────────
def sb_headers():
    return {
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates,return=representation",
    }

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
        print(f"  [SB ERR] {ex}")
        return None

def sb_upsert(table, rows, conflict=None):
    if not rows:
        return []
    path = f"{table}?on_conflict={conflict}" if conflict else table
    results = []
    for i in range(0, len(rows), 500):
        r = sb_request("POST", path, rows[i:i+500])
        if r:
            results.extend(r)
    return results

def sb_get(table, params=""):
    results, offset = [], 0
    while True:
        sep = "&" if ("?" in params or params) else "?"
        r = sb_request("GET", f"{table}?{params}{sep}limit=1000&offset={offset}")
        if not r:
            break
        results.extend(r)
        if len(r) < 1000:
            break
        offset += 1000
    return results

# ── Helpers ───────────────────────────────────────────────────────────────────
def slugify(text):
    t = (text or "").lower().strip()
    t = re.sub(r"[^\w\s-]", "", t)
    t = re.sub(r"[\s_-]+", "-", t)
    return t.strip("-") or "unknown"

INJURY_CHECKS = [
    (["acl","anterior cruciate"],                "acl",        "ACL Tear"),
    (["mcl","medial collateral"],                "mcl",        "MCL Injury"),
    (["pcl","posterior cruciate"],               "pcl",        "PCL Injury"),
    (["hamstring"],                              "hamstring",  "Hamstring"),
    (["quadricep","quad"],                       "quadricep",  "Quadricep"),
    (["calf","gastrocnemius"],                   "calf",       "Calf"),
    (["groin","adductor"],                       "groin",      "Groin"),
    (["achilles"],                               "achilles",   "Achilles"),
    (["knee"],                                   "knee",       "Knee"),
    (["ankle"],                                  "ankle",      "Ankle"),
    (["foot","plantar","heel","toe","hamate"],   "foot",       "Foot"),
    (["shin","tibia","fibula"],                  "shin",       "Shin/Leg"),
    (["hip flexor"],                             "hip-flexor", "Hip Flexor"),
    (["hip"],                                    "hip",        "Hip"),
    (["shoulder","rotator","labrum","clavicle"], "shoulder",   "Shoulder"),
    (["elbow","ulnar","ucl","tommy john"],       "elbow",      "Elbow"),
    (["wrist"],                                  "wrist",      "Wrist"),
    (["hand","finger","thumb"],                  "hand",       "Hand/Finger"),
    (["forearm"],                                "forearm",    "Forearm"),
    (["oblique"],                                "oblique",    "Oblique"),
    (["back","lumbar","spine","disc","vertebra"],"back",       "Back/Spine"),
    (["neck","cervical"],                        "neck",       "Neck"),
    (["rib","chest","pectoral","sternum"],       "chest",      "Chest/Ribs"),
    (["concussion","head trauma","tbi"],         "concussion", "Concussion"),
    (["abdominal","abdomen","hernia"],           "abdominal",  "Abdominal"),
    (["illness","flu","covid","virus"],          "illness",    "Illness"),
    (["personal"],                               "personal",   "Personal"),
    (["strain"],                                 "strain",     "Strain"),
    (["sprain"],                                 "sprain",     "Sprain"),
    (["fracture","broken","break"],              "fracture",   "Fracture"),
    (["torn","tear"],                            "tear",       "Tear"),
    (["bruise","contusion"],                     "contusion",  "Contusion"),
    (["surgery","surgical","post-op","rehab"],   "surgery",    "Surgery/Rehab"),
    (["upper body"],                             "upper-body", "Upper Body"),
    (["lower body"],                             "lower-body", "Lower Body"),
]

def classify_injury(desc):
    d = (desc or "").lower()
    for keywords, slug, label in INJURY_CHECKS:
        if any(kw in d for kw in keywords):
            return slug, label
    return "other", "Other"

def normalize_status(s):
    s = (s or "").lower()
    if any(x in s for x in ["out","ir","injured reserve","il","60-day","10-day","15-day","7-day","ltir","dnp"]):
        return "out"
    if "doubtful" in s: return "doubtful"
    if "questionable" in s: return "questionable"
    if "probable" in s: return "probable"
    if any(x in s for x in ["dtd","day-to-day"]): return "questionable"
    if any(x in s for x in ["active","returned","reinstated","healthy"]): return "returned"
    return "out"

# ── In-memory caches ─────────────────────────────────────────────────────────
LEAGUE_CACHE, TEAM_CACHE, PLAYER_CACHE = {}, {}, {}

def ensure_league(name, slug):
    if slug in LEAGUE_CACHE:
        return LEAGUE_CACHE[slug]
    r = sb_upsert("back_in_play_leagues", [{"league_name": name, "slug": slug}], "slug")
    lid = r[0]["league_id"] if r else None
    if not lid:
        rows = sb_get("back_in_play_leagues", f"slug=eq.{slug}&select=league_id")
        lid = rows[0]["league_id"] if rows else None
    if not lid:
        raise RuntimeError(f"Cannot create league {slug}")
    LEAGUE_CACHE[slug] = lid
    return lid

def ensure_team(team_name, league_id):
    key = f"{league_id}:{team_name}"
    if key in TEAM_CACHE:
        return TEAM_CACHE[key]
    r = sb_upsert("back_in_play_teams",
                  [{"team_name": team_name, "league_id": league_id}],
                  "team_name,league_id")
    tid = r[0]["team_id"] if r else None
    if not tid:
        rows = sb_get("back_in_play_teams",
                      f"team_name=eq.{urllib.parse.quote(team_name)}&league_id=eq.{league_id}&select=team_id")
        tid = rows[0]["team_id"] if rows else None
    if not tid:
        raise RuntimeError(f"Cannot create team {team_name}")
    TEAM_CACHE[key] = tid
    return tid

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
    pid = r[0]["player_id"] if r else None
    if not pid:
        rows = sb_get("back_in_play_players", f"slug=eq.{urllib.parse.quote(slug)}&select=player_id")
        pid = rows[0]["player_id"] if rows else None
    if not pid:
        raise RuntimeError(f"Cannot create player {player_name}")
    PLAYER_CACHE[key] = pid
    return pid

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

def fix_date(date_str, default_year=None):
    if not date_str:
        return f"{default_year}-01-01" if default_year else TODAY
    date_str = str(date_str).strip()[:10]
    if re.match(r"^\d{4}-\d{2}-\d{2}$", date_str):
        return date_str
    # Try MM/DD/YYYY
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", date_str)
    if m:
        return f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}"
    return f"{default_year}-01-01" if default_year else TODAY

# ── OpenAI helpers ────────────────────────────────────────────────────────────
def openai_chat(prompt, use_web_search=False, timeout=120):
    """Call OpenAI. use_web_search=True for 2024+, False uses training knowledge."""
    if not OPENAI_API_KEY:
        print("  [WARN] No OPENAI_API_KEY")
        return ""

    if use_web_search:
        # Responses API with web_search_preview tool
        body = json.dumps({
            "model":  "gpt-4o",
            "tools":  [{"type": "web_search_preview"}],
            "input":  prompt,
        }).encode()
        endpoint = "https://api.openai.com/v1/responses"
    else:
        # Chat completions — uses model's training knowledge (fast, no web)
        body = json.dumps({
            "model":    "gpt-4o",
            "messages": [
                {"role": "system", "content":
                    "You are a sports data expert with comprehensive knowledge of professional "
                    "sports injuries from 2015-2024. Return ONLY valid JSON arrays when asked. "
                    "Never truncate — include every player you know about for the given team/season."},
                {"role": "user", "content": prompt}
            ],
            "temperature": 0.1,
            "max_tokens":  4096,
        }).encode()
        endpoint = "https://api.openai.com/v1/chat/completions"

    req = urllib.request.Request(
        endpoint, data=body,
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    for attempt in range(3):
        try:
            resp = urllib.request.urlopen(req, timeout=timeout)
            data = json.loads(resp.read())
            if use_web_search:
                for item in data.get("output", []):
                    if item.get("type") == "message":
                        for c in item.get("content", []):
                            if c.get("type") == "output_text":
                                return c.get("text", "")
                return ""
            else:
                return data["choices"][0]["message"]["content"]
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
    total = 0
    if not text:
        return 0
    # Find JSON arrays in the response
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
            has_player = any(k in sample for k in ["player_name","name","player","Player","athlete"])
            has_team   = any(k in sample for k in ["team","team_name","Team","club","franchise"])
            if not has_player or not has_team:
                continue

            for inj in injuries:
                if not isinstance(inj, dict):
                    continue
                player_name = (inj.get("player_name") or inj.get("name") or
                               inj.get("player") or inj.get("Player") or
                               inj.get("athlete") or "").strip()
                team_name   = (inj.get("team") or inj.get("team_name") or
                               inj.get("Team") or inj.get("club") or
                               inj.get("franchise") or "").strip()
                position    = (inj.get("position") or inj.get("pos") or "Unknown").strip()
                injury_desc = (inj.get("injury") or inj.get("injury_description") or
                               inj.get("description") or inj.get("Injury") or
                               inj.get("injury_type") or "Injury").strip()
                date_str    = (inj.get("date_placed") or inj.get("date_injured") or
                               inj.get("date") or inj.get("Date") or
                               inj.get("date_on_il") or "").strip()
                status_raw  = (inj.get("status") or inj.get("Status") or "out").strip()
                ret_date    = (inj.get("expected_return") or inj.get("return_date") or
                               inj.get("expected_return_date") or inj.get("date_returned") or "").strip() or None

                if not player_name or not team_name:
                    continue
                date_str = fix_date(date_str, default_year)
                if ret_date:
                    ret_date = fix_date(ret_date, None)
                    if ret_date == f"{default_year}-01-01":
                        ret_date = None

                try:
                    tid = ensure_team(team_name, league_id)
                    pid = ensure_player(player_name, tid, position)
                    r   = store_injury(pid, injury_desc, date_str,
                                       normalize_status(status_raw), source, ret_date)
                    if r is not None:
                        total += 1
                except Exception:
                    pass
        except (json.JSONDecodeError, ValueError):
            continue
    return total

# ══════════════════════════════════════════════════════════════════════════════
# MLB — Official MLB Transactions API
# ══════════════════════════════════════════════════════════════════════════════
IL_KEYWORDS   = ["injured list","disabled list","10-day il","60-day il",
                 "15-day dl","10-day dl","7-day il","injured reserve"]
SKIP_KEYWORDS = ["reinstated","activated","recalled","returned to",
                 "selected","released","designated for","transferred to 60-day"]

def is_il_placement(desc):
    dl = desc.lower()
    if any(kw in dl for kw in SKIP_KEYWORDS):
        return False
    return any(kw in dl for kw in IL_KEYWORDS) and ("placed" in dl or "transferred" in dl)

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

def extract_mlb_injury(desc):
    parts = desc.split(". ", 1)
    if len(parts) > 1 and 5 < len(parts[1]) < 150:
        return parts[1].strip().rstrip(".")
    return desc[:300]

def ingest_mlb_year(league_id, year):
    total = 0
    print(f"  MLB {year}: ", end="", flush=True)
    for month in range(1, 13):
        txns = fetch_mlb_month(year, month)
        for tx in txns:
            desc = tx.get("description", "")
            if not is_il_placement(desc):
                continue
            person    = tx.get("person", {})
            team      = tx.get("toTeam") or tx.get("fromTeam") or {}
            tx_date   = (tx.get("date") or f"{year}-{month:02d}-15")[:10]
            pname     = person.get("fullName", "")
            tname     = (team.get("name") or "") if isinstance(team, dict) else ""
            if not pname or not tname:
                continue
            inj_detail = extract_mlb_injury(desc)
            try:
                tid = ensure_team(tname, league_id)
                pid = ensure_player(pname, tid, "Unknown")
                r   = store_injury(pid, inj_detail, tx_date, "out",
                                   f"statsapi.mlb.com ({year})")
                if r is not None:
                    total += 1
            except Exception:
                pass
        time.sleep(0.2)
    print(f"{total} placements")
    return total

# ══════════════════════════════════════════════════════════════════════════════
# NBA — GPT-4o knowledge + web_search for 2024+
# ══════════════════════════════════════════════════════════════════════════════
NBA_TEAM_GROUPS = [
    ["Boston Celtics","Brooklyn Nets","New York Knicks","Philadelphia 76ers","Toronto Raptors"],
    ["Chicago Bulls","Cleveland Cavaliers","Detroit Pistons","Indiana Pacers","Milwaukee Bucks"],
    ["Atlanta Hawks","Charlotte Hornets","Miami Heat","Orlando Magic","Washington Wizards"],
    ["Denver Nuggets","Minnesota Timberwolves","Oklahoma City Thunder","Portland Trail Blazers","Utah Jazz"],
    ["Golden State Warriors","Los Angeles Clippers","Los Angeles Lakers","Phoenix Suns","Sacramento Kings"],
    ["Dallas Mavericks","Houston Rockets","Memphis Grizzlies","New Orleans Pelicans","San Antonio Spurs"],
]

NBA_JSON_FORMAT = '''Return ONLY a valid JSON array (no other text, no markdown):
[{"player_name":"Full Name","team":"Team Name","position":"PG","injury":"left knee ACL tear","date_placed":"YYYY-MM-DD","status":"out","expected_return":"YYYY-MM-DD"}]
Rules: dates must be YYYY-MM-DD format; include ALL players you can recall; aim for 30-60 entries per group.'''

def nba_prompt(year, teams, use_web):
    teams_str = ", ".join(teams)
    season    = f"{year}-{str(year+1)[2:]}"
    if use_web:
        return (
            f"Search basketball-reference.com and spotrac.com/nba/injured-reserve/ for all NBA players "
            f"placed on the injured list (IL) during the {season} season for: {teams_str}. "
            f"Include every IL placement from October {year} through June {year+1}.\n"
            + NBA_JSON_FORMAT
        )
    return (
        f"Using your training data, list ALL NBA players placed on the injured list (IL) "
        f"during the {season} NBA season for these teams: {teams_str}.\n"
        f"Include every IL placement from October {year} through June {year+1}. "
        f"Use basketball-reference.com injury data and ESPN reports as your knowledge base.\n"
        + NBA_JSON_FORMAT
    )

def ingest_nba_year(league_id, year):
    use_web = (year >= 2024)
    mode    = "web+search" if use_web else "AI-knowledge"
    print(f"  NBA {year}-{year+1}: {len(NBA_TEAM_GROUPS)} groups [{mode}]...")
    total = 0
    for i, group in enumerate(NBA_TEAM_GROUPS, 1):
        text = openai_chat(nba_prompt(year, group, use_web), use_web_search=use_web)
        cnt  = parse_and_store(text, league_id, f"basketball-reference.com/spotrac ({year})", year)
        total += cnt
        print(f"    group {i}/{len(NBA_TEAM_GROUPS)} ({', '.join(group[:2])}...): {cnt} stored")
        time.sleep(2)
    print(f"  NBA {year}-{year+1} DONE — {total}")
    return total

# ══════════════════════════════════════════════════════════════════════════════
# NHL — GPT-4o knowledge + web_search for 2024+
# ══════════════════════════════════════════════════════════════════════════════
NHL_TEAM_GROUPS = [
    ["Boston Bruins","Buffalo Sabres","Detroit Red Wings","Florida Panthers","Montreal Canadiens","Ottawa Senators"],
    ["Tampa Bay Lightning","Toronto Maple Leafs","Carolina Hurricanes","Columbus Blue Jackets",
     "New Jersey Devils","New York Islanders"],
    ["New York Rangers","Philadelphia Flyers","Pittsburgh Penguins","Washington Capitals",
     "Chicago Blackhawks","Colorado Avalanche"],
    ["Dallas Stars","Minnesota Wild","Nashville Predators","St. Louis Blues","Winnipeg Jets",
     "Anaheim Ducks","Calgary Flames"],
    ["Edmonton Oilers","Los Angeles Kings","San Jose Sharks","Seattle Kraken","Vancouver Canucks",
     "Vegas Golden Knights","Arizona Coyotes","Utah Hockey Club"],
]

NHL_JSON_FORMAT = '''Return ONLY a valid JSON array (no other text, no markdown):
[{"player_name":"Full Name","team":"Team Name","position":"C","injury":"upper body","date_placed":"YYYY-MM-DD","status":"out","expected_return":"YYYY-MM-DD"}]
Rules: dates must be YYYY-MM-DD format; include ALL players you can recall; aim for 30-60 entries per group.'''

def nhl_prompt(year, teams, use_web):
    teams_str = ", ".join(teams)
    season    = f"{year}-{str(year+1)[2:]}"
    if use_web:
        return (
            f"Search capfriendly.com/injuries and nhl.com for all NHL players placed on injured reserve (IR/LTIR) "
            f"during the {season} NHL season for: {teams_str}. "
            f"Include all IR placements from October {year} through June {year+1}.\n"
            + NHL_JSON_FORMAT
        )
    return (
        f"Using your training data, list ALL NHL players placed on injured reserve (IR or LTIR) "
        f"during the {season} NHL season for these teams: {teams_str}.\n"
        f"Include every IR placement from October {year} through June {year+1}. "
        f"Reference capfriendly.com and nhl.com injury reports as your knowledge base.\n"
        + NHL_JSON_FORMAT
    )

def ingest_nhl_year(league_id, year):
    use_web = (year >= 2024)
    mode    = "web+search" if use_web else "AI-knowledge"
    print(f"  NHL {year}-{year+1}: {len(NHL_TEAM_GROUPS)} groups [{mode}]...")
    total = 0
    for i, group in enumerate(NHL_TEAM_GROUPS, 1):
        text = openai_chat(nhl_prompt(year, group, use_web), use_web_search=use_web)
        cnt  = parse_and_store(text, league_id, f"capfriendly.com/nhl.com ({year})", year)
        total += cnt
        print(f"    group {i}/{len(NHL_TEAM_GROUPS)} ({', '.join(group[:2])}...): {cnt} stored")
        time.sleep(2)
    print(f"  NHL {year}-{year+1} DONE — {total}")
    return total

# ══════════════════════════════════════════════════════════════════════════════
# EPL — GPT-4o knowledge + web_search for 2024+ (transfermarkt.com)
# ══════════════════════════════════════════════════════════════════════════════
EPL_TEAM_GROUPS = [
    ["Arsenal","Chelsea","Liverpool","Manchester City","Manchester United","Tottenham Hotspur"],
    ["Aston Villa","Everton","Leicester City","Newcastle United","West Ham United","Wolverhampton Wanderers"],
    ["Crystal Palace","Brighton & Hove Albion","Southampton","Brentford","Fulham","Nottingham Forest"],
    ["Leeds United","Burnley","Watford","Norwich City","Bournemouth","Sheffield United",
     "Luton Town","Swansea City","Cardiff City","Sunderland"],
]

EPL_JSON_FORMAT = '''Return ONLY a valid JSON array (no other text, no markdown):
[{"player_name":"Full Name","team":"Club Name","position":"CM","injury":"hamstring strain","date_placed":"YYYY-MM-DD","status":"out","expected_return":"YYYY-MM-DD"}]
Rules: dates must be YYYY-MM-DD format; include ALL players you can recall; aim for 30-60 entries per group.'''

def epl_prompt(year, teams, use_web):
    teams_str = ", ".join(teams)
    season    = f"{year}/{year+1}"
    if use_web:
        return (
            f"Search transfermarkt.com/premier-league/verletzungen/wettbewerb/GB1/saison_id/{year} "
            f"and premierinjuries.com for all Premier League injuries during the {season} season "
            f"for: {teams_str}. Include injuries from August {year} through May {year+1}.\n"
            + EPL_JSON_FORMAT
        )
    return (
        f"Using your training data, list ALL Premier League players who suffered injuries "
        f"during the {season} season for these clubs: {teams_str}.\n"
        f"Include every injury from August {year} through May {year+1}. "
        f"Reference transfermarkt.com injury records as your knowledge base.\n"
        + EPL_JSON_FORMAT
    )

def ingest_epl_year(league_id, year):
    use_web = (year >= 2024)
    mode    = "web+search" if use_web else "AI-knowledge"
    print(f"  EPL {year}/{year+1}: {len(EPL_TEAM_GROUPS)} groups [{mode}]...")
    total = 0
    for i, group in enumerate(EPL_TEAM_GROUPS, 1):
        text = openai_chat(epl_prompt(year, group, use_web), use_web_search=use_web)
        cnt  = parse_and_store(text, league_id, f"transfermarkt.com ({year})", year)
        total += cnt
        print(f"    group {i}/{len(EPL_TEAM_GROUPS)} ({', '.join(group[:2])}...): {cnt} stored")
        time.sleep(2)
    print(f"  EPL {year}/{year+1} DONE — {total}")
    return total

# ══════════════════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════════════════
def print_summary():
    import subprocess
    try:
        result = subprocess.run([
            "curl","-s","-X","POST",
            f"https://api.supabase.com/v1/projects/{os.environ['SUPABASE_PROJECT_REF']}/database/query",
            "-H", f"Authorization: Bearer {os.environ['SUPABASE_MGMT_TOKEN']}",
            "-H", "Content-Type: application/json",
            "-d", '{"query":"SELECT l.league_name, COUNT(DISTINCT p.player_id) as players, COUNT(i.injury_id) as injuries FROM back_in_play_leagues l LEFT JOIN back_in_play_teams t ON t.league_id=l.league_id LEFT JOIN back_in_play_players p ON p.team_id=t.team_id LEFT JOIN back_in_play_injuries i ON i.player_id=p.player_id GROUP BY l.league_name ORDER BY l.league_name;"}'
        ], capture_output=True, text=True, timeout=30)
        data = json.loads(result.stdout)
        print("\n── Final DB counts ─────────────────────────────────────")
        for row in data:
            print(f"  {row['league_name']}: {row['players']} players, {row['injuries']} injuries")
    except Exception as e:
        print(f"  [summary error] {e}")

# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════
def main():
    print("=" * 68)
    print("Back In Play — Historical Gap Filler")
    print(f"Seasons: {SEASONS[0]}-{SEASONS[-1]}  |  Date: {TODAY}")
    if ONLY_LEAGUE and ONLY_LEAGUE != [""]:
        print(f"Only: {ONLY_LEAGUE}")
    print("=" * 68)

    leagues = {
        "nfl": ensure_league("NFL",           "nfl"),
        "nba": ensure_league("NBA",           "nba"),
        "mlb": ensure_league("MLB",           "mlb"),
        "nhl": ensure_league("NHL",           "nhl"),
        "epl": ensure_league("Premier League","premier-league"),
    }
    print(f"Leagues ready: {list(leagues.keys())}\n")

    grand = 0

    if should_run("MLB"):
        print("─" * 50)
        print("[MLB] statsapi.mlb.com (official transactions API)")
        print("─" * 50)
        mlb_total = 0
        for year in SEASONS:
            mlb_total += ingest_mlb_year(leagues["mlb"], year)
            time.sleep(0.3)
        print(f"\n✅ MLB TOTAL: {mlb_total}\n")
        grand += mlb_total

    if should_run("NBA"):
        print("─" * 50)
        print("[NBA] GPT-4o knowledge (basketball-reference / spotrac)")
        print("─" * 50)
        nba_total = 0
        for year in SEASONS:
            nba_total += ingest_nba_year(leagues["nba"], year)
            time.sleep(1)
        print(f"\n✅ NBA TOTAL: {nba_total}\n")
        grand += nba_total

    if should_run("NHL"):
        print("─" * 50)
        print("[NHL] GPT-4o knowledge (capfriendly.com / nhl.com)")
        print("─" * 50)
        nhl_total = 0
        for year in SEASONS:
            nhl_total += ingest_nhl_year(leagues["nhl"], year)
            time.sleep(1)
        print(f"\n✅ NHL TOTAL: {nhl_total}\n")
        grand += nhl_total

    if should_run("EPL"):
        print("─" * 50)
        print("[EPL] GPT-4o knowledge (transfermarkt.com)")
        print("─" * 50)
        epl_total = 0
        for year in SEASONS:
            epl_total += ingest_epl_year(leagues["epl"], year)
            time.sleep(1)
        print(f"\n✅ EPL TOTAL: {epl_total}\n")
        grand += epl_total

    print("=" * 68)
    print(f"GRAND TOTAL NEW INJURIES STORED: {grand}")
    print("=" * 68)
    print_summary()
    print("\nDone.")

if __name__ == "__main__":
    main()
