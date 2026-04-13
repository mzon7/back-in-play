#!/usr/bin/env python3
"""
Shared database writer for all scraper/import scripts.

Uses Supabase's Postgres connection pooler (port 6543) for bulk writes
instead of the REST API. This prevents connection pool exhaustion that
takes down the production site.

REST API: Each HTTP request opens a DB connection → 1000 requests = 1000 connections
Pooler:   One persistent connection, bulk INSERTs → 1 connection for all writes

Usage:
    from db_writer import get_db, pg_upsert, pg_query

    # Write (uses Postgres pooler)
    pg_upsert("back_in_play_player_game_logs", rows, conflict_cols=["player_id", "game_date"])

    # Read (uses REST API — lightweight, no connection cost)
    data = pg_query("back_in_play_leagues", "slug, league_id", filters={"slug": "eq.nhl"})
"""
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

# ─── Env loading ─────────────────────────────────────────────────────────────

def _load_env():
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

_load_env()

SB_URL = os.environ.get("SUPABASE_URL", "")
SB_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
PG_URL = os.environ.get("SUPABASE_DB_URL", "")

# ─── Postgres connection (for writes) ────────────────────────────────────────

_pg_conn = None

def get_db():
    """Get a persistent Postgres connection via Supabase's connection pooler."""
    global _pg_conn
    if _pg_conn is not None:
        try:
            _pg_conn.cursor().execute("SELECT 1")
            return _pg_conn
        except Exception:
            _pg_conn = None

    if not PG_URL:
        print("WARNING: SUPABASE_DB_URL not set — falling back to REST API for writes", file=sys.stderr)
        return None

    try:
        import psycopg2
        _pg_conn = psycopg2.connect(PG_URL, connect_timeout=10)
        _pg_conn.autocommit = True
        return _pg_conn
    except ImportError:
        print("WARNING: psycopg2 not installed — falling back to REST API for writes", file=sys.stderr)
        return None
    except Exception as e:
        print(f"WARNING: Postgres connection failed ({e}) — falling back to REST API", file=sys.stderr)
        return None


def pg_upsert(table, rows, conflict_cols=None, batch_size=500):
    """
    Upsert rows into a table.

    Tries Postgres pooler first (efficient, single connection).
    Falls back to REST API if Postgres is unavailable.

    Args:
        table: Table name
        rows: List of dicts with column names as keys
        conflict_cols: List of columns for ON CONFLICT (default: ["player_id", "game_date"])
        batch_size: Rows per INSERT statement (default: 500)

    Returns:
        Number of rows upserted
    """
    if not rows:
        return 0

    if conflict_cols is None:
        conflict_cols = ["player_id", "game_date"]

    # Dedupe
    seen = set()
    unique = []
    for r in rows:
        k = tuple(r.get(c) for c in conflict_cols)
        if k not in seen:
            seen.add(k)
            unique.append(r)
    rows = unique

    conn = get_db()
    if conn:
        return _pg_upsert_postgres(conn, table, rows, conflict_cols, batch_size)
    else:
        return _pg_upsert_rest(table, rows, conflict_cols, batch_size)


def _pg_upsert_postgres(conn, table, rows, conflict_cols, batch_size):
    """Bulk upsert via Postgres — single connection, very efficient."""
    import psycopg2.extras

    if not rows:
        return 0

    cols = list(rows[0].keys())
    conflict = ", ".join(conflict_cols)
    update_cols = [c for c in cols if c not in conflict_cols]
    update_clause = ", ".join(f"{c} = EXCLUDED.{c}" for c in update_cols)

    total = 0
    cur = conn.cursor()

    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        values_list = []
        params = []
        for row in batch:
            placeholders = ", ".join(["%s"] * len(cols))
            values_list.append(f"({placeholders})")
            params.extend(row.get(c) for c in cols)

        sql = (
            f"INSERT INTO {table} ({', '.join(cols)}) "
            f"VALUES {', '.join(values_list)} "
            f"ON CONFLICT ({conflict}) "
        )
        if update_cols:
            sql += f"DO UPDATE SET {update_clause}"
        else:
            sql += "DO NOTHING"

        for attempt in range(3):
            try:
                cur.execute(sql, params)
                total += len(batch)
                break
            except Exception as e:
                if attempt < 2:
                    time.sleep(2 ** (attempt + 1))
                    try:
                        conn.rollback()
                    except Exception:
                        pass
                else:
                    print(f"  PG UPSERT ERR ({table}): {str(e)[:100]}", file=sys.stderr)

    return total


def _pg_upsert_rest(table, rows, conflict_cols, batch_size):
    """Fallback: upsert via REST API with rate limiting."""
    conflict = ",".join(conflict_cols)
    hdrs = {
        "apikey": SB_KEY,
        "Authorization": f"Bearer {SB_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal,resolution=merge-duplicates",
    }
    url = f"{SB_URL}/rest/v1/{table}?on_conflict={conflict}"
    total = 0
    rest_batch = min(batch_size, 200)  # REST API can't handle as large batches

    for i in range(0, len(rows), rest_batch):
        batch = rows[i:i + rest_batch]
        for attempt in range(3):
            try:
                req = urllib.request.Request(
                    url, data=json.dumps(batch).encode(), headers=hdrs, method="POST"
                )
                urllib.request.urlopen(req, timeout=120).read()
                total += len(batch)
                break
            except Exception as e:
                if attempt < 2:
                    time.sleep(5 * (attempt + 1))
                else:
                    print(f"  REST UPSERT ERR ({table}): {str(e)[:100]}", file=sys.stderr)
        time.sleep(0.5)  # Rate limit REST API writes

    return total


# ─── REST API reads (lightweight, fine for frontend-style queries) ───────────

def pg_query(table, select="*", filters=None, limit=1000, order=None):
    """
    Query via REST API (for reads — lightweight, no connection pool cost).

    Args:
        table: Table name
        select: Columns to select
        filters: Dict of {column: "eq.value"} filters
        limit: Max rows
        order: Order column (e.g. "game_date.desc")
    """
    params = f"select={select}&limit={limit}"
    if filters:
        for col, val in filters.items():
            params += f"&{col}={val}"
    if order:
        params += f"&order={order}"

    url = f"{SB_URL}/rest/v1/{table}?{params}"
    hdrs = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"}

    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=hdrs)
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read())
        except Exception as e:
            if attempt < 2:
                time.sleep(2 * (attempt + 1))
            else:
                print(f"  [SB GET ERR] {table}: {e}", file=sys.stderr)
    return []


def pg_query_paginate(table, select="*", filters=None, order=None, batch=1000):
    """Paginate through all rows of a table."""
    all_data = []
    offset = 0
    while True:
        params = f"select={select}&limit={batch}&offset={offset}"
        if filters:
            for col, val in filters.items():
                params += f"&{col}={val}"
        if order:
            params += f"&order={order}"

        url = f"{SB_URL}/rest/v1/{table}?{params}"
        hdrs = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"}

        rows = []
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, headers=hdrs)
                with urllib.request.urlopen(req, timeout=60) as resp:
                    rows = json.loads(resp.read())
                break
            except Exception:
                time.sleep(3)

        all_data.extend(rows)
        if len(rows) < batch:
            break
        offset += batch

    return all_data
