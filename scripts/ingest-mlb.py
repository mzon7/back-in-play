#!/usr/bin/env python3
"""
MLB Injury Ingestion from MLB StatsAPI (2015-2024) + ESPN current
Uses correct team at time of IL placement.
"""

import os, re, requests, json, time
from datetime import date
from collections import defaultdict

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
SUPABASE_PROJECT_REF = os.environ.get("SUPABASE_PROJECT_REF", "")
SUPABASE_MGMT_TOKEN = os.environ.get("SUPABASE_MGMT_TOKEN", "")
HEADERS = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"}
HTTP = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}
MLB_API = "https://statsapi.mlb.com/api/v1"


def slugify(text):
    text = text.lower()
    text = re.sub(r"[^a-z0-9\s-]", "", text)
    return re.sub(r"[\s]+", "-", text.strip())


def injury_slug(t):
    return slugify(t.split(",")[0].strip()) or "other" if t else "other"


def sql(query):
    """Run SQL via Management API."""
    r = requests.post(
        f"https://api.supabase.com/v1/projects/{SUPABASE_PROJECT_REF}/database/query",
        headers={"Authorization": f"Bearer {SUPABASE_MGMT_TOKEN}", "Content-Type": "application/json"},
        json={"query": query}, timeout=60
    )
    if r.status_code not in (200, 201):
        print(f"SQL ERROR: {r.status_code} {r.text[:200]}")
        return []
    data = r.json()
    # Management API wraps results differently for 201 vs 200
    if isinstance(data, list):
        return data
    return []


def bulk_insert(table, records, chunk=200, ignore_conflicts=False):
    """Insert records via REST API."""
    if not records:
        return 0
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    h = dict(HEADERS)
    h["Prefer"] = "return=minimal"
    if ignore_conflicts:
        h["Prefer"] += ",resolution=ignore-duplicates"
    total = 0
    for i in range(0, len(records), chunk):
        batch = records[i:i+chunk]
        r = requests.post(url, headers=h, json=batch, timeout=60)
        if r.status_code not in (200, 201, 204):
            # Try individually
            for rec in batch:
                r2 = requests.post(url, headers=h, json=[rec], timeout=30)
                if r2.status_code in (200, 201, 204):
                    total += 1
        else:
            total += len(batch)
    return total


def parse_injury(desc):
    """Extract injury type from MLB transaction description."""
    parts = desc.split(".")
    for part in parts[1:]:
        p = part.strip()
        if 5 < len(p) < 70:
            cleaned = re.sub(r"^(Left|Right|Bilateral|Lower|Upper)\s+", "", p, flags=re.I).strip()
            if cleaned:
                return cleaned.split(".")[0].strip().title()
    # Fallback keywords
    for kw in ["knee","hamstring","elbow","shoulder","back","ankle","wrist","oblique",
               "hip","quad","calf","forearm","hand","finger","groin","foot","rib",
               "abdominal","lat","flexor","biceps","strain","sprain","fracture",
               "concussion","illness","toe","neck","nerve","tendon"]:
        if kw in desc.lower():
            idx = desc.lower().find(kw)
            s = max(0, idx-10)
            e = min(len(desc), idx+len(kw)+15)
            return desc[s:e].strip().split(".")[0].strip().title()
    return "Undisclosed"


def main():
    print("=== MLB Injury Ingestion (2015-2024) ===\n")

    # Setup league
    result = sql("SELECT league_id FROM back_in_play_leagues WHERE slug='mlb'")
    if not result:
        sql("INSERT INTO back_in_play_leagues(league_name,slug) VALUES('MLB','mlb') ON CONFLICT(slug) DO NOTHING")
        result = sql("SELECT league_id FROM back_in_play_leagues WHERE slug='mlb'")
    league_id = result[0]["league_id"]
    print(f"League: MLB ({league_id})")

    # Fetch MLB teams
    r = requests.get(f"{MLB_API}/teams", params={"sportId": "1"}, headers=HTTP, timeout=15)
    mlb_teams_raw = r.json().get("teams", []) if r.status_code == 200 else []
    active_teams = [t for t in mlb_teams_raw if t.get("sport", {}).get("id") == 1 and t.get("active")]

    # Upsert teams
    for t in active_teams:
        name = t.get("name", "")
        if name:
            sql(f"INSERT INTO back_in_play_teams(team_name,league_id) VALUES('{name.replace(chr(39),chr(39)*2)}','{league_id}') ON CONFLICT(team_name,league_id) DO NOTHING")

    # Get team map
    teams_db = sql(f"SELECT team_id, team_name FROM back_in_play_teams WHERE league_id='{league_id}'")
    team_name_to_id = {t["team_name"]: t["team_id"] for t in teams_db}
    mlb_api_id_to_team_id = {}
    for t in active_teams:
        name = t.get("name", "")
        if name in team_name_to_id:
            mlb_api_id_to_team_id[t.get("id")] = team_name_to_id[name]
    print(f"Teams: {len(team_name_to_id)}")

    # Collect all IL transactions
    # mlb_player_id -> {name, team_id (latest), position}
    players = {}  # mlb_id -> info
    injuries = []  # list of (mlb_id, injury_type, date, status, source, team_id)

    for year in range(2015, 2026):
        year_count = 0
        months = range(1, 13) if year <= 2025 else range(1, 4)
        for month in months:
            if year == 2025 and month > 3:
                break

            next_y, next_m = (year, month + 1) if month < 12 else (year + 1, 1)
            start = f"{year}-{month:02d}-01"
            end = f"{year}-{month:02d}-28" if month == 2 else (f"{year}-{month:02d}-30" if month in [4,6,9,11] else f"{year}-{month:02d}-31")

            try:
                r = requests.get(f"{MLB_API}/transactions",
                    params={"sportId": "1", "startDate": start, "endDate": end, "limit": 500},
                    headers=HTTP, timeout=20)
                if r.status_code != 200:
                    continue
                txns = r.json().get("transactions", [])
            except:
                continue

            for t in txns:
                if t.get("typeCode") != "SC":
                    continue
                desc = t.get("description", "")
                if not ("injured list" in desc.lower() or "disabled list" in desc.lower()):
                    continue
                if "activated" in desc.lower() or "reinstated" in desc.lower():
                    continue  # Skip activations
                if "transferred" in desc.lower() and "placed" not in desc.lower():
                    continue  # Skip pure transfers

                person = t.get("person", {})
                if not isinstance(person, dict):
                    continue
                mlb_id = person.get("id")
                player_name = person.get("fullName", "")
                if not player_name or not mlb_id:
                    continue

                # Team from toTeam (or extract from description)
                team_info = t.get("toTeam") or {}
                team_name = team_info.get("name", "") if isinstance(team_info, dict) else ""
                team_id = team_name_to_id.get(team_name)
                if not team_id:
                    continue

                txn_date = (t.get("effectiveDate") or t.get("date") or start)[:10]
                injury_type = parse_injury(desc)

                # Track player (latest info wins)
                if mlb_id not in players or year > players[mlb_id].get("year", 0):
                    players[mlb_id] = {
                        "name": player_name, "team_id": team_id,
                        "position": "", "year": year,
                    }

                injuries.append((mlb_id, team_id, injury_type, txn_date,
                                  f"mlb-statsapi-{year}", desc[:250]))
                year_count += 1

        print(f"  {year}: {year_count} IL placements")

    print(f"\nTotal players: {len(players)}")
    print(f"Total IL placements: {len(injuries)}")

    # Insert players
    print("\nInserting players...")
    player_records = []
    seen = set()
    for mlb_id, info in players.items():
        slug = f"{slugify(info['name'])}-mlb{mlb_id}"
        if slug in seen:
            continue
        seen.add(slug)
        player_records.append({
            "player_name": info["name"],
            "team_id": info["team_id"],
            "position": "Unknown",
            "slug": slug,
        })

    # Use SQL upsert for players
    for i in range(0, len(player_records), 50):
        batch = player_records[i:i+50]
        values = []
        for p in batch:
            n = p["player_name"].replace("'", "''")
            values.append(f"('{n}','{p['team_id']}','Unknown','{p['slug']}')")
        if values:
            sql(f"""INSERT INTO back_in_play_players(player_name,team_id,position,slug)
                    VALUES {','.join(values)}
                    ON CONFLICT(slug) DO NOTHING""")

    # Get player ID mapping
    print("Building player ID map...")
    all_players = sql("SELECT player_id, slug FROM back_in_play_players WHERE slug LIKE '%mlb%'")
    slug_to_pid = {p["slug"]: p["player_id"] for p in all_players}
    print(f"  Found {len(slug_to_pid)} MLB players in DB")

    # Map mlb_id → player_id
    mlb_id_to_pid = {}
    for mlb_id in players:
        slug = f"{slugify(players[mlb_id]['name'])}-mlb{mlb_id}"
        pid = slug_to_pid.get(slug)
        if pid:
            mlb_id_to_pid[mlb_id] = pid

    print(f"  Mapped {len(mlb_id_to_pid)} players")

    # Insert injuries
    print("\nInserting injuries...")
    injury_records = []
    for mlb_id, team_id, injury_type, txn_date, source, desc in injuries:
        pid = mlb_id_to_pid.get(mlb_id)
        if not pid:
            continue
        injury_records.append({
            "player_id": pid,
            "injury_type": injury_type,
            "injury_type_slug": injury_slug(injury_type),
            "injury_description": desc,
            "date_injured": txn_date,
            "status": "out",
            "source": source,
        })

    inserted = bulk_insert("back_in_play_injuries", injury_records, ignore_conflicts=True)
    print(f"  → Inserted {inserted} MLB injury records")

    # Also get activated-from-IL transactions to mark as returned
    print("\nFetching return-from-IL data for 2024-2025...")
    for year in [2024, 2025]:
        for month in range(1, 13):
            if year == 2025 and month > 3:
                break
            start = f"{year}-{month:02d}-01"
            end = f"{year}-{month:02d}-28" if month == 2 else (f"{year}-{month:02d}-30" if month in [4,6,9,11] else f"{year}-{month:02d}-31")
            try:
                r = requests.get(f"{MLB_API}/transactions",
                    params={"sportId": "1", "startDate": start, "endDate": end, "limit": 500},
                    headers=HTTP, timeout=20)
                if r.status_code != 200:
                    continue
                txns = r.json().get("transactions", [])
                for t in txns:
                    if t.get("typeCode") != "SC":
                        continue
                    desc = t.get("description", "")
                    dl = desc.lower()
                    if ("activated" in dl or "reinstated" in dl) and ("injured" in dl or " il" in dl):
                        person = t.get("person", {})
                        mlb_id = person.get("id") if isinstance(person, dict) else None
                        if mlb_id and mlb_id in mlb_id_to_pid:
                            pid = mlb_id_to_pid[mlb_id]
                            ret_date = (t.get("effectiveDate") or t.get("date") or start)[:10]
                            # Update most recent out injury for this player to returned
                            sql(f"""UPDATE back_in_play_injuries
                                    SET status='returned', return_date='{ret_date}'
                                    WHERE player_id='{pid}' AND status='out'
                                    AND date_injured = (
                                        SELECT MAX(date_injured) FROM back_in_play_injuries
                                        WHERE player_id='{pid}' AND status='out'
                                    )""")
            except:
                pass

    # ESPN current season
    print("\nFetching ESPN current MLB injuries...")
    r = requests.get("https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/injuries",
        headers=HTTP, timeout=15)
    if r.status_code == 200:
        data = r.json()
        today = date.today().isoformat()
        ep_players = []
        ep_injuries = []
        for team_data in data.get("injuries", []):
            team_name = team_data.get("displayName", "")
            team_id = team_name_to_id.get(team_name)
            if not team_id:
                continue
            for inj in team_data.get("injuries", []):
                athlete = inj.get("athlete", {})
                pname = athlete.get("displayName", "")
                if not pname:
                    continue
                status_raw = inj.get("status", "").lower()
                sm = {"out": "out", "questionable": "questionable", "doubtful": "doubtful",
                      "day-to-day": "questionable", "10-day il": "out", "15-day il": "out", "60-day il": "out"}
                status = sm.get(status_raw, "out")
                short = inj.get("shortComment", "")
                m = re.search(r"\(([^)]{1,35})\)", short)
                injury_type = m.group(1).title() if m else "Undisclosed"
                links = athlete.get("links", [])
                aid = ""
                for lnk in links:
                    m2 = re.search(r"/id/(\d+)/", lnk.get("href", ""))
                    if m2:
                        aid = m2.group(1)
                        break
                slug = f"{slugify(pname)}-espnmlb{aid}"
                ep_players.append({"player_name": pname, "team_id": team_id,
                                   "position": "Unknown", "slug": slug})
                ep_injuries.append({"_slug": slug, "injury_type": injury_type,
                                    "injury_type_slug": injury_slug(injury_type),
                                    "injury_description": short[:200] or f"{injury_type} injury",
                                    "date_injured": today, "status": status, "source": "espn-mlb-current"})

        seen2 = set()
        deduped = [p for p in ep_players if p["slug"] not in seen2 and not seen2.add(p["slug"])]
        bulk_insert("back_in_play_players", deduped)
        all_p = sql("SELECT player_id, slug FROM back_in_play_players WHERE slug LIKE '%espnmlb%'")
        slug_map = {p["slug"]: p["player_id"] for p in all_p}
        final_ep = []
        for irec in ep_injuries:
            slug = irec.pop("_slug")
            pid = slug_map.get(slug)
            if pid:
                irec["player_id"] = pid
                final_ep.append(irec)
        bulk_insert("back_in_play_injuries", final_ep)
        print(f"  ESPN current: {len(final_ep)} injuries")

    total = sql("SELECT COUNT(*) as c FROM back_in_play_injuries")[0]["c"]
    print(f"\n✅ MLB done! Total injuries in DB: {total}")


if __name__ == "__main__":
    main()
