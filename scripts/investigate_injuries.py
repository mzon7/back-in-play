#!/usr/bin/env python3
"""
Investigate each reported injury by looking at the player's actual data.

For each injury:
1. Look at the player's ESPN box score appearances around the injury date
2. Did they play the game before? The game after?
3. How many consecutive games did they miss starting near the injury date?
4. What was their last game before the injury and first game after?
5. Does the team have games during the reported window?

Output: a detailed per-injury investigation with evidence-based verdicts.

Usage:
  python3 investigate_injuries.py --league nba
  python3 investigate_injuries.py --league nba --player "LeBron James"
  python3 investigate_injuries.py --all --save-to-db
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
    """Load per-player game dates and per-team schedules."""
    print("  Loading ESPN data...")
    summaries = sorted(glob.glob(f"{ESPN_CACHE}/summary_{league}_*.json"))

    player_dates = defaultdict(list)  # espn_id → sorted list of dates
    player_names = {}
    player_teams = defaultdict(set)
    team_dates = defaultdict(list)

    for sf in summaries:
        data = json.load(open(sf))
        team_name = data.get("team_name", "")

        for g in data.get("games", []):
            d = g.get("date", "")
            if d and d not in team_dates[team_name]:
                team_dates[team_name].append(d)

        for espn_id, player in data.get("players", {}).items():
            player_names[espn_id] = player.get("name", "")
            for gd in player.get("game_dates", []):
                if gd not in player_dates[espn_id]:
                    player_dates[espn_id].append(gd)
            # Get team from summary (more reliable than player.teams)
            player_teams[espn_id].add(team_name)
            for t in (player.get("teams", []) if isinstance(player.get("teams"), list) else []):
                if t:
                    player_teams[espn_id].add(t)

    # Sort
    for k in player_dates:
        player_dates[k] = sorted(set(player_dates[k]))
    for k in team_dates:
        team_dates[k] = sorted(set(team_dates[k]))

    # Build name → espn_id index
    name_to_espn = {}
    for eid, name in player_names.items():
        name_to_espn[name.lower()] = eid

    print(f"    {len(player_names):,} players, {len(team_dates):,} teams")
    return player_dates, player_names, player_teams, team_dates, name_to_espn


def load_injuries(league, player_filter=None):
    import psycopg2
    conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"])
    cur = conn.cursor()
    cur.execute("""
        SELECT i.injury_id, i.player_id, i.date_injured, i.return_date, i.injury_type,
               i.games_missed, i.status, i.source, i.injury_description,
               p.player_name, p.espn_id
        FROM back_in_play_injuries i
        JOIN back_in_play_players p ON i.player_id = p.player_id
        WHERE p.league_id = %s AND i.date_injured IS NOT NULL
        ORDER BY i.date_injured
    """, (LEAGUE_IDS[league],))
    injuries = [dict(zip([d[0] for d in cur.description], r)) for r in cur.fetchall()]
    conn.close()

    if player_filter:
        injuries = [i for i in injuries if player_filter.lower() in (i.get("player_name") or "").lower()]

    print(f"  Injuries: {len(injuries):,}")
    return injuries


def investigate_injury(inj, player_dates, player_teams, team_dates, name_to_espn):
    """Look at what actually happened around this injury date."""
    player_name = inj.get("player_name", "")
    espn_id = str(inj.get("espn_id") or "")
    date_injured = str(inj.get("date_injured", ""))
    return_date = str(inj.get("return_date") or "")

    if not date_injured:
        return None

    # Find player's game dates
    pgd = player_dates.get(espn_id)
    if not pgd:
        alt = name_to_espn.get(player_name.lower())
        if alt:
            pgd = player_dates.get(alt)
            espn_id = alt

    if not pgd:
        return {
            "verdict": "player_not_found",
            "detail": "Player not found in ESPN box scores",
        }

    played_set = set(pgd)

    # Get team schedule
    teams = player_teams.get(espn_id, set())
    all_team_games = set()
    for t in teams:
        all_team_games.update(team_dates.get(t, []))
    team_schedule = sorted(all_team_games)

    try:
        inj_dt = datetime.strptime(date_injured, "%Y-%m-%d")
    except:
        return None

    MAX_GAP_DAYS = 7  # If last game or first game back is >7 days from injury date, flag as uncertain

    # Find last game played BEFORE injury date
    games_before = [d for d in pgd if d < date_injured]
    last_game_before = games_before[-1] if games_before else None

    # Find first game played AFTER injury date
    games_after = [d for d in pgd if d > date_injured]
    first_game_after = games_after[0] if games_after else None

    # Did they play ON the injury date?
    played_on_injury_date = date_injured in played_set

    # Compute gap in days between injury date and nearest games
    start_gap_days = None
    if last_game_before:
        try:
            start_gap_days = (inj_dt - datetime.strptime(last_game_before, "%Y-%m-%d")).days
        except:
            pass

    return_gap_days = None
    if first_game_after:
        try:
            return_gap_days = (datetime.strptime(first_game_after, "%Y-%m-%d") - inj_dt).days
        except:
            pass

    # Count team games between injury date and first game back
    if first_game_after:
        team_games_during = [d for d in team_schedule if date_injured <= d < first_game_after]
        games_missed = len([d for d in team_games_during if d not in played_set])
    else:
        team_games_during = [d for d in team_schedule if d >= date_injured]
        games_missed = len([d for d in team_games_during if d not in played_set])

    # Check reported return date
    ret_diff = None
    if return_date and return_date != "None" and return_date < "2028" and first_game_after:
        try:
            ret_dt = datetime.strptime(return_date, "%Y-%m-%d")
            first_back_dt = datetime.strptime(first_game_after, "%Y-%m-%d")
            ret_diff = (first_back_dt - ret_dt).days
        except:
            pass

    # Check if the gap is too far from the injury date (>7 days = uncertain)
    start_too_far = start_gap_days is not None and start_gap_days > MAX_GAP_DAYS
    return_too_far = return_gap_days is not None and return_gap_days > MAX_GAP_DAYS * 30  # return can be far for long injuries

    # Verdict
    if played_on_injury_date and games_missed == 0:
        verdict = "played_through"
        detail = "Played on injury date and didn't miss any games"
    elif played_on_injury_date and games_missed > 0:
        if start_too_far:
            verdict = "uncertain_gap"
            detail = f"Played on injury date, missed {games_missed} games but last game was {start_gap_days}d before injury"
        else:
            verdict = "played_then_missed"
            detail = f"Played on injury date but then missed {games_missed} games"
    elif games_missed == 0:
        if start_too_far:
            verdict = "offseason_no_miss"
            detail = f"Offseason injury (gap {start_gap_days}d), no regular season games missed"
        else:
            verdict = "no_games_missed"
            detail = "Didn't play on injury date but no team games were missed"
    elif start_too_far and games_missed > 0 and first_game_after:
        # Offseason/preseason injury that caused missed games — recoverable
        verdict = "offseason_missed_games"
        detail = f"Offseason injury (gap {start_gap_days}d), missed {games_missed} games, first back {first_game_after}"
    elif start_too_far and games_missed > 0 and not first_game_after:
        # Career-ending or season-ending, never came back
        verdict = "offseason_career_ending"
        detail = f"Offseason injury (gap {start_gap_days}d), missed {games_missed}+ games, never returned"
    elif start_too_far:
        verdict = "uncertain_gap"
        detail = f"Missed {games_missed} games but last game was {start_gap_days}d before reported injury — may be wrong match"
    elif games_missed <= 2:
        verdict = "minor_absence"
        detail = f"Missed {games_missed} game(s)"
    else:
        verdict = "confirmed_absence"
        detail = f"Missed {games_missed} games, from {date_injured} to {first_game_after or 'season end'}"

    return {
        "verdict": verdict,
        "games_missed": games_missed,
        "played_on_injury_date": played_on_injury_date,
        "last_game_before": last_game_before,
        "first_game_after": first_game_after,
        "start_gap_days": start_gap_days,
        "return_gap_days": return_gap_days,
        "reported_return": return_date if return_date and return_date != "None" else None,
        "return_diff_days": ret_diff,
        "detail": detail,
    }


def run(league, player_filter=None, save_to_db=False):
    print(f"\n{'='*60}")
    print(f"  INVESTIGATE INJURIES — {league.upper()}")
    print(f"{'='*60}")

    player_dates, player_names, player_teams, team_dates, name_to_espn = load_espn_data(league)
    injuries = load_injuries(league, player_filter)

    verdicts = defaultdict(int)
    results = []

    for inj in injuries:
        investigation = investigate_injury(inj, player_dates, player_teams, team_dates, name_to_espn)
        if not investigation:
            continue

        verdict = investigation["verdict"]
        verdicts[verdict] += 1

        results.append({
            "injury_id": str(inj["injury_id"]),
            "player_id": str(inj.get("player_id", "")),
            "player": inj["player_name"],
            "injury_type": inj.get("injury_type"),
            "source": inj.get("source"),
            "reported_start": str(inj["date_injured"]),
            "reported_end": str(inj.get("return_date") or ""),
            "reported_games_missed": inj.get("games_missed"),
            **investigation,
        })

    # Summary
    total = len(results)
    print(f"\n  VERDICTS ({total:,} injuries investigated):")
    for v in ["confirmed_absence", "minor_absence", "played_then_missed", "offseason_missed_games", "offseason_career_ending", "offseason_no_miss", "uncertain_gap", "played_through", "no_games_missed", "player_not_found"]:
        cnt = verdicts.get(v, 0)
        pct = round(cnt / total * 100) if total > 0 else 0
        print(f"    {v}: {cnt:,} ({pct}%)")

    # Start gap distribution
    gap_buckets = {"0-3d": 0, "4-7d": 0, "8-10d": 0, "11-14d": 0, "15-21d": 0, "21+d": 0, "n/a": 0}
    for r in results:
        sg = r.get("start_gap_days")
        if sg is None: gap_buckets["n/a"] += 1
        elif sg <= 3: gap_buckets["0-3d"] += 1
        elif sg <= 7: gap_buckets["4-7d"] += 1
        elif sg <= 10: gap_buckets["8-10d"] += 1
        elif sg <= 14: gap_buckets["11-14d"] += 1
        elif sg <= 21: gap_buckets["15-21d"] += 1
        else: gap_buckets["21+d"] += 1

    print(f"\n  START GAP (days between injury date and last game played):")
    for bk in ["0-3d", "4-7d", "8-10d", "11-14d", "15-21d", "21+d", "n/a"]:
        cnt = gap_buckets[bk]
        pct = round(cnt / total * 100) if total > 0 else 0
        print(f"    {bk}: {cnt:,} ({pct}%)")

    # Return gap distribution
    ret_buckets = {"0-3d": 0, "4-7d": 0, "8-10d": 0, "11-14d": 0, "15-21d": 0, "21+d": 0, "n/a": 0}
    for r in results:
        rg = r.get("return_gap_days")
        if rg is None: ret_buckets["n/a"] += 1
        elif rg <= 3: ret_buckets["0-3d"] += 1
        elif rg <= 7: ret_buckets["4-7d"] += 1
        elif rg <= 10: ret_buckets["8-10d"] += 1
        elif rg <= 14: ret_buckets["11-14d"] += 1
        elif rg <= 21: ret_buckets["15-21d"] += 1
        else: ret_buckets["21+d"] += 1

    print(f"\n  RETURN GAP (days between injury date and first game back):")
    for bk in ["0-3d", "4-7d", "8-10d", "11-14d", "15-21d", "21+d", "n/a"]:
        cnt = ret_buckets[bk]
        pct = round(cnt / total * 100) if total > 0 else 0
        print(f"    {bk}: {cnt:,} ({pct}%)")

    # By source
    print(f"\n  BY SOURCE (top sources):")
    by_source = defaultdict(lambda: defaultdict(int))
    for r in results:
        src = (r.get("source") or "unknown").split(" ")[0][:25]
        by_source[src][r["verdict"]] += 1

    for src in sorted(by_source, key=lambda s: -sum(by_source[s].values()))[:10]:
        total_src = sum(by_source[src].values())
        confirmed = by_source[src].get("confirmed_absence", 0) + by_source[src].get("minor_absence", 0)
        played = by_source[src].get("played_through", 0)
        no_miss = by_source[src].get("no_games_missed", 0)
        pct_real = round(confirmed / total_src * 100) if total_src > 0 else 0
        print(f"    {src}: {total_src:,} total, {confirmed:,} confirmed ({pct_real}%), {played:,} played through, {no_miss:,} no games missed")

    # Sample details
    if player_filter:
        print(f"\n  DETAILED RESULTS:")
        for r in results[:30]:
            print(f"    {r['reported_start']} {r['injury_type']}: {r['verdict']}")
            print(f"      {r['detail']}")
            print(f"      Last played: {r.get('last_game_before', '?')}, First back: {r.get('first_game_after', '?')}")
            if r.get("return_diff_days") is not None:
                print(f"      Reported return: {r['reported_end']}, Actual: {r['first_game_after']} (diff: {r['return_diff_days']}d)")

    # Save
    out_file = os.path.join(DATA_DIR, f"injury_investigation_{league}.json")
    with open(out_file, "w") as f:
        json.dump(results, f, indent=2, default=str)
    print(f"\n  Saved: {out_file}")

    # Save to DB if requested
    if save_to_db:
        print("  Updating corrected injuries table with verdicts...")
        import psycopg2
        conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"])
        cur = conn.cursor()

        # Clear and repopulate
        cur.execute("DELETE FROM back_in_play_injuries_corrected WHERE league_slug = %s", (league,))
        conn.commit()

        rows = []
        for r in results:
            # Determine grade based on verdict + date proximity
            gm = r.get("games_missed", 0)
            ret_diff = r.get("return_diff_days")
            verdict = r["verdict"]

            start_gap = r.get("start_gap_days")
            return_gap = r.get("return_gap_days")

            if verdict == "confirmed_absence" and gm >= 3:
                if start_gap is not None and start_gap <= 7:
                    if ret_diff is not None and abs(ret_diff) <= 7:
                        grade = "A"
                    else:
                        grade = "B"
                else:
                    grade = "C"  # absence found but start too far
            elif verdict in ("minor_absence", "played_then_missed"):
                if start_gap is not None and start_gap <= 7:
                    grade = "B"
                else:
                    grade = "C"
            elif verdict == "offseason_missed_games":
                # Offseason injury that caused missed games — keep with B
                # Use first_game_after as verified return date
                grade = "B"
            elif verdict == "offseason_career_ending":
                grade = "C"  # real but can't verify return
            elif verdict == "offseason_no_miss":
                grade = "U"  # offseason, no games missed — useless
            elif verdict == "uncertain_gap":
                grade = "D"
            elif verdict == "played_through":
                grade = "C"
            elif verdict == "no_games_missed":
                grade = "U"
            elif verdict == "player_not_found":
                grade = "U"
            else:
                grade = "C"

            reported_end = r.get("reported_end")
            if reported_end == "" or reported_end == "None" or (isinstance(reported_end, str) and reported_end > "2027"):
                reported_end = None
            reported_start = r.get("reported_start")
            if reported_start == "" or reported_start == "None":
                reported_start = None

            first_back = r.get("first_game_after")
            last_before = r.get("last_game_before")

            rows.append((
                r.get("injury_id"), r.get("player_id"), r.get("player"), league,
                last_before,  # date_injured = last game before absence
                first_back,   # return_date = first game back
                gm,           # games_missed
                reported_start, reported_end, r.get("reported_games_missed"),
                r.get("injury_type"), None,
                grade,
                start_gap,  # start_day_diff = days between injury date and last game
                abs(ret_diff) if ret_diff is not None else return_gap,  # return_day_diff
                None,
                f"{verdict}: {r.get('detail', '')} | start_gap={start_gap}d return_gap={return_gap}d"
            ))

        # Batch insert
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
                print(f"    {inserted:,} / {len(rows):,} inserted...")

        print(f"    Inserted {inserted:,} injuries")
        conn.close()


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
