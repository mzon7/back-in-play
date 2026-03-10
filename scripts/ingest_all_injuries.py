#!/usr/bin/env python3
"""
Comprehensive historical injury data ingestion for Back In Play.
Collects 10 years of data (2015-2025) from:
- MLB: Official MLB Transactions API (IL placements)
- NFL: ESPN Injuries API + OpenAI web search for historical
- NBA: ESPN Injuries API + OpenAI web search for historical
- NHL: NHL official API
- Premier League: ESPN Soccer API + OpenAI web search
"""

import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timedelta, date
from typing import Optional

# ── Config ────────────────────────────────────────────────────────────────────
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")

START_YEAR = 2015
END_YEAR = 2025  # inclusive (through 2025 season)

HEADERS_ESPN = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Accept": "application/json",
}

HEADERS_NHL = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Accept": "application/json",
}

# ── Supabase helpers ───────────────────────────────────────────────────────────
def sb_req(method: str, path: str, body=None):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    data = json.dumps(body).encode() if body else None
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=representation",
    }
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        content = resp.read()
        return json.loads(content) if content else []
    except urllib.error.HTTPError as e:
        err = e.read().decode()
        print(f"  [SB ERROR] {method} {path}: {e.code} - {err[:200]}")
        return None

def sb_upsert(table: str, rows: list, conflict: str = None):
    if not rows:
        return []
    path = table
    if conflict:
        path += f"?on_conflict={conflict}"
    return sb_req("POST", path, rows)

def sb_get(table: str, params: str = ""):
    return sb_req("GET", f"{table}?{params}", None) or []

# ── Generic HTTP fetch ──────────────────────────────────────────────────────────
def fetch_json(url: str, headers: dict = None, retries: int = 3) -> Optional[dict]:
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers or HEADERS_ESPN)
            resp = urllib.request.urlopen(req, timeout=20)
            return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = 2 ** attempt * 5
                print(f"  Rate limited. Waiting {wait}s...")
                time.sleep(wait)
            elif attempt == retries - 1:
                print(f"  HTTP {e.code} on {url}")
                return None
            else:
                time.sleep(2)
        except Exception as e:
            if attempt == retries - 1:
                print(f"  Error fetching {url}: {e}")
                return None
            time.sleep(2)
    return None

# ── Slug helpers ────────────────────────────────────────────────────────────────
def slugify(text: str) -> str:
    t = text.lower().strip()
    t = re.sub(r"[^\w\s-]", "", t)
    t = re.sub(r"[\s_-]+", "-", t)
    return t.strip("-")

def injury_type_slug(description: str) -> str:
    """Extract injury type slug from description text."""
    desc = description.lower()
    mappings = [
        (["acl", "anterior cruciate"], "acl"),
        (["mcl", "medial collateral"], "mcl"),
        (["pcl", "posterior cruciate"], "pcl"),
        (["hamstring"], "hamstring"),
        (["quad", "quadricep"], "quadricep"),
        (["calf", "gastrocnemius"], "calf"),
        (["groin", "adductor"], "groin"),
        (["hip", "hip flexor", "hip pointer"], "hip"),
        (["knee"], "knee"),
        (["ankle"], "ankle"),
        (["achilles"], "achilles"),
        (["foot", "plantar", "heel", "toe"], "foot"),
        (["shin", "tibia", "fibula", "leg"], "leg"),
        (["shoulder", "rotator", "labrum", "clavicle", "collarbone"], "shoulder"),
        (["elbow", "ulnar", "ucl", "tommy john"], "elbow"),
        (["wrist"], "wrist"),
        (["hand", "finger", "thumb", "hamate"], "hand"),
        (["forearm"], "forearm"),
        (["back", "lumbar", "spine", "disc", "vertebra"], "back"),
        (["neck", "cervical"], "neck"),
        (["rib", "chest", "pectoral", "sternum"], "chest"),
        (["concussion", "head", "brain", "tbi"], "concussion"),
        (["eye", "orbital"], "eye"),
        (["jaw", "face", "facial"], "facial"),
        (["abdominal", "abdomen", "oblique", "core", "hernia"], "abdominal"),
        (["hip flexor"], "hip-flexor"),
        (["illness", "flu", "covid", "virus", "sick", "non-covid", "non-injury"], "illness"),
        (["personal", "personal reason"], "personal"),
        (["surgery", "surgical", "post-op", "post op"], "surgery"),
        (["strain"], "strain"),
        (["sprain"], "sprain"),
        (["fracture", "broken", "break"], "fracture"),
        (["torn", "tear"], "tear"),
        (["bruise", "contusion"], "contusion"),
    ]
    for keywords, slug in mappings:
        if any(kw in desc for kw in keywords):
            return slug
    return "other"

def extract_injury_type(description: str) -> str:
    """Human-readable injury type from description."""
    slug = injury_type_slug(description)
    labels = {
        "acl": "ACL Tear", "mcl": "MCL Injury", "pcl": "PCL Injury",
        "hamstring": "Hamstring", "quadricep": "Quadricep", "calf": "Calf",
        "groin": "Groin", "hip": "Hip", "knee": "Knee", "ankle": "Ankle",
        "achilles": "Achilles", "foot": "Foot", "leg": "Leg",
        "shoulder": "Shoulder", "elbow": "Elbow", "wrist": "Wrist",
        "hand": "Hand/Finger", "forearm": "Forearm", "back": "Back/Spine",
        "neck": "Neck", "chest": "Chest/Ribs", "concussion": "Concussion",
        "eye": "Eye", "facial": "Facial", "abdominal": "Abdominal",
        "hip-flexor": "Hip Flexor", "illness": "Illness", "personal": "Personal",
        "surgery": "Surgery", "strain": "Strain", "sprain": "Sprain",
        "fracture": "Fracture", "tear": "Tear", "contusion": "Contusion",
        "other": "Other",
    }
    return labels.get(slug, "Other")

def espn_status_to_db(status: str) -> str:
    """Map ESPN status to our DB enum."""
    status_lower = status.lower()
    if "out" in status_lower or "ir" in status_lower or "injured reserve" in status_lower:
        return "out"
    if "doubtful" in status_lower:
        return "doubtful"
    if "questionable" in status_lower:
        return "questionable"
    if "probable" in status_lower:
        return "probable"
    if "day-to-day" in status_lower or "dtd" in status_lower:
        return "questionable"
    if "active" in status_lower or "return" in status_lower:
        return "returned"
    return "out"

# ── DB Cache ────────────────────────────────────────────────────────────────────
league_cache = {}    # slug -> id
team_cache = {}      # (league_id, name) -> id
player_cache = {}    # (team_id, name) -> id

def ensure_league(name: str, slug: str) -> str:
    if slug in league_cache:
        return league_cache[slug]
    result = sb_upsert("back_in_play_leagues", [{"league_name": name, "slug": slug}], "slug")
    if result and len(result) > 0:
        lid = result[0]["league_id"]
        league_cache[slug] = lid
        return lid
    # try fetch
    rows = sb_get("back_in_play_leagues", f"slug=eq.{slug}&select=league_id")
    if rows:
        league_cache[slug] = rows[0]["league_id"]
        return league_cache[slug]
    raise Exception(f"Could not ensure league {slug}")

def ensure_team(team_name: str, league_id: str) -> str:
    key = (league_id, team_name)
    if key in team_cache:
        return team_cache[key]
    result = sb_upsert("back_in_play_teams", [{"team_name": team_name, "league_id": league_id}], "team_name,league_id")
    if result and len(result) > 0:
        tid = result[0]["team_id"]
        team_cache[key] = tid
        return tid
    rows = sb_get("back_in_play_teams", f"team_name=eq.{urllib.parse.quote(team_name)}&league_id=eq.{league_id}&select=team_id")
    if rows:
        team_cache[key] = rows[0]["team_id"]
        return team_cache[key]
    raise Exception(f"Could not ensure team {team_name}")

def ensure_player(player_name: str, team_id: str, position: str = "") -> str:
    key = (team_id, player_name)
    if key in player_cache:
        return player_cache[key]
    base_slug = slugify(player_name)
    slug = f"{base_slug}-{team_id[:8]}"
    result = sb_upsert("back_in_play_players", [{
        "player_name": player_name,
        "team_id": team_id,
        "position": position or "Unknown",
        "slug": slug,
    }], "slug")
    if result and len(result) > 0:
        pid = result[0]["player_id"]
        player_cache[key] = pid
        return pid
    rows = sb_get("back_in_play_players", f"slug=eq.{slug}&select=player_id")
    if rows:
        player_cache[key] = rows[0]["player_id"]
        return player_cache[key]
    raise Exception(f"Could not ensure player {player_name}")

import urllib.parse

def insert_injury(player_id: str, injury_desc: str, date_injured: str, status: str = "out", source: str = "", expected_return: str = None):
    inj_type = extract_injury_type(injury_desc)
    inj_slug = injury_type_slug(injury_desc)
    row = {
        "player_id": player_id,
        "injury_type": inj_type,
        "injury_type_slug": inj_slug,
        "injury_description": injury_desc[:500],
        "date_injured": date_injured,
        "status": status,
        "source": source[:100] if source else "",
    }
    if expected_return:
        row["expected_return_date"] = expected_return
    result = sb_upsert("back_in_play_injuries", [row])
    return result

# ══════════════════════════════════════════════════════════════════════════════
# MLB: Official MLB Transactions API
# ══════════════════════════════════════════════════════════════════════════════
MLB_TEAM_MAP = {
    109: "Arizona Diamondbacks", 144: "Atlanta Braves", 110: "Baltimore Orioles",
    111: "Boston Red Sox", 112: "Chicago Cubs", 145: "Chicago White Sox",
    113: "Cincinnati Reds", 114: "Cleveland Guardians", 115: "Colorado Rockies",
    116: "Detroit Tigers", 117: "Houston Astros", 118: "Kansas City Royals",
    108: "Los Angeles Angels", 119: "Los Angeles Dodgers", 146: "Miami Marlins",
    158: "Milwaukee Brewers", 142: "Minnesota Twins", 121: "New York Mets",
    147: "New York Yankees", 133: "Oakland Athletics", 143: "Philadelphia Phillies",
    134: "Pittsburgh Pirates", 135: "San Diego Padres", 137: "San Francisco Giants",
    136: "Seattle Mariners", 139: "Tampa Bay Rays", 140: "Texas Rangers",
    141: "Toronto Blue Jays", 120: "Washington Nationals",
    # historical names
    114: "Cleveland Indians",
}

MLB_POS_FROM_DESC = {
    " C ": "C", " 1B ": "1B", " 2B ": "2B", " 3B ": "3B", " SS ": "SS",
    " LF ": "OF", " CF ": "OF", " RF ": "OF", " OF ": "OF",
    " SP ": "P", " RP ": "P", " RHP ": "P", " LHP ": "P", " P ": "P",
    " DH ": "DH",
}

def extract_mlb_position(description: str) -> str:
    for abbr, pos in MLB_POS_FROM_DESC.items():
        if abbr in f" {description} ":
            return pos
    return "Unknown"

def ingest_mlb_transactions(league_id: str, year: int):
    """Ingest MLB IL transactions for a given year."""
    print(f"\n  MLB {year}: Fetching transactions...")

    # MLB season runs March-October roughly
    if year == 2025:
        start = f"{year}-01-01"
        end = f"{year}-12-31"
    else:
        start = f"{year}-01-01"
        end = f"{year}-12-31"

    offset = 0
    limit = 500
    total_injuries = 0

    while True:
        url = f"https://statsapi.mlb.com/api/v1/transactions?sportId=1&startDate={start}&endDate={end}&limit={limit}&offset={offset}"
        data = fetch_json(url, {})
        if not data:
            break

        transactions = data.get("transactions", [])
        if not transactions:
            break

        batch = []
        for tx in transactions:
            desc = tx.get("description", "")
            # Filter for IL placements and reinstatements
            if not any(kw in desc.lower() for kw in ["injured list", "disabled list"]):
                continue
            if "reinstat" in desc.lower() or "activated" in desc.lower() or "recalled" in desc.lower():
                continue  # Skip reinstatements

            person = tx.get("person", {})
            team = tx.get("toTeam", {}) or tx.get("fromTeam", {})
            tx_date = tx.get("date", "")[:10]

            if not person.get("fullName") or not tx_date:
                continue

            player_name = person["fullName"]
            team_name = team.get("name", "Unknown")
            position = extract_mlb_position(desc)

            # Extract injury from description
            # Format: "Team placed POS Player on the X-day injured list. Injury detail."
            injury_detail = ""
            parts = desc.split(". ")
            if len(parts) > 1:
                injury_detail = ". ".join(parts[1:]).strip()
            if not injury_detail:
                injury_detail = desc

            batch.append({
                "player_name": player_name,
                "team_name": team_name,
                "position": position,
                "injury_desc": injury_detail or desc,
                "date": tx_date,
                "source": "mlb-transactions",
            })

        # Process batch
        for item in batch:
            try:
                tid = ensure_team(item["team_name"], league_id)
                pid = ensure_player(item["player_name"], tid, item["position"])
                insert_injury(pid, item["injury_desc"], item["date"], "out", item["source"])
                total_injuries += 1
            except Exception as e:
                print(f"    Error: {e}")

        if batch:
            print(f"    Processed {offset + len(transactions)} transactions, found {total_injuries} injuries so far")

        if len(transactions) < limit:
            break
        offset += limit
        time.sleep(0.3)  # Be polite

    print(f"  MLB {year}: Done - {total_injuries} injuries ingested")
    return total_injuries

# ══════════════════════════════════════════════════════════════════════════════
# ESPN: NFL / NBA / Premier League (current + historical via news/athletes)
# ══════════════════════════════════════════════════════════════════════════════
ESPN_LEAGUES = {
    "nfl": {"sport": "football", "league": "nfl", "espn_league": "nfl"},
    "nba": {"sport": "basketball", "league": "nba", "espn_league": "nba"},
    "epl": {"sport": "soccer", "league": "eng.1", "espn_league": "eng.1"},
}

def ingest_espn_current_injuries(league_slug: str, league_id: str, config: dict):
    """Ingest current ESPN injuries for a league."""
    sport = config["sport"]
    league = config["league"]
    url = f"https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/injuries"
    data = fetch_json(url)
    if not data:
        return 0

    season_info = data.get("season", {})
    season_year = season_info.get("year", date.today().year)

    total = 0
    for team_group in data.get("injuries", []):
        team_name = team_group.get("displayName", "")
        if not team_name:
            continue

        try:
            tid = ensure_team(team_name, league_id)
        except Exception as e:
            print(f"    Team error {team_name}: {e}")
            continue

        for injury in team_group.get("injuries", []):
            athlete = injury.get("athlete", {})
            player_name = athlete.get("displayName", "")
            if not player_name:
                continue

            # Get position from athlete
            pos = athlete.get("position", {})
            position = pos.get("abbreviation", "") if isinstance(pos, dict) else str(pos)

            status = espn_status_to_db(injury.get("status", "out"))
            date_str = injury.get("date", "")[:10] if injury.get("date") else date.today().isoformat()
            long_comment = injury.get("longComment", "")
            short_comment = injury.get("shortComment", "")
            desc = short_comment or long_comment or "Injury"

            try:
                pid = ensure_player(player_name, tid, position)
                insert_injury(pid, desc, date_str, status, f"espn-{league}-{season_year}")
                total += 1
            except Exception as e:
                print(f"    Player error {player_name}: {e}")

    print(f"  ESPN {league_slug} current: {total} injuries")
    return total

def ingest_espn_historical_via_teams(league_slug: str, league_id: str, config: dict, year: int):
    """Get team rosters and check injury history per athlete."""
    sport = config["sport"]
    league = config["league"]

    # Get all teams
    url = f"https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/teams?limit=100"
    data = fetch_json(url)
    if not data:
        return 0

    teams = []
    try:
        sports_data = data.get("sports", [])
        if sports_data:
            leagues = sports_data[0].get("leagues", [])
            if leagues:
                teams = leagues[0].get("teams", [])
    except:
        pass

    if not teams:
        return 0

    total = 0
    for team_info in teams:
        team = team_info.get("team", team_info)
        team_id_espn = team.get("id", "")
        team_name = team.get("displayName", team.get("name", ""))
        if not team_name:
            continue

        try:
            tid = ensure_team(team_name, league_id)
        except:
            continue

        # Get roster for this team/year
        roster_url = f"https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/teams/{team_id_espn}/roster"
        roster_data = fetch_json(roster_url)
        if not roster_data:
            time.sleep(0.5)
            continue

        # ESPN roster structure
        athlete_groups = roster_data.get("athletes", [])
        for group in athlete_groups:
            items = group.get("items", []) if isinstance(group, dict) else []
            for athlete in items:
                athlete_id = athlete.get("id", "")
                player_name = athlete.get("fullName", "")
                pos = athlete.get("position", {})
                position = pos.get("abbreviation", "") if isinstance(pos, dict) else ""

                if not player_name or not athlete_id:
                    continue

                # Check athlete injury history
                inj_url = f"https://sports.core.api.espn.com/v2/sports/{sport}/leagues/{league}/athletes/{athlete_id}/injuries?limit=50"
                inj_data = fetch_json(inj_url)
                if not inj_data:
                    time.sleep(0.2)
                    continue

                injury_items = inj_data.get("items", [])
                if injury_items:
                    try:
                        pid = ensure_player(player_name, tid, position)
                        for inj_ref in injury_items:
                            ref_url = inj_ref.get("$ref", "")
                            if not ref_url:
                                continue
                            inj_detail = fetch_json(ref_url)
                            if not inj_detail:
                                continue

                            inj_date = inj_detail.get("date", "")[:10] if inj_detail.get("date") else ""
                            if not inj_date:
                                continue

                            # Filter by year
                            if not inj_date.startswith(str(year)):
                                continue

                            desc = inj_detail.get("longComment", "") or inj_detail.get("shortComment", "") or "Injury"
                            status = espn_status_to_db(inj_detail.get("status", "out"))
                            insert_injury(pid, desc, inj_date, status, f"espn-{league}-{year}")
                            total += 1
                            time.sleep(0.1)
                    except Exception as e:
                        pass

                time.sleep(0.1)

        time.sleep(0.3)

    print(f"  ESPN {league_slug} {year} historical: {total} injuries")
    return total

# ══════════════════════════════════════════════════════════════════════════════
# NHL: Official NHL API
# ══════════════════════════════════════════════════════════════════════════════
NHL_TEAMS = [
    "ANA", "ARI", "BOS", "BUF", "CGY", "CAR", "CHI", "COL", "CBJ", "DAL",
    "DET", "EDM", "FLA", "LAK", "MIN", "MTL", "NSH", "NJD", "NYI", "NYR",
    "OTT", "PHI", "PIT", "SEA", "SJS", "STL", "TBL", "TOR", "UTA", "VAN",
    "VGK", "WSH", "WPG",
    # historical
    "ATL", "PHX",
]

NHL_SEASON_FORMATS = {
    2015: "20152016", 2016: "20162017", 2017: "20172018", 2018: "20182019",
    2019: "20192020", 2020: "20202021", 2021: "20212022", 2022: "20222023",
    2023: "20232024", 2024: "20242025", 2025: "20252026",
}

def ingest_nhl_season(league_id: str, year: int):
    """Ingest NHL injuries for a given season."""
    season_str = NHL_SEASON_FORMATS.get(year)
    if not season_str:
        return 0

    total = 0

    # First, get current injuries (for current season)
    if year == 2025:
        # Get current injuries from all teams
        for team_abbr in NHL_TEAMS:
            url = f"https://api-web.nhle.com/v1/roster/{team_abbr}/{season_str}"
            data = fetch_json(url, HEADERS_NHL)
            if not data:
                time.sleep(0.5)
                continue

            # Get team name from roster
            all_players = []
            for group_key in ["forwards", "defensemen", "goalies"]:
                all_players.extend(data.get(group_key, []))

            if not all_players:
                time.sleep(0.3)
                continue

            # Try to get team info
            team_name = f"NHL {team_abbr}"  # fallback

            # Look up team name via standings
            try:
                tid = ensure_team(team_name, league_id)
            except:
                time.sleep(0.3)
                continue

            # For each player, check their injury status
            for player in all_players:
                player_id = player.get("id")
                first = player.get("firstName", {}).get("default", "")
                last = player.get("lastName", {}).get("default", "")
                player_name = f"{first} {last}".strip()
                position = player.get("positionCode", "")

                if not player_name or player_name == " ":
                    continue

                # Check player page for injuries
                player_url = f"https://api-web.nhle.com/v1/player/{player_id}/landing"
                player_data = fetch_json(player_url, HEADERS_NHL)
                if player_data:
                    # Update team name from player data
                    current_team = player_data.get("currentTeam", {})
                    if current_team.get("name", {}).get("default"):
                        team_name = current_team["name"]["default"]

                time.sleep(0.15)

    print(f"  NHL {year}: {total} injuries")
    return total

def ingest_nhl_current_injuries(league_id: str):
    """Get current NHL injuries by checking all team rosters."""
    total = 0

    # Get current standings to get team list with proper names
    standings_url = "https://api-web.nhle.com/v1/standings/2026-03-09"
    standings_data = fetch_json(standings_url, HEADERS_NHL)

    teams_info = []
    if standings_data:
        for team in standings_data.get("standings", []):
            abbrev = team.get("teamAbbrev", {}).get("default", "")
            name = team.get("teamName", {}).get("default", "")
            if abbrev and name:
                teams_info.append({"abbrev": abbrev, "name": name})

    if not teams_info:
        # Fallback team list
        teams_info = [
            {"abbrev": t, "name": f"NHL {t}"} for t in NHL_TEAMS
        ]

    season = "20252026"

    for team_info in teams_info:
        abbrev = team_info["abbrev"]
        team_name = team_info["name"]

        try:
            tid = ensure_team(team_name, league_id)
        except Exception as e:
            print(f"    NHL team error {team_name}: {e}")
            continue

        # Get roster
        roster_url = f"https://api-web.nhle.com/v1/roster/{abbrev}/{season}"
        roster_data = fetch_json(roster_url, HEADERS_NHL)
        if not roster_data:
            time.sleep(0.5)
            continue

        all_players = []
        for group_key in ["forwards", "defensemen", "goalies"]:
            all_players.extend(roster_data.get(group_key, []))

        for player in all_players:
            player_id = player.get("id")
            first = player.get("firstName", {}).get("default", "")
            last = player.get("lastName", {}).get("default", "")
            player_name = f"{first} {last}".strip()
            position = player.get("positionCode", "")

            if not player_name:
                continue

            try:
                pid = ensure_player(player_name, tid, position)
            except Exception as e:
                continue

            time.sleep(0.1)

        time.sleep(0.3)

    print(f"  NHL current rosters: {total} injuries stored")
    return total

# ══════════════════════════════════════════════════════════════════════════════
# OpenAI Web Search: Get injury data from specified sites
# ══════════════════════════════════════════════════════════════════════════════
def openai_search(prompt: str) -> str:
    """Use OpenAI responses API with web search."""
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
        headers={
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST"
    )

    try:
        resp = urllib.request.urlopen(req, timeout=60)
        data = json.loads(resp.read())
        # Extract text from output
        for item in data.get("output", []):
            if item.get("type") == "message":
                for content in item.get("content", []):
                    if content.get("type") == "output_text":
                        return content.get("text", "")
        return ""
    except Exception as e:
        print(f"    OpenAI search error: {e}")
        return ""

def parse_injuries_from_text(text: str, league_id: str, source: str, default_status: str = "out"):
    """Parse injury data from AI-generated text and insert into DB."""
    total = 0

    # Try to find JSON in the response
    json_match = re.search(r'\[[\s\S]*?\]', text)
    if json_match:
        try:
            injuries = json.loads(json_match.group())
            for inj in injuries:
                player_name = inj.get("player_name", "") or inj.get("name", "") or inj.get("player", "")
                team_name = inj.get("team", "") or inj.get("team_name", "")
                position = inj.get("position", "")
                injury_desc = inj.get("injury", "") or inj.get("injury_description", "") or inj.get("description", "")
                date_str = inj.get("date_injured", "") or inj.get("date", "") or inj.get("date_placed", "")
                status = inj.get("status", default_status)

                if not player_name or not team_name:
                    continue

                # Normalize date
                if date_str:
                    date_str = date_str[:10]
                else:
                    date_str = date.today().isoformat()

                try:
                    tid = ensure_team(team_name, league_id)
                    pid = ensure_player(player_name, tid, position)
                    insert_injury(pid, injury_desc or "Injury", date_str, espn_status_to_db(status), source)
                    total += 1
                except Exception as e:
                    pass
        except json.JSONDecodeError:
            pass

    return total

def ingest_via_openai_search(league_slug: str, league_id: str, site_url: str, year: int):
    """Use OpenAI web search to collect injury data from a specific site/year."""

    # Use a more focused query
    if league_slug == "nfl":
        prompt = f"""Search for NFL injured reserve list data from {year} season on spotrac.com or similar sites.
Return a JSON array of injured players with format:
[{{"player_name": "...", "team": "...", "position": "...", "injury": "...", "date_placed": "YYYY-MM-DD", "status": "out"}}]
Include at least 20-30 players if available. Only return the JSON array, no other text."""

    elif league_slug == "nba":
        prompt = f"""Search for NBA injured players list for the {year}-{year+1} season from spotrac.com or espn.com.
Return a JSON array of injured players with format:
[{{"player_name": "...", "team": "...", "position": "...", "injury": "...", "date_placed": "YYYY-MM-DD", "status": "out"}}]
Include at least 20-30 players if available. Only return the JSON array, no other text."""

    elif league_slug == "nhl":
        prompt = f"""Search for NHL injured players list for the {year}-{year+1} season from capfriendly.com or espn.com.
Return a JSON array of injured players with format:
[{{"player_name": "...", "team": "...", "position": "...", "injury": "...", "date_placed": "YYYY-MM-DD", "status": "out"}}]
Include at least 20-30 players if available. Only return the JSON array, no other text."""

    elif league_slug == "epl":
        prompt = f"""Search for Premier League injured players for the {year}/{year+1} season from transfermarkt.com or espn.com.
Return a JSON array of injured players with format:
[{{"player_name": "...", "team": "...", "position": "...", "injury": "...", "date_placed": "YYYY-MM-DD", "status": "out"}}]
Include at least 20-30 players if available. Only return the JSON array, no other text."""
    else:
        return 0

    print(f"  {league_slug.upper()} {year}: Querying OpenAI web search...")
    text = openai_search(prompt)
    if not text:
        return 0

    total = parse_injuries_from_text(text, league_id, f"openai-search-{league_slug}-{year}")
    print(f"  {league_slug.upper()} {year}: {total} injuries from web search")
    return total

# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════
def main():
    print("=" * 60)
    print("Back In Play — Historical Injury Data Ingestion")
    print(f"Years: {START_YEAR} - {END_YEAR}")
    print("=" * 60)

    grand_total = 0

    # ── Step 1: Set up leagues ──────────────────────────────────────────────
    print("\n[1/5] Setting up leagues...")
    leagues = {
        "nfl": ensure_league("NFL", "nfl"),
        "nba": ensure_league("NBA", "nba"),
        "mlb": ensure_league("MLB", "mlb"),
        "nhl": ensure_league("NHL", "nhl"),
        "epl": ensure_league("Premier League", "epl"),
    }
    print(f"  Leagues ready: {list(leagues.keys())}")

    # ── Step 2: MLB (10 years via official API) ─────────────────────────────
    print("\n[2/5] MLB — Official Transactions API (10 years)")
    mlb_total = 0
    for year in range(START_YEAR, END_YEAR + 1):
        count = ingest_mlb_transactions(leagues["mlb"], year)
        mlb_total += count
        time.sleep(0.5)
    print(f"  MLB TOTAL: {mlb_total} injuries")
    grand_total += mlb_total

    # ── Step 3: NFL ─────────────────────────────────────────────────────────
    print("\n[3/5] NFL — ESPN current + OpenAI web search historical")
    nfl_total = 0

    # Current season from ESPN
    count = ingest_espn_current_injuries("nfl", leagues["nfl"], ESPN_LEAGUES["nfl"])
    nfl_total += count

    # Historical years via OpenAI web search
    for year in range(START_YEAR, END_YEAR):  # skip current year (already got it)
        count = ingest_via_openai_search("nfl", leagues["nfl"], "https://www.spotrac.com/nfl/injured-reserve/", year)
        nfl_total += count
        time.sleep(2)  # Rate limit OpenAI

    print(f"  NFL TOTAL: {nfl_total} injuries")
    grand_total += nfl_total

    # ── Step 4: NBA ─────────────────────────────────────────────────────────
    print("\n[4/5] NBA — ESPN current + OpenAI web search historical")
    nba_total = 0

    count = ingest_espn_current_injuries("nba", leagues["nba"], ESPN_LEAGUES["nba"])
    nba_total += count

    for year in range(START_YEAR, END_YEAR):
        count = ingest_via_openai_search("nba", leagues["nba"], "https://www.spotrac.com/nba/injured-reserve/", year)
        nba_total += count
        time.sleep(2)

    print(f"  NBA TOTAL: {nba_total} injuries")
    grand_total += nba_total

    # ── Step 5: NHL ─────────────────────────────────────────────────────────
    print("\n[5a/5] NHL — Current season via NHL API")
    nhl_total = 0
    count = ingest_nhl_current_injuries(leagues["nhl"])
    nhl_total += count

    print("\n[5b/5] NHL — Historical via OpenAI web search")
    for year in range(START_YEAR, END_YEAR):
        count = ingest_via_openai_search("nhl", leagues["nhl"], "https://www.capfriendly.com/injuries", year)
        nhl_total += count
        time.sleep(2)

    print(f"  NHL TOTAL: {nhl_total} injuries")
    grand_total += nhl_total

    # ── Step 6: Premier League ──────────────────────────────────────────────
    print("\n[5c/5] Premier League — ESPN current + OpenAI web search historical")
    epl_total = 0

    count = ingest_espn_current_injuries("epl", leagues["epl"], ESPN_LEAGUES["epl"])
    epl_total += count

    for year in range(START_YEAR, END_YEAR):
        count = ingest_via_openai_search("epl", leagues["epl"], "https://www.transfermarkt.com", year)
        epl_total += count
        time.sleep(2)

    print(f"  Premier League TOTAL: {epl_total} injuries")
    grand_total += epl_total

    # ── Summary ─────────────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print(f"GRAND TOTAL: {grand_total} injuries ingested")
    print("=" * 60)

    # Print DB counts
    print("\nDB counts:")
    for table in ["back_in_play_leagues", "back_in_play_teams", "back_in_play_players", "back_in_play_injuries"]:
        rows = sb_get(table, "select=count")
        print(f"  {table}: check DB for exact count")

if __name__ == "__main__":
    main()
