#!/usr/bin/env python3
"""
Generate sitemap.xml for Back In Play SEO pages.
Run daily via cron or during build.
Outputs to public/sitemap.xml
"""

import json, os, sys, urllib.request
from datetime import datetime
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
SITE_URL = "https://backinplay.app"


def sb_get(table, params=""):
    url = SUPABASE_URL + "/rest/v1/" + table + "?" + params
    hdrs = {"apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY}
    req = urllib.request.Request(url, headers=hdrs)
    resp = urllib.request.urlopen(req, timeout=30)
    return json.loads(resp.read().decode())


def slugify(name):
    import re
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')


def main():
    today = datetime.utcnow().strftime("%Y-%m-%d")
    urls = []

    # Homepage
    urls.append({"loc": "/", "priority": "1.0", "changefreq": "hourly"})

    # League hub pages
    for slug in ["nba", "nfl", "mlb", "nhl", "premier-league"]:
        urls.append({"loc": "/%s-injuries" % slug, "priority": "0.9", "changefreq": "hourly"})

    # Team pages
    leagues = sb_get("back_in_play_leagues", "select=league_id,slug")
    for league in leagues:
        teams = sb_get("back_in_play_teams",
                       "league_id=eq.%s&team_name=neq.Unknown&select=team_name" % league["league_id"])
        for team in teams:
            team_slug = slugify(team["team_name"])
            urls.append({
                "loc": "/%s/%s-injuries" % (league["slug"], team_slug),
                "priority": "0.8",
                "changefreq": "daily",
            })

    # Player pages — only players with recent injuries (last 90 days)
    cutoff = datetime.utcnow()
    cutoff_str = (datetime(cutoff.year, cutoff.month, cutoff.day) - __import__('datetime').timedelta(days=90)).strftime("%Y-%m-%d")

    # Get player IDs with recent injuries
    injured_players = set()
    offset = 0
    while True:
        injs = sb_get("back_in_play_injuries",
                       "date_injured=gte.%s&select=player_id&limit=1000&offset=%d" % (cutoff_str, offset))
        if not injs:
            break
        for inj in injs:
            injured_players.add(inj["player_id"])
        if len(injs) < 1000:
            break
        offset += 1000

    print("Players with recent injuries: %d" % len(injured_players), flush=True)

    # Get slugs for those players in chunks
    player_ids = list(injured_players)
    for i in range(0, len(player_ids), 100):
        chunk = player_ids[i:i+100]
        ids_param = ",".join(chunk)
        players = sb_get("back_in_play_players",
                         "player_id=in.(%s)&select=slug&team_id=not.is.null" % ids_param)
        for p in players:
            if p.get("slug"):
                urls.append({
                    "loc": "/player/%s" % p["slug"],
                    "priority": "0.7",
                    "changefreq": "daily",
                })

    # Generate XML
    xml_lines = ['<?xml version="1.0" encoding="UTF-8"?>']
    xml_lines.append('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    for u in urls:
        xml_lines.append("  <url>")
        xml_lines.append("    <loc>%s%s</loc>" % (SITE_URL, u["loc"]))
        xml_lines.append("    <lastmod>%s</lastmod>" % today)
        xml_lines.append("    <changefreq>%s</changefreq>" % u["changefreq"])
        xml_lines.append("    <priority>%s</priority>" % u["priority"])
        xml_lines.append("  </url>")
    xml_lines.append("</urlset>")

    # Write to public/sitemap.xml
    out_path = Path(__file__).parent.parent / "public" / "sitemap.xml"
    out_path.write_text("\n".join(xml_lines))
    print("Wrote %d URLs to %s" % (len(urls), out_path), flush=True)


if __name__ == "__main__":
    main()
