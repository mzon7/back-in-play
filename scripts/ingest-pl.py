#!/usr/bin/env python3
"""
Premier League Injury Ingestion
Sources:
- GitHub CSV: keremkarayaz (2019/20 - 2023/24) - 657 records with real injury data
- Grok API: Historical seasons 2015/16 - 2018/19 based on known injuries
- ESPN API: Current 2024/25 season
"""

import os, re, requests, json, csv, io
from datetime import date, datetime

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
SUPABASE_PROJECT_REF = os.environ.get("SUPABASE_PROJECT_REF", "")
SUPABASE_MGMT_TOKEN = os.environ.get("SUPABASE_MGMT_TOKEN", "")
GROK_API_KEY = os.environ.get("GROK_API_KEY", "")
HEADERS = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"}
HTTP = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}

PL_TEAMS_2024 = [
    "Arsenal", "Aston Villa", "AFC Bournemouth", "Brentford", "Brighton & Hove Albion",
    "Chelsea", "Crystal Palace", "Everton", "Fulham", "Ipswich Town",
    "Leicester City", "Liverpool", "Manchester City", "Manchester United",
    "Newcastle United", "Nottingham Forest", "Southampton", "Tottenham Hotspur",
    "West Ham United", "Wolverhampton Wanderers",
]
# Historical PL teams (relegated/promoted over the years)
PL_HISTORICAL_TEAMS = PL_TEAMS_2024 + [
    "Burnley", "Leeds United", "Norwich City", "Watford", "Sheffield United",
    "Huddersfield Town", "Swansea City", "Stoke City", "West Bromwich Albion",
    "Middlesbrough", "Hull City", "Sunderland", "Queens Park Rangers",
    "Cardiff City", "Reading", "Derby County", "Blackpool",
]


def slugify(text):
    text = text.lower()
    text = re.sub(r"[^a-z0-9\s-]", "", text)
    return re.sub(r"[\s]+", "-", text.strip())


def injury_slug(t):
    return slugify(t.split(",")[0].strip()) or "other" if t else "other"


def sql(query):
    r = requests.post(
        f"https://api.supabase.com/v1/projects/{SUPABASE_PROJECT_REF}/database/query",
        headers={"Authorization": f"Bearer {SUPABASE_MGMT_TOKEN}", "Content-Type": "application/json"},
        json={"query": query}, timeout=60
    )
    if r.status_code not in (200, 201):
        print(f"SQL ERROR: {r.status_code} {r.text[:200]}")
        return []
    data = r.json()
    return data if isinstance(data, list) else []


def bulk_insert(table, records, chunk=200):
    if not records:
        return 0
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    h = dict(HEADERS)
    h["Prefer"] = "return=minimal"
    total = 0
    for i in range(0, len(records), chunk):
        batch = records[i:i+chunk]
        r = requests.post(url, headers=h, json=batch, timeout=60)
        if r.status_code not in (200, 201, 204):
            for rec in batch:
                r2 = requests.post(url, headers=h, json=[rec], timeout=30)
                if r2.status_code in (200, 201, 204):
                    total += 1
        else:
            total += len(batch)
    return total


def grok_query(prompt, system="You are a sports data expert. Respond only with valid JSON."):
    """Call Grok API for generating historical sports injury data."""
    if not GROK_API_KEY:
        return None
    try:
        r = requests.post(
            "https://api.x.ai/v1/chat/completions",
            headers={"Authorization": f"Bearer {GROK_API_KEY}", "Content-Type": "application/json"},
            json={
                "model": "grok-3-mini",
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0.1,
                "max_tokens": 4000,
            },
            timeout=60
        )
        if r.status_code == 200:
            content = r.json()["choices"][0]["message"]["content"]
            # Extract JSON from response
            m = re.search(r"\[.*\]", content, re.DOTALL)
            if m:
                return json.loads(m.group(0))
        else:
            print(f"  Grok error: {r.status_code} {r.text[:100]}")
    except Exception as e:
        print(f"  Grok exception: {e}")
    return None


def normalize_team_name(name, team_id_map):
    """Normalize team name to match our DB."""
    if name in team_id_map:
        return name
    # Try common variations
    variations = {
        "Man United": "Manchester United", "Man City": "Manchester City",
        "Man Utd": "Manchester United", "Man Utd.": "Manchester United",
        "Spurs": "Tottenham Hotspur", "Tottenham": "Tottenham Hotspur",
        "Newcastle": "Newcastle United", "Wolves": "Wolverhampton Wanderers",
        "West Ham": "West Ham United", "Brighton": "Brighton & Hove Albion",
        "Leicester": "Leicester City", "Bournemouth": "AFC Bournemouth",
        "Nottm Forest": "Nottingham Forest", "Nott'm Forest": "Nottingham Forest",
        "Sheffield Utd": "Sheffield United", "Huddersfield": "Huddersfield Town",
        "West Brom": "West Bromwich Albion", "Hull": "Hull City",
        "Stoke": "Stoke City", "Norwich": "Norwich City", "Leeds": "Leeds United",
        "Burnley FC": "Burnley", "Leeds United FC": "Leeds United",
    }
    normalized = variations.get(name, name)
    return normalized if normalized in team_id_map else None


def main():
    print("=== Premier League Injury Ingestion ===\n")

    # Setup league
    sql("INSERT INTO back_in_play_leagues(league_name,slug) VALUES('Premier League','premier-league') ON CONFLICT(slug) DO NOTHING")
    result = sql("SELECT league_id FROM back_in_play_leagues WHERE slug='premier-league'")
    league_id = result[0]["league_id"]
    print(f"League: Premier League ({league_id})")

    # Setup teams
    all_teams = sorted(set(PL_HISTORICAL_TEAMS))
    for t in all_teams:
        t_esc = t.replace("'", "''")
        sql(f"INSERT INTO back_in_play_teams(team_name,league_id) VALUES('{t_esc}','{league_id}') ON CONFLICT(team_name,league_id) DO NOTHING")

    teams_db = sql(f"SELECT team_id, team_name FROM back_in_play_teams WHERE league_id='{league_id}'")
    team_id_map = {t["team_name"]: t["team_id"] for t in teams_db}
    print(f"Teams: {len(team_id_map)}")

    all_players = {}  # slug → {player_name, team_id, position}
    all_injuries = []  # list of injury records

    # =========================================
    # SOURCE 1: GitHub CSV (2019/20 - 2023/24)
    # =========================================
    print("\n[1] GitHub CSV (2019/20 - 2023/24)...")
    csv_url = "https://raw.githubusercontent.com/keremkarayaz/Premier-League-Injuries/main/player_injuries_impact.csv"
    r = requests.get(csv_url, headers=HTTP, timeout=20)
    if r.status_code == 200:
        reader = csv.DictReader(io.StringIO(r.text))
        csv_count = 0
        for row in reader:
            player_name = row.get("Name", "").strip()
            team_name = row.get("Team Name", "").strip()
            position = row.get("Position", "").strip()
            season = row.get("Season", "").strip()  # e.g. "2019/20"
            injury = row.get("Injury", "").strip()
            date_injured_str = row.get("Date of Injury", "").strip()
            date_return_str = row.get("Date of return", "").strip()

            if not player_name or not team_name or not injury:
                continue

            # Normalize team name
            team_id = team_id_map.get(team_name)
            if not team_id:
                normalized = normalize_team_name(team_name, team_id_map)
                if normalized:
                    team_id = team_id_map[normalized]
                else:
                    continue

            # Parse dates
            def parse_date(ds):
                for fmt in ["%b %d, %Y", "%d/%m/%Y", "%Y-%m-%d", "%d %b %Y"]:
                    try:
                        return datetime.strptime(ds.strip(), fmt).date().isoformat()
                    except:
                        pass
                return None

            date_injured = parse_date(date_injured_str)
            date_return = parse_date(date_return_str)
            if not date_injured:
                continue

            # Compute status
            status = "returned" if date_return else "out"

            # Player slug
            slug = f"{slugify(player_name)}-pl{slugify(team_name)[:8]}"

            if slug not in all_players:
                all_players[slug] = {
                    "player_name": player_name,
                    "team_id": team_id,
                    "position": position or "Unknown",
                    "slug": slug,
                }
            all_injuries.append({
                "_slug": slug,
                "injury_type": injury,
                "injury_type_slug": injury_slug(injury),
                "injury_description": f"{injury} - {season} Premier League season",
                "date_injured": date_injured,
                "expected_return_date": date_return,
                "return_date": date_return,
                "status": status,
                "source": f"pl-github-csv ({season})",
            })
            csv_count += 1
        print(f"  Parsed {csv_count} injuries from CSV")
    else:
        print(f"  CSV fetch failed: {r.status_code}")

    # =========================================
    # SOURCE 2: Grok for 2015/16 - 2018/19
    # =========================================
    if GROK_API_KEY:
        print("\n[2] Grok API for historical seasons (2015/16 - 2018/19)...")
        historical_seasons = [
            ("2015/16", "2015-16"),
            ("2016/17", "2016-17"),
            ("2017/18", "2017-18"),
            ("2018/19", "2018-19"),
        ]
        for display_season, season_code in historical_seasons:
            print(f"  Fetching {display_season}...")
            prompt = f"""List all significant Premier League player injuries from the {display_season} season.
For each injury include:
- player_name (full name)
- team (exact Premier League club name that season)
- position (Goalkeeper/Defender/Midfielder/Forward)
- injury_type (e.g., "Knee ligament injury", "Hamstring strain", "Ankle injury", "ACL tear", "Concussion", etc.)
- date_injured (approximate date in YYYY-MM-DD format)
- date_return (approximate return date or null if unknown)
- status (out/returned/questionable)

Include at minimum 40-60 significant injuries that season (major players and well-known incidents).
Focus on injuries that kept players out for more than 1 week.
Return as JSON array only, no other text.
Example format:
[{{"player_name": "Harry Kane", "team": "Tottenham Hotspur", "position": "Forward", "injury_type": "Ankle injury", "date_injured": "2016-09-18", "date_return": "2016-10-15", "status": "returned"}}]"""

            injuries_grok = grok_query(prompt)
            if injuries_grok:
                grok_count = 0
                for inj in injuries_grok:
                    player_name = str(inj.get("player_name", "")).strip()
                    team_name = str(inj.get("team", "")).strip()
                    position = str(inj.get("position", "Unknown")).strip()
                    injury_type = str(inj.get("injury_type", "Unknown")).strip()
                    date_injured = str(inj.get("date_injured", "")).strip()
                    date_return = inj.get("date_return")
                    if date_return:
                        date_return = str(date_return).strip()
                    status = str(inj.get("status", "returned")).strip()
                    if status not in ["out", "returned", "questionable", "doubtful", "probable"]:
                        status = "returned"

                    if not player_name or not team_name or not date_injured:
                        continue
                    if not re.match(r"\d{4}-\d{2}-\d{2}", date_injured):
                        continue

                    team_id = team_id_map.get(team_name)
                    if not team_id:
                        normalized = normalize_team_name(team_name, team_id_map)
                        if normalized:
                            team_id = team_id_map[normalized]
                        else:
                            continue

                    slug = f"{slugify(player_name)}-pl{slugify(team_name)[:8]}"
                    if slug not in all_players:
                        all_players[slug] = {
                            "player_name": player_name,
                            "team_id": team_id,
                            "position": position,
                            "slug": slug,
                        }
                    all_injuries.append({
                        "_slug": slug,
                        "injury_type": injury_type,
                        "injury_type_slug": injury_slug(injury_type),
                        "injury_description": f"{injury_type} - {display_season} Premier League season",
                        "date_injured": date_injured,
                        "expected_return_date": date_return,
                        "return_date": date_return,
                        "status": status,
                        "source": f"grok-pl ({display_season})",
                    })
                    grok_count += 1
                print(f"  {display_season}: {grok_count} injuries from Grok")
            else:
                print(f"  {display_season}: Grok returned no data")
    else:
        print("\n[2] Skipping Grok (no API key)")

    # =========================================
    # SOURCE 3: ESPN current 2024/25 season
    # =========================================
    print("\n[3] ESPN current Premier League injuries...")
    # Try ESPN's soccer endpoint - fetch each team
    espn_teams = requests.get("https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams",
        headers=HTTP, timeout=15)
    if espn_teams.status_code == 200:
        sports = espn_teams.json().get("sports", [{}])[0].get("leagues", [{}])[0].get("teams", [])
        espn_count = 0
        today = date.today().isoformat()
        for team_entry in sports:
            team_info = team_entry.get("team", {})
            team_id_espn = team_info.get("id", "")
            team_name_espn = team_info.get("displayName", "")
            team_id = team_id_map.get(team_name_espn)
            if not team_id:
                normalized = normalize_team_name(team_name_espn, team_id_map)
                if normalized:
                    team_id = team_id_map[normalized]
                else:
                    continue

            # Get team injuries
            r_inj = requests.get(
                f"https://sports.core.api.espn.com/v2/sports/soccer/leagues/eng.1/teams/{team_id_espn}/injuries",
                headers=HTTP, params={"lang": "en", "region": "us", "limit": 50}, timeout=10
            )
            if r_inj.status_code != 200:
                continue

            inj_data = r_inj.json()
            for item in inj_data.get("items", []):
                ref = item.get("$ref", "")
                if not ref:
                    continue
                r_detail = requests.get(ref, headers=HTTP, timeout=10)
                if r_detail.status_code != 200:
                    continue
                detail = r_detail.json()

                athlete = detail.get("athlete", {})
                if isinstance(athlete, dict) and "$ref" in athlete:
                    r_ath = requests.get(athlete["$ref"], headers=HTTP, timeout=10)
                    if r_ath.status_code == 200:
                        athlete = r_ath.json()

                player_name = athlete.get("displayName", "")
                if not player_name:
                    continue

                status_type = detail.get("type", {})
                status_raw = status_type.get("description", "Out").lower() if isinstance(status_type, dict) else "out"
                status_map = {"out": "out", "questionable": "questionable", "doubtful": "doubtful"}
                status = status_map.get(status_raw, "out")

                injury_type = detail.get("shortText", "") or "Undisclosed"
                inj_date = detail.get("date", today)[:10]

                pos_info = athlete.get("position", {})
                position = pos_info.get("displayName", "Unknown") if isinstance(pos_info, dict) else "Unknown"

                slug = f"{slugify(player_name)}-plespn{team_id_espn}"
                if slug not in all_players:
                    all_players[slug] = {
                        "player_name": player_name,
                        "team_id": team_id,
                        "position": position,
                        "slug": slug,
                    }
                all_injuries.append({
                    "_slug": slug,
                    "injury_type": injury_type,
                    "injury_type_slug": injury_slug(injury_type),
                    "injury_description": detail.get("longText", injury_type)[:200],
                    "date_injured": inj_date,
                    "status": status,
                    "source": "espn-pl-current",
                })
                espn_count += 1

        print(f"  ESPN current: {espn_count} injuries")

        # If ESPN per-team failed (0 injuries), try the aggregated endpoint
        if espn_count == 0:
            r_agg = requests.get("https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/injuries",
                headers=HTTP, timeout=15)
            if r_agg.status_code == 200:
                agg_data = r_agg.json()
                for team_data in agg_data.get("injuries", []):
                    team_name_espn = team_data.get("displayName", "")
                    team_id = team_id_map.get(team_name_espn) or team_id_map.get(
                        normalize_team_name(team_name_espn, team_id_map))
                    if not team_id:
                        continue
                    for inj in team_data.get("injuries", []):
                        athlete = inj.get("athlete", {})
                        player_name = athlete.get("displayName", "")
                        if not player_name:
                            continue
                        status_raw = inj.get("status", "").lower()
                        status = {"out": "out", "questionable": "questionable",
                                  "doubtful": "doubtful"}.get(status_raw, "out")
                        short = inj.get("shortComment", "")
                        m = re.search(r"\(([^)]{1,35})\)", short)
                        injury_type = m.group(1).title() if m else "Undisclosed"
                        slug = f"{slugify(player_name)}-plespnagg"
                        if slug not in all_players:
                            all_players[slug] = {"player_name": player_name,
                                                 "team_id": team_id, "position": "Unknown", "slug": slug}
                        all_injuries.append({
                            "_slug": slug,
                            "injury_type": injury_type, "injury_type_slug": injury_slug(injury_type),
                            "injury_description": short[:200] or injury_type,
                            "date_injured": today, "status": status, "source": "espn-pl-current",
                        })
                        espn_count += 1
                print(f"  ESPN aggregated: {espn_count} injuries")

    # =========================================
    # Insert all data
    # =========================================
    print(f"\nTotal players: {len(all_players)}")
    print(f"Total injuries: {len(all_injuries)}")
    print("\nInserting players...")

    player_list = list(all_players.values())
    for i in range(0, len(player_list), 50):
        batch = player_list[i:i+50]
        values = []
        for p in batch:
            n = p["player_name"].replace("'", "''")
            pos = p["position"].replace("'", "''")
            values.append(f"('{n}','{p['team_id']}','{pos}','{p['slug']}')")
        if values:
            sql(f"""INSERT INTO back_in_play_players(player_name,team_id,position,slug)
                    VALUES {','.join(values)}
                    ON CONFLICT(slug) DO NOTHING""")

    # Get player ID map
    pl_players = sql(f"""SELECT player_id, slug FROM back_in_play_players
                         WHERE team_id IN (SELECT team_id FROM back_in_play_teams WHERE league_id='{league_id}')""")
    slug_to_pid = {p["slug"]: p["player_id"] for p in pl_players}
    print(f"  Player IDs fetched: {len(slug_to_pid)}")

    print("Inserting injuries...")
    injury_records = []
    for irec in all_injuries:
        slug = irec.pop("_slug")
        pid = slug_to_pid.get(slug)
        if pid:
            irec["player_id"] = pid
            injury_records.append(irec)

    # Remove None values
    clean_injuries = []
    for rec in injury_records:
        clean = {k: v for k, v in rec.items() if v is not None}
        clean_injuries.append(clean)

    inserted = bulk_insert("back_in_play_injuries", clean_injuries)
    print(f"  → Inserted {inserted} PL injuries")

    total = sql("SELECT COUNT(*) as c FROM back_in_play_injuries")[0]["c"]
    print(f"\n✅ Premier League done! Total injuries in DB: {total}")


if __name__ == "__main__":
    main()
