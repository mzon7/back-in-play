#!/usr/bin/env python3
"""
Scan Yahoo PIDs to build name→PID mapping for NFL/NHL/MLB.

Uses Yahoo Fantasy API direct player lookup (449.p.{pid}) to get player names.
Then matches to ESPN-discovered players to build the yahoo_map.

Usage:
  python3 scan_yahoo_pids.py --sport nfl --start 1 --end 40000
  python3 scan_yahoo_pids.py --sport nhl --start 1 --end 15000
  python3 scan_yahoo_pids.py --sport nfl --resume   # resume from last checkpoint
"""
import os, sys, json, time, argparse, requests, unicodedata
from collections import defaultdict

for f in ["/root/.daemon-env", ".env"]:
    if os.path.exists(f):
        with open(f) as fh:
            for line in fh:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

ESPN_CACHE = os.path.join(os.path.dirname(__file__), "..", "data", "espn_team_first_cache")

# Yahoo Fantasy API game keys (2024 season)
GAME_KEYS = {"nfl": "449", "nhl": "453", "mlb": "431", "nba": "442"}


def load_yahoo_creds():
    creds = json.load(open("/root/yahoo_creds.json"))
    return creds


def refresh_token(creds):
    rr = requests.post("https://api.login.yahoo.com/oauth2/get_token", data={
        "grant_type": "refresh_token",
        "refresh_token": creds["refresh_token"],
        "client_id": creds["consumer_key"],
        "client_secret": creds["consumer_secret"],
    }, timeout=10)
    if rr.status_code == 200:
        new = rr.json()
        creds["access_token"] = new["access_token"]
        creds["refresh_token"] = new.get("refresh_token", creds["refresh_token"])
        json.dump(creds, open("/root/yahoo_creds.json", "w"), indent=2)
        return True
    return False


def normalize_name(name):
    nfkd = unicodedata.normalize("NFKD", name)
    ascii_name = "".join(c for c in nfkd if not unicodedata.combining(c))
    n = ascii_name.lower().strip()
    for suffix in [" jr.", " sr.", " ii", " iii", " iv", " jr", " sr", "."]:
        n = n.replace(suffix, "")
    return n.strip()


def lookup_pid_page(sport, pid):
    """Look up a player by scraping their Yahoo sports page. Returns name or None."""
    import re
    url = f"https://sports.yahoo.com/{sport}/players/{pid}/"
    try:
        r = requests.get(url, timeout=10, headers={"User-Agent": "Mozilla/5.0"})
        if r.status_code == 200:
            title = re.search(r"<title>([^<]+)</title>", r.text)
            if title:
                t = title.group(1)
                # Title format: "Player Name (POS) Stats, News... | Yahoo Sports"
                name = t.split(" Stats")[0].split(" |")[0].split(" -")[0].strip()
                # Strip position in parentheses: "LeBron James (SF, PF)" -> "LeBron James"
                name = re.sub(r"\s*\([^)]+\)\s*$", "", name).strip()
                if name and name != "Yahoo Sports":
                    return name
        return None
    except:
        return None


def lookup_pid_api(game_key, pid, token):
    """Fallback: look up via Fantasy API direct lookup. Returns name or None."""
    import re
    url = f"https://fantasysports.yahooapis.com/fantasy/v2/players;player_keys={game_key}.p.{pid}?format=json"
    try:
        r = requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=10)
        if r.status_code == 200:
            names = re.findall(r'"full": "([^"]+)"', json.dumps(r.json()))
            return names[0] if names else None
        elif r.status_code == 401:
            return "TOKEN_EXPIRED"
    except:
        pass
    return None


def run(sport, start_pid, end_pid):
    game_key = GAME_KEYS.get(sport)
    if not game_key:
        print(f"Unknown sport: {sport}")
        return

    # Load ESPN players for matching
    import glob
    espn_players = {}  # name_normalized -> {espn_id, name, games}
    for f in sorted(glob.glob(f"{ESPN_CACHE}/summary_{sport}_*.json")):
        data = json.load(open(f))
        for eid, p in data.get("players", {}).items():
            norm = normalize_name(p["name"])
            if norm not in espn_players or p.get("total_games", 0) > espn_players[norm].get("games", 0):
                espn_players[norm] = {"espn_id": eid, "name": p["name"], "games": p.get("total_games", 0)}

    print(f"ESPN players: {len(espn_players)} unique names")

    # Load existing yahoo map
    map_file = f"{ESPN_CACHE}/yahoo_map_{sport}.json"
    yahoo_map = {}
    if os.path.exists(map_file):
        yahoo_map = json.load(open(map_file))
    already_mapped = set(yahoo_map.keys())
    print(f"Already mapped: {len(already_mapped)} players")

    # Checkpoint
    cp_file = f"{ESPN_CACHE}/pid_scan_checkpoint_{sport}.json"
    if os.path.exists(cp_file):
        cp = json.load(open(cp_file))
        if start_pid <= cp.get("last_pid", 0):
            start_pid = cp["last_pid"] + 1
            print(f"Resuming from PID {start_pid}")

    # Load creds for API fallback
    try:
        creds = load_yahoo_creds()
        token = creds["access_token"]
    except:
        creds = None
        token = None

    found = 0
    matched = 0
    scanned = 0
    consecutive_misses = 0
    MAX_CONSECUTIVE_MISSES = 2000  # stop after 2000 not-founds in a row
    pid_to_name = {}  # cache all found names

    print(f"\nScanning {sport} PIDs {start_pid} to {end_pid} (auto-stop after {MAX_CONSECUTIVE_MISSES} consecutive misses)...")
    print(f"  Primary: Yahoo sports page scraping")
    print(f"  Fallback: Fantasy API direct lookup")

    for pid in range(start_pid, end_pid + 1):
        # Primary: scrape Yahoo sports page
        name = lookup_pid_page(sport, pid)

        # Fallback: Fantasy API (if page scrape failed and we have creds)
        if not name and token:
            name = lookup_pid_api(game_key, pid, token)
            if name == "TOKEN_EXPIRED":
                print("  Token expired, refreshing...")
                if creds and refresh_token(creds):
                    token = creds["access_token"]
                    name = lookup_pid_api(game_key, pid, token)
                else:
                    token = None  # disable API fallback

        if name and name != "TOKEN_EXPIRED":
            found += 1
            consecutive_misses = 0
            pid_to_name[str(pid)] = name
            norm = normalize_name(name)

            # Match to ESPN player
            if norm in espn_players:
                espn_id = espn_players[norm]["espn_id"]
                if espn_id not in already_mapped:
                    yahoo_map[espn_id] = str(pid)
                    matched += 1
        else:
            consecutive_misses += 1
            if consecutive_misses >= MAX_CONSECUTIVE_MISSES:
                print(f"  Stopping: {MAX_CONSECUTIVE_MISSES} consecutive misses at PID {pid}")
                break

        scanned += 1

        # Save checkpoint every 500
        if scanned % 500 == 0:
            json.dump({"last_pid": pid, "found": found, "matched": matched}, open(cp_file, "w"))
            json.dump(yahoo_map, open(map_file, "w"), indent=2)
            json.dump(pid_to_name, open(f"{ESPN_CACHE}/pid_names_{sport}.json", "w"), indent=2)
            print(f"  PID {pid}: scanned={scanned}, found={found}, matched={matched}, map={len(yahoo_map)}, streak={consecutive_misses}")

        time.sleep(0.05)  # rate limit

    # Final save
    json.dump(yahoo_map, open(map_file, "w"), indent=2)
    json.dump(pid_to_name, open(f"{ESPN_CACHE}/pid_names_{sport}.json", "w"), indent=2)
    json.dump({"last_pid": end_pid, "found": found, "matched": matched}, open(cp_file, "w"))

    print(f"\nDone: scanned={scanned}, found={found} players, matched={matched} to ESPN")
    print(f"Yahoo map: {len(yahoo_map)} total entries")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--sport", required=True, choices=["nfl", "nhl", "mlb", "nba"])
    parser.add_argument("--start", type=int, default=1)
    parser.add_argument("--end", type=int, default=100000)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()

    if args.resume:
        args.start = 1  # will be overridden by checkpoint

    run(args.sport, args.start, args.end)
