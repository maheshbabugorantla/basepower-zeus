"""Refresh the M1 score materialized views (0102_m1_materialize.sql):
core.mv_home_block_group -> core.mv_blockgroup_scores -> core.mv_top_homes,
in that dependency order.

Why this exists: api.blockgroup_scores and api.top_homes were originally
plain views recomputing a live ST_Within spatial join of ~217K gated
parcel centroids against core.block_groups, plus permit aggregation, on
every request — `select count(*) from api.blockgroup_scores` alone blew
Supabase's 120s statement_timeout (the /ranking outage this fixes).
0102_m1_materialize.sql turned those into materialized views; this module
is what keeps them fresh after every parcel/geometry/block-group/permit
load.

This step has no raw source file and writes no ops.source_manifest row:
it derives entirely from tables that are already manifested (core.parcels,
core.parcel_geoms, core.block_groups, core.permits, core.permit_labels),
and each mv's own source_ids column carries that provenance forward row
by row — so `python -m pipelines.check provenance` still passes on
api.blockgroup_scores / api.top_homes without this module ever touching
ops.source_manifest.

REFRESH MATERIALIZED VIEW CONCURRENTLY cannot run inside a transaction
block (Postgres error: "cannot run inside a transaction block") — it
manages its own transaction internally, hence the module opens its own
autocommit connection here rather than using pipelines.core.db.connect(),
which wraps every statement in one. It requires a unique index on the mv
(created by 0102_m1_materialize.sql on all three) and, unlike a plain
REFRESH, never blocks reads of the mv while it runs.

Uses POSTGRES_URL_NON_POOLING (session pooler) like every other CLI/
backfill-shaped operation in this codebase — a REFRESH this size (a
~217K-row spatial join to start) does not belong on the transaction
pooler, and the ticket calls for a 15-minute statement_timeout, well
past what a pgbouncer transaction-mode connection is meant to hold.
"""
from __future__ import annotations

from typing import Any, Literal

import psycopg

from pipelines.core import config, runs
from sources import scoring_refresh  # sibling module under pipelines/sources (registry convention, see parcels.py)

SOURCE = "refresh_scores"

# The refresh order lives in ONE place: core.refresh_all_scores() in the
# database (0201, extended by 0203). This step just calls it and reports
# row counts, so a new materialized view can't be forgotten here again.
MATERIALIZED_VIEWS = (
    "core.mv_home_block_group",
    "core.mv_home_signals",
    "core.mv_join_rate",
    "core.mv_blockgroup_scores",
    "core.mv_top_homes",
    "core.mv_gate_counts",
    "core.mv_parcel_gate_counts",
    "core.mv_blockgroup_geojson",
)

# mv_home_signals alone takes ~10 min on Supabase Small (spatial joins over
# ~217k homes x territories x flood zones). CLI-only: never fits a Vercel call.
STATEMENT_TIMEOUT = "45min"

Runner = Literal["cron", "cli"]


def _connect_autocommit() -> psycopg.Connection:
    """A dedicated autocommit connection on the session pooler: REFRESH
    MATERIALIZED VIEW CONCURRENTLY must run outside any transaction
    block, so this deliberately does not use pipelines.core.db.connect()
    (which wraps every statement in one and commits/rolls back around
    it)."""
    dsn = config.postgres_url_non_pooling()
    return psycopg.connect(dsn, prepare_threshold=None, autocommit=True)


def refresh_all(conn: psycopg.Connection) -> dict[str, int]:
    """REFRESH MATERIALIZED VIEW CONCURRENTLY for each mv, in dependency
    order, under a 45-minute statement_timeout. Returns each mv's row
    count after refresh."""
    row_counts: dict[str, int] = {}
    with conn.cursor() as cur:
        cur.execute(f"set statement_timeout = '{STATEMENT_TIMEOUT}'")
        # Perf follow-up (0307_batched_scoring_swap.sql): core.mv_home_signals
        # and core.mv_home_terms are plain tables now, kept current by
        # scoring_refresh.run()'s batched prop_id-keyset upserts, not by
        # `REFRESH MATERIALIZED VIEW CONCURRENTLY`. scoring_refresh.run()
        # does the full sequence itself -- batches, then
        # `select core.refresh_all_scores()` last for the remaining legacy
        # v0 chain / gate counts / market / anchors+medians / geo rollup /
        # county territories (see that module's run() docstring) -- so this
        # cursor no longer calls refresh_all_scores() directly.
        scoring_refresh.run()
        for mv in MATERIALIZED_VIEWS:
            cur.execute(f"select count(*) from {mv}")
            row = cur.fetchone()
            assert row is not None
            row_counts[mv] = row[0]
    return row_counts


def run(*, runner: Runner, backfill: bool = False, cursor: dict[str, Any] | None = None) -> None:
    """Contract entry point: pipelines/sources/<name>.py's run(). `backfill`
    and `cursor` are accepted for signature parity with every other source
    module but unused — a mv refresh is not incremental or resumable, it
    is a single full recompute each time."""
    with psycopg.connect(
        config.postgres_url_non_pooling(), prepare_threshold=None, autocommit=False
    ) as run_conn:
        run_id = runs.start(run_conn, source=SOURCE, runner=runner, cursor=None)

    conn = _connect_autocommit()
    try:
        row_counts = refresh_all(conn)
    except Exception as exc:
        with psycopg.connect(
            config.postgres_url_non_pooling(), prepare_threshold=None, autocommit=False
        ) as fail_conn:
            runs.finish(fail_conn, run_id, status="failed", error=str(exc))
        raise
    finally:
        conn.close()

    total_rows = sum(row_counts.values())
    with psycopg.connect(
        config.postgres_url_non_pooling(), prepare_threshold=None, autocommit=False
    ) as finish_conn:
        runs.finish(
            finish_conn,
            run_id,
            status="success",
            rows_in=total_rows,
            rows_loaded=total_rows,
            filter_drops={},
            cursor={"row_counts": row_counts},
        )
