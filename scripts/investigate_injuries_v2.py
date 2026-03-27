#!/usr/bin/env python3
"""
Investigate injuries v2 — with consolidation of repeated injury reports.

Steps:
1. Load all injuries per player, sorted by date
2. Consolidate: consecutive same-type injuries within 14 days → merge into one
3. For each consolidated injury, check ESPN box scores for actual absence
4. Grade A/B/C/D/U based on start gap, return date accuracy, games missed

Usage:
  python3 investigate_injuries_v2.py --league nba
  python3 investigate_injuries_v2.py --all --save-to-db
  python3 investigate_injuries_v2.py --league nba --player "LeBron James"
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

MAX_GAP_DAYS = 7  # Max days between injury date and last game to count as a match
CONSOLIDATION_WINDOW = 14  # Days: if same injury type within this window, merge


def load_espn_data(league):
    """Load per-player game dates and per-team schedules."""
    print("  Loading ESPN data...")
    summaries = sorted(glob.glob(f"{ESPN_CACHE}/summary_{league}_*.json"))

    player_dates = defaultdict(set)
    player_names = {}
    player_teams = defaultdict(set)
    team_dates = defaultdict(set)

    for sf in summaries:
        data = json.load(open(sf))
        team_name = data.get("team_name", "")

        for g in data.get("games", []):
            d = g.get("date", "")
            if d:
                team_dates[team_name].add(d)

        for espn_id, player in data.get("players", {}).items():
            player_names[espn_id] = player.get("name", "")
            player_teams[espn_id].add(team_name)
            for gd in player.get("game_dates", []):
                player_dates[espn_id].add(gd)

    # Sort
    player_sorted = {eid: sorted(dates) for eid, dates in player_dates.items()}
    team_sorted = {tn: sorted(dates) for tn, dates in team_dates.items()}
    name_to_espn = {v.lower(): k for k, v in player_names.items()}

    print(f"    {len(player_names):,} players, {len(team_sorted):,} teams")
    return player_sorted, player_names, player_teams, team_sorted, name_to_espn


def load_injuries(league, player_filter=None):
    import psycopg2
    conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"])
    cur = conn.cursor()
    cur.execute("""
        SELECT i.injury_id, i.player_id, i.date_injured, i.return_date, i.injury_type,
               i.games_missed, i.status, i.source,
               p.player_name, p.espn_id
        FROM back_in_play_injuries i
        JOIN back_in_play_players p ON i.player_id = p.player_id
        WHERE p.league_id = %s AND i.date_injured IS NOT NULL
        ORDER BY p.player_name, i.date_injured
    """, (LEAGUE_IDS[league],))
    injuries = [dict(zip([d[0] for d in cur.description], r)) for r in cur.fetchall()]
    conn.close()

    if player_filter:
        injuries = [i for i in injuries if player_filter.lower() in (i.get("player_name") or "").lower()]

    print(f"  Raw injuries: {len(injuries):,}")
    return injuries


def consolidate_injuries(injuries):
    """Merge consecutive same-type injuries for the same player within CONSOLIDATION_WINDOW days."""
    # Group by player
    by_player = defaultdict(list)
    for inj in injuries:
        by_player[(inj.get("player_name", ""), str(inj.get("player_id", "")))].append(inj)

    consolidated = []
    merge_count = 0

    for (player_name, player_id), player_injuries in by_player.items():
        # Sort by date
        sorted_inj = sorted(player_injuries, key=lambda x: str(x.get("date_injured", "")))

        i = 0
        while i < len(sorted_inj):
            current = sorted_inj[i]
            injury_type = (current.get("injury_type") or "").lower().strip()
            date_injured = str(current.get("date_injured", ""))
            return_date = str(current.get("return_date") or "")

            # Look ahead for same-type injuries within the window
            merged_ids = [str(current.get("injury_id", ""))]
            merged_count = 1
            last_return = return_date

            j = i + 1
            while j < len(sorted_inj):
                next_inj = sorted_inj[j]
                next_type = (next_inj.get("injury_type") or "").lower().strip()
                next_date = str(next_inj.get("date_injured", ""))
                next_return = str(next_inj.get("return_date") or "")

                # Same injury type?
                if next_type != injury_type:
                    break

                # Within consolidation window of last return or last injury date?
                try:
                    anchor = last_return if last_return and last_return != "None" and last_return < "2028" else date_injured
                    gap = (datetime.strptime(next_date, "%Y-%m-%d") - datetime.strptime(anchor, "%Y-%m-%d")).days
                except:
                    break

                if gap > CONSOLIDATION_WINDOW:
                    break

                # Merge
                merged_ids.append(str(next_inj.get("injury_id", "")))
                merged_count += 1
                if next_return and next_return != "None" and next_return < "2028":
                    last_return = next_return
                j += 1

            if merged_count > 1:
                merge_count += merged_count - 1

            # Build consolidated injury
            consolidated.append({
                "injury_ids": merged_ids,
                "player_id": player_id,
                "player_name": player_name,
                "espn_id": str(current.get("espn_id") or ""),
                "injury_type": current.get("injury_type"),
                "source": current.get("source"),
                "date_injured": date_injured,
                "return_date": last_return if last_return and last_return != "None" else None,
                "original_count": merged_count,
            })

            i = j  # skip merged entries

    print(f"  Consolidated: {len(injuries):,} → {len(consolidated):,} ({merge_count:,} merged)")
    return consolidated


def investigate(inj, player_dates, player_teams, team_dates, name_to_espn):
    """Check ESPN box scores for actual absence around this injury."""
    player_name = inj["player_name"]
    espn_id = inj.get("espn_id", "")
    date_injured = inj["date_injured"]
    return_date = inj.get("return_date")

    if not date_injured:
        return None

    # Find player's game dates
    pgd = player_dates.get(espn_id)
    if not pgd:
        alt = name_to_espn.get(player_name.lower())
        if alt:
            pgd = player_dates.get(alt)

    if not pgd:
        return {"verdict": "player_not_found", "games_missed": 0,
                "start_gap_days": None, "return_gap_days": None,
                "last_game_before": None, "first_game_after": None, "return_diff_days": None}

    played_set = set(pgd)

    # Get team schedule
    teams = player_teams.get(espn_id, set())
    if not teams:
        alt = name_to_espn.get(player_name.lower())
        if alt:
            teams = player_teams.get(alt, set())
    all_team_games = set()
    for t in teams:
        all_team_games.update(team_dates.get(t, set()))
    team_schedule = sorted(all_team_games)

    try:
        inj_dt = datetime.strptime(date_injured, "%Y-%m-%d")
    except:
        return None

    # Find last game before and first game after
    games_before = [d for d in pgd if d < date_injured]
    last_game_before = games_before[-1] if games_before else None

    games_after = [d for d in pgd if d > date_injured]
    first_game_after = games_after[0] if games_after else None

    played_on_date = date_injured in played_set

    # Gaps in days
    start_gap = None
    if last_game_before:
        try:
            start_gap = (inj_dt - datetime.strptime(last_game_before, "%Y-%m-%d")).days
        except:
            pass

    return_gap = None
    if first_game_after:
        try:
            return_gap = (datetime.strptime(first_game_after, "%Y-%m-%d") - inj_dt).days
        except:
            pass

    # Count missed team games
    if first_game_after:
        team_games_during = [d for d in team_schedule if date_injured <= d < first_game_after]
        games_missed = len([d for d in team_games_during if d not in played_set])
    else:
        team_games_during = [d for d in team_schedule if d >= date_injured]
        games_missed = len([d for d in team_games_during if d not in played_set])

    # Return date accuracy
    ret_diff = None
    if return_date and return_date != "None" and return_date < "2028" and first_game_after:
        try:
            ret_dt = datetime.strptime(return_date, "%Y-%m-%d")
            first_back_dt = datetime.strptime(first_game_after, "%Y-%m-%d")
            ret_diff = (first_back_dt - ret_dt).days
        except:
            pass

    # Verdict
    start_too_far = start_gap is not None and start_gap > MAX_GAP_DAYS

    if played_on_date and games_missed == 0:
        verdict = "played_through"
    elif games_missed == 0 and start_too_far:
        verdict = "offseason_no_miss"
    elif games_missed == 0:
        verdict = "no_games_missed"
    elif start_too_far and games_missed > 0 and first_game_after:
        verdict = "offseason_missed_games"
    elif start_too_far and games_missed > 0 and not first_game_after:
        verdict = "offseason_career_ending"
    elif played_on_date and games_missed > 0:
        verdict = "played_then_missed"
    elif games_missed <= 2:
        verdict = "minor_absence"
    else:
        verdict = "confirmed_absence"

    return {
        "verdict": verdict,
        "games_missed": games_missed,
        "last_game_before": last_game_before,
        "first_game_after": first_game_after,
        "start_gap_days": start_gap,
        "return_gap_days": return_gap,
        "return_diff_days": ret_diff,
    }


def grade_injury(verdict, games_missed, start_gap, ret_diff, return_gap):
    """Assign grade A/B/C/D/U."""
    if verdict == "confirmed_absence" and games_missed >= 3:
        if start_gap is not None and start_gap <= MAX_GAP_DAYS:
            if ret_diff is not None and abs(ret_diff) <= 7:
                return "A"  # start close + return close + 3+ games
            else:
                return "B"  # start close, return unknown/off
        else:
            return "C"
    elif verdict in ("minor_absence", "played_then_missed"):
        if start_gap is not None and start_gap <= MAX_GAP_DAYS:
            if ret_diff is not None and abs(ret_diff) <= 7:
                return "A"  # even minor absences can be A if both dates match
            return "B"
        return "C"
    elif verdict == "offseason_missed_games":
        if ret_diff is not None and abs(ret_diff) <= 7:
            return "A"  # offseason but return date matches
        return "B"
    elif verdict == "offseason_career_ending":
        return "C"
    elif verdict == "offseason_no_miss":
        return "U"
    elif verdict == "played_through":
        return "C"
    elif verdict == "no_games_missed":
        return "U"
    elif verdict == "player_not_found":
        return "U"
    return "C"


def run(league, player_filter=None, save_to_db=False):
    print(f"\n{'='*60}")
    print(f"  INVESTIGATE INJURIES v2 — {league.upper()}")
    print(f"{'='*60}")

    player_dates, player_names, player_teams, team_dates, name_to_espn = load_espn_data(league)
    raw_injuries = load_injuries(league, player_filter)

    # Step 1: Consolidate
    consolidated = consolidate_injuries(raw_injuries)

    # Step 2: Investigate each consolidated injury
    results = []
    verdicts = defaultdict(int)
    grades = defaultdict(int)

    for inj in consolidated:
        inv = investigate(inj, player_dates, player_teams, team_dates, name_to_espn)
        if not inv:
            continue

        verdict = inv["verdict"]
        grade = grade_injury(verdict, inv["games_missed"], inv["start_gap_days"],
                            inv["return_diff_days"], inv["return_gap_days"])

        verdicts[verdict] += 1
        grades[grade] += 1

        results.append({
            **inj,
            **inv,
            "grade": grade,
        })

    # Summary
    total = len(results)
    print(f"\n  VERDICTS ({total:,} consolidated injuries):")
    for v in ["confirmed_absence", "minor_absence", "played_then_missed",
              "offseason_missed_games", "offseason_career_ending", "offseason_no_miss",
              "played_through", "no_games_missed", "player_not_found"]:
        cnt = verdicts.get(v, 0)
        pct = round(cnt / total * 100) if total > 0 else 0
        print(f"    {v}: {cnt:,} ({pct}%)")

    print(f"\n  GRADES:")
    for g in ["A", "B", "C", "D", "U"]:
        cnt = grades.get(g, 0)
        pct = round(cnt / total * 100) if total > 0 else 0
        print(f"    {g}: {cnt:,} ({pct}%)")
    ab = grades.get("A", 0) + grades.get("B", 0)
    print(f"    A+B: {ab:,} ({round(ab/total*100) if total > 0 else 0}%)")

    # Gap distribution
    print(f"\n  START GAP:")
    for label, lo, hi in [("0-3d", 0, 3), ("4-7d", 4, 7), ("8-14d", 8, 14), ("15-21d", 15, 21), ("21+d", 22, 99999)]:
        cnt = sum(1 for r in results if r.get("start_gap_days") is not None and lo <= r["start_gap_days"] <= hi)
        print(f"    {label}: {cnt:,}")
    print(f"    n/a: {sum(1 for r in results if r.get('start_gap_days') is None):,}")

    # Sample details
    if player_filter:
        print(f"\n  DETAILS:")
        for r in results[:30]:
            print(f"    {r['date_injured']} {r['injury_type']} [{r['grade']}]: {r['verdict']}")
            print(f"      Missed {r['games_missed']} GP, last={r.get('last_game_before')}, back={r.get('first_game_after')}")
            print(f"      start_gap={r.get('start_gap_days')}d, ret_diff={r.get('return_diff_days')}d")
            if r.get("original_count", 1) > 1:
                print(f"      (consolidated from {r['original_count']} reports)")

    # Save to DB
    if save_to_db:
        print(f"\n  Saving to DB...")
        import psycopg2
        conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"])
        cur = conn.cursor()
        cur.execute("DELETE FROM back_in_play_injuries_corrected WHERE league_slug = %s", (league,))
        conn.commit()

        def clean_date(d):
            if d is None or d == "" or d == "None" or (isinstance(d, str) and d > "2027"):
                return None
            return d

        rows = []
        for r in results:
            rows.append((
                r.get("injury_ids", [""])[0],  # original_injury_id (first in chain)
                r.get("player_id"), r.get("player_name"), league,
                clean_date(r.get("last_game_before")),
                clean_date(r.get("first_game_after")),
                r.get("games_missed"),
                clean_date(r.get("date_injured")),
                clean_date(r.get("return_date")),
                None,  # original_games_missed
                r.get("injury_type"), None,
                r.get("grade"),
                r.get("start_gap_days"),
                abs(r["return_diff_days"]) if r.get("return_diff_days") is not None else r.get("return_gap_days"),
                None,
                f"{r['verdict']}, merged={r.get('original_count',1)}, start_gap={r.get('start_gap_days')}d, ret_diff={r.get('return_diff_days')}d"
            ))

        CHUNK = 500
        inserted = 0
        for i in range(0, len(rows), CHUNK):
            chunk = rows[i:i + CHUNK]
            values_list = []
            params = []
            for row in chunk:
                values_list.append("(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)")
                params.extend(row)
            sql = """
                INSERT INTO back_in_play_injuries_corrected
                (original_injury_id, player_id, player_name, league_slug,
                 date_injured, return_date, games_missed,
                 original_date_injured, original_return_date, original_games_missed,
                 injury_type, injury_description,
                 grade, start_day_diff, return_day_diff, duration_pct_off, match_notes)
                VALUES """ + ",".join(values_list)
            try:
                cur.execute(sql, params)
                conn.commit()
                inserted += len(chunk)
            except Exception as e:
                conn.rollback()
                print(f"    Batch error: {e}")
            if (i + CHUNK) % 5000 < CHUNK:
                print(f"    {inserted:,} / {len(rows):,}...")

        print(f"    Inserted {inserted:,}")
        conn.close()

    # Save JSON
    out_file = os.path.join(DATA_DIR, f"injury_investigation_v2_{league}.json")
    with open(out_file, "w") as f:
        json.dump(results, f, indent=2, default=str)
    print(f"  Saved: {out_file}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--league", choices=["nba", "nhl", "nfl", "mlb"])
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--player", help="Filter to specific player")
    parser.add_argument("--save-to-db", action="store_true")
    args = parser.parse_args()

    if args.all:
        for league in ["nba", "nhl", "nfl", "mlb"]:
            run(league, save_to_db=args.save_to_db)
    elif args.league:
        run(args.league, args.player, args.save_to_db)
    else:
        print("Specify --league or --all")


if __name__ == "__main__":
    main()
