#!/usr/bin/env python3
"""
Fix injury dates using ESPN box scores as ground truth.

For each injury:
1. Find the player's full game-date timeline from ESPN box scores
2. Find the actual gap (consecutive missed games) nearest to the reported injury date
3. Correct date_injured → first missed game, return_date → first game back
4. Compute actual games_missed from the gap

Usage:
  python3 fix_injury_dates.py --league nba --report     # Just show what would change
  python3 fix_injury_dates.py --league nba --fix         # Apply fixes to DB
  python3 fix_injury_dates.py --all --report
"""
import os, sys, json, glob, argparse
from collections import defaultdict
from datetime import datetime, timedelta

for f in ["/root/.daemon-env", ".env"]:
    if os.path.exists(f):
        with open(f) as fh:
            for line in fh:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

ESPN_CACHE = os.path.join(os.path.dirname(__file__), "..", "data", "espn_team_first_cache")
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")

LEAGUE_IDS = {
    "nba": "2aa180e9-a7c2-4d08-a1d8-a16152827b5d",
    "nhl": "0894f8ac-c744-4b58-9023-20c514f64fff",
    "nfl": "0fea41a7-250e-40bf-9220-97853a69b6d7",
    "mlb": "312485db-3c4a-4f83-b4b0-c761e114d870",
}


def load_player_game_dates(league):
    """From ESPN box scores + schedules, build per-player sorted game date lists
    AND per-team sorted schedule dates."""
    print("  Loading ESPN data...")
    summaries = sorted(glob.glob(f"{ESPN_CACHE}/summary_{league}_*.json"))

    player_dates = defaultdict(set)   # espn_id → set of dates played
    player_names = {}                  # espn_id → name
    player_teams = defaultdict(set)    # espn_id → set of team names
    team_dates = defaultdict(set)      # team_name_lower → set of all game dates

    for sf in summaries:
        data = json.load(open(sf))
        team_name = data.get("team_name", "")

        # Team schedule
        for g in data.get("games", []):
            d = g.get("date", "")
            if d:
                team_dates[team_name.lower()].add(d)
                if g.get("home_team"):
                    team_dates[g["home_team"].lower()].add(d)
                if g.get("away_team"):
                    team_dates[g["away_team"].lower()].add(d)

        # Player appearances
        for espn_id, player in data.get("players", {}).items():
            player_names[espn_id] = player.get("name", "")
            for gd in player.get("game_dates", []):
                player_dates[espn_id].add(gd)
            teams = player.get("teams", [])
            if isinstance(teams, list):
                for t in teams:
                    player_teams[espn_id].add(t.lower() if isinstance(t, str) else "")

    # Convert to sorted lists
    player_sorted = {eid: sorted(dates) for eid, dates in player_dates.items()}
    team_sorted = {tn: sorted(dates) for tn, dates in team_dates.items()}

    print(f"    {len(player_names):,} players, {len(team_sorted):,} teams")
    return player_sorted, player_names, player_teams, team_sorted


def find_gap_near_date(player_game_dates, team_game_dates, injury_date_str, search_window=30):
    """Find the gap in a player's appearances nearest to the injury date.

    A 'gap' = consecutive team games where the player didn't play.
    Returns (gap_start_date, gap_end_date, games_missed) or None.
    """
    if not player_game_dates or not team_game_dates:
        return None

    try:
        injury_dt = datetime.strptime(injury_date_str, "%Y-%m-%d")
    except:
        return None

    # Find team games in a window around the injury date
    window_start = (injury_dt - timedelta(days=search_window)).strftime("%Y-%m-%d")
    window_end = (injury_dt + timedelta(days=search_window * 4)).strftime("%Y-%m-%d")

    team_games_in_window = [d for d in team_game_dates if window_start <= d <= window_end]
    player_played = set(player_game_dates)

    if not team_games_in_window:
        return None

    # Find all gaps (consecutive team games where player was absent)
    gaps = []
    current_gap_start = None
    current_gap_count = 0

    for tg in team_games_in_window:
        if tg not in player_played:
            if current_gap_start is None:
                current_gap_start = tg
            current_gap_count += 1
        else:
            if current_gap_start is not None and current_gap_count >= 1:
                # Find first game back
                first_back = tg
                gaps.append((current_gap_start, first_back, current_gap_count))
            current_gap_start = None
            current_gap_count = 0

    # Handle gap that extends to end of window
    if current_gap_start is not None and current_gap_count >= 1:
        # No return game found in window — use last missed date
        last_missed = [d for d in team_games_in_window if d not in player_played and d >= current_gap_start]
        if last_missed:
            gaps.append((current_gap_start, None, current_gap_count))

    if not gaps:
        return None

    # Pick the gap closest to the reported injury date
    best_gap = None
    best_dist = float("inf")
    for gap_start, gap_end, count in gaps:
        try:
            dist = abs((datetime.strptime(gap_start, "%Y-%m-%d") - injury_dt).days)
        except:
            continue
        if dist < best_dist:
            best_dist = dist
            best_gap = (gap_start, gap_end, count)

    return best_gap


def run(league, fix_mode=False):
    print(f"\n{'='*60}")
    print(f"  FIX INJURY DATES — {league.upper()}")
    print(f"{'='*60}")

    player_dates, player_names, player_teams, team_dates = load_player_game_dates(league)

    # Load injuries
    import psycopg2
    conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"])
    cur = conn.cursor()

    league_id = LEAGUE_IDS.get(league)
    cur.execute("""
        SELECT i.id, i.player_id, i.date_injured, i.return_date, i.injury_type,
               i.games_missed, i.status, p.player_name, p.espn_id
        FROM back_in_play_injuries i
        JOIN back_in_play_players p ON i.player_id = p.player_id
        WHERE p.league_id = %s AND i.date_injured IS NOT NULL
        ORDER BY i.date_injured
    """, (league_id,))
    injuries = [dict(zip([d[0] for d in cur.description], r)) for r in cur.fetchall()]
    print(f"  Injuries: {len(injuries):,}")

    # Build name → espn_id index
    name_to_espn = {}
    for eid, name in player_names.items():
        name_to_espn[name.lower()] = eid

    stats = {"confirmed": 0, "date_fixed": 0, "no_gap_found": 0, "not_in_espn": 0, "bogus_removed": 0}
    fixes = []

    for inj in injuries:
        injury_id = inj["id"]
        player_name = inj["player_name"]
        espn_id = str(inj.get("espn_id") or "")
        date_injured = str(inj["date_injured"])
        return_date = str(inj.get("return_date") or "")
        injury_type = inj.get("injury_type", "")

        # Find player's game dates
        pgd = player_dates.get(espn_id)
        if not pgd:
            alt = name_to_espn.get(player_name.lower())
            if alt:
                pgd = player_dates.get(alt)
                espn_id = alt

        if not pgd:
            stats["not_in_espn"] += 1
            continue

        # Find this player's team(s) to get team schedule
        teams = player_teams.get(espn_id, set())
        all_team_dates = set()
        for tn in teams:
            all_team_dates.update(team_dates.get(tn, set()))
        if not all_team_dates:
            # Fallback: use all dates the player ever played
            all_team_dates = set(pgd)

        team_game_list = sorted(all_team_dates)

        # Check for bogus return dates (2069, etc)
        if return_date and return_date > "2027-01-01":
            # Bogus placeholder — try to find actual gap
            gap = find_gap_near_date(pgd, team_game_list, date_injured, search_window=30)
            if gap:
                new_start, new_end, missed = gap
                fixes.append({
                    "id": injury_id, "player": player_name, "injury": injury_type,
                    "old_injured": date_injured, "old_return": return_date,
                    "new_injured": new_start, "new_return": new_end,
                    "games_missed": missed, "reason": "bogus_return_date_fixed",
                })
                stats["date_fixed"] += 1
            else:
                stats["no_gap_found"] += 1
            continue

        # Normal case: check if dates align with box score gap
        gap = find_gap_near_date(pgd, team_game_list, date_injured, search_window=14)

        if not gap:
            # No gap found near injury date — player might not have missed games
            # Check if they played on the injury date
            if date_injured in set(pgd):
                stats["bogus_removed"] += 1
                fixes.append({
                    "id": injury_id, "player": player_name, "injury": injury_type,
                    "old_injured": date_injured, "old_return": return_date,
                    "new_injured": None, "new_return": None,
                    "games_missed": 0, "reason": "played_on_injury_date_remove",
                })
            else:
                stats["no_gap_found"] += 1
            continue

        gap_start, gap_end, missed = gap

        # Check if dates need adjusting
        if gap_start == date_injured and gap_end == return_date:
            stats["confirmed"] += 1
        else:
            # Dates off — fix them
            old_missed = inj.get("games_missed")
            fixes.append({
                "id": injury_id, "player": player_name, "injury": injury_type,
                "old_injured": date_injured, "old_return": return_date,
                "new_injured": gap_start, "new_return": gap_end,
                "games_missed": missed, "old_games_missed": old_missed,
                "reason": "dates_adjusted",
            })
            stats["date_fixed"] += 1

    # Summary
    print(f"\n  RESULTS:")
    print(f"    Confirmed correct:     {stats['confirmed']:,}")
    print(f"    Dates fixed:           {stats['date_fixed']:,}")
    print(f"    Bogus (played on day): {stats['bogus_removed']:,}")
    print(f"    No gap found:          {stats['no_gap_found']:,}")
    print(f"    Not in ESPN:           {stats['not_in_espn']:,}")
    print(f"    Total fixes:           {len(fixes):,}")

    # Show sample fixes
    if fixes:
        print(f"\n  SAMPLE FIXES (first 15):")
        for f in fixes[:15]:
            print(f"    {f['player']}: {f['injury']}")
            print(f"      {f['old_injured']} → {f['old_return']}  =>  {f['new_injured']} → {f['new_return']} ({f['games_missed']} GP missed)")
            print(f"      Reason: {f['reason']}")

    # Apply fixes
    if fix_mode and fixes:
        print(f"\n  APPLYING {len(fixes)} fixes to DB...")
        applied = 0
        for f in fixes:
            try:
                if f["reason"] == "played_on_injury_date_remove":
                    # Mark as bad data rather than deleting
                    cur.execute("""
                        UPDATE back_in_play_injuries
                        SET status = 'invalid_played_during', games_missed = 0
                        WHERE id = %s
                    """, (f["id"],))
                else:
                    update_fields = {"games_missed": f["games_missed"]}
                    if f["new_injured"]:
                        update_fields["date_injured"] = f["new_injured"]
                    if f["new_return"]:
                        update_fields["return_date"] = f["new_return"]

                    set_clauses = ", ".join(f"{k} = %s" for k in update_fields)
                    values = list(update_fields.values()) + [f["id"]]
                    cur.execute(f"UPDATE back_in_play_injuries SET {set_clauses} WHERE id = %s", values)

                applied += 1
            except Exception as e:
                print(f"    Error fixing {f['player']}: {e}")
                conn.rollback()
                continue

        conn.commit()
        print(f"    Applied {applied} fixes")

    # Save fixes report
    out_file = os.path.join(DATA_DIR, f"injury_fixes_{league}.json")
    with open(out_file, "w") as fout:
        json.dump(fixes, fout, indent=2, default=str)
    print(f"  Report: {out_file}")

    conn.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--league", choices=["nba", "nhl", "nfl", "mlb"])
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--report", action="store_true", help="Just show what would change")
    parser.add_argument("--fix", action="store_true", help="Apply fixes to DB")
    args = parser.parse_args()

    if not args.report and not args.fix:
        args.report = True  # Default to report mode

    fix_mode = args.fix

    if args.all:
        for league in ["nba", "nhl", "nfl", "mlb"]:
            run(league, fix_mode)
    elif args.league:
        run(args.league, fix_mode)
    else:
        print("Specify --league or --all")


if __name__ == "__main__":
    main()
