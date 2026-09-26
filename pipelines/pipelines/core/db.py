"""Postgres connections.

POSTGRES_URL is the Supabase transaction pooler (pgbouncer, port 6543):
psycopg must connect with prepare_threshold=None so it never issues a
named PREPARE, which pgbouncer's transaction pool mode cannot support.

POSTGRES_URL_NON_POOLING is the session pooler (port 5432): use it only
for migrations and long CLI backfills (never from the cron app, which
must return well inside the 300 s Hobby limit).
"""
from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

import psycopg

from . import config


@contextmanager
def connect(*, pooled: bool = True) -> Iterator[psycopg.Connection]:
    """Yield a psycopg connection, committing on success and rolling back
    on error. `pooled=True` (default) uses POSTGRES_URL (transaction
    pooler) — the right choice for every cron/request-scoped call.
    `pooled=False` uses POSTGRES_URL_NON_POOLING — for CLI backfills only.
    """
    dsn = config.postgres_url() if pooled else config.postgres_url_non_pooling()
    conn = psycopg.connect(dsn, prepare_threshold=None, autocommit=False)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
