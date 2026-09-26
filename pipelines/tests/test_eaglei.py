"""Real tests for pipelines/sources/eaglei.py.

No synthetic rows: the fixture is a byte slice of the real 2025 EAGLE-I
CSV (see fixtures/eaglei/eaglei_outages_2025_slice0.csv.source.json for
its exact byte range in the source file), and the aggregation check
recomputes the expected numbers from that same slice independently
in-test (plain csv module), rather than hardcoding magic numbers.

The live-DB test requires a real backfill to have already loaded
core.outage_county_year (via `python -m pipelines.run eaglei --backfill`)
and is skipped if POSTGRES_URL_NON_POOLING isn't configured.
"""
from __future__ import annotations

import csv
import os
from pathlib import Path

import pytest

from sources import eaglei

FIXTURE = Path(__file__).parent / "fixtures" / "eaglei" / "eaglei_outages_2025_slice0.csv"


def test_aggregate_matches_independent_recompute_on_fixture():
    state = eaglei.aggregate(str(FIXTURE))

    # Independent recomputation of the same fixture slice, not using any
    # of eaglei.py's own code.
    rows_in = 0
    non_texas = 0
    missing = 0
    expected_sums: dict[str, int] = {}
    with open(FIXTURE, newline="") as f:
        for row in csv.DictReader(f):
            rows_in += 1
            if row["state"] != "Texas":
                non_texas += 1
                continue
            if row["customers_out"] == "":
                missing += 1
                continue
            key = f"{row['fips_code']}|{row['run_start_time'][:4]}"
            expected_sums[key] = expected_sums.get(key, 0) + int(row["customers_out"])

    assert state["rows_in"] == rows_in
    assert state["filter_drops"]["non_texas"] == non_texas
    assert state["filter_drops"]["missing_customers_out"] == missing
    assert state["filter_drops"]["unparseable_customers_out"] == 0
    assert eaglei.rows_loaded(state) == rows_in - non_texas - missing
    assert state["sums"] == expected_sums
    assert len(expected_sums) > 0  # the slice does contain Texas rows


@pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) to check the live backfill",
)
def test_travis_county_2025_loaded_in_db():
    from pipelines.core import db

    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select customer_hours_out, source_ids from core.outage_county_year "
                "where county_fips = %s and year = %s",
                ("48453", 2025),
            )
            row = cur.fetchone()
            assert row is not None, "Travis County (48453) 2025 not loaded"
            customer_hours_out, source_ids = row
            assert customer_hours_out is not None
            assert source_ids and len(source_ids) >= 1

            cur.execute(
                "select count(*) from ops.source_manifest where id = any(%s) and source = 'eaglei'",
                (source_ids,),
            )
            assert cur.fetchone()[0] >= 1, "Travis's source_ids do not resolve to an eaglei manifest row"
