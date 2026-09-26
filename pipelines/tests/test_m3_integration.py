"""Real-DB tests for M3 integration: Harris (48201) and Williamson (48491)
homes gated, scored, and predicted like Travis.

Every test here reads the live Supabase DB via POSTGRES_URL_NON_POOLING
(skipped if that env var isn't set) -- no synthetic rows, no seeded
fakes; every assertion is against whatever the real backfills/refresh in
this ticket actually wrote. Assertions that depend on a specific
pipeline having already run (core.home_propensity for the new counties)
skip rather than fail if that data isn't there yet, matching
pipelines/tests/test_propensity.py's own pattern.
"""
from __future__ import annotations

import os

import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) against the live DB",
)

NEW_COUNTIES = ("48201", "48491")  # Harris, Williamson


def _connect():
    from pipelines.core import db

    return db.connect(pooled=False)


# ---------------------------------------------------------------------------
# Utility crosswalk / retail_market / base_capture: the five Williamson-
# area utilities this ticket added must all be real, cited, and NOT
# invented as served.
# ---------------------------------------------------------------------------

NOT_SERVED_EIA = ("14626", "1892", "1273", "1287", "7129")


def test_new_utilities_are_real_polygons_not_base_served():
    """Every one of the five utilities this ticket added to the
    crosswalk (Pedernales, Bluebonnet, Bartlett EC, City of Bartlett,
    City of Georgetown) must have a real core.territories polygon match
    (a real EIA-861 id, never invented) and must read mapped='no' --
    confirmed not on Base's own served-utility list (pricing.md /
    llms.txt), never guessed as served."""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select eia_utility_number, mapped from core.utility_crosswalk "
                "where eia_utility_number = any(%s)",
                (list(NOT_SERVED_EIA),),
            )
            rows = {r[0]: r[1] for r in cur.fetchall()}
            assert set(rows) == set(NOT_SERVED_EIA), f"missing crosswalk rows: {set(NOT_SERVED_EIA) - set(rows)}"
            for eia_id, mapped in rows.items():
                assert mapped == "no", f"{eia_id} should be mapped='no' (not on Base's served list), got {mapped!r}"

            cur.execute(
                "select eia_id from core.territories where eia_id = any(%s)",
                (list(NOT_SERVED_EIA),),
            )
            territory_ids = {r[0] for r in cur.fetchall()}
            assert territory_ids == set(NOT_SERVED_EIA), (
                "every crosswalk row this ticket added must trace to a real "
                f"core.territories polygon; missing: {set(NOT_SERVED_EIA) - territory_ids}"
            )


def test_base_capture_classifies_new_utilities_not_served():
    """core.base_capture's explicit CASE (extended by
    0302b_m3_integration.sql) must classify all five utilities as
    'not_served' with no null_reason -- never left at the generic
    'utility_tier_not_classified' fallback, which would hide the real,
    cited reason."""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select eia_utility_number, base_capture, base_capture_null_reason "
                "from core.base_capture where eia_utility_number = any(%s)",
                (list(NOT_SERVED_EIA),),
            )
            rows = cur.fetchall()
            assert len(rows) == len(NOT_SERVED_EIA)
            for eia_id, base_capture, null_reason in rows:
                assert base_capture == "not_served", f"{eia_id}: expected not_served, got {base_capture!r}"
                assert null_reason is None, f"{eia_id}: expected no null_reason, got {null_reason!r}"


# ---------------------------------------------------------------------------
# Gating: Harris and Williamson homes reach core.mv_home_signals with a
# real county_fips (geometry-derived, per 0102_m1_materialize.sql), and
# gate_reason is one of the documented real reasons -- never invented.
# ---------------------------------------------------------------------------

VALID_GATE_REASONS = {None, "territory_not_base_served", "territories_not_loaded", "crosswalk_not_loaded"}


@pytest.mark.parametrize("county_fips", NEW_COUNTIES)
def test_new_county_homes_are_gated_with_real_reasons(county_fips):
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select count(*) from core.mv_home_signals where county_fips = %s",
                (county_fips,),
            )
            n = cur.fetchone()[0]
            if n == 0:
                pytest.skip(f"county {county_fips} has no rows in core.mv_home_signals yet")

            cur.execute(
                "select distinct gate_reason from core.mv_home_signals where county_fips = %s",
                (county_fips,),
            )
            reasons = {r[0] for r in cur.fetchall()}
            assert reasons <= VALID_GATE_REASONS, f"unexpected gate_reason(s) for {county_fips}: {reasons - VALID_GATE_REASONS}"


def test_harris_gated_homes_have_no_permit_coverage_reason():
    """Harris (HCAD) has no Austin permit feed at all, so every one of
    its gated homes must read permit_null_reason='no_permit_coverage' --
    never a guessed False for home_permits/installability."""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select count(*) from core.mv_home_signals "
                "where county_fips = '48201' and gate_reason is null"
            )
            if cur.fetchone()[0] == 0:
                pytest.skip("county 48201 has no gated homes yet")
            cur.execute(
                "select distinct permit_null_reason from core.mv_home_signals "
                "where county_fips = '48201' and gate_reason is null"
            )
            reasons = {r[0] for r in cur.fetchall()}
            assert reasons == {"no_permit_coverage"}, f"expected only 'no_permit_coverage' for Harris, got {reasons}"


@pytest.mark.parametrize("county_fips", NEW_COUNTIES)
def test_permit_null_reason_and_extrapolated_from_stay_consistent(county_fips):
    """Whether or not a given Harris/Williamson home happens to share a
    block group with real Austin permit history (e.g. Williamson's real
    TCAD-rolled overlap homes -- real Travis prop_ids whose centroid
    sits in Williamson, checks/M3-P5.md), core.home_propensity's
    extrapolated_from must always agree with core.mv_home_signals'
    permit_null_reason for that same home: extrapolated_from=
    'austin_installs' iff permit_null_reason is not null -- never
    invented independently of it (pipelines/models/features.py's own
    rule)."""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select count(*)
                from core.home_propensity hp
                join core.mv_home_signals hs on hs.prop_id = hp.prop_id
                where hs.county_fips = %s
                  and (hs.permit_null_reason is not null) != (hp.extrapolated_from = 'austin_installs')
                """,
                (county_fips,),
            )
            n = cur.fetchone()[0]
            assert n == 0, f"{n} {county_fips} rows have extrapolated_from out of sync with permit_null_reason"


# ---------------------------------------------------------------------------
# Predictive model: new-county homes, once scored, must carry
# extrapolated_from='austin_installs' -- never a guessed value from
# permit-derived features they don't have.
# ---------------------------------------------------------------------------


def test_home_propensity_decile_orders_highest_probability_first():
    """core.home_propensity.decile is documented (0401_propensity.sql) as
    1 = highest p_install_12m .. 10 = lowest, ranked within county. This
    checks the real, live data agrees with that direction (regression
    test for the decile-ranking-backwards bug fixed in this ticket)."""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("select count(*) from core.home_propensity")
            if cur.fetchone()[0] == 0:
                pytest.skip("core.home_propensity is empty (run `python -m models score`)")

            cur.execute(
                """
                select hs.county_fips,
                       avg(hp.p_install_12m) filter (where hp.decile = 1) as decile1_mean,
                       avg(hp.p_install_12m) filter (where hp.decile = 10) as decile10_mean
                from core.home_propensity hp
                join core.mv_home_signals hs on hs.prop_id = hp.prop_id
                group by hs.county_fips
                having count(*) filter (where hp.decile = 1) > 0
                   and count(*) filter (where hp.decile = 10) > 0
                """
            )
            rows = cur.fetchall()
            if not rows:
                pytest.skip("no county has both decile 1 and decile 10 rows yet")
            for county_fips, decile1_mean, decile10_mean in rows:
                assert decile1_mean > decile10_mean, (
                    f"{county_fips}: decile 1 mean p_install_12m ({decile1_mean}) should exceed "
                    f"decile 10's ({decile10_mean}) -- decile 1 must be the most-likely homes"
                )
