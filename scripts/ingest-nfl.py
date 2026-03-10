#!/usr/bin/env python3
"""
NFL Injury Ingestion from nflverse (2015-2024) + ESPN current
Source: https://github.com/nflverse/nflverse-data
Uses correct historical team at time of injury via nflverse weekly reports.
"""

import csv, io, json, os, re, requests
from collections import defaultdict
from datetime import datetime, timedelta, date

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
}

NFL_TEAMS = {
    "ARI": "Arizona Cardinals", "ATL": "Atlanta Falcons", "BAL": "Baltimore Ravens",
    "BUF": "Buffalo Bills", "CAR": "Carolina Panthers", "CHI": "Chicago Bears",
    "CIN": "Cincinnati Bengals", "CLE": "Cleveland Browns", "DAL": "Dallas Cowboys",
    "DEN": "Denver Broncos", "DET": "Detroit Lions", "GB": "Green Bay Packers",
    "HOU": "Houston Texans", "IND": "Indianapolis Colts", "JAX": "Jacksonville Jaguars",
    "JAC": "Jacksonville Jaguars", "KC": "Kansas City Chiefs", "LAC": "Los Angeles Chargers",
    "LAR": "Los Angeles Rams", "LV": "Las Vegas Raiders", "MIA": "Miami Dolphins",
    "MIN": "Minnesota Vikings", "NE": "New England Patriots", "NO": "New Orleans Saints",
    "NYG": "New York Giants", "NYJ": "New York Jets", "OAK": "Las Vegas Raiders",
    "PHI": "Philadelphia Eagles", "PIT": "Pittsburgh Steelers", "SD": "Los Angeles Chargers",
    "SEA": "Seattle Seahawks", "SF": "San Francisco 49ers", "STL": "Los Angeles Rams",
    "TB": "Tampa Bay Buccaneers", "TEN": "Tennessee Titans", "WAS": "Washington Commanders",
    "WSH": "Washington Commanders",
}

STATUS_MAP = {"Out": "out", "Doubtful": "doubtful", "Questionable": "questionable", "Probable": "probable"}
POSITION_MAP = {
    "QB": "Quarterback", "RB": "Running Back", "WR": "Wide Receiver", "TE": "Tight End",
    "OL": "Offensive Lineman", "OT": "Offensive Tackle", "OG": "Guard", "C": "Center",
    "DL": "Defensive Lineman", "DE": "Defensive End", "DT": "Defensive Tackle",
    "LB": "Linebacker", "CB": "Cornerback", "S": "Safety", "FS": "Free Safety",
    "SS": "Strong Safety", "K": "Kicker", "P": "Punter", "LS": "Long Snapper",
    "FB": "Fullback", "DB": "Defensive Back", "T": "Offensive Tackle", "G": "Guard",
}


def slugify(text):
    text = text.lower()
    text = re.sub(r"[^a-z0-9\s-]", "", text)
    return re.sub(r"[\s]+", "-", text.strip())


def injury_slug(t):
    return slugify(t.split(",")[0].strip()) or "other" if t else "other"


def batch_upsert(table, records, on_conflict=None, chunk=500):
    if not records:
        return 0
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    params = {"on_conflict": on_conflict} if on_conflict else {}
    # For upsert use Prefer header
    upsert_headers = dict(HEADERS)
    upsert_headers["Prefer"] = "resolution=merge-duplicates,return=minimal"
    total = 0
    for i in range(0, len(records), chunk):
        batch = records[i:i+chunk]
        r = requests.post(url, headers=upsert_headers, json=batch, params=params, timeout=60)
        if r.status_code not in (200, 201, 204):
            print(f"    UPSERT ERROR [{table}]: {r.status_code} {r.text[:300]}")
        else:
            total += len(batch)
    return total


def batch_insert(table, records, chunk=500):
    """Plain insert, ignore conflicts."""
    if not records:
        return 0
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    ins_headers = dict(HEADERS)
    ins_headers["Prefer"] = "return=minimal"
    total = 0
    for i in range(0, len(records), chunk):
        batch = records[i:i+chunk]
        r = requests.post(url, headers=ins_headers, json=batch, timeout=60)
        if r.status_code not in (200, 201):
            print(f"    INSERT ERROR [{table}]: {r.status_code} {r.text[:200]}")
        else:
            total += len(batch)
    return total


def select_all(table, columns="*", eq_filter=None):
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    params = {"select": columns}
    if eq_filter:
        params.update(eq_filter)
    results = []
    offset = 0
    while True:
        params["offset"] = offset
        params["limit"] = 1000
        r = requests.get(url, headers=HEADERS, params=params, timeout=30)
        if r.status_code != 200:
            break
        batch = r.json()
        results.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000
    return results


def main():
    print("=== NFL Injury Ingestion (nflverse 2015-2024) ===\n")

    # Create league
    batch_upsert("back_in_play_leagues", [{"league_name": "NFL", "slug": "nfl"}], on_conflict="slug")
    league = select_all("back_in_play_leagues", eq_filter={"slug": "eq.nfl"})[0]
    league_id = league["league_id"]
    print(f"League: NFL ({league_id})")

    # Create teams
    unique_teams = sorted(set(NFL_TEAMS.values()))
    team_records = [{"team_name": n, "league_id": league_id} for n in unique_teams]
    batch_upsert("back_in_play_teams", team_records)
    teams_db = select_all("back_in_play_teams", eq_filter={"league_id": f"eq.{league_id}"})
    team_name_to_id = {t["team_name"]: t["team_id"] for t in teams_db}
    # Also build abbr → team_id
    team_abbr_to_id = {abbr: team_name_to_id.get(name) for abbr, name in NFL_TEAMS.items() if name in team_name_to_id}
    print(f"Teams: {len(team_name_to_id)}\n")

    # --- Phase 1: Download all years and collect all data ---
    # players_by_gsis: gsis_id → {name, position, most_recent_team_id, most_recent_year}
    players_by_gsis = {}
    # injuries: list of {gsis_id, injury_type, date_injured, status, source}
    all_injury_episodes = []

    for year in range(2015, 2025):
        url = f"https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_{year}.csv"
        r = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=30, allow_redirects=True)
        if r.status_code != 200:
            print(f"  {year}: skip (HTTP {r.status_code})")
            continue

        rows = list(csv.DictReader(io.StringIO(r.text)))
        print(f"  {year}: {len(rows)} weekly report rows")

        # Group by (gsis_id, team_abbr, injury_type) to form injury episodes
        episodes = defaultdict(list)
        for row in rows:
            gsis_id = row.get("gsis_id", "").strip()
            full_name = row.get("full_name", "").strip()
            team_abbr = row.get("team", "").strip()
            status_raw = row.get("report_status", "").strip()
            primary = row.get("report_primary_injury", "").strip()
            secondary = row.get("report_secondary_injury", "").strip()
            position = row.get("position", "").strip()
            date_mod = row.get("date_modified", "").strip()
            week = int(row.get("week", 0) or 0)

            if not gsis_id or not full_name or not team_abbr or not status_raw:
                continue
            if status_raw not in STATUS_MAP:
                continue

            injury = (primary or secondary or "Undisclosed").split(",")[0].strip().title()
            team_id = team_abbr_to_id.get(team_abbr)
            if not team_id:
                continue

            # Update player info (use latest year's info)
            if gsis_id not in players_by_gsis or year > players_by_gsis[gsis_id]["year"]:
                players_by_gsis[gsis_id] = {
                    "name": full_name,
                    "position": POSITION_MAP.get(position, position or "Unknown"),
                    "team_id": team_id,
                    "year": year,
                }

            key = (gsis_id, team_abbr, injury, year)
            episodes[key].append({
                "week": week,
                "status": STATUS_MAP[status_raw],
                "date_mod": date_mod,
                "team_id": team_id,
            })

        # Convert episodes to injury records
        for (gsis_id, team_abbr, injury_type, ep_year), entries in episodes.items():
            entries.sort(key=lambda x: x["week"])
            first = entries[0]
            last = entries[-1]

            # Date from first entry's date_modified
            date_injured = None
            if first["date_mod"]:
                try:
                    dt = datetime.fromisoformat(first["date_mod"].replace("Z", "+00:00"))
                    date_injured = dt.date().isoformat()
                except:
                    pass
            if not date_injured:
                wk = max(1, first["week"])
                season_start = date(ep_year, 9, 5)
                date_injured = (season_start + timedelta(weeks=wk - 1)).isoformat()

            all_injury_episodes.append({
                "_gsis_id": gsis_id,
                "_team_abbr": team_abbr,
                "injury_type": injury_type,
                "injury_type_slug": injury_slug(injury_type),
                "injury_description": f"{injury_type} injury ({ep_year} season)",
                "date_injured": date_injured,
                "status": last["status"],
                "source": f"nflverse ({ep_year})",
            })

    print(f"\nTotal players found: {len(players_by_gsis)}")
    print(f"Total injury episodes: {len(all_injury_episodes)}\n")

    # --- Phase 2: Insert players (deduplicated by gsis_id) ---
    player_records = []
    for gsis_id, info in players_by_gsis.items():
        slug = f"{slugify(info['name'])}-{gsis_id[-7:]}"
        player_records.append({
            "player_name": info["name"],
            "team_id": info["team_id"],
            "position": info["position"],
            "slug": slug,
        })

    # Deduplicate slugs within batch (keep first occurrence)
    seen_slugs = set()
    unique_players = []
    for p in player_records:
        if p["slug"] not in seen_slugs:
            seen_slugs.add(p["slug"])
            unique_players.append(p)

    print(f"Inserting {len(unique_players)} unique players...")
    batch_upsert("back_in_play_players", unique_players, on_conflict="slug")

    # Fetch all inserted players
    print("Fetching player IDs...")
    all_players = select_all("back_in_play_players", columns="player_id,slug")
    slug_to_pid = {p["slug"]: p["player_id"] for p in all_players}

    # Build gsis_id → player_id mapping
    gsis_to_pid = {}
    for gsis_id, info in players_by_gsis.items():
        slug = f"{slugify(info['name'])}-{gsis_id[-7:]}"
        pid = slug_to_pid.get(slug)
        if pid:
            gsis_to_pid[gsis_id] = pid

    # --- Phase 3: Insert injuries ---
    final_injuries = []
    for irec in all_injury_episodes:
        gsis_id = irec.pop("_gsis_id")
        irec.pop("_team_abbr", None)
        pid = gsis_to_pid.get(gsis_id)
        if pid:
            irec["player_id"] = pid
            final_injuries.append(irec)

    print(f"Inserting {len(final_injuries)} injury records...")
    inserted = batch_insert("back_in_play_injuries", final_injuries)
    print(f"  → Inserted {inserted} injuries")

    # --- Phase 4: ESPN current 2025 season ---
    print("\nFetching ESPN current 2025 NFL injuries...")
    r = requests.get(
        "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries",
        headers={"User-Agent": "Mozilla/5.0"}, timeout=15
    )
    if r.status_code == 200:
        data = r.json()
        espn_players = []
        espn_injuries = []
        today = date.today().isoformat()

        for team_data in data.get("injuries", []):
            team_name = team_data.get("displayName", "")
            team_id = team_name_to_id.get(team_name)
            if not team_id:
                continue

            for inj in team_data.get("injuries", []):
                athlete = inj.get("athlete", {})
                player_name = athlete.get("displayName", "")
                if not player_name:
                    continue
                status_raw = inj.get("status", "").lower()
                status_map = {"out": "out", "questionable": "questionable",
                              "doubtful": "doubtful", "probable": "probable"}
                status = status_map.get(status_raw)
                if not status:
                    continue

                short = inj.get("shortComment", "")
                m = re.search(r"\(([^)]{1,35})\)", short)
                injury_type = m.group(1).title() if m else "Undisclosed"
                pos_info = athlete.get("position", {})
                position = pos_info.get("abbreviation", "") if isinstance(pos_info, dict) else ""

                # Use ESPN athlete ID for unique slug
                links = athlete.get("links", [])
                athlete_id = ""
                for lnk in links:
                    href = lnk.get("href", "")
                    m2 = re.search(r"/id/(\d+)/", href)
                    if m2:
                        athlete_id = m2.group(1)
                        break
                slug = f"{slugify(player_name)}-espn{athlete_id or slugify(team_name)[:8]}"

                espn_players.append({
                    "player_name": player_name, "team_id": team_id,
                    "position": POSITION_MAP.get(position, position or "Unknown"), "slug": slug,
                })
                espn_injuries.append({
                    "_slug": slug,
                    "injury_type": injury_type, "injury_type_slug": injury_slug(injury_type),
                    "injury_description": short[:200] or f"{injury_type} injury",
                    "date_injured": today, "status": status, "source": "espn-nfl-2025",
                })

        # Dedup by slug
        seen = set()
        deduped = []
        for p in espn_players:
            if p["slug"] not in seen:
                seen.add(p["slug"])
                deduped.append(p)
        batch_upsert("back_in_play_players", deduped, on_conflict="slug")

        all_p = select_all("back_in_play_players", columns="player_id,slug")
        slug_map = {p["slug"]: p["player_id"] for p in all_p}
        final_espn = []
        for irec in espn_injuries:
            slug = irec.pop("_slug")
            pid = slug_map.get(slug)
            if pid:
                irec["player_id"] = pid
                final_espn.append(irec)
        batch_insert("back_in_play_injuries", final_espn)
        print(f"  ESPN 2025: {len(final_espn)} current injuries added")

    # --- Summary ---
    nfl_injuries = select_all("back_in_play_injuries",
        columns="injury_id",
        eq_filter={"player_id": f"in.({','.join(list(gsis_to_pid.values())[:100])})"})
    print(f"\n✅ NFL ingestion complete!")
    totals = select_all("back_in_play_injuries", columns="injury_id")
    print(f"   Total injuries in DB: {len(totals)}")


if __name__ == "__main__":
    main()
