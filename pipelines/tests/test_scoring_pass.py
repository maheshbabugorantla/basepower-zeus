"""Real-DB tests for 0216_scoring_pass.sql (M2-P9 scoring half + M2-P10 +
M2-P11): income/age terms, permit_path/permit_risk, and coverage gaps.

Every test here reads the live Supabase DB via POSTGRES_URL_NON_POOLING
(skipped if that env var isn't set) -- no synthetic rows, no seeded
fakes: every assertion is checked against whatever real data the
pipelines have actually loaded (a real block group, a real home, a real
permit_path_stats row), never a hard-coded expected value invented by
this test.
"""
from __future__ import annotations

import os

import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) against the live DB",
)


def _connect():
    from pipelines.core import db

    return db.connect(pooled=False)


def test_default_weights_has_new_keys_and_fixed_outage_basis():
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("select signal_key, weight, basis from core.default_weights where signal_key in ('income_100k', 'age_35_64', 'permit_risk', 'outage')")
            rows = {k: (float(w), basis) for k, w, basis in cur.fetchall()}

    assert rows["income_100k"][0] == 5
    assert rows["age_35_64"][0] == 3
    assert rows["permit_risk"][0] == 2
    outage_basis = rows["outage"][1]
    assert "sciencedirect.com" in outage_basis
    assert "home_value" not in outage_basis or "copied in error" in outage_basis


def test_acs_income_age_bg_loaded_and_traces_to_manifest():
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("select count(*) from core.acs_income_age_bg")
            total = cur.fetchone()[0]
            if total == 0:
                pytest.skip("core.acs_income_age_bg not backfilled yet (python -m pipelines.run acs --backfill)")
            cur.execute(
                """
                select count(*) from core.acs_income_age_bg a
                join ops.source_manifest sm on sm.id = a.source_id
                where sm.source = 'acs_income_age'
                """
            )
            traced = cur.fetchone()[0]
            assert traced == total


def test_permit_path_only_two_real_values_or_null():
    """permit_path is derived from territory only (see 0216's own
    comment): 'city_battery_permit', 'state_rules_only', or NULL --
    NEVER 'county_fire_code' (no incorporated/unincorporated boundary
    dataset is loaded; asserting that value is never fabricated)."""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("select distinct permit_path from api.top_homes_weighted('{\"outage\": 1}'::jsonb, '48453') limit 50")
            values = {r[0] for r in cur.fetchall()}
    assert values.issubset({"city_battery_permit", "state_rules_only", None})
    assert "county_fire_code" not in values


def test_home_score_breakdown_contributions_sum_to_score_within_tolerance():
    """P9 acceptance: permit_risk contributes to the score and
    breakdown; contributions still sum to the score (+/-0.001)."""
    weights = {
        "outage": 8, "home_value": 8, "backup_intent": 7, "age65": 4,
        "home_permits": 4, "electric_heat": 2, "empower": 2, "owner_65": 1,
        "installability": 2, "flood": 2, "income_100k": 5, "age_35_64": 3,
        "permit_risk": 2,
    }
    import json

    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select prop_id, score from api.top_homes_weighted(%s::jsonb, '48453') limit 5",
                (json.dumps(weights),),
            )
            top = cur.fetchall()
            assert top, "no homes returned from api.top_homes_weighted for Travis with the extended weights object"

            checked = 0
            for prop_id, score in top:
                cur.execute(
                    "select contribution from api.home_score_breakdown(%s, %s::jsonb) where contribution is not null",
                    (prop_id, json.dumps(weights)),
                )
                contributions = [float(c) for (c,) in cur.fetchall()]
                assert abs(sum(contributions) - float(score)) < 0.001, (
                    f"{prop_id}: sum(contributions)={sum(contributions)} != score={score}"
                )
                checked += 1
    assert checked >= 1


def test_coverage_bucket_counts_and_gaps_bg_are_internally_consistent():
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("select count(*) from core.home_coverage")
            total = cur.fetchone()[0]
            if total == 0:
                pytest.skip("core.home_coverage not populated yet")

            cur.execute("select bucket, home_count from api.coverage_bucket_counts")
            buckets = dict(cur.fetchall())
            assert set(buckets).issubset({"base_customer", "other_backup", "prospect", "not_observable"})
            assert sum(buckets.values()) == total

            cur.execute(
                "select homes, base_customers, other_backup, prospects from api.coverage_gaps_bg limit 20"
            )
            rows = cur.fetchall()
            assert rows, "core.coverage_gaps_bg has no rows"
            for homes, base_customers, other_backup, prospects in rows:
                assert base_customers + other_backup + prospects <= homes


def test_no_individual_address_labelled_base_customer_in_zone_view():
    """Privacy rule (M2-P11): api.coverage_gaps_bg / api.coverage_bucket_counts
    never carry a prop_id, address, or contractor name column."""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select column_name from information_schema.columns "
                "where table_schema='api' and table_name in ('coverage_gaps_bg', 'coverage_bucket_counts')"
            )
            cols = {c for (c,) in cur.fetchall()}
    assert not cols & {"prop_id", "situs_num", "situs_street", "contractor_company_name"}
