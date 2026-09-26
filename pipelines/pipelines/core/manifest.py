"""Write ops.source_manifest rows.

Column names/types below match tickets/M0/M0-S1.md's ops.source_manifest
contract exactly (id uuid pk default, source text, url text,
retrieved_at timestamptz, sha256 text, bytes bigint, rows bigint nullable,
runner text check in ('cron','cli'), storage_key text, created_at
default). This module is written against that contract but does not
create or migrate the table — M0-S1 owns the migration.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

import psycopg

Runner = Literal["cron", "cli"]


def insert(
    conn: psycopg.Connection,
    *,
    source: str,
    url: str,
    retrieved_at: datetime,
    sha256: str,
    bytes_: int,
    rows: int | None,
    runner: Runner,
    storage_key: str,
) -> str:
    """Insert one ops.source_manifest row and return its id."""
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into ops.source_manifest
                (source, url, retrieved_at, sha256, bytes, rows, runner, storage_key)
            values (%s, %s, %s, %s, %s, %s, %s, %s)
            returning id
            """,
            (source, url, retrieved_at, sha256, bytes_, rows, runner, storage_key),
        )
        row = cur.fetchone()
        assert row is not None
        return str(row[0])
