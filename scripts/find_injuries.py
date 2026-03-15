#!/usr/bin/env python3
"""Find the injury table and check its structure."""
import json, os, urllib.request
from pathlib import Path

for envfile in ["/root/.daemon-env", ".env", "../.env"]:
    p = Path(envfile)
    if p.exists():
        for line in p.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                if line.startswith("export "):
                    line = line[7:]
                key, _, val = line.partition("=")
                os.environ.setdefault(key.strip(), val.strip().strip("'\""))

SB_URL = os.environ["SUPABASE_URL"]
SB_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
hdrs = {"apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY}

# Try different table names
for t in ["back_in_play_injuries", "back_in_play_player_injuries",
          "injuries", "player_injuries"]:
    url = SB_URL + "/rest/v1/" + t + "?select=*&limit=3"
    try:
        req = urllib.request.Request(url, headers=hdrs)
        resp = urllib.request.urlopen(req, timeout=10)
        data = json.loads(resp.read().decode())
        if data:
            print(f"\n{t}: has data")
            print(f"  Columns: {list(data[0].keys())}")
            print(f"  Sample: {json.dumps(data[0], indent=2)[:500]}")
        else:
            print(f"{t}: EMPTY")
    except Exception as e:
        err_str = str(e)
        if "404" in err_str or "Not Found" in err_str:
            print(f"{t}: table not found")
        else:
            print(f"{t}: ERROR {e}")

# Also check what tables exist with 'injur' in the name
url = SB_URL + "/rest/v1/"
try:
    req = urllib.request.Request(url, headers=hdrs)
    resp = urllib.request.urlopen(req, timeout=10)
    print("\nAvailable endpoints hint from response...")
except Exception as e:
    print(f"Root endpoint: {e}")

# Check the back_in_play_injuries with a count
url = SB_URL + "/rest/v1/back_in_play_injuries?select=*"
count_hdrs = dict(hdrs)
count_hdrs["Prefer"] = "count=exact"
count_hdrs["Range"] = "0-0"
try:
    req = urllib.request.Request(url, headers=count_hdrs)
    resp = urllib.request.urlopen(req, timeout=10)
    cr = resp.headers.get("Content-Range", "")
    print(f"\nback_in_play_injuries count: {cr}")
except Exception as e:
    print(f"\nback_in_play_injuries count error: {e}")

# Try without league_slug filter
url2 = SB_URL + "/rest/v1/back_in_play_injuries?select=*&limit=5"
try:
    req = urllib.request.Request(url2, headers=hdrs)
    resp = urllib.request.urlopen(req, timeout=10)
    data = json.loads(resp.read().decode())
    print(f"\nback_in_play_injuries (no filter): {len(data)} rows")
    if data:
        print(f"  Columns: {list(data[0].keys())}")
        for r in data[:2]:
            print(f"  {json.dumps(r, default=str)[:300]}")
except Exception as e:
    print(f"Unfiltered query error: {e}")
