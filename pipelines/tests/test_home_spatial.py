"""Real-DB tests for M3-P6's spatial precompute (core.home_spatial,
core.flood_zones_sub, core.territories_sub — supabase/migrations/0304*).

Every test reads the live Supabase DB via POSTGRES_URL_NON_POOLING
(skipped if that env var isn't set, and skipped per-test if the relevant
table/rows aren't loaded yet) — no synthetic rows, no seeded fakes, real
extracts only, per CLAUDE.md's real-data rule. Follows
pipelines/tests/test_utility_gate.py's pattern.

What's under test:
  * Flood membership is identical between the raw core.flood_zones and
    the subdivided core.flood_zones_sub for every home already computed
    into core.home_spatial (acceptance: "subdivision must not change
    answers").
  * A rerun of pipelines/sources/home_spatial.run() for a county with no
    upstream change touches zero rows (acceptance: "Incremental").
  * The Harris-pin / Williamson-withhold territory rule (same user
    decision as 0303_utility_gate_counts.sql) is reproduced in
    core.home_spatial itself, not just in mv_home_signals downstream.
  * Every core.home_spatial row's boundary_source_ids is non-empty and
    traces to real source rows (real-data rule 1 — nothing invented).
"""
from __future__ import annotations

import os

import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) against the live DB",
)

HARRIS = "48201"
WILLIAMSON = "48491"
TRAVIS = "48453"


def _connect():
    from pipelines.core import db

    return db.connect(pooled=False)


def _table_exists(cur, schema: str, table: str) -> bool:
    cur.execute(
        "select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace "
        "where n.nspname = %s and c.relname = %s",
        (schema, table),
    )
    return cur.fetchone() is not None


def test_flood_zones_sub_matches_raw_hit_count():
    """The subdivided flood table must never change which homes are
    inside a Special Flood Hazard Area — only how fast that's computed.
    Compares raw vs. subdivided membership for every home already in
    core.home_spatial with a resolved point."""
    with _connect() as conn:
        with conn.cursor() as cur:
            if not _table_exists(cur, "core", "flood_zones_sub") or not _table_exists(cur, "core", "home_spatial"):
                pytest.skip("core.flood_zones_sub / core.home_spatial not migrated yet")
            cur.execute("select count(*) from core.home_spatial where pt is not null")
            (n,) = cur.fetchone()
            if n == 0:
                pytest.skip("core.home_spatial has no rows with a resolved point yet")

            cur.execute(
                """
                select count(*)
                from core.home_spatial hs
                where hs.pt is not null
                  and hs.in_sfha is not null
                  and hs.in_sfha != exists (
                      select 1 from core.flood_zones fz
                      where fz.fld_zone ~ '^(A|V)' and extensions.ST_Within(hs.pt, fz.geom)
                  )
                """
            )
            (mismatches,) = cur.fetchone()
            assert mismatches == 0, (
                f"{mismatches} home(s) disagree between core.flood_zones (raw) and "
                f"core.home_spatial.in_sfha (subdivided) — subdivision changed an answer"
            )


def test_rerun_with_no_upstream_change_writes_zero_rows():
    """Acceptance: 'Incremental. Re-running home_spatial with no changed
    sources touches 0 rows and finishes in seconds.' Runs one real batch
    for Travis twice in a row against the live DB and asserts the second
    pass's rows_written is 0."""
    with _connect() as conn:
        with conn.cursor() as cur:
            if not _table_exists(cur, "core", "home_spatial"):
                pytest.skip("core.home_spatial not migrated yet")
            cur.execute("select count(*) from core.parcels where county_fips = %s", (TRAVIS,))
            (n,) = cur.fetchone()
            if n == 0:
                pytest.skip("no Travis parcels loaded yet")

    from pipelines.sources import home_spatial

    first = home_spatial.run_county(county_fips=TRAVIS, runner="cli")
    assert first["rows_seen"] > 0, "expected the first pass to compute at least one row"

    second = home_spatial.run_county(county_fips=TRAVIS, runner="cli")
    assert second["rows_written"] == 0, (
        f"rerun with no upstream change should write 0 rows, wrote {second['rows_written']}"
    )


def test_harris_pinned_to_centerpoint_in_home_spatial():
    """Same user decision as 0303_utility_gate_counts.sql, reproduced at
    the home_spatial layer: every Harris home resolves to CenterPoint
    (8901) with basis 'most_likely_county_utility'."""
    with _connect() as conn:
        with conn.cursor() as cur:
            if not _table_exists(cur, "core", "home_spatial"):
                pytest.skip("core.home_spatial not migrated yet")
            cur.execute(
                "select distinct resolved_territory_eia_id, territory_basis "
                "from core.home_spatial where county_fips = %s",
                (HARRIS,),
            )
            rows = cur.fetchall()
            if not rows:
                pytest.skip("no Harris rows in core.home_spatial yet")
            assert rows == [("8901", "most_likely_county_utility")], (
                f"expected every Harris home_spatial row pinned to CenterPoint (8901), got {rows}"
            )


def test_williamson_utility_withheld_in_home_spatial():
    """Williamson stays withheld at the home_spatial layer too:
    resolved_territory_eia_id NULL, territory_null_reason=
    'utility_not_confirmed', territory_gate_reason NULL (still gated
    in — only the territory/utility claim is withheld)."""
    with _connect() as conn:
        with conn.cursor() as cur:
            if not _table_exists(cur, "core", "home_spatial"):
                pytest.skip("core.home_spatial not migrated yet")
            cur.execute(
                "select distinct resolved_territory_eia_id, territory_null_reason, territory_gate_reason "
                "from core.home_spatial where county_fips = %s",
                (WILLIAMSON,),
            )
            rows = cur.fetchall()
            if not rows:
                pytest.skip("no Williamson rows in core.home_spatial yet")
            assert rows == [(None, "utility_not_confirmed", None)], (
                f"expected Williamson home_spatial rows withheld, got {rows}"
            )


def test_boundary_source_ids_never_empty_for_a_resolved_home():
    """Real-data rule 1: every home_spatial row with a resolved block
    group traces to at least one real source_id (its parcel geometry or
    the block-group boundary file) — never an empty provenance list for a
    row that clearly used loaded boundary data."""
    with _connect() as conn:
        with conn.cursor() as cur:
            if not _table_exists(cur, "core", "home_spatial"):
                pytest.skip("core.home_spatial not migrated yet")
            cur.execute("select count(*) from core.home_spatial where block_group_geoid is not null")
            (n,) = cur.fetchone()
            if n == 0:
                pytest.skip("no home_spatial rows with a resolved block group yet")
            cur.execute(
                "select count(*) from core.home_spatial "
                "where block_group_geoid is not null "
                "  and (boundary_source_ids is null or cardinality(boundary_source_ids) = 0)"
            )
            (bad,) = cur.fetchone()
            assert bad == 0, f"{bad} home_spatial row(s) with a resolved block group but empty boundary_source_ids"


def test_input_hash_never_null():
    """Every row must carry an input_hash (the incremental-skip key) —
    a null hash would make every future run recompute that row forever."""
    with _connect() as conn:
        with conn.cursor() as cur:
            if not _table_exists(cur, "core", "home_spatial"):
                pytest.skip("core.home_spatial not migrated yet")
            cur.execute("select count(*) from core.home_spatial")
            (n,) = cur.fetchone()
            if n == 0:
                pytest.skip("core.home_spatial has no rows yet")
            cur.execute("select count(*) from core.home_spatial where input_hash is null")
            (bad,) = cur.fetchone()
            assert bad == 0, f"{bad} core.home_spatial row(s) with a null input_hash"
