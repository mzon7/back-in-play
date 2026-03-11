#!/usr/bin/env python3
"""
Resolve remaining Unknown-team players using GPT.
Sends batches of player names per league, asks GPT for their current team,
then matches to our DB teams and updates.
"""

import json, os, sys, urllib.request
from pathlib import Path


def load_env():
    for envfile in ["/root/.daemon-env", ".env", "../.env"]:
        p = Path(envfile)
        if p.exists():
            for line in p.read_text().splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, val = line.partition("=")
                    os.environ.setdefault(key.strip(), val.strip().strip("'\""))

load_env()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"); sys.exit(1)
if not OPENAI_API_KEY:
    print("ERROR: Set OPENAI_API_KEY"); sys.exit(1)


def sb_get(table, params=""):
    url = SUPABASE_URL + "/rest/v1/" + table + "?" + params
    hdrs = {"apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY}
    req = urllib.request.Request(url, headers=hdrs)
    resp = urllib.request.urlopen(req, timeout=30)
    return json.loads(resp.read().decode())


def sb_patch(table, filter_params, body):
    url = SUPABASE_URL + "/rest/v1/" + table + "?" + filter_params
    data = json.dumps(body).encode()
    hdrs = {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    req = urllib.request.Request(url, data=data, headers=hdrs, method="PATCH")
    urllib.request.urlopen(req, timeout=30)
    return True


def sb_delete(table, filter_params):
    url = SUPABASE_URL + "/rest/v1/" + table + "?" + filter_params
    hdrs = {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
        "Prefer": "return=minimal",
    }
    req = urllib.request.Request(url, headers=hdrs, method="DELETE")
    urllib.request.urlopen(req, timeout=30)
    return True


def ask_gpt(player_names, league_name, team_names):
    """Ask GPT which team each player currently plays for."""
    team_list = ", ".join(sorted(team_names))
    players_json = json.dumps(player_names)

    prompt = (
        f"For each player in this {league_name} list, respond with their CURRENT team name "
        f"from this exact list of teams: [{team_list}].\n\n"
        f"If a player is retired, in the minor leagues, or you're unsure, respond with \"UNKNOWN\".\n"
        f"Clean up any name artifacts (leading slashes, position prefixes like 'LWs ', etc).\n\n"
        f"Players: {players_json}\n\n"
        f"Respond ONLY with a JSON array of objects: "
        f'[{{"name": "cleaned name", "team": "exact team name or UNKNOWN"}}]\n'
        f"No explanation, just the JSON array."
    )

    body = json.dumps({
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
        "max_tokens": 4000,
    }).encode()

    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=body,
        headers={
            "Authorization": "Bearer " + OPENAI_API_KEY,
            "Content-Type": "application/json",
        },
    )
    resp = urllib.request.urlopen(req, timeout=60)
    data = json.loads(resp.read().decode())
    content = data["choices"][0]["message"]["content"].strip()

    # Parse JSON from response (handle markdown code blocks)
    if content.startswith("```"):
        content = content.split("\n", 1)[1].rsplit("```", 1)[0].strip()

    return json.loads(content)


LEAGUE_NAMES = {
    "nba": "NBA", "nfl": "NFL", "mlb": "MLB", "nhl": "NHL",
    "premier-league": "English Premier League",
}


def main():
    # Get leagues
    leagues = sb_get("back_in_play_leagues", "select=league_id,slug")
    league_slug_map = {l["league_id"]: l["slug"] for l in leagues}

    # Get Unknown teams
    unknown_teams = sb_get("back_in_play_teams", "team_name=eq.Unknown&select=team_id,league_id")
    if not unknown_teams:
        print("No Unknown teams found"); return

    # Get real teams per league
    real_teams = sb_get("back_in_play_teams",
                        "team_name=neq.Unknown&select=team_id,team_name,league_id")
    teams_by_league = {}
    for t in real_teams:
        slug = league_slug_map.get(t["league_id"], "")
        teams_by_league.setdefault(slug, []).append(t)

    total_resolved = 0
    total_removed = 0

    for ut in unknown_teams:
        slug = league_slug_map.get(ut["league_id"], "")
        if not slug or slug not in LEAGUE_NAMES:
            continue

        # Get players on this Unknown team
        players = sb_get("back_in_play_players",
                         "team_id=eq.%s&select=player_id,player_name" % ut["team_id"])
        if not players:
            continue

        league_teams = teams_by_league.get(slug, [])
        team_names = [t["team_name"] for t in league_teams]
        # Build name → team_id map (case-insensitive)
        team_lookup = {}
        for t in league_teams:
            team_lookup[t["team_name"].lower()] = t["team_id"]

        print("\n%s: %d players to resolve via GPT" % (slug.upper(), len(players)), flush=True)

        # Process in batches of 30
        for i in range(0, len(players), 30):
            batch = players[i:i+30]
            names = [p["player_name"] for p in batch]

            try:
                results = ask_gpt(names, LEAGUE_NAMES[slug], team_names)
            except Exception as e:
                print("  GPT error: %s" % e, flush=True)
                continue

            # Build name→result map
            result_map = {}
            for r in results:
                # Match by index since GPT returns in order
                result_map[r.get("name", "")] = r.get("team", "UNKNOWN")

            resolved = 0
            removed = 0
            for idx, p in enumerate(batch):
                # Try to match by index first, then by cleaned name
                if idx < len(results):
                    gpt_team = results[idx].get("team", "UNKNOWN")
                    cleaned_name = results[idx].get("name", p["player_name"])
                else:
                    gpt_team = "UNKNOWN"
                    cleaned_name = p["player_name"]

                if gpt_team == "UNKNOWN":
                    # Check if player has any active injuries
                    injs = sb_get("back_in_play_injuries",
                                  "player_id=eq.%s&status=neq.cleared&status=neq.returned&select=injury_id&limit=1" % p["player_id"])
                    if not injs:
                        # No active injuries, safe to delete
                        try:
                            sb_delete("back_in_play_injuries", "player_id=eq.%s" % p["player_id"])
                            sb_delete("back_in_play_status_changes", "player_id=eq.%s" % p["player_id"])
                            sb_delete("back_in_play_players", "player_id=eq.%s" % p["player_id"])
                            removed += 1
                        except:
                            pass
                    continue

                matched_team_id = team_lookup.get(gpt_team.lower())
                if matched_team_id:
                    update = {"team_id": matched_team_id}
                    # Clean up name if it was dirty
                    if cleaned_name != p["player_name"]:
                        update["player_name"] = cleaned_name
                    try:
                        sb_patch("back_in_play_players",
                                 "player_id=eq.%s" % p["player_id"], update)
                        resolved += 1
                    except Exception as e:
                        print("  Patch err for %s: %s" % (p["player_name"], e), flush=True)

            print("  Batch %d-%d: resolved %d, removed %d" % (
                i+1, min(i+30, len(players)), resolved, removed), flush=True)
            total_resolved += resolved
            total_removed += removed

    print("\nTotal resolved: %d, removed: %d" % (total_resolved, total_removed), flush=True)


if __name__ == "__main__":
    main()
