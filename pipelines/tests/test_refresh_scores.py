"""Real-DB tests for pipelines/sources/refresh_scores.py.

No synthetic rows: every assertion here runs against the live Supabase
database (POSTGRES_URL_NON_POOLING, exported by whatever invoked pytest —
see CLAUDE.md's `set -a; source .env; set +a` convention) and the
materialized views 0102_m1_materialize.sql already created from real
core.parcels / core.parcel_geoms / core.block_groups / core.permits /
core.permit_labels data. CI has no DB secrets, so every test here is
skipped, not failed, when POSTGRES_URL_NON_POOLING is unset.
"""
from __future__ import annotations

import os

import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) to check the live database",
)


def test_run_refreshes_mvs_and_records_a_success_run():
    from pipelines.core import db
    from sources import refresh_scores

    refresh_scores.run(runner="cli")

    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select status, rows_in, rows_loaded, filter_drops, runner, manifest_id
                from ops.pipeline_runs
                where source = %s
                order by started_at desc
                limit 1
                """,
                (refresh_scores.SOURCE,),
            )
            row = cur.fetchone()
            assert row is not None, "no ops.pipeline_runs row was written for refresh_scores"
            status, rows_in, rows_loaded, filter_drops, runner, manifest_id = row
            assert status == "success"
            assert runner == "cli"
            # No raw source file backs this step; it derives entirely from
            # already-manifested tables, so it writes no manifest row.
            assert manifest_id is None
            assert rows_in is not None and rows_loaded is not None
            # reconcile invariant: rows_loaded = rows_in - sum(filter_drops)
            drops = filter_drops or {}
            assert rows_loaded == rows_in - sum(drops.values())

        with conn.cursor() as cur:
            cur.execute("select count(*) from core.mv_home_block_group")
            home_bg_count = cur.fetchone()[0]
            cur.execute("select count(*) from core.mv_blockgroup_scores")
            bg_scores_count = cur.fetchone()[0]
            cur.execute("select count(*) from core.mv_top_homes")
            top_homes_count = cur.fetchone()[0]

    # Live data has already loaded parcels/geoms/block groups by M1, so a
    # real refresh must actually produce rows in each mv, not just run
    # without error.
    assert home_bg_count > 0
    assert bg_scores_count > 0
    assert top_homes_count > 0
    assert top_homes_count <= 50


def test_api_views_read_the_materialized_views_and_stay_fast():
    import time

    from pipelines.core import db

    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute("set statement_timeout = '5s'")

            t0 = time.time()
            cur.execute("select count(*) from api.blockgroup_scores")
            bg_count = cur.fetchone()[0]
            bg_elapsed = time.time() - t0
            assert bg_count > 0
            assert bg_elapsed < 2.0, f"api.blockgroup_scores took {bg_elapsed:.2f}s, want < 2s"

            t0 = time.time()
            cur.execute("select count(*) from api.top_homes")
            top_count = cur.fetchone()[0]
            top_elapsed = time.time() - t0
            assert top_count > 0
            assert top_elapsed < 2.0, f"api.top_homes took {top_elapsed:.2f}s, want < 2s"
