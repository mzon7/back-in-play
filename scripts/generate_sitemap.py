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

    # Player pages — ALL players with slugs (not just recently injured)
    # This maximizes indexable pages for programmatic SEO (4000+ pages)
    player_count = 0
    offset = 0
    while True:
        players = sb_get("back_in_play_players",
                         "slug=not.is.null&team_id=not.is.null&select=slug&limit=1000&offset=%d" % offset)
        if not players:
            break
        for p in players:
            if p.get("slug"):
                urls.append({
                    "loc": "/player/%s" % p["slug"],
                    "priority": "0.7",
                    "changefreq": "daily",
                })
                # Return date page (highest traffic potential)
                urls.append({
                    "loc": "/%s-return-date" % p["slug"],
                    "priority": "0.8",
                    "changefreq": "daily",
                })
                player_count += 1
        if len(players) < 1000:
            break
        offset += 1000

    print("Players in sitemap: %d (%d URLs incl. return pages)" % (player_count, player_count * 2), flush=True)

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
