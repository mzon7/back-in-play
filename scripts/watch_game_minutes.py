#!/usr/bin/env python3
"""
Back In Play — Game Minutes Watcher
=====================================
Monitors ESPN live scoreboards to detect when injured players return to action.

Flow:
  1. Check scoreboard for each league — find games in progress or recently finished
  2. For each game, pull box score and check if any injured player has minutes > 0
  3. During game  → status = "active_today" (shown in "Back In Play Today!" section)
  4. After game   → compare minutes to pre-injury average:
     - >= 80% of usual → status = "back_in_play"
     - <  80% of usual → status = "reduced_load" (with actual vs usual minutes)
  5. After 7 days on reduced_load with no new injury → status = "cleared" (removed from site)

Usage:
  python3 watch_game_minutes.py --watch              # continuous (every 1 min during games)
  python3 watch_game_minutes.py --watch --interval 2  # every 2 min
  python3 watch_game_minutes.py --once                # single check
  python3 watch_game_minutes.py --clear-stale         # clear old reduced_load entries

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
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

MAX_RETRIES = 3
USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

REDUCED_LOAD_CLEAR_DAYS = 7  # days on reduced_load before auto-clearing


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


# -- HTTP fetch ---------------------------------------------------------------
def fetch_json(url, timeout=15):
    hdrs = {"User-Agent": USER_AGENT}
    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(url, headers=hdrs)
            resp = urllib.request.urlopen(req, timeout=timeout)
            return json.loads(resp.read().decode())
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                time.sleep(2 ** attempt)
            else:
                return None
    return None


# -- Slugify ------------------------------------------------------------------
def slugify(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


# -- League config ------------------------------------------------------------
LEAGUES = {
    "nba": {"sport": "basketball", "league": "nba",   "name": "NBA",            "slug": "nba",             "min_label": "MIN",  "min_index": 0},
    "nhl": {"sport": "hockey",     "league": "nhl",   "name": "NHL",            "slug": "nhl",             "min_label": "TOI",  "min_index": 4},
    "nfl": {"sport": "football",   "league": "nfl",   "name": "NFL",            "slug": "nfl",             "min_label": None,   "min_index": None},  # presence-based
    "mlb": {"sport": "baseball",   "league": "mlb",   "name": "MLB",            "slug": "mlb",             "min_label": None,   "min_index": None},  # presence-based
    "epl": {"sport": "soccer",     "league": "eng.1", "name": "Premier League",  "slug": "premier-league", "min_label": "MIN",  "min_index": None},  # check dynamically
}


# -- Parse minutes string to float -------------------------------------------
def parse_minutes(val):
    """Parse minutes string to float. Handles '21', '20:24' (MM:SS), etc."""
    if not val or val == "--" or val == "DNP":
        return 0.0
    # MM:SS format (NHL TOI)
    m = re.match(r"(\d+):(\d+)", str(val))
    if m:
        return int(m.group(1)) + int(m.group(2)) / 60.0
    # Plain number
    try:
        return float(val)
    except (ValueError, TypeError):
        return 0.0


# -- Load injured player lookup -----------------------------------------------
def load_injured_players():
    """Load all currently injured players (status not in active/cleared/back_in_play)
    and build a lookup by player slug -> injury info."""
    # Get players with open injuries
    cutoff = (datetime.now() - timedelta(days=90)).strftime("%Y-%m-%d")
    injuries = sb_get(
        "back_in_play_injuries",
        "status=neq.cleared&date_injured=gte.%s"
        "&select=injury_id,player_id,status,date_injured,injury_type,return_date" % cutoff
    )
    if not injuries:
        return {}, {}

    # Get player details
    player_ids = list(set(inj["player_id"] for inj in injuries))
    player_map = {}  # player_id -> {name, slug, pre_injury_avg_minutes, ...}

    for ci in range(0, len(player_ids), 30):
        chunk = player_ids[ci:ci + 30]
        ids = ",".join(chunk)
        players = sb_get("back_in_play_players",
                         "player_id=in.(%s)&select=player_id,player_name,slug,position,team_id,pre_injury_avg_minutes" % ids)
        for p in (players or []):
            player_map[p["player_id"]] = p

    # Build slug -> injury lookup
    slug_to_injury = {}  # slug -> {injury_id, player_id, status, pre_injury_avg_minutes}
    for inj in injuries:
        player = player_map.get(inj["player_id"])
        if not player:
            continue
        slug = player.get("slug", "")
        if not slug:
            continue
        slug_to_injury[slug] = {
            "injury_id": inj["injury_id"],
            "player_id": inj["player_id"],
            "player_name": player.get("player_name", ""),
            "status": inj["status"],
            "pre_injury_avg_minutes": player.get("pre_injury_avg_minutes"),
        }

    return slug_to_injury, player_map


# -- Check scoreboard for a league -------------------------------------------
def check_league_games(league_key, slug_to_injury):
    """Check today's games for a league. Return list of player updates."""
    cfg = LEAGUES[league_key]
    url = ("https://site.api.espn.com/apis/site/v2/sports/"
           "%s/%s/scoreboard" % (cfg["sport"], cfg["league"]))

    data = fetch_json(url)
    if not data:
        return []

    events = data.get("events", [])
    if not events:
        return []

    updates = []

    for event in events:
        state = event.get("status", {}).get("type", {}).get("state", "")
        eid = event.get("id", "")

        if state == "pre":
            continue  # Game hasn't started

        # Fetch box score
        summary_url = ("https://site.api.espn.com/apis/site/v2/sports/"
                       "%s/%s/summary?event=%s" % (cfg["sport"], cfg["league"], eid))
        box_data = fetch_json(summary_url)
        if not box_data:
            continue

        boxscore = box_data.get("boxscore", {})
        player_groups = boxscore.get("players", [])

        for team_group in player_groups:
            stat_groups = team_group.get("statistics", [])

            for stat_group in stat_groups:
                labels = stat_group.get("labels", [])

                # Find minutes index
                min_idx = None
                if cfg["min_label"] and cfg["min_label"] in labels:
                    min_idx = labels.index(cfg["min_label"])
                elif "MIN" in labels:
                    min_idx = labels.index("MIN")
                elif "TOI" in labels:
                    min_idx = labels.index("TOI")
                # For NFL/MLB: no minutes, just check presence

                athletes = stat_group.get("athletes", [])
                for athlete_entry in athletes:
                    athlete = athlete_entry.get("athlete", {})
                    aname = athlete.get("displayName", "")
                    if not aname:
                        continue

                    aslug = slugify(aname)
                    if aslug not in slug_to_injury:
                        continue

                    # This player is on our injured list and appeared in a box score!
                    inj_info = slug_to_injury[aslug]
                    stats = athlete_entry.get("stats", [])

                    game_minutes = 0.0
                    if min_idx is not None and min_idx < len(stats):
                        game_minutes = parse_minutes(stats[min_idx])
                    elif stats:
                        # For NFL/MLB: player appeared = they played
                        # Use 1.0 as a flag that they were active
                        game_minutes = 1.0

                    if game_minutes > 0:
                        is_live = (state == "in")
                        is_final = (state == "post")

                        updates.append({
                            "player_slug": aslug,
                            "player_name": aname,
                            "player_id": inj_info["player_id"],
                            "injury_id": inj_info["injury_id"],
                            "old_status": inj_info["status"],
                            "game_minutes": round(game_minutes, 1),
                            "pre_injury_avg": inj_info.get("pre_injury_avg_minutes"),
                            "is_live": is_live,
                            "is_final": is_final,
                            "event_id": eid,
                            "league": league_key,
                        })

        time.sleep(0.3)  # Rate limit between events

    return updates


# -- Process updates ----------------------------------------------------------
def process_updates(updates):
    """Apply status changes to Supabase based on game minutes."""
    today = date.today().isoformat()

    for u in updates:
        pid = u["player_id"]
        iid = u["injury_id"]
        old_status = u["old_status"]
        minutes = u["game_minutes"]
        pre_avg = u["pre_injury_avg"]

        if u["is_live"]:
            # Game in progress → "active_today"
            if old_status != "active_today":
                print("  ★ PLAYING NOW: %s — %s min so far (%s)" % (
                    u["player_name"], minutes, u["league"].upper()), flush=True)
                sb_request("PATCH",
                           "back_in_play_injuries?injury_id=eq.%s" % iid,
                           {"status": "active_today", "return_date": today,
                            "game_minutes": minutes})

        elif u["is_final"]:
            # Game finished → determine back_in_play vs reduced_load
            if pre_avg and pre_avg > 0:
                pct = (minutes / pre_avg) * 100
                if pct >= 80:
                    new_status = "back_in_play"
                    print("  ✓ BACK IN PLAY: %s — %.0f min (%.0f%% of %.0f avg) (%s)" % (
                        u["player_name"], minutes, pct, pre_avg, u["league"].upper()), flush=True)
                else:
                    new_status = "reduced_load"
                    print("  ~ REDUCED LOAD: %s — %.0f min (%.0f%% of %.0f avg) (%s)" % (
                        u["player_name"], minutes, pct, pre_avg, u["league"].upper()), flush=True)
            else:
                # No pre-injury average — if they played, mark them back in play
                # (we can refine this later with actual avg data)
                new_status = "back_in_play"
                print("  ✓ BACK (no avg): %s — %.0f min (%s)" % (
                    u["player_name"], minutes, u["league"].upper()), flush=True)

            sb_request("PATCH",
                       "back_in_play_injuries?injury_id=eq.%s" % iid,
                       {"status": new_status, "return_date": today,
                        "game_minutes": minutes})


# -- Clear stale reduced_load entries -----------------------------------------
def clear_stale_reduced_load():
    """Clear players who have been on reduced_load for > 7 days with no new injury."""
    cutoff = (datetime.now() - timedelta(days=REDUCED_LOAD_CLEAR_DAYS)).strftime("%Y-%m-%d")

    stale = sb_get(
        "back_in_play_injuries",
        "status=eq.reduced_load&return_date=lt.%s&select=injury_id,player_id" % cutoff
    )
    if not stale:
        return 0

    count = 0
    for entry in stale:
        pid = entry["player_id"]
        iid = entry["injury_id"]

        # Check if player has a newer injury (don't clear if re-injured)
        newer = sb_get(
            "back_in_play_injuries",
            "player_id=eq.%s&date_injured=gt.%s&status=not.in.(cleared,reduced_load,back_in_play)"
            "&select=injury_id&limit=1" % (pid, cutoff)
        )
        if newer:
            continue  # Player re-injured, don't clear

        sb_request("PATCH",
                   "back_in_play_injuries?injury_id=eq.%s" % iid,
                   {"status": "cleared"})
        count += 1

    if count:
        print("  Cleared %d stale reduced_load entries" % count, flush=True)
    return count


# -- Main loop ----------------------------------------------------------------
def run_once():
    """Single check across all leagues."""
    slug_to_injury, player_map = load_injured_players()
    if not slug_to_injury:
        print("  No injured players to monitor", flush=True)
        return

    print("  Monitoring %d injured players" % len(slug_to_injury), flush=True)

    all_updates = []
    for league_key in LEAGUES:
        updates = check_league_games(league_key, slug_to_injury)
        all_updates.extend(updates)

    if all_updates:
        print("  %d players detected in games:" % len(all_updates), flush=True)
        process_updates(all_updates)
    else:
        print("  No injured players found in today's games", flush=True)

    # Clear stale entries once per run
    clear_stale_reduced_load()


def main():
    args = [a.lower() for a in sys.argv[1:]]

    watch = "--watch" in args
    once = "--once" in args or not watch
    clear_only = "--clear-stale" in args

    interval = 1  # default 1 minute for game monitoring
    if "--interval" in args:
        idx = args.index("--interval")
        if idx + 1 < len(args) and args[idx + 1].isdigit():
            interval = int(args[idx + 1])

    print("=" * 60, flush=True)
    print("Back In Play — Game Minutes Watcher", flush=True)
    print("Date: %s" % date.today().isoformat(), flush=True)
    print("Mode: %s" % ("WATCH every %dm" % interval if watch else "ONCE"), flush=True)
    print("=" * 60, flush=True)

    if clear_only:
        clear_stale_reduced_load()
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
