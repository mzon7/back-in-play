#!/usr/bin/env python3
"""
Optimized team odds scraper v2 — only fetches what's missing.

Phase 1: Fill close odds for events that have commence_time but no close (~520 requests)
Phase 2: Fill commence_time + close for events that have open but no commence_time
Phase 3: Scrape missing date ranges (only processing events on their game day)

Key optimization: on each date, ONLY process events commencing THAT day.
The old scraper processed ALL future events every day = massive waste.

Usage:
  python3 scrape_team_odds_v2.py --report           # Show what's missing
  python3 scrape_team_odds_v2.py --fill-close        # Phase 1: fill close for events with CT
  python3 scrape_team_odds_v2.py --fill-commence     # Phase 2: fill commence_time + close
  python3 scrape_team_odds_v2.py --scrape-missing    # Phase 3: scrape missing date ranges
  python3 scrape_team_odds_v2.py --all               # Run all phases
  python3 scrape_team_odds_v2.py --sport baseball_mlb --scrape-missing  # Single sport
"""
import os, sys, json, time, argparse, requests, psycopg2
from datetime import datetime, timedelta

for f in ["/root/.daemon-env", ".env"]:
    if os.path.exists(f):
        with open(f) as fh:
            for line in fh:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

API_KEY = os.environ.get("ODDS_API_KEY")
BASE = "https://api.the-odds-api.com/v4/historical/sports"

PREFERRED_BOOKS = ["fanduel", "draftkings", "betmgm", "pointsbetus", "bovada"]

from collections import OrderedDict
SPORT_CONFIGS = OrderedDict([
    ("basketball_nba",       {"start": "2021-10-19", "end": "2026-03-25", "regions": "us",
                              "markets": "h2h,spreads,totals"}),
    ("icehockey_nhl",        {"start": "2021-10-12", "end": "2026-03-25", "regions": "us",
                              "markets": "h2h,spreads,totals"}),
    ("americanfootball_nfl", {"start": "2020-09-10", "end": "2026-03-25", "regions": "us",
                              "markets": "h2h,spreads,totals"}),
    ("baseball_mlb",         {"start": "2020-07-23", "end": "2026-03-25", "regions": "us",
                              "markets": "h2h,spreads,totals"}),
    ("soccer_epl",           {"start": "2021-08-13", "end": "2026-03-25", "regions": "uk,us",
                              "markets": "h2h,spreads,totals,btts,h2h_3_way,draw_no_bet"}),
])

# Columns allowed in upsert
ALLOWED_COLS = {
    "event_id","sport_key","game_date","home_team","away_team",
    "h2h_home_price","h2h_away_price",
    "spread_home_line","spread_home_price","spread_away_line","spread_away_price",
    "total_line","total_over_price","total_under_price",
    "source","home_score","away_score","commence_time",
    "home_total_line","home_total_over_price","home_total_under_price",
    "away_total_line","away_total_over_price","away_total_under_price",
    "btts_yes_price","btts_no_price","draw_price",
    "close_spread_home_line","close_spread_home_price",
    "close_spread_away_line","close_spread_away_price",
    "close_total_line","close_total_over_price","close_total_under_price",
    "close_h2h_home_price","close_h2h_away_price",
    "close_home_total_line","close_home_total_over_price","close_home_total_under_price",
    "close_away_total_line","close_away_total_over_price","close_away_total_under_price",
    "close_source","close_btts_yes_price","close_btts_no_price","close_draw_price",
}

total_requests = 0
remaining_credits = "?"
CREDIT_FLOOR = 5_000_000  # Stop if credits drop below this


def get_conn():
    return psycopg2.connect(os.environ["SUPABASE_DB_URL"])


def api_get(url, params, retries=2):
    """Make API request with retry and credit tracking. Stops if credits below CREDIT_FLOOR."""
    global total_requests, remaining_credits
    # Safety net: stop if credits too low
    if remaining_credits != "?" and int(remaining_credits) <= CREDIT_FLOOR:
        print(f"\n  SAFETY STOP: Credits ({remaining_credits}) at or below floor ({CREDIT_FLOOR:,}). Exiting.")
        sys.exit(1)
    for attempt in range(retries + 1):
        try:
            r = requests.get(url, params=params, timeout=20)
            total_requests += 1
            remaining_credits = r.headers.get("x-requests-remaining", remaining_credits)
            if remaining_credits != "?" and int(remaining_credits) <= CREDIT_FLOOR:
                print(f"\n  SAFETY STOP: Credits ({remaining_credits}) at or below floor ({CREDIT_FLOOR:,}). Exiting.")
                sys.exit(1)
            if r.status_code == 200:
                return r.json()
            elif r.status_code == 422:
                return None  # No data for this request
            elif r.status_code == 429:
                print(f"    Rate limited, sleeping 60s...")
                time.sleep(60)
                continue
            else:
                return None
        except requests.exceptions.Timeout:
            if attempt < retries:
                time.sleep(2)
                continue
            return None
        except Exception as e:
            print(f"    API error: {e}")
            return None
    return None


def get_best_book(bookmakers):
    if not bookmakers:
        return None
    for pref in PREFERRED_BOOKS:
        for bk in bookmakers:
            if bk.get("key") == pref and len(bk.get("markets", [])) > 0:
                return bk
    return max(bookmakers, key=lambda bk: len(bk.get("markets", [])))


def _extract_single_book(bk, home, away):
    """Extract odds from a single bookmaker. Returns dict of columns."""
    result = {"source": bk.get("key")}
    for mkt in bk.get("markets", []):
        key = mkt["key"]
        outcomes = {o.get("name"): o for o in mkt.get("outcomes", [])}
        if key == "h2h":
            result["h2h_home_price"] = outcomes.get(home, {}).get("price")
            result["h2h_away_price"] = outcomes.get(away, {}).get("price")
        elif key == "spreads":
            result["spread_home_line"] = outcomes.get(home, {}).get("point")
            result["spread_home_price"] = outcomes.get(home, {}).get("price")
            result["spread_away_line"] = outcomes.get(away, {}).get("point")
            result["spread_away_price"] = outcomes.get(away, {}).get("price")
        elif key == "totals":
            result["total_line"] = outcomes.get("Over", {}).get("point")
            result["total_over_price"] = outcomes.get("Over", {}).get("price")
            result["total_under_price"] = outcomes.get("Under", {}).get("price")
        elif key == "team_totals":
            for o in mkt.get("outcomes", []):
                desc = o.get("description")
                name = o.get("name")
                if desc == home:
                    if name == "Over":
                        result["home_total_line"] = o.get("point")
                        result["home_total_over_price"] = o.get("price")
                    elif name == "Under":
                        result["home_total_under_price"] = o.get("price")
                elif desc == away:
                    if name == "Over":
                        result["away_total_line"] = o.get("point")
                        result["away_total_over_price"] = o.get("price")
                    elif name == "Under":
                        result["away_total_under_price"] = o.get("price")
        elif key == "btts":
            result["btts_yes_price"] = outcomes.get("Yes", {}).get("price")
            result["btts_no_price"] = outcomes.get("No", {}).get("price")
        elif key == "h2h_3_way":
            result["draw_price"] = outcomes.get("Draw", {}).get("price")
    return result


def extract_odds_multi(event_data, sport):
    """Extract odds from event data. Returns list of rows — one per DK/FD bookmaker found.
    Each row has data from that bookmaker, with gaps filled from other books."""
    if not event_data:
        return []
    bks = event_data.get("bookmakers", [])
    if not bks:
        return []

    home = event_data.get("home_team")
    away = event_data.get("away_team")
    bk_by_key = {bk.get("key"): bk for bk in bks}

    # Scores (shared across all rows)
    score_data = {}
    scores = event_data.get("scores")
    if scores:
        for s in scores:
            if s.get("name") == home:
                try: score_data["home_score"] = int(s.get("score", 0))
                except: pass
            elif s.get("name") == away:
                try: score_data["away_score"] = int(s.get("score", 0))
                except: pass

    # Build a row for each preferred book that exists
    rows = []
    STORE_BOOKS = ["fanduel", "draftkings"]
    for book_key in STORE_BOOKS:
        bk = bk_by_key.get(book_key)
        if not bk:
            continue
        row = _extract_single_book(bk, home, away)
        # Fill missing markets from other books (prefer DK/FD, then others)
        fill_order = [b for b in PREFERRED_BOOKS if b != book_key] + [b for b in bk_by_key if b not in PREFERRED_BOOKS]
        for fill_key in fill_order:
            fill_bk = bk_by_key.get(fill_key)
            if not fill_bk:
                continue
            fill = _extract_single_book(fill_bk, home, away)
            for k, v in fill.items():
                if k != "source" and row.get(k) is None and v is not None:
                    row[k] = v
        row.update(score_data)
        rows.append(row)

    # Fallback: if neither DK nor FD exists, use best available book
    if not rows:
        pref_order = {b: i for i, b in enumerate(PREFERRED_BOOKS)}
        sorted_bks = sorted(bks, key=lambda bk: (pref_order.get(bk.get("key"), 99), -len(bk.get("markets", []))))
        row = _extract_single_book(sorted_bks[0], home, away)
        row.update(score_data)
        rows.append(row)

    return rows


def ensure_conn(conn):
    """Reconnect if connection is closed."""
    try:
        cur = conn.cursor()
        cur.execute("SELECT 1")
        cur.close()
        return conn
    except Exception:
        print("    Reconnecting to DB...")
        try:
            conn.close()
        except Exception:
            pass
        return get_conn()


def upsert_batch(conn, batch):
    """Bulk upsert using psycopg2 for reliability. Returns (possibly new) conn."""
    if not batch:
        return conn
    # Clean and deduplicate by (event_id, source)
    clean = [{k: v for k, v in r.items() if k in ALLOWED_COLS and v is not None} for r in batch]
    seen = set()
    deduped = []
    for row in clean:
        key = (row.get("event_id", ""), row.get("source", ""))
        if key[0] and key not in seen:
            seen.add(key)
            deduped.append(row)

    if not deduped:
        return

    # Build multi-value INSERT ... ON CONFLICT UPDATE
    all_cols = set()
    for row in deduped:
        all_cols.update(row.keys())
    cols = sorted(all_cols)

    placeholders = []
    values = []
    for row in deduped:
        ph = []
        for c in cols:
            ph.append("%s")
            values.append(row.get(c))
        placeholders.append(f"({','.join(ph)})")

    update_cols = [c for c in cols if c not in ("event_id", "source")]
    update_clause = ", ".join(f"{c} = COALESCE(EXCLUDED.{c}, back_in_play_game_odds.{c})" for c in update_cols)

    sql = f"""
        INSERT INTO back_in_play_game_odds ({','.join(cols)})
        VALUES {','.join(placeholders)}
        ON CONFLICT (event_id, source) DO UPDATE SET {update_clause}
    """

    conn = ensure_conn(conn)
    cur = conn.cursor()
    try:
        cur.execute(sql, values)
        conn.commit()
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        print(f"    Upsert error: {e}")
        # Reconnect and try individual rows
        conn = ensure_conn(conn)
        cur = conn.cursor()
        for row in deduped:
            try:
                row_cols = sorted(row.keys())
                row_vals = [row[c] for c in row_cols]
                row_update = [c for c in row_cols if c not in ("event_id", "source")]
                row_update_clause = ", ".join(f"{c} = COALESCE(EXCLUDED.{c}, back_in_play_game_odds.{c})" for c in row_update)
                sql2 = f"""
                    INSERT INTO back_in_play_game_odds ({','.join(row_cols)})
                    VALUES ({','.join(['%s']*len(row_cols))})
                    ON CONFLICT (event_id, source) DO UPDATE SET {row_update_clause}
                """
                cur.execute(sql2, row_vals)
                conn.commit()
            except Exception as e2:
                try:
                    conn.rollback()
                except Exception:
                    conn = ensure_conn(conn)
                    cur = conn.cursor()
    return conn


def report():
    """Show exactly what's missing."""
    conn = get_conn()
    cur = conn.cursor()

    for sport, config in SPORT_CONFIGS.items():
        label = sport.split("_")[-1].upper()
        cur.execute("""
            SELECT EXTRACT(YEAR FROM game_date)::int as yr,
                   COUNT(DISTINCT event_id) as events,
                   COUNT(DISTINCT CASE WHEN close_h2h_home_price IS NOT NULL OR close_spread_home_line IS NOT NULL THEN event_id END) as with_close,
                   COUNT(DISTINCT CASE WHEN commence_time IS NOT NULL THEN event_id END) as with_ct
            FROM back_in_play_game_odds
            WHERE sport_key = %s
            GROUP BY yr ORDER BY yr
        """, (sport,))
        rows = cur.fetchall()

        print(f"\n{'='*60}")
        print(f"  {label} (start: {config['start']})")
        print(f"{'='*60}")
        if not rows:
            print("  NO DATA — full scrape needed")
            continue

        print(f"  {'Year':<6} {'Events':<8} {'Close':<8} {'CT':<8} {'Need Close'}")
        print(f"  {'-'*50}")
        total_need = 0
        for yr, events, close, ct in rows:
            need = events - close
            total_need += need
            print(f"  {int(yr):<6} {events:<8} {close:<8} {ct:<8} {need}")
        print(f"  Total need close: {total_need}")

    # Credits
    try:
        r = requests.get("https://api.the-odds-api.com/v4/sports", params={"apiKey": API_KEY})
        print(f"\n  API credits: {r.headers.get('x-requests-used')} used, {r.headers.get('x-requests-remaining')} remaining")
    except:
        pass
    conn.close()


def fill_close_odds(conn, sport_filter=None):
    """Phase 1: Fill close odds for DISTINCT events that have commence_time but no close."""
    cur = conn.cursor()

    where_clause = "WHERE commence_time IS NOT NULL AND close_h2h_home_price IS NULL AND close_spread_home_line IS NULL"
    params = []
    if sport_filter:
        where_clause += " AND sport_key = %s"
        params.append(sport_filter)

    # Get DISTINCT events — not every row
    cur.execute(f"""
        SELECT DISTINCT ON (event_id) event_id, sport_key, commence_time, source, game_date
        FROM back_in_play_game_odds
        {where_clause}
        ORDER BY event_id, game_date
    """, params)
    rows = cur.fetchall()
    print(f"\nPhase 1: {len(rows)} distinct events need close odds")

    batch = []
    for i, (event_id, sport, ct, source, game_date) in enumerate(rows):
        config = SPORT_CONFIGS.get(sport, {})
        regions = config.get("regions", "us")
        markets = config.get("markets", "h2h,spreads,totals")

        # Close = commence_time - 30 minutes
        try:
            if isinstance(ct, str):
                ct_dt = datetime.fromisoformat(ct.replace("Z", "+00:00"))
            else:
                ct_dt = ct
            close_ts = (ct_dt - timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
        except:
            continue

        data = api_get(f"{BASE}/{sport}/events/{event_id}/odds", {
            "apiKey": API_KEY, "date": close_ts,
            "regions": regions, "markets": markets, "oddsFormat": "american",
        })

        if data:
            od = data.get("data", data) if isinstance(data, dict) else data
            if isinstance(od, dict):
                close = extract_odds(od, sport)
                if close:
                    # Update the existing row for this event+source
                    gd = game_date.strftime("%Y-%m-%d") if hasattr(game_date, 'strftime') else str(game_date)
                    row = {"event_id": event_id, "sport_key": sport, "source": source, "game_date": gd}
                    for k, v in close.items():
                        if k == "source":
                            row["close_source"] = v
                        else:
                            row[f"close_{k}"] = v
                    batch.append(row)

        if len(batch) >= 50:
            conn = upsert_batch(conn, batch)
            print(f"    [{i+1}/{len(rows)}] Uploaded {len(batch)} close odds (credits: {remaining_credits})")
            batch = []
        elif (i + 1) % 25 == 0:
            print(f"    [{i+1}/{len(rows)}] Processing... batch={len(batch)} (credits: {remaining_credits})")

        time.sleep(0.15)

    if batch:
        conn = upsert_batch(conn, batch)
        print(f"    Final: uploaded {len(batch)} close odds")

    print(f"  Phase 1 done: {total_requests} API requests")


def fill_commence_time(conn, sport_filter=None):
    """Phase 2: Fill commence_time + close odds for events that lack commence_time.
    Uses UPDATE for commence_time (affects all rows per event), then fetches close odds."""
    cur = conn.cursor()

    where = "WHERE commence_time IS NULL"
    params = []
    if sport_filter:
        where += " AND sport_key = %s"
        params.append(sport_filter)

    # Get distinct (sport, game_date) combos and their event_ids
    cur.execute(f"""
        SELECT sport_key, game_date, array_agg(DISTINCT event_id) as event_ids
        FROM back_in_play_game_odds
        {where}
        GROUP BY sport_key, game_date
        ORDER BY sport_key, game_date
    """, params)
    date_rows = cur.fetchall()

    total_events = sum(len(eids) for _, _, eids in date_rows)
    print(f"\nPhase 2: {len(date_rows)} sport+date combos, {total_events} distinct events need commence_time")

    updated = 0
    close_batch = []

    for i, (sport, game_date, event_ids) in enumerate(date_rows):
        config = SPORT_CONFIGS.get(sport, {})
        regions = config.get("regions", "us")
        markets = config.get("markets", "h2h,spreads,totals")
        date_str = game_date.strftime("%Y-%m-%d") if hasattr(game_date, 'strftime') else str(game_date)
        event_id_set = set(event_ids)

        # Get events for this date to find commence_times (1 API call per date)
        data = api_get(f"{BASE}/{sport}/events", {
            "apiKey": API_KEY, "date": f"{date_str}T12:00:00Z",
        })
        if not data:
            continue

        events = data.get("data", data) if isinstance(data, dict) else data
        if not isinstance(events, list):
            continue

        # Process events commencing on this date that we need
        for event in events:
            eid = event.get("id")
            ct = event.get("commence_time", "")
            if not eid or not ct or eid not in event_id_set:
                continue

            # Only process events commencing on this date
            if ct[:10] != date_str:
                continue

            # UPDATE commence_time for ALL rows of this event
            cur.execute("""
                UPDATE back_in_play_game_odds
                SET commence_time = %s
                WHERE event_id = %s AND commence_time IS NULL
            """, (ct, eid))
            conn.commit()
            updated += 1

            # Fetch close odds (1 API call per event)
            try:
                ct_dt = datetime.fromisoformat(ct.replace("Z", "+00:00"))
                close_ts = (ct_dt - timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M:%SZ")

                close_data = api_get(f"{BASE}/{sport}/events/{eid}/odds", {
                    "apiKey": API_KEY, "date": close_ts,
                    "regions": regions, "markets": markets, "oddsFormat": "american",
                })
                if close_data:
                    od = close_data.get("data", close_data) if isinstance(close_data, dict) else close_data
                    if isinstance(od, dict):
                        close = extract_odds(od, sport)
                        if close:
                            # Get all source rows for this event to update each
                            cur.execute("SELECT DISTINCT source FROM back_in_play_game_odds WHERE event_id = %s", (eid,))
                            sources = [r[0] for r in cur.fetchall()]
                            for src in sources:
                                row = {"event_id": eid, "sport_key": sport, "source": src, "game_date": date_str}
                                for k, v in close.items():
                                    if k == "source":
                                        row["close_source"] = v
                                    else:
                                        row[f"close_{k}"] = v
                                close_batch.append(row)
            except Exception as e:
                pass

            time.sleep(0.1)

        if len(close_batch) >= 100:
            conn = upsert_batch(conn, close_batch)
            print(f"    [{i+1}/{len(date_rows)}] Updated {updated} CT, uploaded {len(close_batch)} close odds (credits: {remaining_credits})")
            close_batch = []
        elif (i + 1) % 20 == 0:
            print(f"    [{i+1}/{len(date_rows)}] dates processed, {updated} CT updated, {len(close_batch)} close pending (credits: {remaining_credits})")

        time.sleep(0.15)

    if close_batch:
        conn = upsert_batch(conn, close_batch)
        print(f"    Final: uploaded {len(close_batch)} close odds")

    print(f"  Phase 2 done: {updated} commence_times updated, {total_requests} API requests")


def scrape_missing(conn, sport_filter=None):
    """Phase 3: Scrape date ranges where we have NO data.
    Key optimization: only process events commencing on the current date."""

    cur = conn.cursor()

    sports = {sport_filter: SPORT_CONFIGS[sport_filter]} if sport_filter else SPORT_CONFIGS

    for sport, config in sports.items():
        label = sport.split("_")[-1].upper()
        start_date = config["start"]
        end_date = config.get("end", "2026-03-25")
        regions = config.get("regions", "us")
        markets = config.get("markets", "h2h,spreads,totals")

        # Get dates we already have events for
        cur.execute("""
            SELECT DISTINCT game_date FROM back_in_play_game_odds
            WHERE sport_key = %s
        """, (sport,))
        existing_dates = {str(r[0]) for r in cur.fetchall()}

        # Get event_ids that are COMPLETE (have all key markets filled)
        # Incomplete events (missing spread or total) will be re-fetched with per-market merge
        cur.execute("""
            SELECT DISTINCT event_id FROM back_in_play_game_odds
            WHERE sport_key = %s
              AND h2h_home_price IS NOT NULL
              AND spread_home_line IS NOT NULL
              AND total_line IS NOT NULL
        """, (sport,))
        existing_events = {r[0] for r in cur.fetchall()}
        # Also count how many incomplete events exist
        cur.execute("""
            SELECT COUNT(DISTINCT event_id) FROM back_in_play_game_odds
            WHERE sport_key = %s
              AND h2h_home_price IS NOT NULL
              AND (spread_home_line IS NULL OR total_line IS NULL)
        """, (sport,))
        incomplete = cur.fetchone()[0]

        print(f"\n{'='*60}")
        print(f"  Phase 3: {label} — scraping missing dates")
        print(f"  Range: {start_date} to {end_date}")
        print(f"  Complete: {len(existing_events)} events, {incomplete} incomplete (will re-fetch)")
        print(f"{'='*60}")

        current = datetime.strptime(start_date, "%Y-%m-%d")
        end = datetime.strptime(end_date, "%Y-%m-%d")
        batch = []
        new_events = 0
        skipped_events = 0

        while current <= end:
            date_str = current.strftime("%Y-%m-%d")

            # Note: we don't skip dates entirely — existing_events handles per-event dedup
            # A date may have partial data (e.g., 1 of 8 NHL games)

            # Get events for this date
            data = api_get(f"{BASE}/{sport}/events", {
                "apiKey": API_KEY, "date": f"{date_str}T12:00:00Z",
            })

            if not data:
                current += timedelta(days=1)
                continue

            events = data.get("data", data) if isinstance(data, dict) else data
            if not isinstance(events, list) or not events:
                current += timedelta(days=1)
                continue

            # ONLY process events commencing on THIS date (ET timezone)
            # NHL/NBA/NFL/MLB evening games have UTC commence_time on the NEXT day
            # e.g., 7pm ET Jan 3 = 2023-01-04T00:00:00Z
            # So we accept events from date_str 05:00 UTC to date_str+1 05:00 UTC (= midnight-midnight ET)
            next_date = (current + timedelta(days=1)).strftime("%Y-%m-%d")
            todays_events = []
            for event in events:
                ct = event.get("commence_time", "")
                if not ct:
                    continue
                # Convert UTC to ET by checking if commence is between date 05:00Z and next_date 05:00Z
                ct_date_utc = ct[:10]
                ct_hour = int(ct[11:13]) if len(ct) > 13 else 12
                # Game is "today" in ET if:
                # - UTC date matches and hour >= 5 (after midnight ET)
                # - OR UTC date is next day and hour < 5 (before midnight ET = late evening game)
                is_today_et = (ct_date_utc == date_str and ct_hour >= 5) or \
                              (ct_date_utc == next_date and ct_hour < 5)
                if is_today_et:
                    todays_events.append(event)

            for event in todays_events:
                eid = event.get("id")
                if not eid or eid in existing_events:
                    skipped_events += 1
                    continue

                ct = event.get("commence_time", "")
                # Store game_date in ET (the actual local game day)
                game_date = date_str  # Always use the iteration date = ET date

                # Fetch OPEN odds (game day at noon)
                open_data = api_get(f"{BASE}/{sport}/events/{eid}/odds", {
                    "apiKey": API_KEY, "date": f"{date_str}T12:00:00Z",
                    "regions": regions, "markets": markets, "oddsFormat": "american",
                })

                base = {
                    "event_id": eid,
                    "sport_key": sport,
                    "game_date": game_date,
                    "home_team": event.get("home_team"),
                    "away_team": event.get("away_team"),
                    "commence_time": ct,
                }

                open_rows = []
                if open_data:
                    od = open_data.get("data", open_data) if isinstance(open_data, dict) else open_data
                    if isinstance(od, dict):
                        open_rows = extract_odds_multi(od, sport)

                # Fetch CLOSE odds (commence_time - 30 min)
                close_rows = []
                if ct:
                    try:
                        ct_dt = datetime.fromisoformat(ct.replace("Z", "+00:00"))
                        close_ts = (ct_dt - timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
                        close_data = api_get(f"{BASE}/{sport}/events/{eid}/odds", {
                            "apiKey": API_KEY, "date": close_ts,
                            "regions": regions, "markets": markets, "oddsFormat": "american",
                        })
                        if close_data:
                            od = close_data.get("data", close_data) if isinstance(close_data, dict) else close_data
                            if isinstance(od, dict):
                                close_rows = extract_odds_multi(od, sport)
                    except:
                        pass

                # Build final rows — one per bookmaker source
                if not open_rows:
                    open_rows = [{}]
                close_by_source = {r.get("source"): r for r in close_rows}
                for open_odds in open_rows:
                    row = {**base, **open_odds}
                    src = open_odds.get("source", "unknown")
                    close_odds = close_by_source.get(src) or (close_rows[0] if close_rows else None)
                    if close_odds:
                        for k, v in close_odds.items():
                            if k == "source":
                                row["close_source"] = v
                            else:
                                row[f"close_{k}"] = v
                    batch.append(row)

                existing_events.add(eid)
                new_events += 1
                time.sleep(0.1)

            if len(batch) >= 100:
                conn = upsert_batch(conn, batch)
                print(f"    {date_str}: +{len(batch)} events, {new_events} total new, {skipped_events} existing skipped (credits: {remaining_credits})")
                batch = []

            if todays_events:
                if len(batch) < 100:  # only print if we didn't just print from upload
                    pass  # will print on next upload

            current += timedelta(days=1)
            time.sleep(0.15)

        # Final upload
        if batch:
            conn = upsert_batch(conn, batch)
            print(f"    Final: +{len(batch)} events")

        print(f"  {label} done: {new_events} new events, {skipped_events} existing skipped, {total_requests} total API requests")
        existing_dates_str = date_str  # save for checkpoint


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", action="store_true")
    parser.add_argument("--fill-close", action="store_true", help="Phase 1: fill close odds")
    parser.add_argument("--fill-commence", action="store_true", help="Phase 2: fill commence_time + close")
    parser.add_argument("--scrape-missing", action="store_true", help="Phase 3: scrape missing dates")
    parser.add_argument("--all", action="store_true", help="Run all phases")
    parser.add_argument("--sport", help="Filter to one sport (e.g. baseball_mlb)")
    args = parser.parse_args()

    if args.report:
        report()
        return

    conn = get_conn()

    if args.fill_close or args.all:
        print("\n" + "="*60)
        print("PHASE 1: Fill close odds for events with commence_time")
        print("="*60)
        fill_close_odds(conn, args.sport)

    if args.fill_commence or args.all:
        print("\n" + "="*60)
        print("PHASE 2: Fill commence_time + close odds")
        print("="*60)
        fill_commence_time(conn, args.sport)

    if args.scrape_missing or args.all:
        print("\n" + "="*60)
        print("PHASE 3: Scrape missing date ranges")
        print("="*60)
        scrape_missing(conn, args.sport)

    conn.close()

    # Final credit check
    try:
        r = requests.get("https://api.the-odds-api.com/v4/sports", params={"apiKey": API_KEY})
        print(f"\nFinal credits: {r.headers.get('x-requests-used')} used, {r.headers.get('x-requests-remaining')} remaining")
    except:
        pass

    print(f"Total API requests this run: {total_requests}")


if __name__ == "__main__":
    main()
