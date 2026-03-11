#!/usr/bin/env python3
"""
Back In Play — Player Minutes Calculator
==========================================
1. For injured players missing pre_injury_avg_minutes, fetch ESPN season averages.
2. For returned players (active_today, back_in_play, reduced_load), fetch their
   last 7 days of game logs and compare to pre-injury average.
   - >= 80% → back_in_play
   - <  80% → reduced_load
3. After 7 days on reduced_load with no new injury → cleared

Usage:
  python3 compute_player_minutes.py --once       # single pass
  python3 compute_player_minutes.py --watch      # every 5 min
  python3 compute_player_minutes.py --backfill   # fill pre_injury_avg for all players
"""

import json, os, re, sys, time, urllib.request, urllib.error
from datetime import date, datetime, timedelta
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

USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

# ESPN sport/league config
LEAGUE_CFG = {
    "nba":            {"sport": "basketball", "league": "nba",   "min_label": "MIN"},
    "nhl":            {"sport": "hockey",     "league": "nhl",   "min_label": "TOI"},
    "nfl":            {"sport": "football",   "league": "nfl",   "min_label": None},
    "mlb":            {"sport": "baseball",   "league": "mlb",   "min_label": None},
    "premier-league": {"sport": "soccer",     "league": "eng.1", "min_label": "MIN"},
}


# -- HTTP helpers -------------------------------------------------------------
def fetch_json(url, timeout=15):
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            resp = urllib.request.urlopen(req, timeout=timeout)
            return json.loads(resp.read().decode())
        except Exception as e:
            if attempt < 2:
                time.sleep(2 ** attempt)
            else:
                return None
    return None


def sb_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


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


def sb_patch(table, filter_params, body):
    url = SUPABASE_URL + "/rest/v1/" + table + "?" + filter_params
    data = json.dumps(body).encode()
    try:
        req = urllib.request.Request(url, data=data, headers=sb_headers(), method="PATCH")
        urllib.request.urlopen(req, timeout=30)
        return True
    except Exception as e:
        print("    [PATCH err] %s: %s" % (table, e), flush=True)
        return False


def parse_minutes(val):
    """Parse minutes string: '34', '20:24' (MM:SS), etc."""
    if not val or val in ("--", "DNP", "0"):
        return 0.0
    m = re.match(r"(\d+):(\d+)", str(val))
    if m:
        return int(m.group(1)) + int(m.group(2)) / 60.0
    try:
        return float(val)
    except (ValueError, TypeError):
        return 0.0


# -- Get league slug for a team -----------------------------------------------
_team_league_cache = {}

def get_league_slug_for_team(team_id):
    if not _team_league_cache:
        teams = sb_get("back_in_play_teams", "select=team_id,league_id")
        leagues = sb_get("back_in_play_leagues", "select=league_id,slug")
        league_map = {l["league_id"]: l["slug"] for l in leagues}
        for t in teams:
            _team_league_cache[t["team_id"]] = league_map.get(t["league_id"], "")
    return _team_league_cache.get(team_id, "")


# -- Fetch ESPN season average minutes ----------------------------------------
def fetch_season_avg_minutes(espn_id, sport, league):
    """Fetch season average minutes for a player from ESPN."""
    url = ("https://site.api.espn.com/apis/common/v3/sports/"
           "%s/%s/athletes/%s/stats" % (sport, league, espn_id))
    data = fetch_json(url)
    if not data:
        return None

    for cat in data.get("categories", []):
        if cat.get("name") == "averages":
            labels = cat.get("labels", [])
            min_label = "MIN" if "MIN" in labels else ("TOI" if "TOI" in labels else None)
            if not min_label:
                return None
            min_idx = labels.index(min_label)
            stats_list = cat.get("statistics", cat.get("stats", []))
            if isinstance(stats_list, list) and stats_list:
                first = stats_list[0]
                if isinstance(first, dict):
                    vals = first.get("stats", first.get("values", []))
                elif isinstance(first, str):
                    vals = stats_list
                else:
                    continue
                if min_idx < len(vals):
                    return parse_minutes(vals[min_idx])
    return None


# -- Fetch recent game log minutes -------------------------------------------
def fetch_recent_game_minutes(espn_id, sport, league, days=7):
    """Fetch game minutes from the last N days from ESPN game log."""
    url = ("https://site.api.espn.com/apis/common/v3/sports/"
           "%s/%s/athletes/%s/gamelog" % (sport, league, espn_id))
    data = fetch_json(url)
    if not data:
        return []

    labels = data.get("labels", data.get("names", []))
    min_label = "MIN" if "MIN" in labels else ("TOI" if "TOI" in labels else None)
    min_idx = labels.index(min_label) if min_label and min_label in labels else None

    cutoff = datetime.utcnow() - timedelta(days=days)
    games = []

    # Events can be dict (keyed by event ID) or in seasonTypes
    events = data.get("events", {})
    if isinstance(events, dict):
        for eid, ev in events.items():
            gdate = ev.get("gameDate", "")
            if gdate:
                try:
                    dt = datetime.fromisoformat(gdate.replace("Z", "+00:00").replace("+00:00", ""))
                except ValueError:
                    dt = datetime.min
                if dt >= cutoff:
                    games.append(ev)

    # Also check seasonTypes for stats
    game_minutes = []
    for st in data.get("seasonTypes", []):
        for cat in st.get("categories", []):
            for ev in cat.get("events", []):
                eid = ev.get("eventId", "")
                stats = ev.get("stats", [])
                # Match with events dict for date
                event_info = events.get(eid, {}) if isinstance(events, dict) else {}
                gdate = event_info.get("gameDate", "")
                if gdate:
                    try:
                        dt = datetime.fromisoformat(gdate.replace("Z", "+00:00").replace("+00:00", ""))
                    except ValueError:
                        dt = datetime.min
                    if dt < cutoff:
                        continue
                if min_idx is not None and min_idx < len(stats):
                    mins = parse_minutes(stats[min_idx])
                    if mins > 0:
                        game_minutes.append(mins)

    return game_minutes


# -- Step 1: Backfill pre_injury_avg_minutes ----------------------------------
def backfill_pre_injury_averages():
    """Fill pre_injury_avg_minutes for players that have espn_id but no average."""
    players = sb_get(
        "back_in_play_players",
        "pre_injury_avg_minutes=is.null&espn_id=not.is.null&select=player_id,player_name,espn_id,team_id"
    )
    if not players:
        print("  No players need pre_injury_avg backfill", flush=True)
        return 0

    print("  %d players need pre_injury_avg_minutes" % len(players), flush=True)
    count = 0

    for p in players:
        espn_id = p.get("espn_id")
        if not espn_id:
            continue

        league_slug = get_league_slug_for_team(p["team_id"])
        cfg = LEAGUE_CFG.get(league_slug)
        if not cfg or not cfg["min_label"]:
            continue  # NFL/MLB don't have minutes

        avg = fetch_season_avg_minutes(espn_id, cfg["sport"], cfg["league"])
        if avg and avg > 0:
            sb_patch("back_in_play_players",
                     "player_id=eq.%s" % p["player_id"],
                     {"pre_injury_avg_minutes": round(avg, 1)})
            print("    %s: %.1f avg min" % (p["player_name"], avg), flush=True)
            count += 1
        else:
            print("    %s: no avg found (espn_id=%s)" % (p["player_name"], espn_id), flush=True)

        time.sleep(0.3)  # Rate limit

    print("  Updated %d players with pre_injury_avg" % count, flush=True)
    return count


# -- Step 2: Check returned players' recent games ----------------------------
def check_returned_players():
    """For players with status active_today/back_in_play/reduced_load,
    fetch their last 7 days of games and update status based on minutes."""
    cutoff = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")

    injuries = sb_get(
        "back_in_play_injuries",
        "status=in.(active_today,back_in_play,reduced_load,active)"
        "&return_date=not.is.null&return_date=gte.%s"
        "&select=injury_id,player_id,status,return_date,game_minutes" % cutoff
    )
    if not injuries:
        print("  No returned players to check", flush=True)
        return 0

    # Get player info
    player_ids = list(set(inj["player_id"] for inj in injuries))
    player_map = {}
    for ci in range(0, len(player_ids), 30):
        chunk = player_ids[ci:ci + 30]
        ids = ",".join(chunk)
        players = sb_get("back_in_play_players",
                         "player_id=in.(%s)&select=player_id,player_name,espn_id,team_id,pre_injury_avg_minutes" % ids)
        for p in (players or []):
            player_map[p["player_id"]] = p

    count = 0
    for inj in injuries:
        player = player_map.get(inj["player_id"])
        if not player:
            continue

        espn_id = player.get("espn_id")
        pre_avg = player.get("pre_injury_avg_minutes")
        if not espn_id or not pre_avg or pre_avg <= 0:
            continue

        league_slug = get_league_slug_for_team(player["team_id"])
        cfg = LEAGUE_CFG.get(league_slug)
        if not cfg or not cfg["min_label"]:
            continue

        # Fetch last 7 days of game logs
        recent_minutes = fetch_recent_game_minutes(
            espn_id, cfg["sport"], cfg["league"], days=7
        )

        if not recent_minutes:
            continue

        # Use latest game minutes
        latest_mins = recent_minutes[0]
        avg_recent = sum(recent_minutes) / len(recent_minutes)
        pct = (avg_recent / pre_avg) * 100

        if pct >= 80:
            new_status = "back_in_play"
        else:
            new_status = "reduced_load"

        if new_status != inj["status"]:
            old_status = inj["status"]
            sb_patch("back_in_play_injuries",
                     "injury_id=eq.%s" % inj["injury_id"],
                     {"status": new_status, "game_minutes": round(latest_mins, 1)})

            # Log status change
            try:
                change_data = json.dumps([{
                    "player_id": inj["player_id"],
                    "injury_id": inj["injury_id"],
                    "old_status": old_status,
                    "new_status": new_status,
                    "change_type": "status_change",
                    "summary": "Full return" if new_status == "back_in_play" else "Minutes restriction (%.0f%%)" % pct,
                }]).encode()
                req = urllib.request.Request(
                    SUPABASE_URL + "/rest/v1/back_in_play_status_changes",
                    data=change_data, headers=sb_headers(), method="POST"
                )
                urllib.request.urlopen(req, timeout=10)
            except Exception:
                pass

            label = "BACK IN PLAY" if new_status == "back_in_play" else "REDUCED LOAD"
            print("    %s %s: %.0f min avg (%.0f%% of %.0f pre-injury) → %s" % (
                label, player["player_name"], avg_recent, pct, pre_avg,
                new_status), flush=True)
            count += 1
        else:
            # Update game_minutes even if status unchanged
            sb_patch("back_in_play_injuries",
                     "injury_id=eq.%s" % inj["injury_id"],
                     {"game_minutes": round(latest_mins, 1)})

        time.sleep(0.3)

    print("  Updated %d returned player statuses" % count, flush=True)
    return count


# -- Main ---------------------------------------------------------------------
def run_once(backfill=False):
    print("  [1/2] Backfilling pre-injury averages...", flush=True)
    backfill_pre_injury_averages()

    print("  [2/2] Checking returned player minutes...", flush=True)
    check_returned_players()


def main():
    args = [a.lower() for a in sys.argv[1:]]
    watch = "--watch" in args
    backfill_only = "--backfill" in args

    interval = 5  # minutes
    if "--interval" in args:
        idx = args.index("--interval")
        if idx + 1 < len(args) and args[idx + 1].isdigit():
            interval = int(args[idx + 1])

    print("=" * 60, flush=True)
    print("Back In Play — Player Minutes Calculator", flush=True)
    print("Date: %s" % date.today().isoformat(), flush=True)
    print("Mode: %s" % ("WATCH every %dm" % interval if watch else "ONCE"), flush=True)
    print("=" * 60, flush=True)

    if backfill_only:
        backfill_pre_injury_averages()
        return

    if watch:
        run_count = 0
        while True:
            run_count += 1
            ts = datetime.now().strftime("%H:%M:%S")
            print("\n>>> [%s] Check #%d" % (ts, run_count), flush=True)
            try:
                run_once()
            except Exception as e:
                print("  [ERROR] %s" % e, flush=True)
            time.sleep(interval * 60)
    else:
        run_once()


if __name__ == "__main__":
    main()
