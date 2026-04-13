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


def write_segment(out_dir, filename, urls):
    """Write a single sitemap segment XML file."""
    today = datetime.utcnow().strftime("%Y-%m-%d")
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for u in urls:
        lines.append("  <url>")
        lines.append("    <loc>%s%s</loc>" % (SITE_URL, u["loc"]))
        lines.append("    <lastmod>%s</lastmod>" % today)
        lines.append("    <changefreq>%s</changefreq>" % u["changefreq"])
        lines.append("    <priority>%s</priority>" % u["priority"])
        lines.append("  </url>")
    lines.append("</urlset>")
    (out_dir / filename).write_text("\n".join(lines))
    return len(urls)


def write_sitemap_index(out_dir, segment_files):
    """Write sitemap-index.xml pointing to segment files."""
    today = datetime.utcnow().strftime("%Y-%m-%d")
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for f in segment_files:
        lines.append("  <sitemap>")
        lines.append("    <loc>%s/%s</loc>" % (SITE_URL, f))
        lines.append("    <lastmod>%s</lastmod>" % today)
        lines.append("  </sitemap>")
    lines.append("</sitemapindex>")
    (out_dir / "sitemap.xml").write_text("\n".join(lines))


def main():
    today = datetime.utcnow().strftime("%Y-%m-%d")
    out_dir = Path(__file__).parent.parent / "public"

    # Segment buckets
    core_urls = []
    league_urls = []
    team_urls = []
    injury_urls = []
    performance_urls = []
    player_urls = []

    # Core pages
    core_urls.append({"loc": "/", "priority": "1.0", "changefreq": "hourly"})
    core_urls.append({"loc": "/returning-today", "priority": "0.8", "changefreq": "daily"})
    core_urls.append({"loc": "/players-returning-from-injury-this-week", "priority": "0.8", "changefreq": "daily"})
    core_urls.append({"loc": "/performance-curves", "priority": "0.7", "changefreq": "weekly"})
    core_urls.append({"loc": "/recovery-stats", "priority": "0.7", "changefreq": "weekly"})
    core_urls.append({"loc": "/minutes-restriction-after-injury", "priority": "0.7", "changefreq": "weekly"})

    # League hub pages + returning-today per league + injury performance + analysis
    for slug in ["nba", "nfl", "mlb", "nhl", "premier-league"]:
        league_urls.append({"loc": "/%s-injuries" % slug, "priority": "0.9", "changefreq": "hourly"})
        league_urls.append({"loc": "/%s-injury-performance" % slug, "priority": "0.7", "changefreq": "weekly"})
        league_urls.append({"loc": "/%s-injury-analysis" % slug, "priority": "0.7", "changefreq": "weekly"})
        league_urls.append({"loc": "/%s-injury-report" % slug, "priority": "0.9", "changefreq": "hourly"})
        core_urls.append({"loc": "/%s/returning-today" % slug, "priority": "0.7", "changefreq": "daily"})
        core_urls.append({"loc": "/%s/players-returning-from-injury-this-week" % slug, "priority": "0.7", "changefreq": "daily"})
        core_urls.append({"loc": "/%s/minutes-restriction-after-injury" % slug, "priority": "0.7", "changefreq": "weekly"})

    # Team pages
    leagues = sb_get("back_in_play_leagues", "select=league_id,slug")
    for league in leagues:
        teams = sb_get("back_in_play_teams",
                       "league_id=eq.%s&team_name=neq.Unknown&select=team_name" % league["league_id"])
        for team in teams:
            team_slug = slugify(team["team_name"])
            team_urls.append({
                "loc": "/%s/%s-injuries" % (league["slug"], team_slug),
                "priority": "0.8",
                "changefreq": "daily",
            })

    # Injury type pages
    try:
        inj_types = sb_get("back_in_play_injuries",
                           "select=injury_type&order=injury_type&limit=1000")
        seen_types = set()
        for row in inj_types:
            t = row.get("injury_type", "")
            ts = slugify(t)
            if ts and ts not in seen_types and ts != "other":
                seen_types.add(ts)
                injury_urls.append({"loc": "/injuries/%s" % ts, "priority": "0.6", "changefreq": "weekly"})
    except Exception as e:
        print("Warning: could not fetch injury types for sitemap: %s" % e, flush=True)

    # League + injury type performance pages (from performance_curves table)
    try:
        curves = sb_get("back_in_play_performance_curves",
                        "select=league_slug,injury_type_slug&position=is.null&injury_type_slug=neq.other&limit=1000")
        for c in curves:
            ts = c.get("injury_type_slug", "")
            ls = c.get("league_slug", "")
            if ts and ls:
                performance_urls.append({
                    "loc": "/%s/%s-injury-performance" % (ls, ts),
                    "priority": "0.6",
                    "changefreq": "weekly",
                })
    except Exception as e:
        print("Warning: could not fetch performance curves for sitemap: %s" % e, flush=True)

    # Player pages
    player_count = 0
    offset = 0
    while True:
        players = sb_get("back_in_play_players",
                         "slug=not.is.null&team_id=not.is.null&select=slug&limit=1000&offset=%d" % offset)
        if not players:
            break
        for p in players:
            if p.get("slug"):
                player_urls.append({
                    "loc": "/player/%s" % p["slug"],
                    "priority": "0.7",
                    "changefreq": "daily",
                })
                player_urls.append({
                    "loc": "/%s-return-date" % p["slug"],
                    "priority": "0.8",
                    "changefreq": "daily",
                })
                player_count += 1
        if len(players) < 1000:
            break
        offset += 1000

    print("Players in sitemap: %d (%d URLs incl. return pages)" % (player_count, player_count * 2), flush=True)

    # Write segments
    segment_files = []
    for name, urls in [("core", core_urls), ("leagues", league_urls),
                       ("teams", team_urls), ("injuries", injury_urls),
                       ("performance", performance_urls), ("players", player_urls)]:
        if urls:
            fname = "sitemap-%s.xml" % name
            write_segment(out_dir, fname, urls)
            segment_files.append(fname)

    # Write sitemap index
    write_sitemap_index(out_dir, segment_files)
    total = sum(len(u) for u in [core_urls, league_urls, team_urls, injury_urls, performance_urls, player_urls])
    print("Wrote sitemap index with %d segments, %d total URLs to %s" % (len(segment_files), total, out_dir / "sitemap.xml"), flush=True)


if __name__ == "__main__":
    main()
