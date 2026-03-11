#!/usr/bin/env python3
"""
Back In Play — Current Injury Scraper (RotoWire + ESPN)
=======================================================
Scrapes CURRENT injury reports with maximum field capture.

Sources:
  RotoWire -> rotowire.com/{sport}/injury-report.php
  ESPN     -> site.api.espn.com/apis/site/v2/sports/{sport}/{league}/injuries

Leagues: MLB, NBA, NFL, NHL, EPL

Fields captured:
  - player_id, injury_type, injury_type_slug, injury_description
  - date_injured, expected_return, status, source
  - position, side (L/R), long_comment, short_comment
  - fantasy_impact (rotowire), injury_location (body part)

Usage:
  python3 scrape_injuries_current.py              # all leagues
  python3 scrape_injuries_current.py mlb nba       # specific leagues
  python3 scrape_injuries_current.py --source rw   # rotowire only
  python3 scrape_injuries_current.py --source espn # espn only

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
"""

import json, os, re, sys, time, urllib.request, urllib.error
from datetime import date, datetime
from pathlib import Path


# -- Load env -----------------------------------------------------------------
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

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
    sys.exit(1)

MAX_RETRIES = 3
USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


# -- Supabase helpers ---------------------------------------------------------
def sb_headers(prefer="return=representation"):
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json",
        "Prefer": prefer,
    }

def sb_request(method, path, body=None):
    url = SUPABASE_URL + "/rest/v1/" + path
    data = json.dumps(body).encode() if body else None
    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(url, data=data, headers=sb_headers(), method=method)
            resp = urllib.request.urlopen(req, timeout=30)
            text = resp.read().decode()
            return json.loads(text) if text.strip() else []
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                time.sleep(2 ** attempt)
            else:
                print("    [SB FAIL] %s %s: %s" % (method, path, e), flush=True)
                return None

_known_columns = {}  # cache: table -> set of known column names

def _detect_columns(table):
    """Detect which columns exist on a table by doing a SELECT *."""
    if table in _known_columns:
        return _known_columns[table]
    row = sb_get(table, "select=*&limit=1")
    if row and isinstance(row, list) and len(row) > 0:
        cols = set(row[0].keys())
        _known_columns[table] = cols
        return cols
    # Fallback: return None (don't strip anything)
    return None

def _strip_unknown_columns(table, rows):
    """Remove keys that don't exist as columns on the table."""
    known = _detect_columns(table)
    if known is None:
        return rows
    return [{k: v for k, v in row.items() if k in known} for row in rows]


def sb_upsert(table, rows, conflict=""):
    if not rows:
        return 0
    if conflict:
        keys = conflict.split(",")
        seen = set()
        unique = []
        for r in rows:
            k = tuple(r.get(c) for c in keys)
            if k not in seen:
                seen.add(k)
                unique.append(r)
        rows = unique
    # Strip columns that don't exist yet (migration not run)
    rows = _strip_unknown_columns(table, rows)
    hdrs = sb_headers("return=representation,resolution=merge-duplicates")
    url = SUPABASE_URL + "/rest/v1/" + table
    if conflict:
        url += "?on_conflict=" + conflict
    total = 0
    for i in range(0, len(rows), 50):
        batch = rows[i:i+50]
        for attempt in range(MAX_RETRIES):
            try:
                req = urllib.request.Request(url, data=json.dumps(batch).encode(),
                                             headers=hdrs, method="POST")
                resp = urllib.request.urlopen(req, timeout=60)
                result = json.loads(resp.read().decode())
                total += len(result) if isinstance(result, list) else 1
                break
            except Exception as e:
                if attempt < MAX_RETRIES - 1:
                    time.sleep(2 ** attempt)
                else:
                    for row in batch:
                        try:
                            req2 = urllib.request.Request(url, data=json.dumps([row]).encode(),
                                                          headers=hdrs, method="POST")
                            resp2 = urllib.request.urlopen(req2, timeout=30)
                            resp2.read()
                            total += 1
                        except Exception:
                            pass
                    break
    return total

def sb_get(table, params=""):
    url = SUPABASE_URL + "/rest/v1/" + table + "?" + params
    hdrs = {"apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY}
    try:
        req = urllib.request.Request(url, headers=hdrs)
        resp = urllib.request.urlopen(req, timeout=30)
        return json.loads(resp.read().decode())
    except Exception as e:
        print("    [GET err] %s: %s" % (table, e), flush=True)
        return []


# -- Entity helpers -----------------------------------------------------------
_league_cache = {}
_team_cache = {}
_player_cache = {}

def slugify(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")

def get_or_create_league(name, slug):
    if slug in _league_cache:
        return _league_cache[slug]
    existing = sb_get("back_in_play_leagues", "slug=eq.%s&select=league_id" % slug)
    if existing:
        _league_cache[slug] = existing[0]["league_id"]
        return _league_cache[slug]
    result = sb_request("POST", "back_in_play_leagues", {"league_name": name, "slug": slug})
    if result and isinstance(result, list):
        _league_cache[slug] = result[0]["league_id"]
        return _league_cache[slug]
    return None

def get_or_create_team(team_name, league_id):
    key = "%s:%s" % (team_name, league_id)
    if key in _team_cache:
        return _team_cache[key]
    slug = slugify(team_name)
    existing = sb_get("back_in_play_teams", "league_id=eq.%s&select=team_id,team_name" % league_id)
    for t in existing:
        if t["team_name"].lower() == team_name.lower() or slugify(t["team_name"]) == slug:
            _team_cache[key] = t["team_id"]
            return t["team_id"]
    result = sb_request("POST", "back_in_play_teams", {"team_name": team_name, "league_id": league_id})
    if result and isinstance(result, list):
        _team_cache[key] = result[0]["team_id"]
        return result[0]["team_id"]
    return None

def get_or_create_player(name, team_id, position="Unknown"):
    key = "%s:%s" % (name, team_id)
    if key in _player_cache:
        return _player_cache[key]
    slug = slugify(name)
    existing = sb_get("back_in_play_players", "slug=eq.%s&select=player_id,team_id" % slug)
    if existing:
        pid = existing[0]["player_id"]
        _player_cache[key] = pid
        if existing[0]["team_id"] != team_id:
            sb_request("PATCH", "back_in_play_players?player_id=eq.%s" % pid,
                       {"team_id": team_id})
        return pid
    result = sb_request("POST", "back_in_play_players", {
        "player_name": name, "team_id": team_id, "position": position, "slug": slug
    })
    if result and isinstance(result, list):
        _player_cache[key] = result[0]["player_id"]
        return result[0]["player_id"]
    existing2 = sb_get("back_in_play_players", "slug=eq.%s&select=player_id" % slug)
    if existing2:
        _player_cache[key] = existing2[0]["player_id"]
        return existing2[0]["player_id"]
    return None


# -- Injury classification ---------------------------------------------------
INJURY_TYPES = {
    "acl": "ACL", "mcl": "MCL", "meniscus": "Knee", "knee": "Knee",
    "hamstring": "Hamstring", "groin": "Groin", "quad": "Quad",
    "calf": "Calf", "ankle": "Ankle", "achilles": "Achilles",
    "shoulder": "Shoulder", "elbow": "Elbow", "wrist": "Wrist",
    "hand": "Hand", "finger": "Hand", "thumb": "Hand",
    "foot": "Foot", "toe": "Foot", "hip": "Hip", "back": "Back",
    "spine": "Back", "neck": "Neck", "head": "Head",
    "concussion": "Concussion", "oblique": "Oblique", "rib": "Ribs",
    "abdomen": "Abdomen", "abdominal": "Abdomen",
    "pectoral": "Chest", "chest": "Chest",
    "thigh": "Thigh", "forearm": "Arm", "arm": "Arm", "bicep": "Arm",
    "tricep": "Arm", "shin": "Shin", "tibia": "Shin", "fibula": "Shin",
    "illness": "Illness", "covid": "Illness",
    "suspension": "Suspension", "personal": "Personal",
    "rest": "Rest", "load": "Load Management",
}

def classify_injury(desc):
    if not desc:
        return "Unknown", "unknown"
    desc_lower = desc.lower()
    for keyword, injury_type in INJURY_TYPES.items():
        if keyword in desc_lower:
            return injury_type, slugify(injury_type)
    return "Other", "other"

# Detect side (left/right) from description
def extract_side(desc):
    if not desc:
        return None
    desc_lower = desc.lower()
    if "left" in desc_lower:
        return "left"
    if "right" in desc_lower:
        return "right"
    return None


# -- HTTP fetch ---------------------------------------------------------------
def fetch_url(url, headers=None, timeout=30):
    hdrs = dict(headers) if headers else {}
    hdrs.setdefault("User-Agent", USER_AGENT)
    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(url, headers=hdrs)
            resp = urllib.request.urlopen(req, timeout=timeout)
            return resp.read().decode()
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = min(30, 5 * (attempt + 1))
                print("    [429] waiting %ds" % wait, flush=True)
                time.sleep(wait)
            elif e.code >= 500:
                time.sleep(2 ** attempt)
            else:
                print("    [HTTP %d] %s" % (e.code, url[:80]), flush=True)
                return None
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                time.sleep(2 ** attempt)
            else:
                print("    [FETCH FAIL] %s: %s" % (url[:80], e), flush=True)
                return None
    return None

def fetch_json(url, headers=None, timeout=30):
    text = fetch_url(url, headers, timeout)
    if text:
        try:
            return json.loads(text)
        except json.JSONDecodeError as e:
            print("    [JSON err] %s" % e, flush=True)
    return None


# =============================================================================
# ESPN Injuries API (structured JSON — primary source)
# =============================================================================
ESPN_LEAGUES = {
    "nfl": {"sport": "football",   "league": "nfl",    "name": "NFL",            "slug": "nfl"},
    "nba": {"sport": "basketball", "league": "nba",    "name": "NBA",            "slug": "nba"},
    "mlb": {"sport": "baseball",   "league": "mlb",    "name": "MLB",            "slug": "mlb"},
    "nhl": {"sport": "hockey",     "league": "nhl",    "name": "NHL",            "slug": "nhl"},
    "epl": {"sport": "soccer",     "league": "eng.1",  "name": "Premier League", "slug": "premier-league"},
}

# Status normalization
STATUS_MAP = {
    "out": "Out",
    "day-to-day": "Day-to-Day",
    "d2d": "Day-to-Day",
    "dtd": "Day-to-Day",
    "questionable": "Questionable",
    "doubtful": "Doubtful",
    "probable": "Probable",
    "injured reserve": "IR",
    "ir": "IR",
    "10-day il": "IL-10",
    "15-day il": "IL-15",
    "60-day il": "IL-60",
    "7-day il": "IL-7",
    "suspension": "Suspended",
    "paternity": "Personal",
    "bereavement": "Personal",
    "not yet reported": "Unknown",
    "active": "Active",
}

def normalize_status(raw):
    if not raw:
        return "Out"
    return STATUS_MAP.get(raw.lower().strip(), raw.strip().title())


def scrape_espn(league_key):
    """Scrape current injuries from ESPN's injuries API — max field capture."""
    cfg = ESPN_LEAGUES[league_key]
    print("\n  [ESPN %s] Fetching injuries..." % cfg["name"], flush=True)

    url = ("https://site.api.espn.com/apis/site/v2/sports/"
           "%s/%s/injuries" % (cfg["sport"], cfg["league"]))

    data = fetch_json(url)
    if not data:
        print("    No data from ESPN for %s" % league_key, flush=True)
        return []

    league_id = get_or_create_league(cfg["name"], cfg["slug"])
    if not league_id:
        return []

    injuries = []
    today = date.today().isoformat()

    teams_data = data.get("injuries", data.get("items", []))

    for team_entry in teams_data:
        team_info = team_entry.get("team", {})
        team_name = team_info.get("displayName") or team_info.get("name", "Unknown")
        team_abbr = team_info.get("abbreviation", "")
        team_logo = team_info.get("logo", team_info.get("logos", [{}])[0].get("href", "") if team_info.get("logos") else "")

        team_id = get_or_create_team(team_name, league_id)
        if not team_id:
            continue

        player_injuries = team_entry.get("injuries", [])
        for inj in player_injuries:
            athlete = inj.get("athlete", inj)
            pname = athlete.get("displayName") or athlete.get("fullName", "")
            if not pname:
                continue

            # Player details
            position = athlete.get("position", {})
            pos_abbr = position.get("abbreviation", "Unknown") if isinstance(position, dict) else str(position)
            jersey = athlete.get("jersey", "")
            headshot_url = ""
            if athlete.get("headshot"):
                hs = athlete["headshot"]
                headshot_url = hs.get("href", "") if isinstance(hs, dict) else str(hs)
            athlete_links = athlete.get("links", [])
            espn_profile_url = athlete_links[0].get("href", "") if athlete_links else ""

            # Injury type details
            inj_type_obj = inj.get("type", {})
            if isinstance(inj_type_obj, dict):
                inj_desc = inj_type_obj.get("description", inj_type_obj.get("detail", ""))
                inj_abbreviation = inj_type_obj.get("abbreviation", "")
            else:
                inj_desc = str(inj_type_obj) if inj_type_obj else ""
                inj_abbreviation = ""

            # Details object
            details = inj.get("details", {})
            if isinstance(details, dict):
                detail_text = details.get("detail", details.get("type", ""))
                detail_side = details.get("side", "")
                detail_returnDate = details.get("returnDate", "")
                if detail_text and not inj_desc:
                    inj_desc = detail_text
            else:
                detail_side = ""
                detail_returnDate = ""
                detail_text = ""

            # Status
            status_raw = inj.get("status", "")
            if isinstance(status_raw, dict):
                status_type = status_raw.get("type", "")
                status_desc = status_raw.get("description", "")
                status_detail = status_raw.get("detail", "")
                status_raw = status_type or status_desc
            else:
                status_desc = ""
                status_detail = ""
            status = normalize_status(str(status_raw))

            # Comments
            long_comment = inj.get("longComment", "")
            short_comment = inj.get("shortComment", "")

            # Determine date of injury if available
            inj_date = inj.get("date", "")
            if inj_date:
                inj_date = inj_date[:10]  # YYYY-MM-DD
            else:
                inj_date = today

            # Extract side from description if not in details
            side = detail_side or extract_side(inj_desc) or extract_side(long_comment)

            # Build full description
            desc_parts = [d for d in [inj_desc, detail_text, short_comment] if d]
            full_desc = " — ".join(dict.fromkeys(desc_parts))  # dedup while preserving order

            injury_type, injury_slug = classify_injury(full_desc or long_comment)

            player_id = get_or_create_player(pname, team_id, pos_abbr)
            if not player_id:
                continue

            injuries.append({
                "player_id": player_id,
                "injury_type": injury_type,
                "injury_type_slug": injury_slug,
                "injury_description": full_desc[:500],
                "date_injured": inj_date,
                "status": status.lower(),
                "source": "espn.com/%s" % cfg["league"],
                "expected_return": detail_returnDate or None,
                "side": side or None,
                "long_comment": long_comment[:1000] if long_comment else None,
                "short_comment": short_comment[:500] if short_comment else None,
                "injury_location": inj_desc[:200] if inj_desc else None,
            })

    print("    ESPN %s: %d injured players" % (cfg["name"], len(injuries)), flush=True)
    return injuries


# =============================================================================
# RotoWire Injury Reports (HTML scraping)
# =============================================================================
ROTOWIRE_LEAGUES = {
    "mlb": {"url": "https://www.rotowire.com/baseball/injury-report.php",   "name": "MLB",            "slug": "mlb"},
    "nba": {"url": "https://www.rotowire.com/basketball/injury-report.php", "name": "NBA",            "slug": "nba"},
    "nfl": {"url": "https://www.rotowire.com/football/injury-report.php",   "name": "NFL",            "slug": "nfl"},
    "nhl": {"url": "https://www.rotowire.com/hockey/injury-report.php",     "name": "NHL",            "slug": "nhl"},
    "epl": {"url": "https://www.rotowire.com/soccer/injury-report.php",     "name": "Premier League", "slug": "premier-league"},
}


def scrape_rotowire(league_key):
    """Scrape current injury report from RotoWire with full field capture."""
    from bs4 import BeautifulSoup

    cfg = ROTOWIRE_LEAGUES[league_key]
    print("\n  [RotoWire %s] Fetching %s..." % (cfg["name"], cfg["url"]), flush=True)

    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.rotowire.com/",
    }

    html = fetch_url(cfg["url"], headers)
    if not html:
        print("    Failed to fetch RotoWire %s" % cfg["name"], flush=True)
        return []

    soup = BeautifulSoup(html, "html.parser")
    league_id = get_or_create_league(cfg["name"], cfg["slug"])
    if not league_id:
        return []

    injuries = []
    today = date.today().isoformat()

    # -- Strategy 1: Look for RotoWire's .injury-report__team sections --------
    # Each team block: team name header + player rows with columns:
    #   Player | Pos | Injury | Status | Updated | Est. Return
    team_blocks = soup.find_all("div", class_=re.compile(r"injury-report", re.I))

    # Also try the main wrapper
    if not team_blocks:
        team_blocks = soup.find_all("div", class_=re.compile(r"is-injured|injury", re.I))

    for block in team_blocks:
        # Team name from header
        team_header = block.find(class_=re.compile(r"team-name|team__name|injury-report__team-name", re.I))
        if not team_header:
            team_header = block.find(["h2", "h3", "h4"])
        team_name = team_header.get_text(strip=True) if team_header else None

        if not team_name:
            # Try getting from img alt or data attribute
            img = block.find("img")
            if img:
                team_name = img.get("alt", "").replace(" Logo", "").strip()
            if not team_name:
                team_name = block.get("data-team", "Unknown")

        if team_name == "Unknown":
            continue

        team_id = get_or_create_team(team_name, league_id)
        if not team_id:
            continue

        # Player rows
        rows = block.find_all("div", class_=re.compile(r"player|row", re.I))
        if not rows:
            rows = block.find_all("tr")
        if not rows:
            rows = block.find_all("li")

        for row in rows:
            # Extract all text spans/links
            all_items = row.find_all(["a", "span", "td", "div"], recursive=True)
            data = {}

            # Try class-based extraction first (RotoWire uses semantic classes)
            for item in all_items:
                cls = " ".join(item.get("class", []))
                text = item.get_text(strip=True)
                if not text:
                    continue

                cls_lower = cls.lower()
                if "name" in cls_lower or "player" in cls_lower:
                    if "player_name" not in data and len(text) > 2:
                        data["player_name"] = text
                elif "pos" in cls_lower:
                    data["position"] = text
                elif "injury" in cls_lower and "status" not in cls_lower:
                    data["injury"] = text
                elif "status" in cls_lower:
                    data["status"] = text
                elif "update" in cls_lower or "date" in cls_lower:
                    data["updated"] = text
                elif "return" in cls_lower or "est" in cls_lower:
                    data["expected_return"] = text
                elif "impact" in cls_lower or "fantasy" in cls_lower:
                    data["fantasy_impact"] = text
                elif "comment" in cls_lower or "note" in cls_lower:
                    data["comment"] = text

            # Fallback: positional text extraction
            if "player_name" not in data:
                texts = [el.get_text(strip=True) for el in all_items if el.get_text(strip=True)]
                if len(texts) >= 3:
                    data["player_name"] = texts[0]
                    if len(texts) >= 4:
                        data["position"] = texts[1]
                        data["injury"] = texts[2]
                        data["status"] = texts[3]
                        if len(texts) >= 5:
                            data["updated"] = texts[4]
                        if len(texts) >= 6:
                            data["expected_return"] = texts[5]
                    else:
                        data["injury"] = texts[1]
                        data["status"] = texts[2]

            pname = data.get("player_name", "")
            if not pname or len(pname) < 3 or not re.search(r"[a-zA-Z]", pname):
                continue

            inj_desc = data.get("injury", "")
            status_text = data.get("status", "Out")
            position = data.get("position", "Unknown")
            updated = data.get("updated", "")
            expected_return = data.get("expected_return", "")
            fantasy_impact = data.get("fantasy_impact", "")
            comment = data.get("comment", "")

            injury_type, injury_slug = classify_injury(inj_desc)
            side = extract_side(inj_desc)

            player_id = get_or_create_player(pname, team_id, position)
            if not player_id:
                continue

            injuries.append({
                "player_id": player_id,
                "injury_type": injury_type,
                "injury_type_slug": injury_slug,
                "injury_description": inj_desc[:500],
                "date_injured": today,
                "status": normalize_status(status_text).lower(),
                "source": "rotowire.com",
                "expected_return": expected_return or None,
                "side": side,
                "long_comment": comment[:1000] if comment else None,
                "short_comment": fantasy_impact[:500] if fantasy_impact else None,
                "injury_location": inj_desc[:200] if inj_desc else None,
            })

    # -- Strategy 2: Table-based layout (fallback) ----------------------------
    if not injuries:
        tables = soup.find_all("table")
        for table in tables:
            rows = table.find_all("tr")
            current_team = "Unknown"
            for row in rows:
                th = row.find("th", colspan=True)
                if th:
                    current_team = th.get_text(strip=True)
                    continue

                cells = row.find_all("td")
                if len(cells) < 3:
                    continue

                # Typical columns: Player, Pos, Injury, Status, Updated, Est Return
                pname = cells[0].get_text(strip=True)
                if not pname or len(pname) < 3:
                    continue

                pos = cells[1].get_text(strip=True) if len(cells) > 3 else "Unknown"
                inj_desc = cells[2].get_text(strip=True) if len(cells) > 3 else cells[1].get_text(strip=True)
                status_text = cells[3].get_text(strip=True) if len(cells) > 3 else cells[2].get_text(strip=True)
                updated = cells[4].get_text(strip=True) if len(cells) > 4 else ""
                expected_return = cells[5].get_text(strip=True) if len(cells) > 5 else ""

                team_id = get_or_create_team(current_team, league_id)
                if not team_id:
                    continue

                injury_type, injury_slug = classify_injury(inj_desc)
                player_id = get_or_create_player(pname, team_id, pos)
                if not player_id:
                    continue

                injuries.append({
                    "player_id": player_id,
                    "injury_type": injury_type,
                    "injury_type_slug": injury_slug,
                    "injury_description": inj_desc[:500],
                    "date_injured": today,
                    "status": normalize_status(status_text).lower(),
                    "source": "rotowire.com",
                    "expected_return": expected_return or None,
                    "side": extract_side(inj_desc),
                    "injury_location": inj_desc[:200] if inj_desc else None,
                })

    print("    RotoWire %s: %d injured players" % (cfg["name"], len(injuries)), flush=True)
    return injuries


# =============================================================================
# ESPN Player Rankings (top 50 per league)
# =============================================================================
# ESPN athletes endpoint returns players sorted by various criteria.
# We use the athletes list endpoint with a limit of 50 and attempt common
# sort parameters. Falls back to roster-based approach.

def scrape_rankings(league_key):
    """Fetch top ~50 players for a league from ESPN and set league_rank."""
    cfg = ESPN_LEAGUES[league_key]
    print("\n  [Rankings %s] Fetching top players..." % cfg["name"], flush=True)

    league_id = get_or_create_league(cfg["name"], cfg["slug"])
    if not league_id:
        return 0

    ranked_players = []

    # Strategy 1: ESPN athletes endpoint (paginated, sorted by popularity/rank)
    # This endpoint returns athletes with basic info
    athletes_url = (
        "https://site.api.espn.com/apis/site/v2/sports/"
        "%s/%s/athletes?limit=50&active=true" % (cfg["sport"], cfg["league"])
    )
    data = fetch_json(athletes_url)

    if data and data.get("items"):
        # Sometimes returns $ref links that need resolving
        items = data["items"]
        for i, item in enumerate(items[:50]):
            if isinstance(item, dict) and item.get("$ref"):
                # Resolve the reference
                ref_data = fetch_json(item["$ref"])
                if ref_data:
                    item = ref_data
                else:
                    continue
            elif isinstance(item, dict) and item.get("id"):
                pass
            else:
                continue

            pname = item.get("displayName") or item.get("fullName", "")
            if not pname:
                continue

            team_info = item.get("team", {})
            if isinstance(team_info, dict) and team_info.get("$ref"):
                # Don't resolve team refs, too slow; we'll match by name later
                team_name = ""
            else:
                team_name = team_info.get("displayName", "")

            pos = item.get("position", {})
            pos_abbr = pos.get("abbreviation", "Unknown") if isinstance(pos, dict) else "Unknown"

            headshot = item.get("headshot", {})
            headshot_url = headshot.get("href", "") if isinstance(headshot, dict) else ""

            espn_id = str(item.get("id", ""))

            ranked_players.append({
                "name": pname,
                "team_name": team_name,
                "position": pos_abbr,
                "rank": i + 1,
                "headshot_url": headshot_url,
                "espn_id": espn_id,
            })

            if len(ranked_players) >= 50:
                break

        time.sleep(1)

    # Strategy 2: If athletes endpoint didn't work, try team rosters approach
    # Get all teams, take star players from each
    if len(ranked_players) < 20:
        print("    Athletes endpoint returned %d, trying team rosters..." % len(ranked_players), flush=True)
        teams_url = (
            "https://site.api.espn.com/apis/site/v2/sports/"
            "%s/%s/teams?limit=50" % (cfg["sport"], cfg["league"])
        )
        teams_data = fetch_json(teams_url)

        if teams_data:
            teams_list = teams_data.get("sports", [{}])[0].get("leagues", [{}])[0].get("teams", [])
            if not teams_list:
                teams_list = teams_data.get("teams", [])

            for team_entry in teams_list[:35]:
                team_info = team_entry.get("team", team_entry)
                team_name = team_info.get("displayName", "")
                team_id_espn = team_info.get("id", "")

                if not team_id_espn:
                    continue

                # Fetch roster for this team
                roster_url = (
                    "https://site.api.espn.com/apis/site/v2/sports/"
                    "%s/%s/teams/%s/roster" % (cfg["sport"], cfg["league"], team_id_espn)
                )
                roster_data = fetch_json(roster_url)
                if not roster_data:
                    time.sleep(0.5)
                    continue

                # Get athletes from roster
                # ESPN returns athletes either as direct list or grouped with items
                athletes_raw = roster_data.get("athletes", [])
                athlete_list = []
                for entry in athletes_raw:
                    if isinstance(entry, dict):
                        if entry.get("displayName") or entry.get("fullName"):
                            # Direct athlete object
                            athlete_list.append(entry)
                        elif entry.get("items"):
                            # Grouped format
                            athlete_list.extend(entry["items"])

                for athlete in athlete_list[:3]:  # Top ~3 per team
                    pname = athlete.get("displayName") or athlete.get("fullName", "")
                    if not pname:
                        continue

                    pos = athlete.get("position", {})
                    pos_abbr = pos.get("abbreviation", "Unknown") if isinstance(pos, dict) else "Unknown"
                    headshot = athlete.get("headshot", {})
                    headshot_url = headshot.get("href", "") if isinstance(headshot, dict) else ""
                    espn_id = str(athlete.get("id", ""))

                    # Check if already in list
                    if any(p["espn_id"] == espn_id for p in ranked_players if p.get("espn_id")):
                        continue

                    ranked_players.append({
                        "name": pname,
                        "team_name": team_name,
                        "position": pos_abbr,
                        "rank": len(ranked_players) + 1,
                        "headshot_url": headshot_url,
                        "espn_id": espn_id,
                    })

                    if len(ranked_players) >= 50:
                        break
                if len(ranked_players) >= 50:
                    break

                time.sleep(0.3)
                if len(ranked_players) >= 50:
                    break

    # Now upsert rankings to back_in_play_players
    updated = 0
    for rp in ranked_players[:50]:
        pname = rp["name"]
        slug = slugify(pname)

        # Check if player exists
        existing = sb_get("back_in_play_players", "slug=eq.%s&select=player_id" % slug)

        update_data = {"league_rank": rp["rank"]}
        if rp.get("headshot_url"):
            update_data["headshot_url"] = rp["headshot_url"]
        if rp.get("espn_id"):
            update_data["espn_id"] = rp["espn_id"]

        if existing:
            # Update current ranking; set preseason_rank only if not already set
            pid = existing[0]["player_id"]
            # Check if preseason_rank already exists
            full = sb_get("back_in_play_players", "player_id=eq.%s&select=preseason_rank" % pid)
            if full and full[0].get("preseason_rank") is None:
                update_data["preseason_rank"] = rp["rank"]
            sb_request("PATCH", "back_in_play_players?player_id=eq.%s" % pid, update_data)
            updated += 1
        elif rp.get("team_name"):
            # Create player with ranking
            team_id = get_or_create_team(rp["team_name"], league_id)
            if team_id:
                result = sb_request("POST", "back_in_play_players", {
                    "player_name": pname,
                    "team_id": team_id,
                    "position": rp.get("position", "Unknown"),
                    "slug": slug,
                    **update_data,
                })
                if result:
                    updated += 1

    print("    Rankings %s: %d players ranked (top 50)" % (cfg["name"], updated), flush=True)
    return updated


# =============================================================================
# Diff / Change Detection
# =============================================================================
# Local state file tracks last-seen injuries per player.
# On each run we compare fresh scrape against local state.
# Only changed/new entries get written to Supabase.

STATE_FILE = "/workspace/back-in-play/scripts/.injury_state.json"

def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}

def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE) or ".", exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)


def injury_fingerprint(inj):
    """Create a hashable fingerprint for an injury row — changes here = real update."""
    return "|".join(str(inj.get(k, "")) for k in [
        "player_id", "status", "injury_type", "injury_description",
        "expected_return", "side", "injury_location",
    ])


def _status_change_summary(old_status, new_status, inj):
    """Generate a human-readable summary for a status transition."""
    ns = new_status.lower().replace("-", "_")
    os_ = old_status.lower().replace("-", "_")
    if ns == "out":
        if os_ in ("day_to_day", "questionable", "doubtful"):
            return "Downgraded to OUT"
        return "Placed on OUT"
    if ns in ("ir", "il_10", "il_15", "il_60", "il_7"):
        return "Placed on %s" % new_status.upper()
    if ns == "day_to_day":
        return "Upgraded to Day-to-Day" if os_ == "out" else "Day-to-Day"
    if ns == "questionable":
        return "Upgraded to Questionable" if os_ == "out" else "Questionable"
    if ns == "doubtful":
        if os_ in ("questionable", "probable"):
            return "Downgraded to Doubtful"
        return "Doubtful"
    if ns == "probable":
        return "Upgraded to Probable"
    if ns == "active":
        return "Activated"
    if ns == "reduced_load":
        return "Minutes restriction"
    if ns == "back_in_play":
        return "Full return"
    if ns == "suspended":
        return "Suspended"
    return "%s -> %s" % (old_status, new_status)


def diff_injuries(fresh, state_for_league):
    """Compare fresh injuries against last-known state.
    Returns (changed, removed_player_ids, change_log).
    changed = list of injury dicts that are new or modified.
    """
    changed = []
    change_log = []

    # Build lookup of last-known state by player_id
    old_by_player = {}
    for fp, entry in state_for_league.items():
        pid = entry.get("player_id", "")
        if pid:
            old_by_player[pid] = entry

    seen_pids = set()
    for inj in fresh:
        pid = inj["player_id"]
        seen_pids.add(pid)
        fp = injury_fingerprint(inj)
        old_entry = old_by_player.get(pid)

        if not old_entry:
            # New injury
            changed.append(inj)
            pname = _resolve_player_name(pid)
            change_log.append("  + NEW: %s — %s (%s)" % (pname, inj.get("injury_type", "?"), inj.get("status", "?")))
        elif old_entry.get("fingerprint") != fp:
            # Changed
            changed.append(inj)
            pname = _resolve_player_name(pid)
            old_status = old_entry.get("status", "?")
            new_status = inj.get("status", "?")
            if old_status != new_status:
                change_log.append("  ~ STATUS: %s — %s → %s" % (pname, old_status, new_status))
            else:
                change_log.append("  ~ UPDATED: %s — %s" % (pname, inj.get("injury_type", "?")))

    # Detect removals (player was injured, now not on injury list = likely returned)
    removed_pids = []
    for pid, entry in old_by_player.items():
        if pid not in seen_pids:
            removed_pids.append(pid)
            pname = _resolve_player_name(pid)
            change_log.append("  - ACTIVE: %s (off injury report → active)" % pname)

    # Build structured status change records
    status_changes = []
    for inj in fresh:
        pid = inj["player_id"]
        old_entry = old_by_player.get(pid)
        if not old_entry:
            status_changes.append({
                "player_id": pid,
                "injury_id": inj.get("injury_id"),
                "old_status": None,
                "new_status": inj.get("status", "out"),
                "change_type": "new_injury",
                "summary": "New injury: %s (%s)" % (inj.get("injury_type", "Unknown"), inj.get("status", "out")),
            })
        elif old_entry.get("fingerprint") != injury_fingerprint(inj):
            old_s = old_entry.get("status", "")
            new_s = inj.get("status", "")
            if old_s != new_s:
                status_changes.append({
                    "player_id": pid,
                    "injury_id": inj.get("injury_id"),
                    "old_status": old_s,
                    "new_status": new_s,
                    "change_type": "status_change",
                    "summary": _status_change_summary(old_s, new_s, inj),
                })
            # Skip logging when status unchanged (avoids spam every scrape cycle)
            pass

    for pid in removed_pids:
        old_entry = old_by_player.get(pid, {})
        status_changes.append({
            "player_id": pid,
            "injury_id": None,
            "old_status": old_entry.get("status", "out"),
            "new_status": "active",
            "change_type": "activated",
            "summary": "Activated (cleared from injury report)",
        })

    return changed, removed_pids, change_log, status_changes


def _resolve_player_name(player_id):
    """Try to resolve player name from cache, fallback to ID."""
    for key, pid in _player_cache.items():
        if pid == player_id:
            return key.split(":")[0]
    return player_id[:8]


def log_status_changes(changes):
    """Write status change records to back_in_play_status_changes table."""
    if not changes:
        return
    rows = []
    for c in changes:
        rows.append({
            "player_id": c["player_id"],
            "injury_id": c.get("injury_id"),
            "old_status": c.get("old_status"),
            "new_status": c["new_status"],
            "change_type": c["change_type"],
            "summary": c["summary"],
        })
    for i in range(0, len(rows), 50):
        chunk = rows[i:i + 50]
        sb_request("POST", "back_in_play_status_changes", chunk)
    print("  Logged %d status changes" % len(rows), flush=True)


def build_state_entry(inj):
    """Build a state entry for persistence."""
    return {
        "player_id": inj["player_id"],
        "status": inj.get("status", ""),
        "injury_type": inj.get("injury_type", ""),
        "fingerprint": injury_fingerprint(inj),
    }


# =============================================================================
# Main orchestrator
# =============================================================================
def fetch_all_injuries(league_key, sources):
    """Fetch injuries from all sources for a league, return merged list."""
    all_injuries = []

    if "espn" in sources:
        espn_injuries = scrape_espn(league_key)
        all_injuries.extend(espn_injuries)
        time.sleep(0.5)

    if "rw" in sources:
        rw_injuries = scrape_rotowire(league_key)
        existing_players = set(inj["player_id"] for inj in all_injuries)
        for inj in rw_injuries:
            if inj["player_id"] not in existing_players:
                all_injuries.append(inj)
                existing_players.add(inj["player_id"])
            else:
                for existing in all_injuries:
                    if existing["player_id"] == inj["player_id"]:
                        for field in ["expected_return", "side", "long_comment", "short_comment", "injury_location"]:
                            if not existing.get(field) and inj.get(field):
                                existing[field] = inj[field]
                        break

    return all_injuries


def stamp_ranks(injuries):
    """Add rank_at_injury from player's current league_rank."""
    if not injuries:
        return
    player_ids = list(set(inj["player_id"] for inj in injuries))
    rank_map = {}
    for ci in range(0, len(player_ids), 20):
        chunk = player_ids[ci:ci+20]
        ids_filter = ",".join(chunk)
        rows = sb_get("back_in_play_players",
                       "player_id=in.(%s)&select=player_id,league_rank" % ids_filter)
        for r in rows:
            if r.get("league_rank"):
                rank_map[r["player_id"]] = r["league_rank"]
    for inj in injuries:
        inj["rank_at_injury"] = rank_map.get(inj["player_id"])


def ingest_league(league_key, sources, use_diff=False, state=None):
    """Scrape and upsert injuries for one league."""
    print("\n" + "=" * 60, flush=True)
    print("[%s] Current Injury Report" % league_key.upper(), flush=True)
    print("=" * 60, flush=True)

    all_injuries = fetch_all_injuries(league_key, sources)

    if not all_injuries:
        print("  No injuries found for %s" % league_key.upper(), flush=True)
        return 0

    if use_diff and state is not None:
        league_state = state.get(league_key, {})
        changed, removed_pids, change_log, status_changes = diff_injuries(all_injuries, league_state)

        if not changed and not removed_pids:
            print("  No changes for %s ✓" % league_key.upper(), flush=True)
            # Still update state (timestamps etc)
            new_state = {}
            for inj in all_injuries:
                new_state[inj["player_id"]] = build_state_entry(inj)
            state[league_key] = new_state
            return 0

        # Log changes
        print("  %d changes detected:" % (len(changed) + len(removed_pids)), flush=True)
        for line in change_log:
            print(line, flush=True)

        # Mark removed players as "active" (cleared from injury report)
        # NOT "returned"/"back in play" — those require actual minutes data
        today = date.today().isoformat()
        from datetime import timedelta
        cutoff_date = (datetime.now() - timedelta(days=60)).strftime("%Y-%m-%d")
        for pid in removed_pids:
            sb_request("PATCH",
                       "back_in_play_injuries?player_id=eq.%s&status=not.in.(active,returned)&date_injured=gte.%s"
                       % (pid, cutoff_date),
                       {"status": "active", "return_date": today})

        # Only upsert the changed ones
        stamp_ranks(changed)
        count = sb_upsert("back_in_play_injuries", changed,
                          "player_id,date_injured,injury_type_slug")
        print("  UPSERTED: %d changed injuries for %s" % (count, league_key.upper()), flush=True)

        # Log status changes to the feed table
        log_status_changes(status_changes)

        # Update state
        new_state = {}
        for inj in all_injuries:
            new_state[inj["player_id"]] = build_state_entry(inj)
        state[league_key] = new_state

        return count
    else:
        # Full mode — upsert everything
        stamp_ranks(all_injuries)
        count = sb_upsert("back_in_play_injuries", all_injuries,
                          "player_id,date_injured,injury_type_slug")
        print("  UPSERTED: %d injuries for %s" % (count, league_key.upper()), flush=True)
        return count


def run_once(targets, sources, skip_rankings=False, rankings_only=False, use_diff=False):
    """Single scrape pass across all target leagues."""
    state = load_state() if use_diff else None

    if not skip_rankings:
        for league_key in targets:
            scrape_rankings(league_key)

    if rankings_only:
        return

    grand_total = 0
    for league_key in targets:
        count = ingest_league(league_key, sources, use_diff=use_diff, state=state)
        grand_total += count

    if use_diff and state is not None:
        save_state(state)

    if grand_total > 0:
        print("\n  >> %d injury changes written to Supabase" % grand_total, flush=True)
    else:
        print("\n  >> No changes across all leagues ✓", flush=True)

    return grand_total


def main():
    args = [a.lower() for a in sys.argv[1:]]

    # Parse flags
    sources = ["espn", "rw"]
    skip_rankings = "--no-rankings" in args
    rankings_only = "--rankings" in args
    watch_mode = "--watch" in args
    full_mode = "--full" in args  # skip diff, upsert everything
    args = [a for a in args if a not in ("--no-rankings", "--rankings", "--watch", "--full")]

    # Parse --interval N (minutes, default 2)
    interval = 2
    if "--interval" in args:
        idx = args.index("--interval")
        if idx + 1 < len(args) and args[idx + 1].isdigit():
            interval = int(args[idx + 1])
            args = [a for i, a in enumerate(args) if i != idx and i != idx + 1]
        else:
            args = [a for i, a in enumerate(args) if i != idx]

    if "--source" in args:
        idx = args.index("--source")
        if idx + 1 < len(args):
            src = args[idx + 1]
            if src in ("espn", "rw", "rotowire"):
                sources = ["rw" if src == "rotowire" else src]
            args = [a for i, a in enumerate(args) if i != idx and i != idx + 1]

    valid_leagues = ["mlb", "nba", "nfl", "nhl", "epl"]
    targets = [a for a in args if a in valid_leagues]
    if not targets:
        targets = valid_leagues

    use_diff = not full_mode  # diff by default

    print("=" * 60, flush=True)
    print("Back In Play — Current Injury Scraper", flush=True)
    print("Date: %s" % date.today().isoformat(), flush=True)
    print("Leagues: %s" % ", ".join(t.upper() for t in targets), flush=True)
    print("Sources: %s" % ", ".join(sources), flush=True)
    print("Mode: %s" % ("WATCH every %dm" % interval if watch_mode else "FULL" if full_mode else "DIFF (once)"), flush=True)
    print("Rankings: %s" % ("only" if rankings_only else "skip" if skip_rankings else "first run"), flush=True)
    print("=" * 60, flush=True)

    if watch_mode:
        # Continuous mode: scrape every N minutes, only write changes
        run_count = 0
        while True:
            run_count += 1
            ts = datetime.now().strftime("%H:%M:%S")
            print("\n>>> [%s] Run #%d" % (ts, run_count), flush=True)

            # Rankings only on first run and every 6 hours
            do_rankings = (run_count == 1) or (run_count % (360 // interval) == 0)

            try:
                run_once(targets, sources,
                         skip_rankings=not do_rankings,
                         use_diff=True)
            except Exception as e:
                print("  [ERROR] %s" % e, flush=True)

            print("  Next check in %d minutes..." % interval, flush=True)
            time.sleep(interval * 60)
    else:
        # Single run
        run_once(targets, sources,
                 skip_rankings=skip_rankings,
                 rankings_only=rankings_only,
                 use_diff=use_diff)


if __name__ == "__main__":
    main()
