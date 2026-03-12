#!/usr/bin/env python3
"""
Post-Injury Performance Curves Pipeline
========================================
Computes how player performance changes after returning from injury.

Primary data sources (game logs):
  NFL  → Pro-Football-Reference
  NBA  → Basketball-Reference
  NHL  → Hockey-Reference
  MLB  → Baseball-Reference
  EPL  → FBref

Also audits games_missed / recovery_days accuracy.

Usage:
  python3 performance_curves_pipeline.py --backfill              # all leagues
  python3 performance_curves_pipeline.py --backfill --league nba  # single league
  python3 performance_curves_pipeline.py --incremental            # daily cron
  python3 performance_curves_pipeline.py --phase resolve-ids      # single phase
  python3 performance_curves_pipeline.py --phase scrape-logs
  python3 performance_curves_pipeline.py --phase compute
  python3 performance_curves_pipeline.py --phase aggregate

Requires: pip install beautifulsoup4 lxml
"""

import argparse
import json
import math
import os
import re
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

try:
    from bs4 import BeautifulSoup
except ImportError:
    print("ERROR: pip install beautifulsoup4 lxml")
    sys.exit(1)

# ─── Env & Supabase ──────────────────────────────────────────────────────────

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

SB_URL = os.environ.get("SUPABASE_URL", "")
SB_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
if not SB_URL or not SB_KEY:
    print("ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
    sys.exit(1)

USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
REQUEST_DELAY = 4.0  # seconds between *-Reference requests (be respectful)

ALL_LEAGUES = ["nba", "nfl", "nhl", "mlb", "premier-league"]

# ─── Supabase helpers ─────────────────────────────────────────────────────────

def sb_headers(prefer="return=representation"):
    return {
        "apikey": SB_KEY,
        "Authorization": "Bearer " + SB_KEY,
        "Content-Type": "application/json",
        "Prefer": prefer,
    }

def sb_request(method, path, body=None, retries=3):
    url = SB_URL + "/rest/v1/" + path
    data = json.dumps(body).encode() if body else None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=data, headers=sb_headers(), method=method)
            resp = urllib.request.urlopen(req, timeout=30)
            text = resp.read().decode()
            return json.loads(text) if text.strip() else []
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
            else:
                print(f"  [SB ERR] {method} {path}: {e}", flush=True)
                return None

def sb_get(table, params=""):
    url = SB_URL + "/rest/v1/" + table + "?" + params
    hdrs = {"apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY}
    try:
        req = urllib.request.Request(url, headers=hdrs)
        resp = urllib.request.urlopen(req, timeout=30)
        return json.loads(resp.read().decode())
    except Exception as e:
        print(f"  [SB GET ERR] {table}: {e}", flush=True)
        return []

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

    hdrs = sb_headers("return=representation,resolution=merge-duplicates")
    url = SB_URL + "/rest/v1/" + table
    if conflict:
        url += "?on_conflict=" + conflict
    total = 0
    for i in range(0, len(rows), 50):
        batch = rows[i:i + 50]
        try:
            req = urllib.request.Request(url, data=json.dumps(batch).encode(),
                                        headers=hdrs, method="POST")
            resp = urllib.request.urlopen(req, timeout=60)
            result = json.loads(resp.read().decode())
            total += len(result) if isinstance(result, list) else 1
        except Exception as e:
            print(f"  [UPSERT ERR] {table}: {e}", flush=True)
            # row-by-row fallback
            for row in batch:
                try:
                    req2 = urllib.request.Request(url, data=json.dumps([row]).encode(),
                                                 headers=hdrs, method="POST")
                    urllib.request.urlopen(req2, timeout=30).read()
                    total += 1
                except Exception:
                    pass
    return total

def sb_patch(table, filters, body):
    url = SB_URL + "/rest/v1/" + table + "?" + filters
    data = json.dumps(body).encode()
    try:
        req = urllib.request.Request(url, data=data, headers=sb_headers(), method="PATCH")
        urllib.request.urlopen(req, timeout=30).read()
    except Exception as e:
        print(f"  [PATCH ERR] {table}: {e}", flush=True)

# ─── HTTP fetch with rate limiting ────────────────────────────────────────────

_last_request_time = 0.0

def fetch_html(url, delay=None):
    global _last_request_time
    wait = (delay or REQUEST_DELAY) - (time.time() - _last_request_time)
    if wait > 0:
        time.sleep(wait)
    _last_request_time = time.time()

    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            resp = urllib.request.urlopen(req, timeout=30)
            return resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            if e.code == 429:
                backoff = min(60, REQUEST_DELAY * (2 ** (attempt + 1)))
                print(f"    Rate limited, waiting {backoff:.0f}s...", flush=True)
                time.sleep(backoff)
            elif e.code == 404:
                return None
            else:
                if attempt == 2:
                    print(f"    HTTP {e.code} for {url}", flush=True)
                    return None
                time.sleep(3)
        except Exception as e:
            if attempt == 2:
                print(f"    Fetch error: {e}", flush=True)
                return None
            time.sleep(3)
    return None

# ─── Composite score formulas ─────────────────────────────────────────────────

def compute_composite(row, league):
    """Compute a standardized composite performance score for a game log row."""
    def g(field):
        v = row.get(field)
        return float(v) if v is not None else 0.0

    if league == "nba":
        return g("stat_pts") + 1.2 * g("stat_reb") + 1.5 * g("stat_ast") + 3.0 * g("stat_stl") + 3.0 * g("stat_blk")
    elif league == "nfl":
        return (0.04 * g("stat_pass_yds") + 4.0 * g("stat_pass_td") +
                0.1 * g("stat_rush_yds") + 6.0 * g("stat_rush_td") +
                g("stat_rec") + 0.1 * g("stat_rec_yds"))
    elif league == "nhl":
        return 3.0 * g("stat_goals") + 2.0 * g("stat_assists") + 0.5 * g("stat_sog")
    elif league == "mlb":
        ip = g("stat_ip")
        if ip > 0:  # pitcher
            return 3.0 * ip + 2.0 * g("stat_k") + max(0, (4.50 - g("stat_era")) * 2)
        else:  # hitter
            return g("stat_h") + 4.0 * g("stat_hr") + g("stat_rbi") + g("stat_r") + 2.0 * g("stat_sb")
    elif league == "premier-league":
        return 6.0 * g("stat_goals") + 3.0 * g("stat_assists") + 0.1 * g("minutes")
    return 0.0

# ─── Sport-Reference ID resolution ───────────────────────────────────────────

SEARCH_URLS = {
    "nba": "https://www.basketball-reference.com/search/search.fcgi?search={}",
    "nfl": "https://www.pro-football-reference.com/search/search.fcgi?search={}",
    "nhl": "https://www.hockey-reference.com/search/search.fcgi?search={}",
    "mlb": "https://www.baseball-reference.com/search/search.fcgi?search={}",
    "premier-league": "https://fbref.com/search/search.fcgi?search={}",
}

PLAYER_URL_PATTERNS = {
    "nba": re.compile(r"/players/[a-z]/([a-z]+\d+)\.html"),
    "nfl": re.compile(r"/players/[A-Z]/([A-Za-z]+\d+)\.htm"),
    "nhl": re.compile(r"/players/[a-z]/([a-z]+\d+)\.html"),
    "mlb": re.compile(r"/players/[a-z]/([a-z]+\d+)\.shtml"),
    "premier-league": re.compile(r"/en/players/([a-f0-9]+)/"),
}

def _name_match(search_name, link_text):
    """Check if a link's text plausibly matches the player name we searched for."""
    s = search_name.lower().strip()
    t = link_text.lower().strip()
    if not t:
        return False
    # Exact match
    if s == t:
        return True
    # Last name match (handles "John Smith" vs "John Q. Smith")
    s_parts = s.split()
    t_parts = t.split()
    if len(s_parts) >= 2 and len(t_parts) >= 2:
        if s_parts[-1] == t_parts[-1] and s_parts[0] == t_parts[0]:
            return True
        # Handle Jr., III, etc.
        if s_parts[0] == t_parts[0] and (s_parts[-1] in t or t_parts[-1] in s):
            return True
    return False


def resolve_sport_ref_id(player_name, league):
    """Search *-Reference site for a player and return their slug/ID."""
    search_url = SEARCH_URLS.get(league)
    if not search_url:
        return None

    encoded = urllib.parse.quote(player_name)
    html = fetch_html(search_url.format(encoded))
    if not html:
        return None

    pattern = PLAYER_URL_PATTERNS.get(league)
    if not pattern:
        return None

    soup = BeautifulSoup(html, "lxml")

    # Direct redirect: the page itself is a player page (canonical link)
    for link in soup.find_all("link", rel="canonical"):
        href = link.get("href", "")
        m = pattern.search(href)
        if m:
            return m.group(1)

    # Check <title> for direct redirect (e.g., "LeBron James Stats")
    title = soup.find("title")
    if title:
        title_text = title.get_text(strip=True)
        if player_name.split()[-1].lower() in title_text.lower():
            for a in soup.find_all("a", href=True):
                m = pattern.search(a["href"])
                if m:
                    return m.group(1)

    # Search results page: find player link whose text matches our search name
    for a in soup.find_all("a", href=True):
        m = pattern.search(a["href"])
        if m and _name_match(player_name, a.get_text(strip=True)):
            return m.group(1)

    return None

# ─── Game log scrapers (per league) ──────────────────────────────────────────

def _parse_float(text):
    if not text or text.strip() in ("", "-", "DNP", "Inactive", "Did Not Play", "Not With Team", "Player Suspended"):
        return None
    text = text.strip().replace(",", "")
    try:
        return float(text)
    except ValueError:
        return None

def _parse_int(text):
    v = _parse_float(text)
    return int(v) if v is not None else None

def _season_for_date(d, league):
    """Return the season year for a game date.
    NBA/NHL: Oct-Dec → next year (2024-25 season = "2025"). Jan-Sep → same year.
    NFL: Sep-Dec → same year. Jan-Feb → previous year (2025 season includes Jan/Feb 2026 playoffs).
    EPL: Aug-Dec → same year. Jan-May → previous year (2025-26 season = "2025" start).
    MLB: Always the calendar year.
    """
    if league in ("nba", "nhl"):
        return d.year + 1 if d.month >= 10 else d.year
    if league == "nfl":
        return d.year - 1 if d.month <= 2 else d.year
    if league == "premier-league":
        return d.year - 1 if d.month <= 6 else d.year
    return d.year


def _season_end_date(season, league):
    """Approximate end date for a given season. Used to determine if a season is over."""
    if league in ("nba", "nhl"):
        return date(season, 6, 30)  # NBA/NHL seasons end by June
    if league == "nfl":
        return date(season + 1, 2, 15)  # NFL season ends Feb (Super Bowl)
    if league == "premier-league":
        return date(season + 1, 5, 31)  # EPL season ends May
    # MLB
    return date(season, 10, 31)  # MLB ends October


def scrape_nba_game_log(sport_ref_id, season):
    """Scrape a player's NBA game log from Basketball-Reference."""
    letter = sport_ref_id[0]
    url = f"https://www.basketball-reference.com/players/{letter}/{sport_ref_id}/gamelog/{season}"
    html = fetch_html(url)
    if not html:
        return []

    soup = BeautifulSoup(html, "lxml")
    table = soup.find("table", id="pgl_basic")
    if not table:
        return []

    rows = []
    for tr in table.find("tbody").find_all("tr"):
        if tr.get("class") and "thead" in tr.get("class"):
            continue
        cells = tr.find_all("td")
        if len(cells) < 20:
            continue

        date_cell = tr.find("td", {"data-stat": "date_game"})
        if not date_cell:
            continue
        game_date = date_cell.get_text(strip=True)
        if not game_date:
            continue

        opp = (tr.find("td", {"data-stat": "opp_id"}) or {})
        mp = (tr.find("td", {"data-stat": "mp"}) or {})
        mp_text = mp.get_text(strip=True) if hasattr(mp, "get_text") else ""

        # Parse minutes (format: "35:22" or "35")
        minutes = None
        if mp_text and ":" in mp_text:
            parts = mp_text.split(":")
            minutes = float(parts[0]) + float(parts[1]) / 60.0
        elif mp_text:
            minutes = _parse_float(mp_text)

        if minutes is None or minutes == 0:
            continue  # DNP

        def stat(name):
            td = tr.find("td", {"data-stat": name})
            return _parse_float(td.get_text(strip=True)) if td else None

        row = {
            "game_date": game_date,
            "opponent": opp.get_text(strip=True) if hasattr(opp, "get_text") else "",
            "started": (tr.find("td", {"data-stat": "gs"}) or {}).get_text(strip=True) == "1" if tr.find("td", {"data-stat": "gs"}) else False,
            "minutes": minutes,
            "stat_pts": stat("pts"),
            "stat_reb": stat("trb"),
            "stat_ast": stat("ast"),
            "stat_stl": stat("stl"),
            "stat_blk": stat("blk"),
        }
        rows.append(row)

    return rows


def scrape_nfl_game_log(sport_ref_id, season):
    """Scrape NFL game log from Pro-Football-Reference."""
    letter = sport_ref_id[0].upper()
    url = f"https://www.pro-football-reference.com/players/{letter}/{sport_ref_id}/gamelog/{season}/"
    html = fetch_html(url)
    if not html:
        return []

    soup = BeautifulSoup(html, "lxml")
    # Try multiple table IDs (varies by position)
    table = soup.find("table", id="gamelog")
    if not table:
        table = soup.find("table", id="stats")
    if not table:
        # Find first stats table
        for t in soup.find_all("table"):
            if t.find("th", {"data-stat": "date_game"}):
                table = t
                break
    if not table:
        return []

    rows = []
    tbody = table.find("tbody")
    if not tbody:
        return []

    for tr in tbody.find_all("tr"):
        if tr.get("class") and "thead" in tr.get("class"):
            continue

        date_td = tr.find("td", {"data-stat": "date_game"})
        if not date_td:
            continue
        game_date = date_td.get_text(strip=True)
        if not game_date:
            continue

        def stat(name):
            td = tr.find("td", {"data-stat": name})
            return _parse_float(td.get_text(strip=True)) if td else None

        opp_td = tr.find("td", {"data-stat": "opp"})

        row = {
            "game_date": game_date,
            "opponent": opp_td.get_text(strip=True) if opp_td else "",
            "started": (tr.find("td", {"data-stat": "gs"}) or {}).get_text(strip=True) == "*" if tr.find("td", {"data-stat": "gs"}) else False,
            "minutes": None,
            "stat_pass_yds": stat("pass_yds"),
            "stat_pass_td": stat("pass_td"),
            "stat_rush_yds": stat("rush_yds"),
            "stat_rush_td": stat("rush_td"),
            "stat_rec": stat("rec"),
            "stat_rec_yds": stat("rec_yds"),
        }
        rows.append(row)

    return rows


def scrape_nhl_game_log(sport_ref_id, season):
    """Scrape NHL game log from Hockey-Reference."""
    letter = sport_ref_id[0]
    url = f"https://www.hockey-reference.com/players/{letter}/{sport_ref_id}/gamelog/{season}"
    html = fetch_html(url)
    if not html:
        return []

    soup = BeautifulSoup(html, "lxml")
    table = soup.find("table", id="gamelog")
    if not table:
        return []

    rows = []
    tbody = table.find("tbody")
    if not tbody:
        return []

    for tr in tbody.find_all("tr"):
        if tr.get("class") and "thead" in tr.get("class"):
            continue

        date_td = tr.find("td", {"data-stat": "date_game"})
        if not date_td:
            continue
        game_date = date_td.get_text(strip=True)
        if not game_date:
            continue

        def stat(name):
            td = tr.find("td", {"data-stat": name})
            return _parse_float(td.get_text(strip=True)) if td else None

        toi = stat("time_on_ice")
        minutes = None
        toi_td = tr.find("td", {"data-stat": "time_on_ice"})
        if toi_td:
            toi_text = toi_td.get_text(strip=True)
            if ":" in toi_text:
                parts = toi_text.split(":")
                minutes = float(parts[0]) + float(parts[1]) / 60.0
            elif toi_text:
                minutes = _parse_float(toi_text)

        opp_td = tr.find("td", {"data-stat": "opp_id"})

        row = {
            "game_date": game_date,
            "opponent": opp_td.get_text(strip=True) if opp_td else "",
            "started": False,
            "minutes": minutes,
            "stat_goals": stat("goals"),
            "stat_assists": stat("assists"),
            "stat_sog": stat("shots"),
        }
        rows.append(row)

    return rows


def scrape_mlb_game_log(sport_ref_id, season, is_pitcher=False):
    """Scrape MLB game log from Baseball-Reference."""
    letter = sport_ref_id[0]
    t = "p" if is_pitcher else "b"
    url = f"https://www.baseball-reference.com/players/gl.fcgi?id={sport_ref_id}&t={t}&year={season}"
    html = fetch_html(url)
    if not html:
        return []

    soup = BeautifulSoup(html, "lxml")
    table = soup.find("table", id=f"batting_gamelogs") if not is_pitcher else soup.find("table", id="pitching_gamelogs")
    if not table:
        # Try alternate ID
        for t_el in soup.find_all("table"):
            if "gamelog" in (t_el.get("id") or ""):
                table = t_el
                break
    if not table:
        return []

    rows = []
    tbody = table.find("tbody")
    if not tbody:
        return []

    for tr in tbody.find_all("tr"):
        if tr.get("class") and "thead" in tr.get("class"):
            continue

        date_td = tr.find("td", {"data-stat": "date_game"})
        if not date_td:
            continue
        # Link text is the date
        a = date_td.find("a")
        game_date = a.get_text(strip=True) if a else date_td.get_text(strip=True)
        if not game_date:
            continue

        def stat(name):
            td = tr.find("td", {"data-stat": name})
            return _parse_float(td.get_text(strip=True)) if td else None

        opp_td = tr.find("td", {"data-stat": "opp_ID"})

        if is_pitcher:
            row = {
                "game_date": game_date,
                "opponent": opp_td.get_text(strip=True) if opp_td else "",
                "started": (tr.find("td", {"data-stat": "GS"}) or {}).get_text(strip=True) == "1" if tr.find("td", {"data-stat": "GS"}) else False,
                "minutes": None,
                "stat_ip": stat("IP"),
                "stat_k": stat("SO"),
                "stat_era": stat("earned_run_avg"),
            }
        else:
            row = {
                "game_date": game_date,
                "opponent": opp_td.get_text(strip=True) if opp_td else "",
                "started": False,
                "minutes": None,
                "stat_h": stat("H"),
                "stat_hr": stat("HR"),
                "stat_rbi": stat("RBI"),
                "stat_r": stat("R"),
                "stat_sb": stat("SB"),
            }
        rows.append(row)

    return rows


def scrape_epl_game_log(sport_ref_id, season):
    """Scrape EPL game log from FBref."""
    url = f"https://fbref.com/en/players/{sport_ref_id}/matchlogs/{season}/summary/"
    html = fetch_html(url)
    if not html:
        return []

    soup = BeautifulSoup(html, "lxml")
    table = soup.find("table", id="matchlogs_all")
    if not table:
        # Try any table with match data
        for t in soup.find_all("table"):
            if t.find("th", {"data-stat": "date"}):
                table = t
                break
    if not table:
        return []

    rows = []
    tbody = table.find("tbody")
    if not tbody:
        return []

    for tr in tbody.find_all("tr"):
        if tr.get("class") and "thead" in tr.get("class"):
            continue

        date_td = tr.find("td", {"data-stat": "date"})
        if not date_td:
            continue
        game_date = date_td.get_text(strip=True)
        if not game_date:
            continue

        def stat(name):
            td = tr.find("td", {"data-stat": name})
            return _parse_float(td.get_text(strip=True)) if td else None

        opp_td = tr.find("td", {"data-stat": "opponent"})
        minutes = stat("minutes")

        row = {
            "game_date": game_date,
            "opponent": opp_td.get_text(strip=True) if opp_td else "",
            "started": (tr.find("td", {"data-stat": "game_started"}) or {}).get_text(strip=True) in ("Y", "1") if tr.find("td", {"data-stat": "game_started"}) else False,
            "minutes": minutes,
            "stat_goals": stat("goals"),
            "stat_assists": stat("assists"),
        }
        rows.append(row)

    return rows


SCRAPERS = {
    "nba": scrape_nba_game_log,
    "nfl": scrape_nfl_game_log,
    "nhl": scrape_nhl_game_log,
    "mlb": scrape_mlb_game_log,
    "premier-league": scrape_epl_game_log,
}

# ─── ESPN API fallback scrapers ──────────────────────────────────────────────
# ESPN API structure:
#   data.events = dict keyed by eventId → {gameDate, opponent: {abbreviation}, ...}
#   data.names = [field_name, ...] — consistent names for stat columns
#   data.labels = [abbreviation, ...] — display labels (may have duplicates like "YDS")
#   data.seasonTypes[n].categories[n].events[n] = {eventId, stats: [string values]}
# We use `names` for index-based lookup since labels can be ambiguous.

ESPN_SPORT_MAP = {
    "nba": ("basketball", "nba"),
    "nfl": ("football", "nfl"),
    "nhl": ("hockey", "nhl"),
    "mlb": ("baseball", "mlb"),
    "premier-league": ("soccer", "eng.1"),
}

def _espn_fetch_gamelog(espn_id, league, season):
    """Fetch game log JSON from ESPN API. Returns parsed JSON or None."""
    sport, espn_league = ESPN_SPORT_MAP.get(league, (None, None))
    if not sport:
        return None
    url = (f"https://site.api.espn.com/apis/common/v3/sports/{sport}/{espn_league}"
           f"/athletes/{espn_id}/gamelog?season={season}")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        resp = urllib.request.urlopen(req, timeout=30)
        return json.loads(resp.read().decode())
    except Exception as e:
        print(f"    ESPN API error ({league} {espn_id} {season}): {e}", flush=True)
        return None


def _espn_stat_by_name(names, stats, field_name):
    """Extract a stat value from ESPN gamelog using the `names` array (not labels)."""
    try:
        idx = names.index(field_name)
        v = stats[idx] if idx < len(stats) else None
        if v is None or v == "--" or v == "" or v == "-":
            return None
        return float(str(v).replace(",", ""))
    except (ValueError, IndexError):
        return None


def _espn_collect_games(data):
    """Collect all per-game stat rows from ESPN API response.
    Returns list of (eventId, stats_values) plus the event metadata dict + names list.
    """
    events_meta = data.get("events", {})  # dict keyed by eventId
    names = data.get("names", [])
    game_rows = []  # [(eventId, [stat_values])]

    for st in data.get("seasonTypes", []):
        st_name = st.get("displayName", "").lower()
        # Skip preseason / all-star
        if "pre" in st_name or "all-star" in st_name or "exhibition" in st_name:
            continue
        for cat in st.get("categories", []):
            cat_type = cat.get("type", "")
            if cat_type != "event":
                continue
            for ev in cat.get("events", []):
                eid = ev.get("eventId")
                stats = ev.get("stats", [])
                if eid and stats:
                    game_rows.append((str(eid), stats))

    return game_rows, events_meta, names


def espn_scrape_nba(espn_id, season):
    """Scrape NBA game log via ESPN API."""
    data = _espn_fetch_gamelog(espn_id, "nba", season)
    if not data:
        return []

    game_rows, events_meta, names = _espn_collect_games(data)
    rows = []
    for eid, stats in game_rows:
        meta = events_meta.get(eid, {})
        game_date = meta.get("gameDate", "")[:10]
        if not game_date:
            continue
        opponent = meta.get("opponent", {}).get("abbreviation", "")

        mins = _espn_stat_by_name(names, stats, "minutes")
        if mins is None or mins == 0:
            continue

        row = {
            "game_date": game_date,
            "opponent": opponent,
            "started": False,
            "minutes": mins,
            "stat_pts": _espn_stat_by_name(names, stats, "points"),
            "stat_reb": _espn_stat_by_name(names, stats, "totalRebounds"),
            "stat_ast": _espn_stat_by_name(names, stats, "assists"),
            "stat_stl": _espn_stat_by_name(names, stats, "steals"),
            "stat_blk": _espn_stat_by_name(names, stats, "blocks"),
        }
        rows.append(row)
    return rows


def espn_scrape_nfl(espn_id, season):
    """Scrape NFL game log via ESPN API.
    NFL stat columns vary by position (QB gets passing+rushing, WR gets receiving+rushing).
    Uses `names` array for unambiguous field lookup.
    """
    data = _espn_fetch_gamelog(espn_id, "nfl", season)
    if not data:
        return []

    game_rows, events_meta, names = _espn_collect_games(data)
    rows = []
    for eid, stats in game_rows:
        meta = events_meta.get(eid, {})
        game_date = meta.get("gameDate", "")[:10]
        if not game_date:
            continue
        opponent = meta.get("opponent", {}).get("abbreviation", "")

        row = {
            "game_date": game_date,
            "opponent": opponent,
            "started": False,
            "minutes": None,
            "stat_pass_yds": _espn_stat_by_name(names, stats, "passingYards"),
            "stat_pass_td": _espn_stat_by_name(names, stats, "passingTouchdowns"),
            "stat_rush_yds": _espn_stat_by_name(names, stats, "rushingYards"),
            "stat_rush_td": _espn_stat_by_name(names, stats, "rushingTouchdowns"),
            "stat_rec": _espn_stat_by_name(names, stats, "receptions"),
            "stat_rec_yds": _espn_stat_by_name(names, stats, "receivingYards"),
        }
        rows.append(row)
    return rows


def espn_scrape_nhl(espn_id, season):
    """Scrape NHL game log via ESPN API."""
    data = _espn_fetch_gamelog(espn_id, "nhl", season)
    if not data:
        return []

    game_rows, events_meta, names = _espn_collect_games(data)
    rows = []
    for eid, stats in game_rows:
        meta = events_meta.get(eid, {})
        game_date = meta.get("gameDate", "")[:10]
        if not game_date:
            continue
        opponent = meta.get("opponent", {}).get("abbreviation", "")

        row = {
            "game_date": game_date,
            "opponent": opponent,
            "started": False,
            "minutes": _espn_stat_by_name(names, stats, "timeOnIcePerGame"),
            "stat_goals": _espn_stat_by_name(names, stats, "goals"),
            "stat_assists": _espn_stat_by_name(names, stats, "assists"),
            "stat_sog": _espn_stat_by_name(names, stats, "shotsTotal"),
        }
        rows.append(row)
    return rows


def espn_scrape_mlb(espn_id, season, is_pitcher=False):
    """Scrape MLB game log via ESPN API."""
    data = _espn_fetch_gamelog(espn_id, "mlb", season)
    if not data:
        return []

    game_rows, events_meta, names = _espn_collect_games(data)
    rows = []
    for eid, stats in game_rows:
        meta = events_meta.get(eid, {})
        game_date = meta.get("gameDate", "")[:10]
        if not game_date:
            continue
        opponent = meta.get("opponent", {}).get("abbreviation", "")

        if is_pitcher:
            row = {
                "game_date": game_date,
                "opponent": opponent,
                "started": False,
                "minutes": None,
                "stat_ip": _espn_stat_by_name(names, stats, "innings") or _espn_stat_by_name(names, stats, "inningsPitched"),
                "stat_k": _espn_stat_by_name(names, stats, "strikeouts"),
                "stat_era": _espn_stat_by_name(names, stats, "ERA"),
            }
        else:
            row = {
                "game_date": game_date,
                "opponent": opponent,
                "started": False,
                "minutes": None,
                "stat_h": _espn_stat_by_name(names, stats, "hits"),
                "stat_hr": _espn_stat_by_name(names, stats, "homeRuns"),
                "stat_rbi": _espn_stat_by_name(names, stats, "RBIs"),
                "stat_r": _espn_stat_by_name(names, stats, "runs"),
                "stat_sb": _espn_stat_by_name(names, stats, "stolenBases"),
            }
        rows.append(row)
    return rows


def espn_scrape_epl(espn_id, season):
    """Scrape EPL game log via ESPN API."""
    data = _espn_fetch_gamelog(espn_id, "premier-league", season)
    if not data:
        return []

    game_rows, events_meta, names = _espn_collect_games(data)
    rows = []
    for eid, stats in game_rows:
        meta = events_meta.get(eid, {})
        game_date = meta.get("gameDate", "")[:10]
        if not game_date:
            continue
        opponent = meta.get("opponent", {}).get("abbreviation", "")

        row = {
            "game_date": game_date,
            "opponent": opponent,
            "started": False,
            "minutes": _espn_stat_by_name(names, stats, "minutesPlayed") or _espn_stat_by_name(names, stats, "minutes"),
            "stat_goals": _espn_stat_by_name(names, stats, "totalGoals") or _espn_stat_by_name(names, stats, "goals"),
            "stat_assists": _espn_stat_by_name(names, stats, "goalAssists") or _espn_stat_by_name(names, stats, "assists"),
        }
        rows.append(row)
    return rows


ESPN_SCRAPERS = {
    "nba": espn_scrape_nba,
    "nfl": espn_scrape_nfl,
    "nhl": espn_scrape_nhl,
    "mlb": espn_scrape_mlb,
    "premier-league": espn_scrape_epl,
}

# ─── FPL (Fantasy Premier League) CSV scraper for EPL ────────────────────────
# Uses https://github.com/vaastav/Fantasy-Premier-League (2016-17 to 2024-25)

_fpl_cache = {}  # season_str → {player_name_lower: [rows]}

def _fpl_season_str(season_year):
    """Convert season year (e.g., 2024) to FPL format (e.g., '2024-25')."""
    return f"{season_year}-{str(season_year + 1)[-2:]}"

def _fpl_load_season(season_year):
    """Download and parse a season's FPL CSV, cached in memory."""
    season_str = _fpl_season_str(season_year)
    if season_str in _fpl_cache:
        return _fpl_cache[season_str]

    url = (f"https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/"
           f"master/data/{season_str}/gws/merged_gw.csv")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        resp = urllib.request.urlopen(req, timeout=30)
        text = resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        print(f"    FPL CSV error ({season_str}): {e}", flush=True)
        _fpl_cache[season_str] = {}
        return {}

    import csv
    import io
    reader = csv.DictReader(io.StringIO(text))
    by_player = {}
    for row in reader:
        name = row.get("name", "").strip().lower()
        if name:
            by_player.setdefault(name, []).append(row)

    _fpl_cache[season_str] = by_player
    print(f"    FPL loaded {season_str}: {len(by_player)} players", flush=True)
    return by_player


def fpl_scrape_epl(player_name, season_year):
    """Get EPL game log for a player from FPL CSV data (2016-2025).
    Falls back to FPL live API for current season.
    Uses player_name (not espn_id) for matching.
    """
    by_player = _fpl_load_season(season_year)
    if not by_player:
        # If CSV not available (current/future season), try FPL live API
        return fpl_api_scrape_epl(player_name, season_year)

    # Try exact match first, then fuzzy
    name_lower = player_name.lower().strip()
    player_rows = by_player.get(name_lower)

    if not player_rows:
        # Try partial match (first + last name)
        parts = name_lower.split()
        if len(parts) >= 2:
            for pname, prows in by_player.items():
                pparts = pname.split()
                if len(pparts) >= 2 and pparts[0] == parts[0] and pparts[-1] == parts[-1]:
                    player_rows = prows
                    break

    if not player_rows:
        # Try FPL live API as fallback
        return fpl_api_scrape_epl(player_name, season_year)

    rows = []
    for pr in player_rows:
        kickoff = pr.get("kickoff_time", "")
        game_date = kickoff[:10] if kickoff else ""
        if not game_date:
            continue

        minutes = _parse_float(pr.get("minutes", "0"))
        if minutes is None or minutes == 0:
            continue  # Didn't play

        row = {
            "game_date": game_date,
            "opponent": str(pr.get("opponent_team", "")),
            "started": pr.get("starts", "0") == "1" or pr.get("was_home", "") == "True",
            "minutes": minutes,
            "stat_goals": _parse_float(pr.get("goals_scored", "0")),
            "stat_assists": _parse_float(pr.get("assists", "0")),
        }
        rows.append(row)

    return rows


# ─── FPL Live API scraper (current season) ──────────────────────────────────
# Uses fantasy.premierleague.com/api/ for current season per-GW stats

_fpl_bootstrap = None  # cached bootstrap-static data

def _fpl_get_bootstrap():
    """Fetch and cache the FPL bootstrap-static data (all players, teams)."""
    global _fpl_bootstrap
    if _fpl_bootstrap is not None:
        return _fpl_bootstrap

    url = "https://fantasy.premierleague.com/api/bootstrap-static/"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        resp = urllib.request.urlopen(req, timeout=30)
        data = json.loads(resp.read().decode())
        _fpl_bootstrap = data
        print(f"    FPL API: loaded {len(data.get('elements', []))} players", flush=True)
        return data
    except Exception as e:
        print(f"    FPL API bootstrap error: {e}", flush=True)
        _fpl_bootstrap = {}
        return {}


def _fpl_find_player(player_name):
    """Find a player's FPL element ID by name matching."""
    bootstrap = _fpl_get_bootstrap()
    elements = bootstrap.get("elements", [])
    if not elements:
        return None

    name_lower = player_name.lower().strip()
    name_parts = name_lower.split()

    for el in elements:
        # FPL has web_name (display name), first_name, second_name
        web = (el.get("web_name") or "").lower()
        full = f"{(el.get('first_name') or '')} {(el.get('second_name') or '')}".lower().strip()

        if name_lower == full or name_lower == web:
            return el["id"]

        # Partial match: first + last name
        if len(name_parts) >= 2:
            full_parts = full.split()
            if len(full_parts) >= 2:
                if name_parts[0] == full_parts[0] and name_parts[-1] == full_parts[-1]:
                    return el["id"]

    return None


def fpl_api_scrape_epl(player_name, season_year):
    """Scrape EPL game logs from FPL live API (current season only).
    Returns game rows compatible with the pipeline format.
    """
    fpl_id = _fpl_find_player(player_name)
    if not fpl_id:
        return []

    url = f"https://fantasy.premierleague.com/api/element-summary/{fpl_id}/"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        resp = urllib.request.urlopen(req, timeout=15)
        data = json.loads(resp.read().decode())
    except Exception as e:
        print(f"    FPL API element error for {player_name}: {e}", flush=True)
        return []

    # history = current season per-GW stats
    history = data.get("history", [])
    if not history:
        return []

    # Get team names from bootstrap for opponent mapping
    bootstrap = _fpl_get_bootstrap()
    teams = {t["id"]: t["short_name"] for t in bootstrap.get("teams", [])}

    rows = []
    for gw in history:
        kickoff = gw.get("kickoff_time", "")
        game_date = kickoff[:10] if kickoff else ""
        if not game_date:
            continue

        # Check season: FPL current season starts Aug/Sep of season_year
        try:
            d = datetime.strptime(game_date, "%Y-%m-%d").date()
        except (ValueError, TypeError):
            continue

        # EPL season year = start year (Aug-May)
        gw_season = d.year if d.month >= 7 else d.year - 1
        if gw_season != season_year:
            continue

        minutes = gw.get("minutes", 0)
        if not minutes or minutes == 0:
            continue

        opp_id = gw.get("opponent_team")
        opponent = teams.get(opp_id, str(opp_id or ""))

        row = {
            "game_date": game_date,
            "opponent": opponent,
            "started": gw.get("starts", 0) == 1,
            "minutes": float(minutes),
            "stat_goals": float(gw.get("goals_scored", 0)),
            "stat_assists": float(gw.get("assists", 0)),
        }
        rows.append(row)

    return rows

# ─── FPL bulk store: download & store all current season EPL game logs ────

def fpl_bulk_store():
    """Download all current season EPL game data from FPL API and store in DB.
    Fetches element-summary for every EPL player in our DB, stores full game logs.
    """
    bootstrap = _fpl_get_bootstrap()
    if not bootstrap:
        print("  FPL API unavailable", flush=True)
        return

    elements = bootstrap.get("elements", [])
    teams = {t["id"]: t["short_name"] for t in bootstrap.get("teams", [])}
    # Map FPL web_name/full_name → element id
    fpl_name_to_id = {}
    for el in elements:
        web = (el.get("web_name") or "").lower()
        full = f"{(el.get('first_name') or '')} {(el.get('second_name') or '')}".lower().strip()
        fpl_name_to_id[full] = el["id"]
        if web:
            fpl_name_to_id[web] = el["id"]

    # Get our EPL league_id
    leagues_data = sb_get("back_in_play_leagues", "select=league_id,slug")
    epl_lid = None
    for l in (leagues_data or []):
        if l["slug"] == "premier-league":
            epl_lid = l["league_id"]
            break
    if not epl_lid:
        print("  EPL league not found in DB", flush=True)
        return

    # Get all EPL players from our DB
    players = []
    offset = 0
    while True:
        batch = sb_get("back_in_play_players",
                       f"select=player_id,player_name&league_id=eq.{epl_lid}&limit=1000&offset={offset}")
        if not batch:
            break
        players.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000

    print(f"  {len(players)} EPL players in DB, {len(fpl_name_to_id)} FPL players", flush=True)

    stored = 0
    not_found = 0

    for i, p in enumerate(players):
        name = p.get("player_name", "").strip()
        name_lower = name.lower()

        # Find FPL element ID
        fpl_id = fpl_name_to_id.get(name_lower)
        if not fpl_id:
            parts = name_lower.split()
            if len(parts) >= 2:
                for fn, fid in fpl_name_to_id.items():
                    fp = fn.split()
                    if len(fp) >= 2 and fp[0] == parts[0] and fp[-1] == parts[-1]:
                        fpl_id = fid
                        break
        if not fpl_id:
            not_found += 1
            continue

        # Fetch game history
        try:
            url = f"https://fantasy.premierleague.com/api/element-summary/{fpl_id}/"
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            resp = urllib.request.urlopen(req, timeout=15)
            data = json.loads(resp.read().decode())
        except Exception:
            continue

        history = data.get("history", [])
        if not history:
            continue

        db_rows = []
        for gw in history:
            kickoff = gw.get("kickoff_time", "")
            game_date = kickoff[:10] if kickoff else ""
            if not game_date:
                continue

            try:
                d = datetime.strptime(game_date, "%Y-%m-%d").date()
            except (ValueError, TypeError):
                continue

            season_year = d.year if d.month >= 7 else d.year - 1
            minutes = gw.get("minutes", 0)

            db_row = {
                "player_id": p["player_id"],
                "league_slug": "premier-league",
                "season": season_year,
                "game_date": game_date,
                "opponent": teams.get(gw.get("opponent_team"), str(gw.get("opponent_team", ""))),
                "started": gw.get("starts", 0) == 1,
                "minutes": float(minutes) if minutes else 0.0,
                "stat_goals": float(gw.get("goals_scored", 0)),
                "stat_assists": float(gw.get("assists", 0)),
            }
            db_row["composite"] = compute_composite(db_row, "premier-league")
            db_rows.append(db_row)

        if db_rows:
            sb_upsert("back_in_play_player_game_logs", db_rows, conflict="player_id,game_date")
            stored += len(db_rows)

        if (i + 1) % 100 == 0:
            print(f"  [{i + 1}/{len(players)}] stored {stored} game logs...", flush=True)

        # Rate limit
        if (i + 1) % 30 == 0:
            time.sleep(1)

    print(f"\n  FPL bulk store: {stored} game logs stored, {not_found} players not found in FPL", flush=True)


# ─── Injury classification ────────────────────────────────────────────────────

# Map body-part injury_type → specific subtypes by keywords in description
INJURY_SUBTYPES = {
    # Knee
    "acl": "ACL Tear",
    "anterior cruciate": "ACL Tear",
    "mcl": "MCL Sprain",
    "medial collateral": "MCL Sprain",
    "pcl": "PCL Injury",
    "posterior cruciate": "PCL Injury",
    "lcl": "LCL Sprain",
    "lateral collateral": "LCL Sprain",
    "meniscus": "Meniscus Tear",
    "torn meniscus": "Meniscus Tear",
    "patellar": "Patellar Injury",
    "patella": "Patellar Injury",
    "hyperextend": "Knee Hyperextension",
    "bone bruise": "Bone Bruise",
    "knee scope": "Knee Scope",
    "knee surgery": "Knee Surgery",
    "arthroscop": "Knee Scope",
    # Shoulder
    "labrum": "Labrum Tear",
    "torn labrum": "Labrum Tear",
    "rotator cuff": "Rotator Cuff",
    "separated shoulder": "Separated Shoulder",
    "shoulder separation": "Separated Shoulder",
    "dislocated shoulder": "Dislocated Shoulder",
    "shoulder disloc": "Dislocated Shoulder",
    # Ankle
    "high ankle": "High Ankle Sprain",
    "syndesmosis": "High Ankle Sprain",
    "ankle sprain": "Ankle Sprain",
    "sprained ankle": "Ankle Sprain",
    "rolled ankle": "Ankle Sprain",
    "ankle fracture": "Ankle Fracture",
    "broken ankle": "Ankle Fracture",
    "achilles": "Achilles Injury",
    "torn achilles": "Achilles Tear",
    "achilles tear": "Achilles Tear",
    "achilles rupture": "Achilles Tear",
    # Hamstring
    "hamstring strain": "Hamstring Strain",
    "hamstring tear": "Hamstring Tear",
    "torn hamstring": "Hamstring Tear",
    "hamstring pull": "Hamstring Strain",
    "hamstring tight": "Hamstring Tightness",
    # Concussion
    "concussion protocol": "Concussion",
    "head injury": "Concussion",
    # Back
    "herniated disc": "Herniated Disc",
    "herniated disk": "Herniated Disc",
    "bulging disc": "Bulging Disc",
    "back spasms": "Back Spasms",
    "back spasm": "Back Spasms",
    "lower back": "Lower Back",
    "lumbar": "Lower Back",
    # Foot
    "lisfranc": "Lisfranc Injury",
    "plantar fasci": "Plantar Fasciitis",
    "turf toe": "Turf Toe",
    "jones fracture": "Jones Fracture",
    "stress fracture": "Stress Fracture",
    "metatarsal": "Metatarsal Fracture",
    # Arm/Elbow
    "tommy john": "Tommy John Surgery",
    "ucl": "UCL Injury",
    "ulnar collateral": "UCL Injury",
    "elbow surgery": "Elbow Surgery",
    "tennis elbow": "Tennis Elbow",
    # Leg
    "quad strain": "Quad Strain",
    "quadricep strain": "Quad Strain",
    "calf strain": "Calf Strain",
    "groin strain": "Groin Strain",
    "groin pull": "Groin Strain",
    "hip flexor": "Hip Flexor Strain",
    "oblique": "Oblique Strain",
    "abdominal strain": "Abdominal Strain",
    "core muscle": "Core Muscle Injury",
    # Other specific
    "tommy john": "Tommy John Surgery",
    "microdiscectomy": "Back Surgery",
    "fracture": "Fracture",
    "torn": "Tear",
    "sprain": "Sprain",
    "strain": "Strain",
    "surgery": "Surgery",
    "scope": "Scope/Arthroscopy",
}

# Normalize body-part variations
INJURY_TYPE_NORMALIZE = {
    "Rib": "Ribs",
    "Right Shoulder": "Shoulder",
    "Left Shoulder": "Shoulder",
    "Right Elbow": "Elbow",
    "Left Elbow": "Elbow",
    "Right Knee": "Knee",
    "Left Knee": "Knee",
    "Right Ankle": "Ankle",
    "Left Ankle": "Ankle",
    "Right Wrist": "Wrist",
    "Left Wrist": "Wrist",
    "Right Foot": "Foot",
    "Left Foot": "Foot",
    "Right Hand": "Hand",
    "Left Hand": "Hand",
    "Lower Leg": "Leg",
    "Quadricep": "Quad",
    "Quadriceps": "Quad",
    "Biceps": "Bicep",
    "Triceps": "Tricep",
    "Pectoral": "Chest",
    "Not Injury Related": "Non-Injury",
}


def classify_injury(injury_type, description="", short_comment="", long_comment=""):
    """Classify an injury into normalized type + specific subtype.

    Returns (normalized_type, subtype, side).
    """
    injury_type = injury_type or ""
    desc_combined = " ".join(filter(None, [description, short_comment, long_comment])).lower()

    # Extract side
    side = None
    orig = injury_type
    for prefix in ("Right ", "Left "):
        if injury_type.startswith(prefix):
            side = prefix.strip().lower()
            break
    if not side:
        if "right" in desc_combined[:60]:
            side = "right"
        elif "left" in desc_combined[:60]:
            side = "left"

    # Normalize type
    normalized = INJURY_TYPE_NORMALIZE.get(injury_type, injury_type)

    # Find specific subtype from description
    subtype = None
    for keyword, sub in INJURY_SUBTYPES.items():
        if keyword in desc_combined:
            subtype = sub
            break  # first match wins (ordered by specificity)

    # If no description match, use injury_type as subtype for specific enough types
    if not subtype and normalized in ("Concussion", "Achilles", "Illness"):
        subtype = normalized

    return normalized, subtype, side


def classify_all_injuries():
    """Batch-classify all injuries and update normalized_type, subtype, side columns."""
    print("[CLASSIFY] Loading injuries for classification...", flush=True)

    # First ensure columns exist
    _ensure_injury_columns()

    offset = 0
    batch_size = 500
    total_classified = 0
    total_updated = 0

    while True:
        rows = sb_get("back_in_play_injuries",
                       f"select=injury_id,injury_type,injury_description,short_comment,long_comment,side"
                       f"&order=injury_id.asc&limit={batch_size}&offset={offset}")
        if not rows:
            break

        updates = []
        for r in rows:
            norm, sub, side = classify_injury(
                r.get("injury_type"),
                r.get("injury_description"),
                r.get("short_comment"),
                r.get("long_comment"),
            )
            patch = {}
            if norm and norm != r.get("injury_type"):
                patch["normalized_injury_type"] = norm
            else:
                patch["normalized_injury_type"] = r.get("injury_type") or "Unknown"
            if sub:
                patch["injury_subtype"] = sub
            if side and not r.get("side"):
                patch["side"] = side

            if patch:
                patch["injury_id"] = r["injury_id"]
                updates.append(patch)

        for u in updates:
            iid = u.pop("injury_id")
            sb_patch("back_in_play_injuries", f"injury_id=eq.{iid}", u)
            total_updated += 1

        total_classified += len(rows)
        if total_classified % 5000 == 0:
            print(f"  Classified {total_classified} injuries ({total_updated} updated)...", flush=True)

        offset += batch_size
        if len(rows) < batch_size:
            break

    print(f"[CLASSIFY] Done: {total_classified} injuries classified, {total_updated} updated", flush=True)


def _ensure_injury_columns():
    """Add normalized_injury_type, injury_subtype columns if they don't exist."""
    # Try a select — if columns don't exist, we'll need to add them via SQL
    try:
        sb_get("back_in_play_injuries",
               "select=injury_id,normalized_injury_type,injury_subtype&limit=1")
    except Exception:
        print("  Adding normalized_injury_type and injury_subtype columns...", flush=True)
        # Use Supabase SQL via REST — this requires service role
        url = SUPABASE_URL + "/rest/v1/rpc/sql"
        # Fallback: just try the upsert and it'll fail gracefully if columns missing
        print("  NOTE: If columns don't exist, run this SQL in Supabase dashboard:", flush=True)
        print("    ALTER TABLE back_in_play_injuries ADD COLUMN IF NOT EXISTS normalized_injury_type TEXT;", flush=True)
        print("    ALTER TABLE back_in_play_injuries ADD COLUMN IF NOT EXISTS injury_subtype TEXT;", flush=True)


# ─── Injury history enrichment ────────────────────────────────────────────────

def enrich_injury_history():
    """Compute per-injury context: total prior injuries, same body part recurrence,
    days since last injury, injury number this season, and performance impact.
    Run this AFTER classify_all_injuries and audit_returns.
    """
    print("[ENRICH] Loading all injuries ordered by player and date...", flush=True)

    # Load all injuries with player info
    all_injuries = []
    offset = 0
    batch = 500
    while True:
        rows = sb_get("back_in_play_injuries",
                       f"select=injury_id,player_id,injury_type,normalized_injury_type,date_injured,return_date,status"
                       f"&date_injured=not.is.null&order=date_injured.asc&limit={batch}&offset={offset}")
        if not rows:
            break
        all_injuries.extend(rows)
        offset += batch
        if len(rows) < batch:
            break

    print(f"  Loaded {len(all_injuries)} injuries", flush=True)

    # Get league info for each player (needed for season calculation)
    player_ids = list(set(inj["player_id"] for inj in all_injuries))
    player_league = {}
    for i in range(0, len(player_ids), 50):
        batch_ids = player_ids[i:i + 50]
        ids_str = ",".join(batch_ids)
        p_data = sb_get("back_in_play_players",
                         f"select=player_id,league_id&player_id=in.({ids_str})")
        for p in (p_data or []):
            player_league[p["player_id"]] = p.get("league_id", "")

    leagues_data = sb_get("back_in_play_leagues", "select=league_id,slug")
    league_slug_map = {l["league_id"]: l["slug"] for l in (leagues_data or [])}

    # Group by player
    by_player = {}
    for inj in all_injuries:
        pid = inj["player_id"]
        by_player.setdefault(pid, []).append(inj)

    print(f"  {len(by_player)} unique players", flush=True)

    # Process each player's injury history
    total_perf = 0
    total_updated = 0
    for pid, injuries in by_player.items():
        ls = league_slug_map.get(player_league.get(pid, ""), "")

        for idx, inj in enumerate(injuries):
            patch = {}

            # Total prior injuries for this player
            patch["total_prior_injuries"] = idx

            # Days since last injury
            if idx > 0:
                prev = injuries[idx - 1]
                try:
                    d_curr = datetime.strptime(inj["date_injured"], "%Y-%m-%d").date()
                    d_prev = datetime.strptime(prev["date_injured"], "%Y-%m-%d").date()
                    patch["days_since_last_injury"] = (d_curr - d_prev).days
                except (ValueError, TypeError):
                    pass

            # Same body part as any prior injury?
            curr_type = inj.get("normalized_injury_type") or inj.get("injury_type") or ""
            if curr_type and idx > 0:
                prior_types = [
                    (i.get("normalized_injury_type") or i.get("injury_type") or "")
                    for i in injuries[:idx]
                ]
                patch["same_body_part_prior"] = curr_type in prior_types

            # Injury number this season
            try:
                d = datetime.strptime(inj["date_injured"], "%Y-%m-%d").date()
                season_injuries = [
                    i for i in injuries[:idx]
                    if i.get("date_injured", "")[:4] == inj["date_injured"][:4]
                    or (int(i.get("date_injured", "0000")[:4]) == d.year - 1
                        and d.month < 7)
                ]
                patch["injury_number_season"] = len(season_injuries) + 1
            except (ValueError, TypeError):
                patch["injury_number_season"] = 1

            # Pre/post performance computation (only for returned injuries with dates)
            if inj.get("return_date") and inj.get("date_injured"):
                try:
                    d_injured = datetime.strptime(inj["date_injured"], "%Y-%m-%d").date()
                    d_return = datetime.strptime(inj["return_date"], "%Y-%m-%d").date()
                    season = _season_for_date(d_injured, ls) if ls else d_injured.year

                    # Pre-injury: last 10 games before injury
                    pre_logs = sb_get("back_in_play_player_game_logs",
                                       f"select=composite&player_id=eq.{pid}"
                                       f"&game_date=lt.{inj['date_injured']}"
                                       f"&composite=not.is.null"
                                       f"&order=game_date.desc&limit=10")

                    # Post-return: first 5 games after return
                    post_logs = sb_get("back_in_play_player_game_logs",
                                        f"select=composite&player_id=eq.{pid}"
                                        f"&game_date=gte.{inj['return_date']}"
                                        f"&composite=not.is.null"
                                        f"&order=game_date.asc&limit=5")

                    if pre_logs and len(pre_logs) >= 3 and post_logs and len(post_logs) >= 1:
                        pre_avg = statistics.mean(g["composite"] for g in pre_logs if g.get("composite") is not None)
                        post_avg = statistics.mean(g["composite"] for g in post_logs if g.get("composite") is not None)

                        patch["pre_injury_composite_avg"] = round(pre_avg, 2)
                        patch["post_return_composite_avg"] = round(post_avg, 2)
                        if pre_avg > 0:
                            patch["performance_drop_pct"] = round((post_avg - pre_avg) / pre_avg * 100, 1)
                        total_perf += 1
                except (ValueError, TypeError):
                    pass

            if patch:
                sb_patch("back_in_play_injuries",
                         f"injury_id=eq.{inj['injury_id']}",
                         patch)
                total_updated += 1

                if total_updated % 500 == 0:
                    print(f"  Updated {total_updated} injuries ({total_perf} with perf stats)...", flush=True)

    print(f"[ENRICH] Done: {total_updated} injuries enriched for {len(by_player)} players", flush=True)
    print(f"  {total_perf} injuries have pre/post performance comparisons", flush=True)


# ─── Injury audit: discover returns from game logs ──────────────────────────

def audit_returns(league=None):
    """Audit ALL injuries to discover unreported returns using game log data.
    For each injury without a return_date, check if the player played games
    after the injury date. If so, set return_date and status=returned.
    Also scrapes game logs for players who don't have them yet.
    """
    print("[AUDIT] Loading all injuries...", flush=True)

    # Get all injuries (not just returned ones)
    params = "select=injury_id,player_id,injury_type,injury_type_slug,date_injured,return_date,status,games_missed,recovery_days"
    params += "&date_injured=not.is.null"
    if league:
        pass  # Filter client-side after joining
    params += "&order=date_injured.desc"
    params += "&limit=50000"

    all_injuries = sb_get("back_in_play_injuries", params)
    if not all_injuries:
        print("  No injuries found", flush=True)
        return

    # Get player info
    player_ids = list(set(i["player_id"] for i in all_injuries))
    players = {}
    for i in range(0, len(player_ids), 50):
        batch = player_ids[i:i + 50]
        ids_str = ",".join(batch)
        p_params = f"select=player_id,player_name,league_id,espn_id,sport_ref_id,position&player_id=in.({ids_str})"
        for p in sb_get("back_in_play_players", p_params) or []:
            players[p["player_id"]] = p

    # Get league map
    leagues_data = sb_get("back_in_play_leagues", "select=league_id,slug")
    league_map = {l["league_id"]: l["slug"] for l in (leagues_data or [])}

    # Filter injuries to target league and identify unresolved ones
    unresolved = []  # injuries without return_date
    all_enriched = []  # all injuries with player info
    player_ids_needing_logs = set()

    for inj in all_injuries:
        p = players.get(inj["player_id"])
        if not p:
            continue
        ls = league_map.get(p.get("league_id", ""), "")
        if league and ls != league:
            continue

        inj["player_name"] = p.get("player_name", "")
        inj["league_slug"] = ls
        inj["espn_id"] = p.get("espn_id")
        inj["sport_ref_id"] = p.get("sport_ref_id")
        inj["position"] = p.get("position", "")
        all_enriched.append(inj)

        if not inj.get("return_date") and inj.get("status") != "returned":
            unresolved.append(inj)
            player_ids_needing_logs.add(inj["player_id"])

    print(f"  {len(all_enriched)} total injuries, {len(unresolved)} unresolved (no return_date)", flush=True)
    print(f"  {len(player_ids_needing_logs)} unique players need game log checks", flush=True)

    if not unresolved:
        print("  All injuries already have return data!", flush=True)
        return

    # Step 1: Scrape game logs for players with unresolved injuries
    # Build combos: (player_id, sport_ref_id/espn_id, league, season)
    combos = set()
    for inj in unresolved:
        pid = inj["player_id"]
        ls = inj["league_slug"]
        ref_id = inj.get("sport_ref_id") or ""
        espn_id = inj.get("espn_id") or ""
        pname = inj.get("player_name", "")

        if not ref_id and not espn_id and ls != "premier-league":
            continue

        try:
            d_injured = datetime.strptime(inj["date_injured"], "%Y-%m-%d").date()
        except (ValueError, TypeError):
            continue

        season = _season_for_date(d_injured, ls)
        combos.add((pid, ref_id, espn_id, ls, season, inj.get("position", ""), pname))

    # Check which we already have
    already_scraped = set()
    for pid, _, _, _, season, _, _ in combos:
        existing = sb_get("back_in_play_player_game_logs",
                          f"select=id&player_id=eq.{pid}&season=eq.{season}&limit=1")
        if existing:
            already_scraped.add((pid, season))

    to_scrape = [(pid, ref_id, eid, ls, season, pos, pname)
                 for pid, ref_id, eid, ls, season, pos, pname in combos
                 if (pid, season) not in already_scraped]

    print(f"\n[AUDIT] Scraping {len(to_scrape)} player-seasons ({len(already_scraped)} cached)...", flush=True)

    for i, (pid, ref_id, espn_id, ls, season, position, pname) in enumerate(sorted(to_scrape)):
        game_rows = []
        is_pitcher = position and position.lower() in ("pitcher", "sp", "rp", "starting pitcher", "relief pitcher", "p")

        # Try *-Reference
        if ref_id:
            scraper = SCRAPERS.get(ls)
            if scraper:
                if ls == "mlb":
                    game_rows = scraper(ref_id, season, is_pitcher=is_pitcher)
                else:
                    game_rows = scraper(ref_id, season)

        # ESPN fallback
        if not game_rows and espn_id:
            espn_scraper = ESPN_SCRAPERS.get(ls)
            if espn_scraper:
                if ls == "mlb":
                    game_rows = espn_scraper(espn_id, season, is_pitcher=is_pitcher)
                else:
                    game_rows = espn_scraper(espn_id, season)

        # FPL fallback for EPL
        if not game_rows and ls == "premier-league" and pname and 2016 <= season <= 2024:
            game_rows = fpl_scrape_epl(pname, season)

        if not game_rows:
            continue

        # Store in DB
        db_rows = []
        for gr in game_rows:
            gd = gr.get("game_date", "")
            try:
                if len(gd) == 10:
                    pass
                elif "," in gd:
                    gd = datetime.strptime(gd, "%b %d, %Y").strftime("%Y-%m-%d")
            except (ValueError, TypeError):
                continue

            db_row = {
                "player_id": pid,
                "league_slug": ls,
                "season": season,
                "game_date": gd,
                "opponent": gr.get("opponent", ""),
                "started": gr.get("started", False),
                "minutes": gr.get("minutes"),
            }
            for k, v in gr.items():
                if k.startswith("stat_") and v is not None:
                    db_row[k] = v
            db_row["composite"] = compute_composite(db_row, ls)
            db_rows.append(db_row)

        if db_rows:
            sb_upsert("back_in_play_player_game_logs", db_rows, conflict="player_id,game_date")

        if (i + 1) % 50 == 0:
            print(f"  [{i + 1}/{len(to_scrape)}] scraped...", flush=True)

    # Step 2: Audit unresolved injuries against game logs
    print(f"\n[AUDIT] Checking {len(unresolved)} unresolved injuries against game logs...", flush=True)
    updated = 0
    season_ending = 0

    for inj in unresolved:
        pid = inj["player_id"]
        ls = inj["league_slug"]

        try:
            d_injured = datetime.strptime(inj["date_injured"], "%Y-%m-%d").date()
        except (ValueError, TypeError):
            continue

        # Get game logs after injury date
        season = _season_for_date(d_injured, ls)
        logs = sb_get("back_in_play_player_game_logs",
                      f"select=game_date&player_id=eq.{pid}&game_date=gt.{d_injured.isoformat()}&season=eq.{season}&order=game_date.asc&limit=1")

        if logs:
            # Player played after injury → they returned!
            first_game = logs[0]["game_date"]
            try:
                d_return = datetime.strptime(first_game, "%Y-%m-%d").date()
            except (ValueError, TypeError):
                continue

            recovery = (d_return - d_injured).days

            # Count games missed: games the player played before injury minus
            # the gap tells us team activity. But simpler: count all their games
            # in the season, and how many fall between injury and return
            all_season = sb_get("back_in_play_player_game_logs",
                                f"select=game_date&player_id=eq.{pid}&season=eq.{season}&order=game_date.asc&limit=200")
            # Games missed ≈ total season games after injury date minus games they played after injury
            # But since logs only show games played, approximate by looking at game frequency
            games_before = len([g for g in all_season if g["game_date"] <= inj["date_injured"]])
            games_after = len([g for g in all_season if g["game_date"] >= first_game])
            total_games = len(all_season)
            # Estimate: if they played X games before and Y after, they missed roughly
            # (total_expected - X - Y) games. Approximate total_expected from total + gap proportion.
            games_missed = max(0, total_games - games_before - games_after) if total_games > 0 else None

            update = {
                "return_date": first_game,
                "status": "returned",
                "recovery_days": recovery,
                "games_missed": games_missed,
            }
            sb_patch("back_in_play_injuries",
                     f"injury_id=eq.{inj['injury_id']}",
                     update)
            updated += 1

            if updated <= 20 or updated % 100 == 0:
                missed_str = f", {games_missed} games missed" if games_missed else ""
                print(f"  [RETURNED] {inj.get('player_name', '?')}: injured {inj['date_injured']} → returned {first_game} ({recovery}d{missed_str})", flush=True)
        else:
            # No games after injury this season → only mark season-ending if
            # the season is actually over (not mid-season)
            today = date.today()
            season_end_approx = _season_end_date(season, ls)
            if today < season_end_approx:
                # Season still in progress — don't mark as season-ending
                continue

            pre_logs = sb_get("back_in_play_player_game_logs",
                              f"select=game_date&player_id=eq.{pid}&season=eq.{season}&game_date=lte.{d_injured.isoformat()}&limit=200")
            if pre_logs:
                # Player was active before injury but didn't return in a finished season
                games_played_before = len(pre_logs)
                all_season = sb_get("back_in_play_player_game_logs",
                                    f"select=game_date&player_id=eq.{pid}&season=eq.{season}&limit=200")
                games_missed = len(all_season) - games_played_before

                update = {
                    "status": "season_ending",
                    "games_missed": max(0, games_missed) if games_missed else None,
                }
                sb_patch("back_in_play_injuries",
                         f"injury_id=eq.{inj['injury_id']}",
                         update)
                season_ending += 1

                if season_ending <= 10 or season_ending % 50 == 0:
                    print(f"  [SEASON-END] {inj.get('player_name', '?')}: injured {inj['date_injured']}, missed {games_missed} games rest of {season} season", flush=True)

    print(f"\n[AUDIT] Results: {updated} returned, {season_ending} season-ending, {len(unresolved) - updated - season_ending} unknown", flush=True)
    return updated


# ─── Pipeline phases ─────────────────────────────────────────────────────────

def phase_1_get_return_cases(league=None, since_date=None):
    """Get injury records with valid returns from Supabase."""
    params = "select=injury_id,player_id,injury_type,injury_type_slug,date_injured,return_date,games_missed,recovery_days,status"
    params += "&return_date=not.is.null"
    params += "&status=eq.returned"
    if league:
        # Need to join through player to get league — query all and filter
        pass
    if since_date:
        params += f"&return_date=gte.{since_date}"
    params += "&order=return_date.desc"
    params += "&limit=5000"

    cases = sb_get("back_in_play_injuries", params)
    if not cases:
        return []

    # Enrich with player info
    player_ids = list(set(c["player_id"] for c in cases))
    players = {}
    for i in range(0, len(player_ids), 50):
        batch = player_ids[i:i + 50]
        ids_str = ",".join(batch)
        p_params = f"select=player_id,player_name,slug,position,league_id,sport_ref_id,espn_id&player_id=in.({ids_str})"
        for p in sb_get("back_in_play_players", p_params) or []:
            players[p["player_id"]] = p

    # Get league slugs
    leagues_data = sb_get("back_in_play_leagues", "select=league_id,slug")
    league_map = {l["league_id"]: l["slug"] for l in (leagues_data or [])}

    enriched = []
    for c in cases:
        p = players.get(c["player_id"])
        if not p:
            continue
        ls = league_map.get(p.get("league_id", ""), "")
        if league and ls != league:
            continue
        c["player_name"] = p.get("player_name", "")
        c["position"] = p.get("position", "")
        c["league_slug"] = ls
        c["sport_ref_id"] = p.get("sport_ref_id")
        c["espn_id"] = p.get("espn_id")
        enriched.append(c)

    return enriched


def phase_2_resolve_ids(cases, league=None):
    """Resolve sport-reference IDs for players that don't have one."""
    to_resolve = [c for c in cases if not c.get("sport_ref_id")]
    if not to_resolve:
        print("  All players already have sport_ref_id", flush=True)
        return

    # Deduplicate by player_id
    seen = set()
    unique = []
    for c in to_resolve:
        if c["player_id"] not in seen:
            seen.add(c["player_id"])
            unique.append(c)

    print(f"  Resolving {len(unique)} player IDs...", flush=True)
    resolved = 0
    for i, c in enumerate(unique):
        ls = c["league_slug"]
        if league and ls != league:
            continue
        name = c.get("player_name", "")
        if not name:
            continue

        ref_id = resolve_sport_ref_id(name, ls)
        if ref_id:
            # Update player record
            sb_patch("back_in_play_players",
                     f"player_id=eq.{c['player_id']}",
                     {"sport_ref_id": ref_id})
            c["sport_ref_id"] = ref_id
            resolved += 1
            print(f"    [{i + 1}/{len(unique)}] {name} → {ref_id}", flush=True)
        else:
            print(f"    [{i + 1}/{len(unique)}] {name} → NOT FOUND", flush=True)

        if (i + 1) % 50 == 0:
            print(f"  Progress: {i + 1}/{len(unique)} ({resolved} resolved)", flush=True)

    print(f"  Resolved {resolved}/{len(unique)} IDs", flush=True)


def phase_3_scrape_logs(cases, league=None):
    """Scrape game logs for players in return cases.
    Tries *-Reference first, falls back to ESPN API, then FPL CSV for EPL.
    """
    # Build player_name lookup for FPL matching
    player_names = {c["player_id"]: c.get("player_name", "") for c in cases}

    # Collect unique (player_id, sport_ref_id, espn_id, league, season, position) combos
    combos = set()
    for c in cases:
        ls = c["league_slug"]
        if league and ls != league:
            continue
        # Need either sport_ref_id, espn_id, or be EPL (FPL uses player_name)
        if not c.get("sport_ref_id") and not c.get("espn_id") and ls != "premier-league":
            continue

        try:
            d_injured = datetime.strptime(c["date_injured"], "%Y-%m-%d").date()
            d_return = datetime.strptime(c["return_date"], "%Y-%m-%d").date()
        except (ValueError, TypeError):
            continue

        season_inj = _season_for_date(d_injured, ls)
        season_ret = _season_for_date(d_return, ls)
        combos.add((c["player_id"], c.get("sport_ref_id") or "", c.get("espn_id") or "",
                     ls, season_inj, c.get("position", "")))
        if season_ret != season_inj:
            combos.add((c["player_id"], c.get("sport_ref_id") or "", c.get("espn_id") or "",
                         ls, season_ret, c.get("position", "")))

    # Check which we already have in game_logs
    already_scraped = set()
    for pid, ref_id, espn_id, ls, season, _ in combos:
        existing = sb_get("back_in_play_player_game_logs",
                          f"select=id&player_id=eq.{pid}&season=eq.{season}&limit=1")
        if existing:
            already_scraped.add((pid, season))

    to_scrape = [(pid, ref_id, espn_id, ls, season, pos)
                 for pid, ref_id, espn_id, ls, season, pos in combos
                 if (pid, season) not in already_scraped]

    print(f"  {len(to_scrape)} player-seasons to scrape ({len(already_scraped)} cached)", flush=True)
    scraped = 0

    for i, (pid, ref_id, espn_id, ls, season, position) in enumerate(sorted(to_scrape)):
        game_rows = []
        source = ""
        is_pitcher = position and position.lower() in ("pitcher", "sp", "rp", "starting pitcher", "relief pitcher", "p")

        # Try *-Reference first (if we have the ID)
        if ref_id:
            scraper = SCRAPERS.get(ls)
            if scraper:
                if ls == "mlb":
                    game_rows = scraper(ref_id, season, is_pitcher=is_pitcher)
                else:
                    game_rows = scraper(ref_id, season)
                if game_rows:
                    source = "ref"

        # Fallback to ESPN API
        if not game_rows and espn_id:
            espn_scraper = ESPN_SCRAPERS.get(ls)
            if espn_scraper:
                if ls == "mlb":
                    game_rows = espn_scraper(espn_id, season, is_pitcher=is_pitcher)
                else:
                    game_rows = espn_scraper(espn_id, season)
                if game_rows:
                    source = "espn"

        # EPL fallback: FPL CSV (uses player_name, works 2016-2024)
        if not game_rows and ls == "premier-league" and 2016 <= season <= 2024:
            pname = player_names.get(pid, "")
            if pname:
                game_rows = fpl_scrape_epl(pname, season)
                if game_rows:
                    source = "fpl"

        if not game_rows:
            label = ref_id or espn_id or pid
            print(f"    [{i + 1}/{len(to_scrape)}] {label} {season} → 0 games", flush=True)
            continue

        # Convert to DB rows
        db_rows = []
        for gr in game_rows:
            gd = gr.get("game_date", "")
            # Normalize date format
            try:
                if len(gd) == 10:  # YYYY-MM-DD
                    pass
                elif "," in gd:  # "Apr 5, 2024"
                    gd = datetime.strptime(gd, "%b %d, %Y").strftime("%Y-%m-%d")
                elif " " in gd:  # "2024-04-05" or other
                    gd = datetime.strptime(gd.strip(), "%Y-%m-%d").strftime("%Y-%m-%d")
            except (ValueError, TypeError):
                continue

            db_row = {
                "player_id": pid,
                "league_slug": ls,
                "season": season,
                "game_date": gd,
                "opponent": gr.get("opponent", ""),
                "started": gr.get("started", False),
                "minutes": gr.get("minutes"),
            }
            # Copy all stat fields
            for k, v in gr.items():
                if k.startswith("stat_") and v is not None:
                    db_row[k] = v

            # Compute composite
            db_row["composite"] = compute_composite(db_row, ls)
            db_rows.append(db_row)

        n = sb_upsert("back_in_play_player_game_logs", db_rows, conflict="player_id,game_date")
        scraped += n
        label = ref_id or espn_id or pid
        print(f"    [{i + 1}/{len(to_scrape)}] {label} {season} → {len(db_rows)} games [{source}]", flush=True)

    print(f"  Scraped {scraped} total game log entries", flush=True)
    return scraped


def phase_4_compute(cases, league=None):
    """Compute baselines and post-return metrics for each return case."""
    processed = 0
    audited = 0

    for c in cases:
        if not c.get("sport_ref_id"):
            continue
        ls = c["league_slug"]
        if league and ls != league:
            continue

        try:
            d_injured = datetime.strptime(c["date_injured"], "%Y-%m-%d").date()
            d_return = datetime.strptime(c["return_date"], "%Y-%m-%d").date()
        except (ValueError, TypeError):
            continue

        # Get all game logs for this player across relevant seasons
        season_inj = _season_for_date(d_injured, ls)
        season_ret = _season_for_date(d_return, ls)
        seasons_str = f"{season_inj}" if season_inj == season_ret else f"{season_inj},{season_ret}"

        logs = sb_get("back_in_play_player_game_logs",
                      f"select=game_date,composite,minutes&player_id=eq.{c['player_id']}&season=in.({seasons_str})&order=game_date.asc")
        if not logs:
            continue

        # Parse dates and sort
        parsed = []
        for lg in logs:
            try:
                gd = datetime.strptime(lg["game_date"], "%Y-%m-%d").date()
                comp = lg.get("composite")
                if comp is not None:
                    parsed.append({"date": gd, "composite": float(comp), "minutes": lg.get("minutes")})
            except (ValueError, TypeError):
                continue

        parsed.sort(key=lambda x: x["date"])

        # Split into pre-injury and post-return
        pre_games = [g for g in parsed if g["date"] < d_injured]
        post_games = [g for g in parsed if g["date"] >= d_return]

        # Audit: count actual games missed
        games_during_injury = [g for g in parsed if d_injured <= g["date"] < d_return]
        # Games missed = team games during absence (approximated by games in log during that period should be 0)
        # Actually, game logs only show games the player appeared in
        # So games_missed_actual = count of team games during injury period
        # We approximate by: (return_date - date_injured).days / avg_game_frequency
        actual_recovery = (d_return - d_injured).days

        # Audit recovery_days
        if c.get("recovery_days") and abs(c["recovery_days"] - actual_recovery) > 1:
            sb_patch("back_in_play_injuries",
                     f"injury_id=eq.{c['injury_id']}",
                     {"recovery_days": actual_recovery})
            audited += 1

        if len(pre_games) < 3:
            continue  # Not enough baseline data

        # Recent baseline (last 5 games)
        recent_5 = pre_games[-5:]
        pre_baseline_5g = statistics.mean(g["composite"] for g in recent_5)

        # Season baseline
        season_games = [g for g in pre_games if _season_for_date(g["date"], ls) == season_inj]
        pre_baseline_season = statistics.mean(g["composite"] for g in season_games) if season_games else pre_baseline_5g

        # Post-return: first 10 games
        post_10 = post_games[:10]
        post_composites = []
        pre_avg_min = statistics.mean(g["minutes"] for g in pre_games if g["minutes"]) if any(g["minutes"] for g in pre_games) else None

        for idx, g in enumerate(post_10):
            entry = {
                "game_num": idx + 1,
                "game_date": g["date"].isoformat(),
                "composite": g["composite"],
            }
            if pre_avg_min and g["minutes"]:
                entry["minutes_pct"] = round(g["minutes"] / pre_avg_min, 3)
            post_composites.append(entry)

        # Rest-of-season (all post-return games in same season)
        rest_games = [g for g in post_games if _season_for_date(g["date"], ls) == season_ret]
        rest_avg = statistics.mean(g["composite"] for g in rest_games) if rest_games else None

        # Build return case row
        case_row = {
            "injury_id": c["injury_id"],
            "player_id": c["player_id"],
            "league_slug": ls,
            "position": c.get("position", ""),
            "injury_type": c["injury_type"],
            "injury_type_slug": c.get("injury_type_slug", ""),
            "date_injured": c["date_injured"],
            "return_date": c["return_date"],
            "games_missed": c.get("games_missed"),
            "games_missed_actual": len(games_during_injury) if games_during_injury else c.get("games_missed"),
            "recovery_days": actual_recovery,
            "pre_baseline_5g": round(pre_baseline_5g, 2),
            "pre_baseline_season": round(pre_baseline_season, 2),
            "post_games_count": len(post_composites),
            "post_game_composites": json.dumps(post_composites),
            "rest_of_season_avg": round(rest_avg, 2) if rest_avg else None,
            "rest_of_season_games": len(rest_games),
        }

        sb_upsert("back_in_play_injury_return_cases", [case_row], conflict="injury_id")
        processed += 1

    print(f"  Computed {processed} return cases, audited {audited} recovery_days", flush=True)
    return processed


def phase_5_aggregate(league=None):
    """Aggregate return cases into performance curves by league + injury type."""
    params = "select=*"
    if league:
        params += f"&league_slug=eq.{league}"
    params += "&limit=10000"

    cases = sb_get("back_in_play_injury_return_cases", params)
    if not cases:
        print("  No return cases to aggregate", flush=True)
        return

    # Group by (league_slug, injury_type_slug)
    groups = {}
    for c in cases:
        key = (c["league_slug"], c["injury_type_slug"])
        groups.setdefault(key, []).append(c)

    curves = []
    for (ls, its), group_cases in groups.items():
        if len(group_cases) < 3:
            continue  # Not enough samples

        # Collect per-game-number data
        game_data = {i: [] for i in range(1, 11)}
        game_min_data = {i: [] for i in range(1, 11)}
        season_data = {i: [] for i in range(1, 11)}

        for c in group_cases:
            baseline_5g = c.get("pre_baseline_5g")
            baseline_season = c.get("pre_baseline_season")
            if not baseline_5g or baseline_5g == 0:
                continue

            composites = json.loads(c["post_game_composites"]) if isinstance(c["post_game_composites"], str) else (c["post_game_composites"] or [])

            for entry in composites:
                gn = entry.get("game_num", 0)
                comp = entry.get("composite", 0)
                if 1 <= gn <= 10 and baseline_5g > 0:
                    pct = comp / baseline_5g
                    game_data[gn].append(pct)
                    if entry.get("minutes_pct"):
                        game_min_data[gn].append(entry["minutes_pct"])
                    if baseline_season and baseline_season > 0:
                        season_data[gn].append(comp / baseline_season)

        # Build arrays
        avg_pct_recent = []
        median_pct_recent = []
        p25_pct_recent = []
        p75_pct_recent = []
        stddev_pct_recent = []
        stderr_pct_recent = []
        avg_pct_season = []
        avg_minutes_pct = []

        for gn in range(1, 11):
            vals = game_data[gn]
            if vals:
                avg_pct_recent.append(round(statistics.mean(vals), 4))
                median_pct_recent.append(round(statistics.median(vals), 4))
                sorted_vals = sorted(vals)
                n = len(sorted_vals)
                p25_pct_recent.append(round(sorted_vals[max(0, n // 4 - 1)], 4))
                p75_pct_recent.append(round(sorted_vals[min(n - 1, 3 * n // 4)], 4))
                sd = statistics.stdev(vals) if len(vals) > 1 else 0
                stddev_pct_recent.append(round(sd, 4))
                stderr_pct_recent.append(round(sd / math.sqrt(n), 4))
            else:
                avg_pct_recent.append(None)
                median_pct_recent.append(None)
                p25_pct_recent.append(None)
                p75_pct_recent.append(None)
                stddev_pct_recent.append(None)
                stderr_pct_recent.append(None)

            s_vals = season_data[gn]
            avg_pct_season.append(round(statistics.mean(s_vals), 4) if s_vals else None)

            m_vals = game_min_data[gn]
            avg_minutes_pct.append(round(statistics.mean(m_vals), 4) if m_vals else None)

        # Rest-of-season aggregates
        ros_recent = [c["rest_of_season_avg"] / c["pre_baseline_5g"]
                      for c in group_cases
                      if c.get("rest_of_season_avg") and c.get("pre_baseline_5g") and c["pre_baseline_5g"] > 0]
        ros_season = [c["rest_of_season_avg"] / c["pre_baseline_season"]
                      for c in group_cases
                      if c.get("rest_of_season_avg") and c.get("pre_baseline_season") and c["pre_baseline_season"] > 0]

        # Estimate games-to-full: linear fit on median curve
        games_to_full = None
        valid_medians = [(gn, v) for gn, v in enumerate(median_pct_recent, 1) if v is not None]
        if len(valid_medians) >= 3:
            last_v = valid_medians[-1][1]
            if last_v < 1.0:
                # Simple linear extrapolation from last two points
                g1, v1 = valid_medians[-2]
                g2, v2 = valid_medians[-1]
                if v2 > v1:
                    slope = (v2 - v1) / (g2 - g1)
                    games_to_full = round(g2 + (1.0 - v2) / slope, 1)

        games_missed_values = [c["games_missed"] for c in group_cases if c.get("games_missed")]
        recovery_values = [c["recovery_days"] for c in group_cases if c.get("recovery_days")]

        curve = {
            "league_slug": ls,
            "injury_type_slug": its,
            "injury_type": group_cases[0]["injury_type"],
            "sample_size": len(group_cases),
            "games_missed_avg": round(statistics.mean(games_missed_values), 1) if games_missed_values else None,
            "recovery_days_avg": round(statistics.mean(recovery_values), 1) if recovery_values else None,
            "avg_pct_recent": json.dumps(avg_pct_recent),
            "avg_pct_season": json.dumps(avg_pct_season),
            "median_pct_recent": json.dumps(median_pct_recent),
            "p25_pct_recent": json.dumps(p25_pct_recent),
            "p75_pct_recent": json.dumps(p75_pct_recent),
            "avg_minutes_pct": json.dumps(avg_minutes_pct),
            "stddev_pct_recent": json.dumps(stddev_pct_recent),
            "stderr_pct_recent": json.dumps(stderr_pct_recent),
            "rest_of_season_pct_recent": round(statistics.mean(ros_recent), 4) if ros_recent else None,
            "rest_of_season_pct_season": round(statistics.mean(ros_season), 4) if ros_season else None,
            "rest_of_season_sample": len(ros_recent),
            "games_to_full": games_to_full,
        }
        curves.append(curve)

    n = sb_upsert("back_in_play_performance_curves", curves, conflict="league_slug,injury_type_slug")
    print(f"  Aggregated {n} performance curves from {len(cases)} cases", flush=True)


# ─── Main ─────────────────────────────────────────────────────────────────────

def run_pipeline(mode, league=None, phase=None):
    """Run the full pipeline or a single phase."""
    start = datetime.utcnow()
    print(f"\n{'=' * 60}")
    print(f"Performance Curves Pipeline — {mode.upper()}")
    if league:
        print(f"League: {league}")
    print(f"Time: {start.strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"{'=' * 60}\n")

    # Record pipeline run
    run_row = {"run_type": mode, "league_slug": league, "status": "running"}
    runs = sb_upsert("back_in_play_pipeline_runs", [run_row])

    # Determine since_date for incremental mode
    since_date = None
    if mode == "incremental":
        last_runs = sb_get("back_in_play_pipeline_runs",
                           "select=finished_at&status=eq.completed&order=finished_at.desc&limit=1")
        if last_runs and last_runs[0].get("finished_at"):
            since_date = last_runs[0]["finished_at"][:10]
        else:
            # Default to last 30 days
            since_date = (date.today() - timedelta(days=30)).isoformat()
        print(f"Incremental since: {since_date}\n")

    errors = []

    try:
        # Phase 1: Get return cases
        if not phase or phase in ("all", "resolve-ids", "scrape-logs", "compute"):
            print("[1/5] Identifying return cases...")
            cases = phase_1_get_return_cases(league=league, since_date=since_date)
            print(f"  Found {len(cases)} return cases\n")
        else:
            cases = phase_1_get_return_cases(league=league, since_date=since_date)

        if not cases:
            print("No cases to process. Done.")
            return

        # Phase 2: Resolve IDs
        if not phase or phase in ("all", "resolve-ids"):
            print("[2/5] Resolving sport-reference IDs...")
            phase_2_resolve_ids(cases, league=league)
            print()

        # Phase 3: Scrape game logs
        if not phase or phase in ("all", "scrape-logs"):
            print("[3/5] Scraping game logs...")
            phase_3_scrape_logs(cases, league=league)
            print()

        # Phase 4: Compute baselines + post-return
        if not phase or phase in ("all", "compute"):
            print("[4/5] Computing baselines and post-return metrics...")
            n = phase_4_compute(cases, league=league)
            print()

        # Phase 5: Aggregate curves
        if not phase or phase in ("all", "aggregate"):
            print("[5/5] Aggregating performance curves...")
            phase_5_aggregate(league=league)
            print()

    except Exception as e:
        errors.append(str(e))
        print(f"\nERROR: {e}", flush=True)
        import traceback
        traceback.print_exc()

    elapsed = (datetime.utcnow() - start).total_seconds()
    print(f"\nDone in {elapsed:.1f}s")

    # Update pipeline run
    sb_patch("back_in_play_pipeline_runs",
             f"status=eq.running&run_type=eq.{mode}",
             {"status": "failed" if errors else "completed",
              "finished_at": datetime.utcnow().isoformat(),
              "cases_processed": len(cases),
              "errors": json.dumps(errors)})


def main():
    parser = argparse.ArgumentParser(description="Post-injury performance curves pipeline")
    parser.add_argument("--backfill", action="store_true", help="Full historical backfill")
    parser.add_argument("--incremental", action="store_true", help="Incremental (daily cron)")
    parser.add_argument("--audit", action="store_true",
                        help="Audit injuries: discover returns and season-ending from game logs")
    parser.add_argument("--classify", action="store_true",
                        help="Classify all injuries: normalize types, extract subtypes and side")
    parser.add_argument("--enrich", action="store_true",
                        help="Enrich injury history: prior injuries, recurrence, days between")
    parser.add_argument("--fpl-store", action="store_true",
                        help="Bulk download and store all current season EPL game logs from FPL API")
    parser.add_argument("--league", type=str, help="Process single league (nba, nfl, nhl, mlb, premier-league)")
    parser.add_argument("--phase", type=str, choices=["resolve-ids", "scrape-logs", "compute", "aggregate"],
                        help="Run single phase")
    args = parser.parse_args()

    if args.classify:
        print(f"\n{'=' * 60}")
        print(f"Injury Classification — Normalize Types & Extract Subtypes")
        print(f"{'=' * 60}\n")
        classify_all_injuries()
        return

    if args.enrich:
        print(f"\n{'=' * 60}")
        print(f"Injury History Enrichment")
        print(f"{'=' * 60}\n")
        enrich_injury_history()
        return

    if args.fpl_store:
        print(f"\n{'=' * 60}")
        print(f"FPL Bulk Store — Current Season EPL Game Logs")
        print(f"{'=' * 60}\n")
        fpl_bulk_store()
        return

    if args.audit:
        print(f"\n{'=' * 60}")
        print(f"Injury Audit Mode")
        if args.league:
            print(f"League: {args.league}")
        print(f"{'=' * 60}\n")
        n = audit_returns(league=args.league)
        if n:
            print(f"\nRe-run with --backfill to compute curves for newly discovered returns.")
        return

    if not args.backfill and not args.incremental and not args.phase and not args.fpl_store:
        parser.print_help()
        sys.exit(1)

    mode = "backfill" if args.backfill else ("incremental" if args.incremental else "phase")
    run_pipeline(mode, league=args.league, phase=args.phase)


if __name__ == "__main__":
    main()
