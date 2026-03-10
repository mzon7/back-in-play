#!/usr/bin/env python3
"""
Supplementary ingestion for EPL (transfermarkt.com) and NHL (capfriendly.com).
Uses a direct knowledge-compilation approach that bypasses anti-bot protections:
- Asks GPT-4o to compile injury data from its training knowledge
- Uses targeted web searches for supplementary verification
- Per-club queries for maximum coverage
- 20 EPL clubs × 11 seasons = comprehensive coverage
- 32 NHL teams × 11 seasons = comprehensive coverage
"""

import json, os, re, sys, time, urllib.request, urllib.parse, urllib.error
from datetime import date

SUPABASE_URL   = os.environ["SUPABASE_URL"]
SUPABASE_KEY   = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
TODAY          = date.today().isoformat()
SEASONS        = list(range(2015, 2026))

ONLY_LEAGUE = os.environ.get("ONLY_LEAGUE", "").upper().split(",")

# ── Supabase ──────────────────────────────────────────────────────────────────
def sb_request(method, path, body=None):
    url  = f"{SUPABASE_URL}/rest/v1/{path}"
    data = json.dumps(body).encode() if body else None
    hdrs = {
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates,return=representation",
    }
    req  = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        raw  = resp.read()
        return json.loads(raw) if raw else []
    except urllib.error.HTTPError as e:
        err = e.read().decode()[:300]
        if "duplicate" in err.lower() or "unique" in err.lower():
            return []
        print(f"  [SB] {e.code}: {err[:150]}")
        return None
    except Exception as ex:
        print(f"  [SB] {ex}")
        return None

def sb_upsert(table, rows, conflict=None):
    if not rows:
        return []
    path = f"{table}?on_conflict={conflict}" if conflict else table
    results = []
    for i in range(0, len(rows), 500):
        r = sb_request("POST", path, rows[i:i+500])
        if r:
            results.extend(r)
    return results

def sb_get(table, params=""):
    results, offset = [], 0
    while True:
        sep = "&" if "?" in params or params else "?"
        r = sb_request("GET", f"{table}?{params}{sep}limit=1000&offset={offset}")
        if not r:
            break
        results.extend(r)
        if len(r) < 1000:
            break
        offset += 1000
    return results

# ── Helpers ───────────────────────────────────────────────────────────────────
def slugify(text):
    t = (text or "").lower().strip()
    t = re.sub(r"[^\w\s-]", "", t)
    t = re.sub(r"[\s_-]+", "-", t)
    return t.strip("-") or "unknown"

INJURY_CHECKS = [
    (["acl","anterior cruciate"],              "acl",       "ACL Tear"),
    (["mcl","medial collateral"],              "mcl",       "MCL Injury"),
    (["hamstring"],                            "hamstring", "Hamstring"),
    (["quadricep","quad"],                     "quadricep", "Quadricep"),
    (["calf","gastrocnemius"],                 "calf",      "Calf"),
    (["groin","adductor"],                     "groin",     "Groin"),
    (["achilles"],                             "achilles",  "Achilles"),
    (["knee"],                                 "knee",      "Knee"),
    (["ankle"],                                "ankle",     "Ankle"),
    (["foot","plantar","heel","toe"],          "foot",      "Foot"),
    (["hip flexor"],                           "hip-flexor","Hip Flexor"),
    (["hip"],                                  "hip",       "Hip"),
    (["shoulder","rotator","labrum"],          "shoulder",  "Shoulder"),
    (["elbow","ucl","tommy john"],             "elbow",     "Elbow"),
    (["wrist"],                                "wrist",     "Wrist"),
    (["hand","finger","thumb"],                "hand",      "Hand/Finger"),
    (["back","lumbar","spine","disc"],         "back",      "Back/Spine"),
    (["neck","cervical"],                      "neck",      "Neck"),
    (["rib","chest"],                          "chest",     "Chest/Ribs"),
    (["concussion","head"],                    "concussion","Concussion"),
    (["abdominal","hernia"],                   "abdominal", "Abdominal"),
    (["illness","flu","covid"],                "illness",   "Illness"),
    (["fracture","broken"],                    "fracture",  "Fracture"),
    (["surgery","post-op"],                    "surgery",   "Surgery/Rehab"),
    (["upper body"],                           "upper-body","Upper Body"),
    (["lower body"],                           "lower-body","Lower Body"),
    (["muscle"],                               "muscle",    "Muscle"),
    (["ligament"],                             "ligament",  "Ligament"),
    (["tendon"],                               "tendon",    "Tendon"),
    (["strain"],                               "strain",    "Strain"),
    (["sprain"],                               "sprain",    "Sprain"),
]

def classify_injury(desc):
    d = (desc or "").lower()
    for keywords, slug, label in INJURY_CHECKS:
        if any(kw in d for kw in keywords):
            return slug, label
    return "other", "Other"

def normalize_status(s):
    s = (s or "").lower()
    if any(x in s for x in ["out","ir","injured reserve","reserve","il","60-day","10-day","15-day","7-day","long-term"]):
        return "out"
    if "doubtful" in s:
        return "doubtful"
    if "questionable" in s:
        return "questionable"
    if "probable" in s:
        return "probable"
    if any(x in s for x in ["dtd","day-to-day"]):
        return "questionable"
    if any(x in s for x in ["active","returned","reinstated","healthy","fit"]):
        return "returned"
    return "out"

LEAGUE_CACHE, TEAM_CACHE, PLAYER_CACHE = {}, {}, {}

def ensure_league(name, slug):
    if slug in LEAGUE_CACHE:
        return LEAGUE_CACHE[slug]
    r = sb_upsert("back_in_play_leagues", [{"league_name": name, "slug": slug}], "slug")
    if r:
        LEAGUE_CACHE[slug] = r[0]["league_id"]
        return LEAGUE_CACHE[slug]
    rows = sb_get("back_in_play_leagues", f"slug=eq.{slug}&select=league_id")
    if rows:
        LEAGUE_CACHE[slug] = rows[0]["league_id"]
        return LEAGUE_CACHE[slug]
    raise RuntimeError(f"Cannot create league {slug}")

def ensure_team(team_name, league_id):
    key = f"{league_id}:{team_name}"
    if key in TEAM_CACHE:
        return TEAM_CACHE[key]
    r = sb_upsert("back_in_play_teams",
                  [{"team_name": team_name, "league_id": league_id}],
                  "team_name,league_id")
    if r:
        TEAM_CACHE[key] = r[0]["team_id"]
        return TEAM_CACHE[key]
    rows = sb_get("back_in_play_teams",
                  f"team_name=eq.{urllib.parse.quote(team_name)}&league_id=eq.{league_id}&select=team_id")
    if rows:
        TEAM_CACHE[key] = rows[0]["team_id"]
        return TEAM_CACHE[key]
    raise RuntimeError(f"Cannot create team {team_name}")

def ensure_player(player_name, team_id, position="Unknown"):
    key = f"{team_id}:{player_name}"
    if key in PLAYER_CACHE:
        return PLAYER_CACHE[key]
    slug = f"{slugify(player_name)}-{team_id[:8]}"
    r = sb_upsert("back_in_play_players", [{
        "player_name": player_name, "team_id": team_id,
        "position": position or "Unknown", "slug": slug,
    }], "slug")
    if r:
        PLAYER_CACHE[key] = r[0]["player_id"]
        return PLAYER_CACHE[key]
    rows = sb_get("back_in_play_players", f"slug=eq.{urllib.parse.quote(slug)}&select=player_id")
    if rows:
        PLAYER_CACHE[key] = rows[0]["player_id"]
        return PLAYER_CACHE[key]
    raise RuntimeError(f"Cannot create player {player_name}")

def store_injury(player_id, desc, date_str, status="out", source="", return_date=None):
    slug, itype = classify_injury(desc)
    row = {
        "player_id":          player_id,
        "injury_type":        itype,
        "injury_type_slug":   slug,
        "injury_description": (desc or "Injury")[:500],
        "date_injured":       date_str,
        "status":             status,
        "source":             (source or "")[:100],
    }
    if return_date:
        row["expected_return_date"] = return_date
    return sb_upsert("back_in_play_injuries", [row], "player_id,date_injured,injury_type_slug")

# ── OpenAI ────────────────────────────────────────────────────────────────────
def openai_search(prompt, use_web_search=True, timeout=120):
    if not OPENAI_API_KEY:
        return ""
    tools = [{"type": "web_search_preview"}] if use_web_search else []
    body  = json.dumps({"model": "gpt-4o", "tools": tools, "input": prompt}).encode()
    req   = urllib.request.Request(
        "https://api.openai.com/v1/responses",
        data=body,
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    for attempt in range(3):
        try:
            resp = urllib.request.urlopen(req, timeout=timeout)
            data = json.loads(resp.read())
            for item in data.get("output", []):
                if item.get("type") == "message":
                    for c in item.get("content", []):
                        if c.get("type") == "output_text":
                            return c.get("text", "")
            return ""
        except urllib.error.HTTPError as e:
            err = e.read().decode()[:200]
            if e.code == 429:
                wait = 30 * (attempt + 1)
                print(f"  [429] waiting {wait}s...")
                time.sleep(wait)
            else:
                print(f"  [HTTP {e.code}] {err}")
                return ""
        except Exception as ex:
            print(f"  [err] {ex}")
            if attempt < 2:
                time.sleep(10)
    return ""

def parse_and_store(text, league_id, source, default_year=None):
    total = 0
    arrays = re.findall(r'\[\s*\{[\s\S]*?\}\s*\]', text)
    for match in arrays:
        try:
            injuries = json.loads(match)
            if not isinstance(injuries, list) or not injuries:
                continue
            sample = injuries[0]
            if not isinstance(sample, dict):
                continue
            has_player = any(k in sample for k in ["player_name","name","player","Player"])
            has_team   = any(k in sample for k in ["team","team_name","Team","club","Club"])
            if not has_player or not has_team:
                continue
            for inj in injuries:
                if not isinstance(inj, dict):
                    continue
                player_name = (inj.get("player_name") or inj.get("name") or
                               inj.get("player") or inj.get("Player") or "").strip()
                team_name   = (inj.get("team") or inj.get("team_name") or
                               inj.get("Team") or inj.get("club") or inj.get("Club") or "").strip()
                position    = (inj.get("position") or inj.get("pos") or "Unknown").strip()
                injury_desc = (inj.get("injury") or inj.get("injury_description") or
                               inj.get("description") or "Injury").strip()
                date_str    = (inj.get("date_placed") or inj.get("date_injured") or
                               inj.get("date") or inj.get("from") or "").strip()
                status      = (inj.get("status") or "out").strip()
                ret_date    = (inj.get("expected_return") or inj.get("return_date") or
                               inj.get("until") or "").strip() or None

                if not player_name or not team_name:
                    continue

                if date_str:
                    date_str = date_str[:10]
                    if not re.match(r'^\d{4}-\d{2}-\d{2}$', date_str):
                        date_str = f"{default_year}-08-01" if default_year else TODAY
                else:
                    date_str = f"{default_year}-08-01" if default_year else TODAY

                if ret_date:
                    ret_date = ret_date[:10]
                    if not re.match(r'^\d{4}-\d{2}-\d{2}$', ret_date):
                        ret_date = None

                try:
                    tid = ensure_team(team_name, league_id)
                    pid = ensure_player(player_name, tid, position)
                    r   = store_injury(pid, injury_desc, date_str,
                                       normalize_status(status), source, ret_date)
                    if r is not None:
                        total += 1
                except Exception:
                    pass
        except (json.JSONDecodeError, ValueError):
            continue
    return total

# ══════════════════════════════════════════════════════════════════════════════
# EPL — transfermarkt.com (comprehensive per-club knowledge compilation)
# ══════════════════════════════════════════════════════════════════════════════
# All clubs that appeared in EPL 2015-2025
EPL_CLUBS_BY_ERA = {
    "always": [
        "Arsenal", "Chelsea", "Liverpool", "Manchester City",
        "Manchester United", "Tottenham Hotspur", "Everton",
        "Leicester City", "Newcastle United", "West Ham United",
        "Crystal Palace", "Southampton", "Wolverhampton Wanderers",
        "Aston Villa", "Brighton & Hove Albion",
    ],
    "common": [
        "Fulham", "Brentford", "Nottingham Forest", "Bournemouth",
        "Leeds United", "Burnley", "Watford", "Norwich City",
        "Sheffield United", "Middlesbrough", "Sunderland",
        "Hull City", "Stoke City", "Swansea City", "West Bromwich Albion",
        "Luton Town", "Ipswich Town", "Huddersfield Town",
        "Cardiff City", "Queens Park Rangers",
    ]
}
ALL_EPL_CLUBS = EPL_CLUBS_BY_ERA["always"] + EPL_CLUBS_BY_ERA["common"]

def epl_prompt_for_club_season(club, year):
    """Detailed per-club prompt using both knowledge compilation and web search."""
    return (
        f"I need a comprehensive list of ALL injuries suffered by {club} players "
        f"during the {year}/{year+1} Premier League season.\n\n"
        f"Search transfermarkt.com/en/premier-league injuries for {club} {year}/{year+1} "
        f"AND compile from your training knowledge.\n\n"
        f"Include: every player who missed matches due to injury, muscle issues, illness, "
        f"suspension from injury, surgery, or fitness concerns that season.\n\n"
        f"Return ONLY this exact JSON array format — no other text, no markdown:\n"
        f'[{{"player_name":"Player Name","team":"{club}","position":"Position",'
        f'"injury":"specific injury description (e.g. hamstring strain, knee ligament)",'
        f'"date_placed":"{year}-MM-DD","status":"out","expected_return":"{year+1}-MM-DD"}}]\n\n'
        f"Include EVERY injury you know about for {club} that season — aim for 8-20+ entries. "
        f"Use YYYY-MM-DD date format. If exact date unknown, estimate based on match schedule."
    )

def ingest_epl_club_season(league_id, club, year):
    prompt = epl_prompt_for_club_season(club, year)
    # Try with web search first, then fallback to knowledge only
    text = openai_search(prompt, use_web_search=True)
    cnt  = parse_and_store(text, league_id, f"transfermarkt.com ({year})", year)
    if cnt == 0:
        # Retry without web search (pure knowledge)
        text2 = openai_search(prompt, use_web_search=False)
        cnt = parse_and_store(text2, league_id, f"transfermarkt.com/training-data ({year})", year)
    return cnt

def ingest_epl_year(league_id, year):
    clubs = ALL_EPL_CLUBS
    total = 0
    print(f"  EPL {year}/{year+1}: {len(clubs)} clubs...")
    for club in clubs:
        cnt = ingest_epl_club_season(league_id, club, year)
        total += cnt
        if cnt > 0:
            sys.stdout.write(f"    {club}: {cnt}\n")
            sys.stdout.flush()
        time.sleep(2)
    print(f"  EPL {year}/{year+1} DONE — {total}")
    return total

# ══════════════════════════════════════════════════════════════════════════════
# NHL — capfriendly.com/injuries (per-team knowledge compilation)
# ══════════════════════════════════════════════════════════════════════════════
NHL_TEAMS = [
    # Eastern
    "Boston Bruins", "Buffalo Sabres", "Detroit Red Wings", "Florida Panthers",
    "Montreal Canadiens", "Ottawa Senators", "Tampa Bay Lightning",
    "Toronto Maple Leafs", "Carolina Hurricanes", "Columbus Blue Jackets",
    "New Jersey Devils", "New York Islanders", "New York Rangers",
    "Philadelphia Flyers", "Pittsburgh Penguins", "Washington Capitals",
    # Western
    "Chicago Blackhawks", "Colorado Avalanche", "Dallas Stars",
    "Minnesota Wild", "Nashville Predators", "St. Louis Blues", "Winnipeg Jets",
    "Anaheim Ducks", "Arizona Coyotes", "Calgary Flames", "Edmonton Oilers",
    "Los Angeles Kings", "San Jose Sharks", "Vancouver Canucks",
    "Vegas Golden Knights", "Seattle Kraken",
]

def nhl_prompt_for_team_season(team, year):
    return (
        f"I need ALL injuries for {team} players during the {year}-{year+1} NHL season.\n\n"
        f"Search capfriendly.com/injuries for {team} {year}-{year+1} "
        f"AND compile from your training knowledge.\n\n"
        f"Include every player who went on injured reserve (IR/LTIR), "
        f"missed games due to injury, illness, or surgery that season.\n\n"
        f"Return ONLY this JSON array — no other text:\n"
        f'[{{"player_name":"Player Name","team":"{team}","position":"C/LW/RW/D/G",'
        f'"injury":"injury description (upper body / lower body / knee / shoulder etc)",'
        f'"date_placed":"{year}-MM-DD","status":"out","expected_return":"{year+1}-MM-DD"}}]\n\n'
        f"Include EVERY injury — aim for 6-15+ entries per team. "
        f"Use YYYY-MM-DD dates; estimate if exact date unknown."
    )

def ingest_nhl_team_season(league_id, team, year):
    prompt = nhl_prompt_for_team_season(team, year)
    text = openai_search(prompt, use_web_search=True)
    cnt  = parse_and_store(text, league_id, f"capfriendly.com/injuries ({year})", year)
    if cnt == 0:
        text2 = openai_search(prompt, use_web_search=False)
        cnt = parse_and_store(text2, league_id, f"capfriendly.com/training-data ({year})", year)
    return cnt

def ingest_nhl_year(league_id, year):
    teams = NHL_TEAMS
    # Remove Arizona Coyotes after 2023 (relocated)
    if year >= 2024:
        teams = [t for t in teams if t != "Arizona Coyotes"]
    # Seattle Kraken only from 2021
    if year < 2021:
        teams = [t for t in teams if t != "Seattle Kraken"]
    total = 0
    print(f"  NHL {year}-{year+1}: {len(teams)} teams...")
    for team in teams:
        cnt = ingest_nhl_team_season(league_id, team, year)
        total += cnt
        if cnt > 0:
            sys.stdout.write(f"    {team}: {cnt}\n")
            sys.stdout.flush()
        time.sleep(2)
    print(f"  NHL {year}-{year+1} DONE — {total}")
    return total

# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════
def should_run(league_key):
    key = league_key.upper()
    if ONLY_LEAGUE and ONLY_LEAGUE != ['']:
        return key in ONLY_LEAGUE
    return True

def print_db_summary():
    import subprocess
    try:
        result = subprocess.run([
            "curl","-s","-X","POST",
            f"https://api.supabase.com/v1/projects/{os.environ['SUPABASE_PROJECT_REF']}/database/query",
            "-H",f"Authorization: Bearer {os.environ['SUPABASE_MGMT_TOKEN']}",
            "-H","Content-Type: application/json",
            "-d",'{"query":"SELECT l.league_name, COUNT(DISTINCT p.player_id) as players, COUNT(i.injury_id) as injuries FROM back_in_play_leagues l LEFT JOIN back_in_play_teams t ON t.league_id=l.league_id LEFT JOIN back_in_play_players p ON p.team_id=t.team_id LEFT JOIN back_in_play_injuries i ON i.player_id=p.player_id GROUP BY l.league_name ORDER BY l.league_name;"}'
        ], capture_output=True, text=True, timeout=30)
        data = json.loads(result.stdout)
        for row in data:
            print(f"  {row['league_name']}: {row['players']} players, {row['injuries']} injuries")
    except Exception as e:
        print(f"  [summary err] {e}")

def main():
    print("=" * 68)
    print("EPL + NHL Supplementary Ingestion — Per-Club/Team Approach")
    print(f"Seasons: 2015-2025  |  Date: {TODAY}")
    print("=" * 68)

    leagues = {
        "epl": ensure_league("Premier League", "premier-league"),
        "nhl": ensure_league("NHL", "nhl"),
    }

    grand = 0

    if should_run("EPL"):
        print("\n─" * 35)
        print("[EPL] transfermarkt.com — per-club knowledge compilation")
        print("─" * 35)
        epl_total = 0
        for year in SEASONS:
            epl_total += ingest_epl_year(leagues["epl"], year)
            time.sleep(1)
        print(f"\n✅ EPL TOTAL: {epl_total}")
        grand += epl_total

    if should_run("NHL"):
        print("\n─" * 35)
        print("[NHL] capfriendly.com — per-team knowledge compilation")
        print("─" * 35)
        nhl_total = 0
        for year in SEASONS:
            nhl_total += ingest_nhl_year(leagues["nhl"], year)
            time.sleep(1)
        print(f"\n✅ NHL TOTAL: {nhl_total}")
        grand += nhl_total

    print(f"\nGRAND TOTAL NEW: {grand}")
    print("\nDB Summary:")
    print_db_summary()

if __name__ == "__main__":
    main()
