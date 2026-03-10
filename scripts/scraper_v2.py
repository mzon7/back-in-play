#!/usr/bin/env python3
"""
Back In Play — Injury Scraper v2
=================================
Direct API/HTML scraping. No AI middleman.

Sources:
  MLB  -> statsapi.mlb.com (JSON transactions API)
  NFL  -> ESPN Transactions API (JSON)
  NBA  -> ESPN Transactions API (JSON)
  NHL  -> ESPN Transactions API (JSON)
  EPL  -> transfermarkt.co.uk (HTML player injury pages)

Features:
  - Checkpoint/resume - tracks progress per league+season
  - Retry with exponential backoff
  - Upserts - safe to re-run
  - Parallel execution per league (run multiple instances)

Usage:
  python3 scraper_v2.py              # all leagues
  python3 scraper_v2.py mlb          # single league
  python3 scraper_v2.py nfl nba      # multiple leagues
  python3 scraper_v2.py --gaps       # show data gaps
  python3 scraper_v2.py --reset mlb  # reset checkpoint and re-scrape
"""

import json, os, re, sys, time, urllib.request, urllib.error
from datetime import date, datetime

# -- Config -------------------------------------------------------------------
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

SEASONS = list(range(2015, 2027))  # 2015 through 2026
CHECKPOINT_FILE = "/workspace/back-in-play/scripts/.scraper_checkpoint.json"
MAX_RETRIES = 3
RATE_LIMIT_DELAY = 1.0  # seconds between requests


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
                wait = 2 ** attempt
                print("    [SB retry %d] %s -- waiting %ds" % (attempt + 1, e, wait), flush=True)
                time.sleep(wait)
            else:
                print("    [SB FAIL] %s %s: %s" % (method, path, e), flush=True)
                return None


def sb_upsert(table, rows, conflict=""):
    if not rows:
        return 0
    hdrs = sb_headers("return=representation,resolution=merge-duplicates")
    url = SUPABASE_URL + "/rest/v1/" + table
    if conflict:
        url += "?on_conflict=" + conflict
    total = 0
    for i in range(0, len(rows), 500):
        batch = rows[i:i + 500]
        data = json.dumps(batch).encode()
        for attempt in range(MAX_RETRIES):
            try:
                req = urllib.request.Request(url, data=data, headers=hdrs, method="POST")
                resp = urllib.request.urlopen(req, timeout=60)
                result = json.loads(resp.read().decode())
                total += len(result) if isinstance(result, list) else 1
                break
            except Exception as e:
                if attempt < MAX_RETRIES - 1:
                    wait = 2 ** attempt
                    print("    [upsert retry %d] %s" % (attempt + 1, e), flush=True)
                    time.sleep(wait)
                else:
                    print("    [UPSERT FAIL] %s: %s" % (table, e), flush=True)
    return total


def sb_get(table, params=""):
    url = SUPABASE_URL + "/rest/v1/" + table + "?" + params
    hdrs = {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
    }
    try:
        req = urllib.request.Request(url, headers=hdrs)
        resp = urllib.request.urlopen(req, timeout=30)
        return json.loads(resp.read().decode())
    except Exception as e:
        print("    [GET err] %s: %s" % (table, e), flush=True)
        return []


# -- Checkpoint system --------------------------------------------------------
def load_checkpoint():
    try:
        with open(CHECKPOINT_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_checkpoint(data):
    with open(CHECKPOINT_FILE, "w") as f:
        json.dump(data, f, indent=2)


def is_done(checkpoint, league, season):
    key = "%s:%s" % (league, season)
    return checkpoint.get(key, {}).get("done", False)


def mark_done(checkpoint, league, season, count):
    key = "%s:%s" % (league, season)
    checkpoint[key] = {"done": True, "count": count, "ts": datetime.now().isoformat()}
    save_checkpoint(checkpoint)


# -- HTTP fetch with retry ----------------------------------------------------
def fetch_url(url, headers=None, timeout=30):
    hdrs = dict(headers) if headers else {}
    hdrs.setdefault("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(url, headers=hdrs)
            resp = urllib.request.urlopen(req, timeout=timeout)
            return resp.read().decode()
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = min(30, 5 * (attempt + 1))
                print("    [429 rate limit] waiting %ds" % wait, flush=True)
                time.sleep(wait)
            elif e.code >= 500:
                wait = 2 ** attempt
                print("    [HTTP %d] retry %d in %ds" % (e.code, attempt + 1, wait), flush=True)
                time.sleep(wait)
            else:
                print("    [HTTP %d] %s" % (e.code, url[:80]), flush=True)
                return None
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                wait = 2 ** attempt
                print("    [fetch retry %d] %s" % (attempt + 1, e), flush=True)
                time.sleep(wait)
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


# -- Entity cache/creation ----------------------------------------------------
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
    result = sb_request("POST", "back_in_play_teams", {
        "team_name": team_name, "league_id": league_id
    })
    if result and isinstance(result, list):
        _team_cache[key] = result[0]["team_id"]
        return result[0]["team_id"]
    return None


def get_or_create_player(name, team_id, position="Unknown"):
    key = "%s:%s" % (name, team_id)
    if key in _player_cache:
        return _player_cache[key]
    slug = slugify(name)
    existing = sb_get("back_in_play_players", "team_id=eq.%s&slug=eq.%s&select=player_id" % (team_id, slug))
    if existing:
        _player_cache[key] = existing[0]["player_id"]
        return existing[0]["player_id"]
    result = sb_request("POST", "back_in_play_players", {
        "player_name": name, "team_id": team_id, "position": position, "slug": slug
    })
    if result and isinstance(result, list):
        _player_cache[key] = result[0]["player_id"]
        return result[0]["player_id"]
    return None


# -- Injury type classification ------------------------------------------------
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
    "tommy john": "Elbow (TJS)", "ucl": "Elbow (UCL)",
    "illness": "Illness", "covid": "Illness",
    "suspension": "Suspension", "personal": "Personal",
}


def classify_injury(desc):
    if not desc:
        return "Unknown", "unknown"
    desc_lower = desc.lower()
    for keyword, injury_type in INJURY_TYPES.items():
        if keyword in desc_lower:
            return injury_type, slugify(injury_type)
    return "Other", "other"


# Position abbreviation patterns
POS_PATTERN = re.compile(
    r"\b(QB|RB|WR|TE|OL|OT|OG|DL|DE|DT|LB|CB|FS|SS|K|P|LS|"  # NFL
    r"PG|SG|SF|PF|"  # NBA
    r"LW|RW|D|G)\b"  # NHL
)


def extract_players_from_espn(desc):
    """Extract player names and positions from ESPN transaction description."""
    players = []

    # Skip return/activation keywords
    skip_kw = ["activated from", "reinstated from", "designated to return",
                "returned to", "cleared to play"]

    parts = re.split(r"\.\s+|;\s+", desc)
    for part in parts:
        part_lower = part.lower()
        if any(kw in part_lower for kw in skip_kw):
            continue

        placed_match = re.search(r"placed\s+(.*?)\s+on\s+", part, re.I)
        if not placed_match:
            continue

        player_text = placed_match.group(1)
        player_text = player_text.replace(" and ", ", ")
        segments = [s.strip() for s in player_text.split(",") if s.strip()]

        for seg in segments:
            pos_match = POS_PATTERN.search(seg)
            position = pos_match.group(1) if pos_match else "Unknown"
            name = POS_PATTERN.sub("", seg).strip()
            name = re.sub(r"\s+", " ", name).strip()
            if name and len(name) > 2 and " " in name:
                players.append((name, position))

    return players


# =============================================================================
# MLB -- statsapi.mlb.com
# =============================================================================
def ingest_mlb(checkpoint):
    print("\n" + "=" * 60, flush=True)
    print("[MLB] statsapi.mlb.com -- official transactions API", flush=True)
    print("=" * 60, flush=True)

    league_id = get_or_create_league("MLB", "mlb")
    total = 0

    for year in SEASONS:
        if is_done(checkpoint, "mlb", year):
            print("  [%d] skipped (checkpoint)" % year, flush=True)
            continue

        year_count = 0
        for month in range(1, 13):
            start = "%d-%02d-01" % (year, month)
            if month == 12:
                end = "%d-12-31" % year
            else:
                end = "%d-%02d-01" % (year, month + 1)

            # Skip future months
            if start > date.today().isoformat():
                continue

            url = "https://statsapi.mlb.com/api/v1/transactions?startDate=%s&endDate=%s" % (start, end)
            data = fetch_json(url)
            if not data:
                continue

            txns = data.get("transactions", [])
            injuries = []

            for txn in txns:
                desc = txn.get("description", "")
                desc_lower = desc.lower()

                # Filter for IL/DL placements
                if not any(kw in desc_lower for kw in [
                    "placed on", "transferred to the", "injured list", "disabled list",
                    "10-day", "15-day", "60-day", "7-day"
                ]):
                    continue
                # Skip activations/returns
                if any(kw in desc_lower for kw in [
                    "activated from", "reinstated from", "recalled from",
                    "returned from", "transferred to the 60-day"
                ]):
                    # Keep "transferred to the 60-day" -- that's a placement
                    if "transferred to the 60-day" not in desc_lower:
                        continue

                team_data = txn.get("toTeam") or txn.get("fromTeam")
                if not team_data:
                    continue

                team_name = team_data.get("name", "Unknown")
                txn_date = (txn.get("effectiveDate") or txn.get("date", ""))[:10]
                if not txn_date:
                    continue

                # Extract player name -- MLB descriptions are structured:
                # "Team placed Player Name on the 10-day injured list..."
                # Try to get from the person field first
                person = txn.get("person", {})
                pname = person.get("fullName", "")

                if not pname:
                    # Fallback: parse from description
                    m = re.search(r"(?:placed|transferred)\s+(?:OF|IF|SS|1B|2B|3B|C|P|SP|RP|LHP|RHP|DH)?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z'.]+)+)", desc)
                    if m:
                        pname = m.group(1)
                    else:
                        continue

                pos_match = re.search(r"\b(P|C|1B|2B|3B|SS|LF|CF|RF|OF|DH|SP|RP|LHP|RHP)\b", desc)
                position = pos_match.group(1) if pos_match else "Unknown"

                injury_type, injury_slug = classify_injury(desc)

                team_id = get_or_create_team(team_name, league_id)
                if not team_id:
                    continue
                player_id = get_or_create_player(pname, team_id, position)
                if not player_id:
                    continue

                injuries.append({
                    "player_id": player_id,
                    "injury_type": injury_type,
                    "injury_type_slug": injury_slug,
                    "injury_description": desc[:500],
                    "date_injured": txn_date,
                    "status": "out",
                    "source": "statsapi.mlb.com",
                })

            if injuries:
                count = sb_upsert("back_in_play_injuries", injuries, "player_id,date_injured")
                year_count += count

            time.sleep(0.5)

        print("  [%d] %d IL placements" % (year, year_count), flush=True)
        mark_done(checkpoint, "mlb", year, year_count)
        total += year_count

    print("\n  MLB TOTAL: %d" % total, flush=True)
    return total


# =============================================================================
# ESPN Leagues (NFL, NBA, NHL)
# =============================================================================
ESPN_SPORTS = {
    "nfl": {"sport": "football", "league": "nfl", "name": "NFL", "slug": "nfl"},
    "nba": {"sport": "basketball", "league": "nba", "name": "NBA", "slug": "nba"},
    "nhl": {"sport": "hockey", "league": "nhl", "name": "NHL", "slug": "nhl"},
}

IR_KEYWORDS = [
    "injured reserve", "injured list", "reserve/injured",
    "placed on ir", "placed on il", "reserve list",
    "disabled list", "day-to-day", "out indefinitely",
    "out for season", "out for the season",
]

SKIP_KEYWORDS = [
    "activated from", "reinstated from", "designated to return",
    "returned to", "cleared to play",
]


def ingest_espn_league(checkpoint, league_key):
    cfg = ESPN_SPORTS[league_key]
    print("\n" + "=" * 60, flush=True)
    print("[%s] ESPN Transactions API" % cfg["name"], flush=True)
    print("=" * 60, flush=True)

    league_id = get_or_create_league(cfg["name"], cfg["slug"])
    total = 0

    for year in SEASONS:
        if is_done(checkpoint, league_key, year):
            print("  [%d] skipped (checkpoint)" % year, flush=True)
            continue

        year_count = 0

        # Scrape in seasonal windows
        if league_key == "nfl":
            windows = [
                ("%d-03-01" % year, "%d-07-31" % year),      # offseason
                ("%d-08-01" % year, "%d-10-31" % year),       # preseason + early
                ("%d-11-01" % year, "%d-02-28" % (year + 1)), # late season + playoffs
            ]
        elif league_key == "nba":
            windows = [
                ("%d-07-01" % year, "%d-10-31" % year),       # offseason
                ("%d-11-01" % year, "%d-02-28" % (year + 1)),  # first half
                ("%d-03-01" % (year + 1), "%d-06-30" % (year + 1)),  # second half
            ]
        elif league_key == "nhl":
            windows = [
                ("%d-07-01" % year, "%d-10-31" % year),
                ("%d-11-01" % year, "%d-02-28" % (year + 1)),
                ("%d-03-01" % (year + 1), "%d-06-30" % (year + 1)),
            ]
        else:
            windows = [("%d-01-01" % year, "%d-12-31" % year)]

        today_str = date.today().isoformat()

        for start_date, end_date in windows:
            if start_date > today_str:
                continue
            if end_date > today_str:
                end_date = today_str

            start_str = start_date.replace("-", "")
            end_str = end_date.replace("-", "")

            page = 1
            while True:
                url = ("https://site.api.espn.com/apis/site/v2/sports/"
                       "%s/%s/transactions"
                       "?dates=%s-%s&limit=100&page=%d" % (
                           cfg["sport"], cfg["league"], start_str, end_str, page))

                data = fetch_json(url)
                if not data:
                    break

                txns = data.get("transactions", [])
                if not txns:
                    break

                injuries = []
                for txn in txns:
                    desc = txn.get("description", "")
                    desc_lower = desc.lower()

                    is_injury = any(kw in desc_lower for kw in IR_KEYWORDS)
                    if not is_injury:
                        continue
                    is_return = any(kw in desc_lower for kw in SKIP_KEYWORDS)
                    if is_return:
                        continue

                    team_data = txn.get("team", {})
                    team_name = team_data.get("displayName", "Unknown")
                    txn_date = txn.get("date", "")[:10]
                    if not txn_date:
                        continue

                    player_names = extract_players_from_espn(desc)

                    injury_type, injury_slug = classify_injury(desc)

                    team_id = get_or_create_team(team_name, league_id)
                    if not team_id:
                        continue

                    for pname, pos in player_names:
                        player_id = get_or_create_player(pname, team_id, pos)
                        if not player_id:
                            continue
                        injuries.append({
                            "player_id": player_id,
                            "injury_type": injury_type,
                            "injury_type_slug": injury_slug,
                            "injury_description": desc[:500],
                            "date_injured": txn_date,
                            "status": "out",
                            "source": "espn.com/%s" % cfg["league"],
                        })

                if injuries:
                    count = sb_upsert("back_in_play_injuries", injuries, "player_id,date_injured")
                    year_count += count

                page_count = data.get("pageCount", 1)
                if page >= page_count:
                    break
                page += 1
                time.sleep(RATE_LIMIT_DELAY)

            time.sleep(0.5)

        print("  [%d] %d injuries" % (year, year_count), flush=True)
        mark_done(checkpoint, league_key, year, year_count)
        total += year_count

    print("\n  %s TOTAL: %d" % (cfg["name"], total), flush=True)
    return total


# =============================================================================
# EPL -- Transfermarkt
# =============================================================================

# Top EPL clubs with TM club IDs
EPL_CLUBS = {
    "Arsenal": 11, "Aston Villa": 405, "Bournemouth": 989,
    "Brentford": 1148, "Brighton & Hove Albion": 1237,
    "Burnley": 1132, "Chelsea": 631, "Crystal Palace": 873,
    "Everton": 29, "Fulham": 931, "Ipswich Town": 677,
    "Leeds United": 399, "Leicester City": 1003,
    "Liverpool": 31, "Manchester City": 281,
    "Manchester United": 985, "Newcastle United": 762,
    "Norwich City": 1123, "Nottingham Forest": 703,
    "Sheffield United": 350, "Southampton": 180,
    "Swansea City": 2288, "Tottenham Hotspur": 148,
    "Watford": 1010, "West Bromwich Albion": 984,
    "West Ham United": 379, "Wolverhampton Wanderers": 543,
}

TM_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


def parse_tm_date(text):
    """Parse Transfermarkt date DD/MM/YYYY to YYYY-MM-DD."""
    if not text or text == "-":
        return None
    match = re.match(r"(\d{2})/(\d{2})/(\d{4})", text)
    if match:
        return "%s-%s-%s" % (match.group(3), match.group(2), match.group(1))
    return None


def ingest_epl(checkpoint):
    from bs4 import BeautifulSoup

    print("\n" + "=" * 60, flush=True)
    print("[EPL] transfermarkt.co.uk -- player injury histories", flush=True)
    print("=" * 60, flush=True)

    league_id = get_or_create_league("Premier League", "premier-league")
    total = 0

    for year in SEASONS:
        if year > 2025:
            continue
        if is_done(checkpoint, "epl", year):
            print("  [%d] skipped (checkpoint)" % year, flush=True)
            continue

        year_count = 0

        for club_name, club_id in EPL_CLUBS.items():
            ck_key = "epl_club:%d:%d" % (year, club_id)
            if checkpoint.get(ck_key, {}).get("done"):
                continue

            # Get squad for this season
            club_slug = slugify(club_name)
            squad_url = ("https://www.transfermarkt.co.uk/%s"
                         "/kader/verein/%d/saison_id/%d" % (club_slug, club_id, year))
            html = fetch_url(squad_url, TM_HEADERS)
            if not html:
                time.sleep(3)
                continue

            soup = BeautifulSoup(html, "lxml")

            # Find player links
            player_links = set()
            for a in soup.find_all("a", href=re.compile(r"/profil/spieler/\d+")):
                href = a["href"]
                pid_match = re.search(r"/spieler/(\d+)", href)
                pname = a.get_text(strip=True)
                if pid_match and pname and len(pname) > 1:
                    player_links.add((pname, pid_match.group(1)))

            print("    %s %d: %d players" % (club_name, year, len(player_links)), flush=True)

            team_id = get_or_create_team(club_name, league_id)
            if not team_id:
                continue

            club_count = 0
            for pname, pid in player_links:
                # Fetch player injury page
                inj_url = ("https://www.transfermarkt.co.uk/%s"
                           "/verletzungen/spieler/%s" % (slugify(pname), pid))
                inj_html = fetch_url(inj_url, TM_HEADERS)
                if not inj_html:
                    time.sleep(2)
                    continue

                inj_soup = BeautifulSoup(inj_html, "lxml")
                table = inj_soup.find("table", class_="items")
                if not table:
                    time.sleep(1)
                    continue

                tbody = table.find("tbody")
                if not tbody:
                    time.sleep(1)
                    continue

                player_id = get_or_create_player(pname, team_id)
                if not player_id:
                    continue

                injuries = []
                for tr in tbody.find_all("tr"):
                    cells = tr.find_all("td")
                    if len(cells) < 6:
                        continue

                    season_text = cells[0].get_text(strip=True)
                    injury_desc = cells[1].get_text(strip=True)
                    date_from = cells[2].get_text(strip=True)
                    date_until = cells[3].get_text(strip=True)
                    days_text = cells[4].get_text(strip=True)
                    games_text = cells[5].get_text(strip=True)

                    # Parse season year
                    season_match = re.match(r"(\d{2})/(\d{2})", season_text)
                    if season_match:
                        season_year = 2000 + int(season_match.group(1))
                    else:
                        continue

                    if season_year < 2015 or season_year > 2026:
                        continue

                    date_injured = parse_tm_date(date_from)
                    return_date = parse_tm_date(date_until)
                    if not date_injured:
                        continue

                    injury_type, injury_slug = classify_injury(injury_desc)

                    recovery_days = None
                    if days_text and days_text != "-":
                        dm = re.search(r"(\d+)", days_text)
                        if dm:
                            recovery_days = int(dm.group(1))

                    gm = None
                    if games_text and games_text != "-":
                        gm_match = re.search(r"(\d+)", games_text)
                        if gm_match:
                            gm = int(gm_match.group(1))

                    injuries.append({
                        "player_id": player_id,
                        "injury_type": injury_type,
                        "injury_type_slug": injury_slug,
                        "injury_description": injury_desc,
                        "date_injured": date_injured,
                        "return_date": return_date,
                        "recovery_days": recovery_days,
                        "games_missed": gm,
                        "status": "recovered" if return_date else "out",
                        "source": "transfermarkt.co.uk",
                    })

                if injuries:
                    count = sb_upsert("back_in_play_injuries", injuries, "player_id,date_injured")
                    club_count += count

                time.sleep(2)  # Be respectful of TM rate limits

            year_count += club_count
            checkpoint[ck_key] = {"done": True, "count": club_count}
            save_checkpoint(checkpoint)
            time.sleep(3)

        print("  [%d] %d injuries" % (year, year_count), flush=True)
        mark_done(checkpoint, "epl", year, year_count)
        total += year_count

    print("\n  EPL TOTAL: %d" % total, flush=True)
    return total


# =============================================================================
# Gap detection
# =============================================================================
def detect_gaps():
    print("\n" + "=" * 60, flush=True)
    print("Gap Detection -- Checkpoint Coverage", flush=True)
    print("=" * 60, flush=True)

    checkpoint = load_checkpoint()
    for league in ["mlb", "nfl", "nba", "nhl", "epl"]:
        print("\n%s:" % league.upper(), flush=True)
        for year in SEASONS:
            key = "%s:%s" % (league, year)
            info = checkpoint.get(key, {})
            if info.get("done"):
                print("  %d: %s injuries (done %s)" % (
                    year, info.get("count", "?"), info.get("ts", "?")[:10]), flush=True)
            else:
                print("  %d: NOT SCRAPED" % year, flush=True)


# =============================================================================
# Main
# =============================================================================
def main():
    args = [a.lower() for a in sys.argv[1:]]

    if "--gaps" in args:
        detect_gaps()
        return

    targets = [a for a in args if a in ("mlb", "nfl", "nba", "nhl", "epl", "all")]
    if not targets:
        targets = ["all"]
    run_all = "all" in targets

    if "--reset" in args:
        print("Resetting checkpoint...", flush=True)
        save_checkpoint({})

    checkpoint = load_checkpoint()

    print("=" * 60, flush=True)
    print("Back In Play -- Injury Scraper v2", flush=True)
    print("Targets: %s  |  Seasons: %d-%d" % (targets, SEASONS[0], SEASONS[-1]), flush=True)
    print("Checkpoint entries: %d" % len(checkpoint), flush=True)
    print("=" * 60, flush=True)

    grand_total = 0

    if run_all or "mlb" in targets:
        grand_total += ingest_mlb(checkpoint)

    if run_all or "nfl" in targets:
        grand_total += ingest_espn_league(checkpoint, "nfl")

    if run_all or "nba" in targets:
        grand_total += ingest_espn_league(checkpoint, "nba")

    if run_all or "nhl" in targets:
        grand_total += ingest_espn_league(checkpoint, "nhl")

    if run_all or "epl" in targets:
        grand_total += ingest_epl(checkpoint)

    print("\n" + "=" * 60, flush=True)
    print("GRAND TOTAL: %d new injuries added" % grand_total, flush=True)
    print("=" * 60, flush=True)


if __name__ == "__main__":
    main()
