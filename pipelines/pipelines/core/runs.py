"""Write ops.pipeline_runs rows: one per pipeline invocation (a single cron
call, or one CLI backfill chunk), with a resumable cursor and per-filter
drop counts.

Column names/types match tickets/M0/M0-S1.md's ops.pipeline_runs contract
exactly (id uuid pk default, source text, status text check in
('running','success','failed'), cursor jsonb, rows_in bigint, rows_loaded
bigint, filter_drops jsonb, runner text check in ('cron','cli'),
started_at/finished_at timestamptz, error text, created_at default).
This module is written against that contract but does not create or
migrate the table — M0-S1 owns the migration.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Literal

import psycopg

Runner = Literal["cron", "cli"]
Status = Literal["running", "success", "failed"]


def start(
    conn: psycopg.Connection,
    *,
    source: str,
    runner: Runner,
    cursor: dict[str, Any] | None = None,
) -> str:
    """Insert a `running` ops.pipeline_runs row and return its id."""
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into ops.pipeline_runs (source, status, cursor, runner)
            values (%s, 'running', %s, %s)
            returning id
            """,
            (source, json.dumps(cursor) if cursor is not None else None, runner),
        )
        row = cur.fetchone()
        assert row is not None
        return str(row[0])


def finish(
    conn: psycopg.Connection,
    run_id: str,
    *,
    status: Status,
    rows_in: int | None = None,
    rows_loaded: int | None = None,
    filter_drops: dict[str, int] | None = None,
    cursor: dict[str, Any] | None = None,
    error: str | None = None,
) -> None:
    """Update an ops.pipeline_runs row to its final status."""
    with conn.cursor() as cur:
        cur.execute(
            """
            update ops.pipeline_runs
            set status = %s,
                rows_in = %s,
                rows_loaded = %s,
                filter_drops = %s,
                cursor = %s,
                error = %s,
                finished_at = %s
            where id = %s
            """,
            (
                status,
                rows_in,
                rows_loaded,
                json.dumps(filter_drops) if filter_drops is not None else None,
                json.dumps(cursor) if cursor is not None else None,
                error,
                datetime.now(timezone.utc),
                run_id,
            ),
        )
