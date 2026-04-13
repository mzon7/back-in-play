#!/usr/bin/env python3
"""
Detect player absences from ESPN box scores and match to reported injuries.

Step 1: Find all gaps where a player missed 1+ team games
Step 2: Match each reported injury to a detected absence
  - Phase A: start dates within ±10 days
  - Phase B: duration within 75% of reported length

Usage:
  python3 detect_player_absences.py --league nba
  python3 detect_player_absences.py --all
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


def load_espn_data(league):
    """Load per-player game dates and per-team schedules from ESPN cache."""
    print("  Loading ESPN summaries...")
    summaries = sorted(glob.glob(f"{ESPN_CACHE}/summary_{league}_*.json"))

    player_dates = defaultdict(set)
    player_names = {}
    player_team_seasons = defaultdict(list)  # espn_id → [(team, season)]
    team_dates = defaultdict(set)

    for sf in summaries:
        data = json.load(open(sf))
        team_name = data.get("team_name", "")
        season = data.get("season", 0)

        for g in data.get("games", []):
            d = g.get("date", "")
            if d:
                team_dates[team_name].add(d)

        for espn_id, player in data.get("players", {}).items():
            player_names[espn_id] = player.get("name", "")
            for gd in player.get("game_dates", []):
                player_dates[espn_id].add(gd)
            player_team_seasons[espn_id].append((team_name, season))

    # Sort dates
    player_sorted = {eid: sorted(dates) for eid, dates in player_dates.items()}
    team_sorted = {tn: sorted(dates) for tn, dates in team_dates.items()}

    print(f"    {len(player_names):,} players, {len(team_sorted):,} teams")
    return player_sorted, player_names, player_team_seasons, team_sorted


def detect_absences(player_dates, player_names, player_team_seasons, team_dates):
    """Find all gaps where a player missed 1+ consecutive team games."""
    print("  Detecting absences...")
    absences = []

    for espn_id, played_dates in player_dates.items():
        played_set = set(played_dates)
        name = player_names.get(espn_id, espn_id)

        # Get all team schedules this player was on
        teams = set(t for t, s in player_team_seasons.get(espn_id, []))
        all_team_games = set()
        for t in teams:
            all_team_games.update(team_dates.get(t, set()))

        if not all_team_games:
            continue

        schedule = sorted(all_team_games)

        # Walk the schedule looking for gaps
        in_gap = False
        gap_start = None
        gap_count = 0

        for i, game_date in enumerate(schedule):
            if game_date not in played_set:
                if not in_gap:
                    gap_start = game_date
                    gap_count = 1
                    in_gap = True
                else:
                    gap_count += 1
            else:
                if in_gap:
                    # Gap ended — player is back
                    absences.append({
                        "espn_id": espn_id,
                        "player_name": name,
                        "team": list(teams)[0] if len(teams) == 1 else "/".join(sorted(teams)),
                        "absence_start": gap_start,
                        "first_game_back": game_date,
                        "games_missed": gap_count,
                    })
                    in_gap = False
                    gap_start = None
                    gap_count = 0

        # Handle gap extending to end of data
        if in_gap and gap_count >= 1:
            absences.append({
                "espn_id": espn_id,
                "player_name": name,
                "team": list(teams)[0] if len(teams) == 1 else "/".join(sorted(teams)),
                "absence_start": gap_start,
                "first_game_back": None,
                "games_missed": gap_count,
            })

    print(f"    Detected {len(absences):,} absences across {len(player_dates):,} players")
    return absences


def load_injuries(league):
    """Load reported injuries from DB."""
    import psycopg2
    conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"])
    cur = conn.cursor()
    cur.execute("""
        SELECT i.injury_id, i.player_id, i.date_injured, i.return_date, i.injury_type,
               i.games_missed, i.status, i.injury_description,
               p.player_name, p.espn_id
        FROM back_in_play_injuries i
        JOIN back_in_play_players p ON i.player_id = p.player_id
        WHERE p.league_id = %s AND i.date_injured IS NOT NULL
        ORDER BY i.date_injured
    """, (LEAGUE_IDS[league],))
    injuries = [dict(zip([d[0] for d in cur.description], r)) for r in cur.fetchall()]
    conn.close()
    print(f"  Reported injuries: {len(injuries):,}")
    return injuries


def match_injuries_to_absences(injuries, absences, player_names):
    """Match each reported injury to the closest detected absence."""
    print("  Matching injuries to absences...")

    # Index absences by espn_id
    abs_by_player = defaultdict(list)
    name_to_espn = {v.lower(): k for k, v in player_names.items()}
    for a in absences:
        abs_by_player[a["espn_id"]].append(a)

    results = {
        "strong_match": [],
        "weak_match": [],
        "unmatched_injury": [],
    }

    for inj in injuries:
        espn_id = str(inj.get("espn_id") or "")
        if not espn_id or espn_id == "None":
            alt = name_to_espn.get((inj.get("player_name") or "").lower())
            if alt:
                espn_id = alt

        date_injured = str(inj.get("date_injured", ""))
        return_date = str(inj.get("return_date") or "")
        if not date_injured:
            continue

        try:
            inj_dt = datetime.strptime(date_injured, "%Y-%m-%d")
        except:
            continue

        # Reported duration in days
        reported_duration = None
        if return_date and return_date != "None" and return_date < "2028-01-01":
            try:
                ret_dt = datetime.strptime(return_date, "%Y-%m-%d")
                reported_duration = (ret_dt - inj_dt).days
            except:
                pass

        # Phase A: find absences with start date within ±10 days
        player_abs = abs_by_player.get(espn_id, [])
        candidates = []
        for a in player_abs:
            try:
                abs_dt = datetime.strptime(a["absence_start"], "%Y-%m-%d")
                day_diff = abs((abs_dt - inj_dt).days)
                if day_diff <= 10:
                    candidates.append((day_diff, a))
            except:
                continue

        if not candidates:
            results["unmatched_injury"].append({
                "injury_id": str(inj["injury_id"]),
                "player": inj.get("player_name"),
                "injury_type": inj.get("injury_type"),
                "date_injured": date_injured,
                "return_date": return_date,
                "reason": "no_absence_within_10_days",
            })
            continue

        # Pick closest
        candidates.sort(key=lambda x: x[0])
        day_diff, best_absence = candidates[0]

        # Phase B: duration match (within 75%)
        # Compute detected duration in days
        detected_duration = None
        if best_absence["first_game_back"]:
            try:
                det_end = datetime.strptime(best_absence["first_game_back"], "%Y-%m-%d")
                det_start = datetime.strptime(best_absence["absence_start"], "%Y-%m-%d")
                detected_duration = (det_end - det_start).days
            except:
                pass

        duration_match = False
        if reported_duration and detected_duration and reported_duration > 0:
            ratio = detected_duration / reported_duration
            duration_match = 0.25 <= ratio <= 1.75  # within 75% tolerance

        # Classify match strength
        start_close = day_diff <= 7
        match_record = {
            "injury_id": str(inj["injury_id"]),
            "player": inj.get("player_name"),
            "injury_type": inj.get("injury_type"),
            "reported_start": date_injured,
            "reported_end": return_date,
            "reported_duration_days": reported_duration,
            "reported_games_missed": inj.get("games_missed"),
            "detected_start": best_absence["absence_start"],
            "detected_end": best_absence["first_game_back"],
            "detected_games_missed": best_absence["games_missed"],
            "detected_duration_days": detected_duration,
            "start_day_diff": day_diff,
            "duration_match": duration_match,
        }

        if start_close and duration_match:
            match_record["match_quality"] = "strong"
            results["strong_match"].append(match_record)
        elif start_close or duration_match:
            match_record["match_quality"] = "weak"
            results["weak_match"].append(match_record)
        else:
            match_record["match_quality"] = "poor"
            match_record["reason"] = f"start_diff={day_diff}d, duration_match={duration_match}"
            results["weak_match"].append(match_record)

    # Count unmatched absences (absences with no injury report)
    matched_absence_starts = set()
    for cat in ["strong_match", "weak_match"]:
        for m in results[cat]:
            matched_absence_starts.add((m.get("player"), m["detected_start"]))

    unmatched_absences = []
    for a in absences:
        if a["games_missed"] >= 2:  # only flag 2+ game absences
            key = (a["player_name"], a["absence_start"])
            if key not in matched_absence_starts:
                unmatched_absences.append(a)

    results["unmatched_absences"] = unmatched_absences

    return results


def grade_match(m):
    """Grade A-D using all 3 dimensions: start, return, duration."""
    start_diff = m["start_day_diff"]
    rep_dur = m.get("reported_duration_days") or 0
    det_dur = m.get("detected_duration_days") or 0

    # Return date diff
    rep_end = m.get("reported_end", "")
    det_end = m.get("detected_end", "")
    ret_diff = None
    if rep_end and det_end and rep_end != "None" and rep_end < "2028":
        try:
            ret_diff = abs((datetime.strptime(det_end, "%Y-%m-%d") - datetime.strptime(rep_end, "%Y-%m-%d")).days)
        except:
            pass

    # Duration % off
    dur_pct_off = None
    if rep_dur > 0 and det_dur is not None and det_dur > 0:
        dur_pct_off = round(abs(det_dur - rep_dur) / max(rep_dur, 1) * 100, 1)

    start_ok = start_diff <= 3
    return_ok = ret_diff is not None and ret_diff <= 7
    duration_ok = dur_pct_off is not None and dur_pct_off <= 30

    score = sum([start_ok, return_ok, duration_ok])
    grade = {3: "A", 2: "B", 1: "C", 0: "D"}[score]

    return grade, start_diff, ret_diff, dur_pct_off


def populate_corrected_table(league, all_matches, unmatched_injuries):
    """Write graded matches + unmatched injuries to back_in_play_injuries_corrected."""
    import psycopg2
    conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"])
    cur = conn.cursor()

    # Clear existing for this league
    cur.execute("DELETE FROM back_in_play_injuries_corrected WHERE league_slug = %s", (league,))
    conn.commit()

    inserted = 0
    for m in all_matches:
        grade, start_diff, ret_diff, dur_pct = grade_match(m)
        try:
            cur.execute("""
                INSERT INTO back_in_play_injuries_corrected
                (original_injury_id, player_id, player_name, league_slug,
                 date_injured, return_date, games_missed,
                 original_date_injured, original_return_date, original_games_missed,
                 injury_type, injury_description,
                 grade, start_day_diff, return_day_diff, duration_pct_off, match_notes)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (
                m.get("injury_id"), m.get("player_id"), m.get("player"), league,
                m.get("detected_start"), m.get("detected_end"), m.get("detected_games_missed"),
                m.get("reported_start"), m.get("reported_end"), m.get("reported_games_missed"),
                m.get("injury_type"), None,
                grade, start_diff, ret_diff, dur_pct,
                f"start_diff={start_diff}d, return_diff={ret_diff}d, dur_pct={dur_pct}%"
            ))
            inserted += 1
        except Exception as e:
            conn.rollback()
            continue

    # Also insert unmatched injuries as grade "U"
    for m in unmatched_injuries:
        try:
            cur.execute("""
                INSERT INTO back_in_play_injuries_corrected
                (original_injury_id, player_name, league_slug,
                 original_date_injured, original_return_date,
                 injury_type, grade, match_notes)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """, (
                m.get("injury_id"), m.get("player"), league,
                m.get("date_injured"), m.get("return_date"),
                m.get("injury_type"), "U", m.get("reason", "unmatched")
            ))
            inserted += 1
        except Exception as e:
            conn.rollback()
            continue

    conn.commit()
    conn.close()
    print(f"    Inserted {inserted:,} corrected injuries into DB")


def run(league, save_to_db=False):
    print(f"\n{'='*60}")
    print(f"  DETECT ABSENCES & MATCH INJURIES — {league.upper()}")
    print(f"{'='*60}")

    player_dates, player_names, player_team_seasons, team_dates = load_espn_data(league)
    absences = detect_absences(player_dates, player_names, player_team_seasons, team_dates)
    injuries = load_injuries(league)
    results = match_injuries_to_absences(injuries, absences, player_names)

    all_matches = results["strong_match"] + results["weak_match"]

    # Grade all matches
    grade_counts = defaultdict(int)
    for m in all_matches:
        g, _, _, _ = grade_match(m)
        grade_counts[g] += 1

    # Summary
    total_matched = len(all_matches)
    print(f"\n  RESULTS:")
    print(f"    Total reported injuries:    {len(injuries):,}")
    print(f"    Total detected absences:    {len(absences):,}")
    print(f"    Matched:                    {total_matched:,}")
    print(f"    Unmatched injuries:         {len(results['unmatched_injury']):,}")
    print(f"\n  GRADES:")
    for g in ["A", "B", "C", "D"]:
        pct = round(grade_counts[g] / total_matched * 100) if total_matched > 0 else 0
        label = {"A": "all 3 match", "B": "2 of 3", "C": "1 of 3", "D": "none"}[g]
        print(f"    Grade {g} ({label}): {grade_counts[g]:,} ({pct}%)")

    # Save to DB
    if save_to_db:
        print("\n  Saving to back_in_play_injuries_corrected...")
        populate_corrected_table(league, all_matches, results["unmatched_injury"])

    # Save JSON
    abs_file = os.path.join(DATA_DIR, f"detected_absences_{league}.json")
    match_file = os.path.join(DATA_DIR, f"injury_match_report_{league}.json")
    with open(abs_file, "w") as f:
        json.dump(absences, f, indent=2, default=str)
    with open(match_file, "w") as f:
        json.dump(results, f, indent=2, default=str)
    print(f"\n  Saved: {abs_file}")
    print(f"  Saved: {match_file}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--league", choices=["nba", "nhl", "nfl", "mlb"])
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--save-to-db", action="store_true", help="Populate corrected injuries table")
    args = parser.parse_args()

    if args.all:
        for league in ["nba", "nhl", "nfl", "mlb"]:
            run(league, args.save_to_db)
    elif args.league:
        run(args.league, args.save_to_db)
    else:
        print("Specify --league or --all")


if __name__ == "__main__":
    main()
