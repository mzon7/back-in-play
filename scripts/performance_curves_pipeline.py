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
    Tries *-Reference first, falls back to ESPN API if that fails (403, no data, no sport_ref_id).
    """
    # Collect unique (player_id, sport_ref_id, espn_id, league, season, position) combos
    combos = set()
    for c in cases:
        # Need either sport_ref_id or espn_id
        if not c.get("sport_ref_id") and not c.get("espn_id"):
            continue
        ls = c["league_slug"]
        if league and ls != league:
            continue

        try:
            d_injured = datetime.strptime(c["date_injured"], "%Y-%m-%d").date()
            d_return = datetime.strptime(c["return_date"], "%Y-%m-%d").date()
        except (ValueError, TypeError):
            continue

        season_inj = _season_for_date(d_injured, ls)
        season_ret = _season_for_date(d_return, ls)
        combos.add((c["player_id"], c.get("sport_ref_id", ""), c.get("espn_id", ""),
                     ls, season_inj, c.get("position", "")))
        if season_ret != season_inj:
            combos.add((c["player_id"], c.get("sport_ref_id", ""), c.get("espn_id", ""),
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
    parser.add_argument("--league", type=str, help="Process single league (nba, nfl, nhl, mlb, premier-league)")
    parser.add_argument("--phase", type=str, choices=["resolve-ids", "scrape-logs", "compute", "aggregate"],
                        help="Run single phase")
    args = parser.parse_args()

    if not args.backfill and not args.incremental and not args.phase:
        parser.print_help()
        sys.exit(1)

    mode = "backfill" if args.backfill else ("incremental" if args.incremental else "phase")
    run_pipeline(mode, league=args.league, phase=args.phase)


if __name__ == "__main__":
    main()
