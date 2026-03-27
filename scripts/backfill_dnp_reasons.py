#!/usr/bin/env python3
"""
Backfill DNP reasons and starter info into existing ESPN box score cache files.

Re-fetches the summary API for each cached box score and adds:
- didNotPlay, dnp_reason, starter fields to each player

Usage:
  python3 backfill_dnp_reasons.py --league nba --limit 1000
  python3 backfill_dnp_reasons.py --all
"""
import os, sys, json, glob, time, argparse, requests

ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports"
CACHE_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "espn_team_first_cache")

SPORT_PATHS = {
    "nba": "basketball/nba",
    "nhl": "hockey/nhl",
    "nfl": "football/nfl",
    "mlb": "baseball/mlb",
}


def backfill_game(sport_path, event_id, cache_file):
    """Re-fetch summary and add DNP info to cached box score."""
    try:
        existing = json.load(open(cache_file))
    except:
        return False

    # Check if already backfilled
    for team in existing.get("teams", []):
        for p in team.get("players", []):
            if "didNotPlay" in p:
                return False  # already has DNP info

    # Fetch from API
    url = f"{ESPN_BASE}/{sport_path}/summary"
    try:
        r = requests.get(url, params={"event": event_id}, timeout=15)
        if r.status_code != 200:
            return False
        data = r.json()
    except:
        return False

    boxscore = data.get("boxscore", {})
    players_data = boxscore.get("players", [])

    # Build lookup: espn_id -> {starter, didNotPlay, reason}
    dnp_info = {}
    for team in players_data:
        for stat_cat in team.get("statistics", []):
            for athlete_data in stat_cat.get("athletes", []):
                athlete = athlete_data.get("athlete", {})
                eid = athlete.get("id", "")
                if eid:
                    dnp_info[eid] = {
                        "starter": athlete_data.get("starter", False),
                        "didNotPlay": athlete_data.get("didNotPlay", False),
                        "dnp_reason": athlete_data.get("reason", ""),
                    }

    # Update cached file
    updated = False
    for team in existing.get("teams", []):
        for p in team.get("players", []):
            info = dnp_info.get(p.get("espn_id", ""))
            if info:
                p["starter"] = info["starter"]
                p["didNotPlay"] = info["didNotPlay"]
                p["dnp_reason"] = info["dnp_reason"]
                updated = True

    if updated:
        with open(cache_file, "w") as f:
            json.dump(existing, f, indent=2)

    return updated


def run(league, limit=None):
    sport_path = SPORT_PATHS.get(league)
    if not sport_path:
        print(f"Unknown league: {league}")
        return

    box_files = sorted(glob.glob(f"{CACHE_DIR}/boxscore_*.json"))
    print(f"Found {len(box_files):,} box score files")

    # Filter to files that need backfill
    needs_backfill = []
    for bf in box_files:
        try:
            data = json.load(open(bf))
            has_dnp = any("didNotPlay" in p for t in data.get("teams", []) for p in t.get("players", []))
            if not has_dnp:
                needs_backfill.append(bf)
        except:
            pass

    print(f"Need backfill: {len(needs_backfill):,}")

    if limit:
        needs_backfill = needs_backfill[:limit]
        print(f"Limited to {limit}")

    updated = 0
    errors = 0
    for i, bf in enumerate(needs_backfill):
        event_id = os.path.basename(bf).replace("boxscore_", "").replace(".json", "")
        if backfill_game(sport_path, event_id, bf):
            updated += 1
        else:
            errors += 1

        if (i + 1) % 100 == 0:
            print(f"  {i+1}/{len(needs_backfill)}: {updated} updated, {errors} errors")

        time.sleep(0.1)  # rate limit

    print(f"\nDone: {updated} updated, {errors} skipped/errors")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--league", choices=["nba", "nhl", "nfl", "mlb"])
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()

    if args.all:
        for league in ["nba", "nhl", "nfl", "mlb"]:
            print(f"\n{'='*40}\n  {league.upper()}\n{'='*40}")
            run(league, args.limit)
    elif args.league:
        run(args.league, args.limit)


if __name__ == "__main__":
    main()
