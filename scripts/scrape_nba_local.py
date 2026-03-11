#!/usr/bin/env python3
"""
Spotrac Injury Scraper — runs LOCALLY (Spotrac blocks datacenter IPs)
=====================================================================
Source: spotrac.com/{league}/injured/_/year/{YEAR}/view/player
Scrapes: player injuries with body part, date ranges, games/days missed
Upserts to Supabase (same back_in_play_* tables)

Supports: NBA, NFL, MLB (NHL not available on Spotrac player view)

Usage:
  python3 scrape_nba_local.py                       # NBA all years
  python3 scrape_nba_local.py --all                  # all leagues, all years
  python3 scrape_nba_local.py --league nfl 2023 2024 # NFL specific years
  python3 scrape_nba_local.py --league mlb           # MLB all years

Requires: pip install beautifulsoup4 lxml
Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or use .env file)
"""

import json, os, re, sys, time, urllib.request, urllib.error
from datetime import datetime
from pathlib import Path

# Try loading env from droplet's .daemon-env or local .env
def load_env():
    for envfile in ["/root/.daemon-env", ".env", "../.env"]:
        p = Path(envfile)
        if p.exists():
            for line in p.read_text().splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, val = line.partition("=")
                    val = val.strip().strip("'\"")
                    os.environ.setdefault(key.strip(), val)

load_env()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars")
    print("  Or create a .env file with them")
    sys.exit(1)

SEASONS = list(range(2015, 2027))
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

def sb_upsert(table, rows, conflict=""):
    if not rows:
        return 0
    # Deduplicate
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
                    # Row-by-row fallback
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

# NBA team abbreviation -> full name mapping
NBA_TEAMS = {
    "ATL": "Atlanta Hawks", "BKN": "Brooklyn Nets", "BOS": "Boston Celtics",
    "CHA": "Charlotte Hornets", "CHI": "Chicago Bulls", "CLE": "Cleveland Cavaliers",
    "DAL": "Dallas Mavericks", "DEN": "Denver Nuggets", "DET": "Detroit Pistons",
    "GSW": "Golden State Warriors", "HOU": "Houston Rockets", "IND": "Indiana Pacers",
    "LAC": "Los Angeles Clippers", "LAL": "Los Angeles Lakers", "MEM": "Memphis Grizzlies",
    "MIA": "Miami Heat", "MIL": "Milwaukee Bucks", "MIN": "Minnesota Timberwolves",
    "NOP": "New Orleans Pelicans", "NYK": "New York Knicks", "OKC": "Oklahoma City Thunder",
    "ORL": "Orlando Magic", "PHI": "Philadelphia 76ers", "PHO": "Phoenix Suns",
    "PHX": "Phoenix Suns", "POR": "Portland Trail Blazers", "SAC": "Sacramento Kings",
    "SAS": "San Antonio Spurs", "TOR": "Toronto Raptors", "UTA": "Utah Jazz",
    "WAS": "Washington Wizards",
    # Historical
    "NJN": "New Jersey Nets", "NOH": "New Orleans Hornets", "SEA": "Seattle SuperSonics",
    "CHO": "Charlotte Hornets", "NO": "New Orleans Pelicans",
}

NFL_TEAMS = {
    "ARI": "Arizona Cardinals", "ATL": "Atlanta Falcons", "BAL": "Baltimore Ravens",
    "BUF": "Buffalo Bills", "CAR": "Carolina Panthers", "CHI": "Chicago Bears",
    "CIN": "Cincinnati Bengals", "CLE": "Cleveland Browns", "DAL": "Dallas Cowboys",
    "DEN": "Denver Broncos", "DET": "Detroit Lions", "GB": "Green Bay Packers",
    "HOU": "Houston Texans", "IND": "Indianapolis Colts", "JAC": "Jacksonville Jaguars",
    "JAX": "Jacksonville Jaguars", "KC": "Kansas City Chiefs", "LAC": "Los Angeles Chargers",
    "LAR": "Los Angeles Rams", "LV": "Las Vegas Raiders", "MIA": "Miami Dolphins",
    "MIN": "Minnesota Vikings", "NE": "New England Patriots", "NO": "New Orleans Saints",
    "NYG": "New York Giants", "NYJ": "New York Jets", "OAK": "Oakland Raiders",
    "PHI": "Philadelphia Eagles", "PIT": "Pittsburgh Steelers", "SD": "San Diego Chargers",
    "SEA": "Seattle Seahawks", "SF": "San Francisco 49ers", "STL": "St. Louis Rams",
    "TB": "Tampa Bay Buccaneers", "TEN": "Tennessee Titans", "WAS": "Washington Commanders",
    "WSH": "Washington Commanders",
}

MLB_TEAMS = {
    "ARI": "Arizona Diamondbacks", "ATL": "Atlanta Braves", "BAL": "Baltimore Orioles",
    "BOS": "Boston Red Sox", "CHC": "Chicago Cubs", "CHW": "Chicago White Sox",
    "CWS": "Chicago White Sox", "CIN": "Cincinnati Reds", "CLE": "Cleveland Guardians",
    "COL": "Colorado Rockies", "DET": "Detroit Tigers", "HOU": "Houston Astros",
    "KC": "Kansas City Royals", "KCR": "Kansas City Royals", "LAA": "Los Angeles Angels",
    "LAD": "Los Angeles Dodgers", "MIA": "Miami Marlins", "MIL": "Milwaukee Brewers",
    "MIN": "Minnesota Twins", "NYM": "New York Mets", "NYY": "New York Yankees",
    "OAK": "Oakland Athletics", "PHI": "Philadelphia Phillies", "PIT": "Pittsburgh Pirates",
    "SD": "San Diego Padres", "SDP": "San Diego Padres", "SF": "San Francisco Giants",
    "SFG": "San Francisco Giants", "SEA": "Seattle Mariners", "STL": "St. Louis Cardinals",
    "TB": "Tampa Bay Rays", "TBR": "Tampa Bay Rays", "TEX": "Texas Rangers",
    "TOR": "Toronto Blue Jays", "WSH": "Washington Nationals", "WAS": "Washington Nationals",
}

LEAGUE_CONFIGS = {
    "nba": {"name": "NBA", "slug": "nba", "teams": NBA_TEAMS, "spotrac": "nba"},
    "nfl": {"name": "NFL", "slug": "nfl", "teams": NFL_TEAMS, "spotrac": "nfl"},
    "mlb": {"name": "MLB", "slug": "mlb", "teams": MLB_TEAMS, "spotrac": "mlb"},
}


def get_or_create_team(abbr, league_id, league_key="nba"):
    cfg = LEAGUE_CONFIGS.get(league_key, {})
    team_map = cfg.get("teams", NBA_TEAMS)
    team_name = team_map.get(abbr, abbr)
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


# -- Injury parsing -----------------------------------------------------------
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
    "injury management": "Load Management",
}

def classify_injury(desc):
    if not desc:
        return "Unknown", "unknown"
    desc_lower = desc.lower()
    for keyword, injury_type in INJURY_TYPES.items():
        if keyword in desc_lower:
            return injury_type, slugify(injury_type)
    return "Other", "other"


def parse_spotrac_reason(reason_text, league_key="nba", year=2023):
    """Parse Spotrac reason field into individual injury stints.

    NBA/MLB format: 'Short-Term IR: Back: 11/4/23-11/5/23, 11/16/23-1/28/24'
    or 'IR: Foot: 1/20/24-4/14/24'
    or '60-Day IL - Ribs: 3/30/23-10/1/23'

    NFL format: 'IR: Knee Acl: 3-18' (week numbers)
    """
    stints = []

    # NFL uses week numbers (e.g., "IR: Knee Acl: 3-18")
    if league_key == "nfl":
        parts = re.split(r"(?=(?:Short-Term )?IR:)", reason_text)
        for part in parts:
            part = part.strip()
            if not part:
                continue
            body_match = re.search(r"IR:\s*([^:]+?):\s*", part)
            body_part = body_match.group(1).strip() if body_match else "Unknown"
            # Week ranges like "3-18" or "1-17, 2-8"
            week_ranges = re.findall(r"(\d{1,2})\s*-\s*(\d{1,2})", part)
            for w_start, w_end in week_ranges:
                ws, we = int(w_start), int(w_end)
                if ws > 30 or we > 30:
                    continue  # Not week numbers, skip
                # Estimate dates from NFL season (starts early Sep)
                from datetime import timedelta
                season_start = datetime(year, 9, 7)  # approximate
                date_from = (season_start + timedelta(weeks=ws - 1)).strftime("%Y-%m-%d")
                date_to = (season_start + timedelta(weeks=we)).strftime("%Y-%m-%d")
                stints.append({
                    "body_part": body_part,
                    "date_from": date_from,
                    "date_to": date_to,
                })
        return stints

    # MLB format: '60-Day IL - Ribs: 3/30/23-10/1/23' or 'IL - Shoulder: dates'
    # NBA/MLB: split by IR/IL boundaries
    parts = re.split(r"(?=(?:Short-Term )?(?:IR|IL)|(?:\d+-Day (?:IR|IL)))", reason_text)

    for part in parts:
        part = part.strip()
        if not part:
            continue

        # Extract body part - try multiple patterns
        body_match = re.search(r"(?:IR|IL)(?:\s*-\s*|\s*:\s*)([^:]+?):\s*", part)
        if not body_match:
            body_match = re.search(r"(?:IR|IL)\s*[:-]\s*(\w[\w\s]*?)(?:\s*:|$)", part)
        body_part = body_match.group(1).strip() if body_match else "Unknown"

        # Extract date ranges (M/D/YY-M/D/YY format)
        date_ranges = re.findall(r"(\d{1,2}/\d{1,2}/\d{2,4})\s*-\s*(\d{1,2}/\d{1,2}/\d{2,4})", part)

        for start_str, end_str in date_ranges:
            start = parse_spotrac_date(start_str)
            end = parse_spotrac_date(end_str)
            if start:
                stints.append({
                    "body_part": body_part,
                    "date_from": start,
                    "date_to": end,
                })

    return stints


def parse_spotrac_date(text):
    """Parse M/D/YY or M/D/YYYY to YYYY-MM-DD."""
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{2,4})", text)
    if not m:
        return None
    month, day, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if year < 100:
        year += 2000
    try:
        return "%04d-%02d-%02d" % (year, month, day)
    except Exception:
        return None


# -- Main scraper -------------------------------------------------------------
def scrape_year(year, league_id, league_key="nba"):
    """Scrape one season from Spotrac."""
    from bs4 import BeautifulSoup

    cfg = LEAGUE_CONFIGS[league_key]
    url = "https://www.spotrac.com/%s/injured/_/year/%d/view/player" % (cfg["spotrac"], year)
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
    }

    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(url, headers=headers)
            resp = urllib.request.urlopen(req, timeout=30)
            html = resp.read().decode()
            break
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                print("    [retry %d] %s" % (attempt + 1, e), flush=True)
                time.sleep(3 * (attempt + 1))
            else:
                print("    [FAIL] Could not fetch %d: %s" % (year, e), flush=True)
                return 0

    soup = BeautifulSoup(html, "lxml")
    table = soup.find("table")
    if not table:
        print("    [WARN] No table found for %d" % year, flush=True)
        return 0

    rows = table.find_all("tr")
    print("  [%d] %d player rows" % (year, len(rows) - 1), flush=True)

    injuries = []
    for tr in rows[1:]:  # skip header
        cells = tr.find_all("td")
        if len(cells) < 5:
            continue

        # Columns: Rank, Player, Pos, Team, Reason, GamesMissed, DaysMissed, Cash
        player_name = cells[1].get_text(strip=True)
        position = cells[2].get_text(strip=True)
        team_abbr = cells[3].get_text(strip=True)
        reason = cells[4].get_text(strip=True)
        games_missed_text = cells[5].get_text(strip=True) if len(cells) > 5 else ""
        days_missed_text = cells[6].get_text(strip=True) if len(cells) > 6 else ""

        if not player_name or not reason:
            continue

        team_id = get_or_create_team(team_abbr, league_id, league_key)
        if not team_id:
            continue

        player_id = get_or_create_player(player_name, team_id, position)
        if not player_id:
            print("    [WARN] Could not create player: %s" % player_name, flush=True)
            continue

        # Parse the reason into individual injury stints
        stints = parse_spotrac_reason(reason, league_key, year)

        if not stints:
            # Fallback: use whole reason as one entry, estimate date from season
            injury_type, injury_slug = classify_injury(reason)
            # NBA season starts in October
            est_date = "%d-10-01" % year
            injuries.append({
                "player_id": player_id,
                "injury_type": injury_type,
                "injury_type_slug": injury_slug,
                "injury_description": reason[:500],
                "date_injured": est_date,
                "status": "out",
                "source": "spotrac.com/%s" % cfg["spotrac"],
            })
        else:
            for stint in stints:
                injury_type, injury_slug = classify_injury(stint["body_part"])

                recovery_days = None
                if stint["date_from"] and stint["date_to"]:
                    try:
                        d1 = datetime.strptime(stint["date_from"], "%Y-%m-%d")
                        d2 = datetime.strptime(stint["date_to"], "%Y-%m-%d")
                        recovery_days = (d2 - d1).days
                    except Exception:
                        pass

                injuries.append({
                    "player_id": player_id,
                    "injury_type": injury_type,
                    "injury_type_slug": injury_slug,
                    "injury_description": "%s: %s" % (stint["body_part"], reason[:400]),
                    "date_injured": stint["date_from"],
                    "return_date": stint["date_to"],
                    "recovery_days": recovery_days,
                    "status": "returned" if stint["date_to"] else "out",
                    "source": "spotrac.com/%s" % cfg["spotrac"],
                })

    if injuries:
        count = sb_upsert("back_in_play_injuries", injuries,
                          "player_id,date_injured,injury_type_slug")
        print("    Upserted %d injury stints from %d players" % (count, len(rows) - 1), flush=True)
        return count
    return 0


def main():
    args = sys.argv[1:]

    # Parse flags
    leagues_to_run = []
    target_years = []
    run_all = "--all" in args

    i = 0
    while i < len(args):
        if args[i] == "--league" and i + 1 < len(args):
            leagues_to_run.append(args[i + 1].lower())
            i += 2
        elif args[i] == "--all":
            i += 1
        elif args[i].isdigit():
            target_years.append(int(args[i]))
            i += 1
        else:
            i += 1

    if not target_years:
        target_years = SEASONS

    if run_all:
        leagues_to_run = ["nba", "nfl", "mlb"]
    elif not leagues_to_run:
        leagues_to_run = ["nba"]

    print("=" * 60, flush=True)
    print("Spotrac Injury Scraper — LOCAL", flush=True)
    print("Leagues: %s  |  Years: %d-%d" % (leagues_to_run, target_years[0], target_years[-1]), flush=True)
    print("=" * 60, flush=True)

    grand_total = 0
    for league_key in leagues_to_run:
        if league_key not in LEAGUE_CONFIGS:
            print("Unknown league: %s (available: nba, nfl, mlb)" % league_key, flush=True)
            continue

        cfg = LEAGUE_CONFIGS[league_key]
        print("\n--- %s ---" % cfg["name"], flush=True)
        league_id = get_or_create_league(cfg["name"], cfg["slug"])
        if not league_id:
            print("ERROR: Could not get/create %s league" % cfg["name"], flush=True)
            continue

        league_total = 0
        for year in target_years:
            count = scrape_year(year, league_id, league_key)
            league_total += count
            time.sleep(3)  # Be respectful

        print("\n  %s TOTAL: %d injury stints" % (cfg["name"], league_total), flush=True)
        grand_total += league_total

    print("\n" + "=" * 60, flush=True)
    print("GRAND TOTAL: %d injury stints added" % grand_total, flush=True)
    print("=" * 60, flush=True)


if __name__ == "__main__":
    main()
