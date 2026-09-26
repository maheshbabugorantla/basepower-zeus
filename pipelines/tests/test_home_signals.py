"""Real-DB tests for M2-P8's home-level signals, corrected outage
percentile/term, and median-deviation "top signals" (supabase/migrations/
0212_home_signals.sql). No synthetic data: every assertion runs against
the live core.mv_home_signals / api.* objects, via POSTGRES_URL_NON_
POOLING, and is skipped entirely (not faked) if that env var isn't set.

Covers the ticket's Acceptance criteria directly:
  - page 1 of the county ranking has >= 10 distinct scores (no more
    block-group-wide ties)
  - no single reason is #1 for > 60% of ranked homes; flood is never a
    reason at all
  - Austin Energy homes have a positive outage term with basis
    'distributor_saidi'; Oncor homes get the EAGLE-I county proxy
    ('county_eaglei_proxy') with a non-null outage_minutes
  - permit-based signals (home_solar/home_ev/home_generator/
    home_panel_upgrade) are null (never false) outside permit coverage
  - api.home_score_breakdown's contributions sum to the home's score,
    +/- 0.001
  - every request-time query completes in well under 1 s
"""
from __future__ import annotations

import json
import os
import time

import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) against the live M2-P8 migration",
)

EQUAL_WEIGHTS = json.dumps(
    {
        "outage": 1, "flood": 1, "empower": 1, "age65": 1, "electric_heat": 1,
        "backup_intent": 1, "owner_65": 1, "home_permits": 1, "installability": 1,
        "home_value": 1,
    }
)


@pytest.fixture(scope="module")
def conn():
    from pipelines.core import db

    with db.connect(pooled=False) as c:
        yield c


def test_page_one_has_distinct_scores(conn):
    with conn.cursor() as cur:
        t0 = time.perf_counter()
        cur.execute("select score from api.top_homes_weighted(%s::jsonb, '48453')", (EQUAL_WEIGHTS,))
        rows = cur.fetchall()
        elapsed = time.perf_counter() - t0
    assert len(rows) > 0, "no ranked homes returned -- is core.mv_home_signals populated?"
    distinct_scores = {r[0] for r in rows}
    assert len(distinct_scores) >= 10, (
        f"page 1 has only {len(distinct_scores)} distinct scores across {len(rows)} homes "
        f"-- homes are still tying at block-group granularity"
    )
    assert elapsed < 1.0, f"api.top_homes_weighted took {elapsed:.3f}s, must be < 1s"


def test_top_signal_distribution_and_flood_never_a_reason(conn):
    with conn.cursor() as cur:
        cur.execute(
            "select prop_id, reasons from api.homes_ranked_weighted(%s::jsonb, '48453', null, null, null, 2000)",
            (EQUAL_WEIGHTS,),
        )
        rows = cur.fetchall()
    assert len(rows) > 0
    n = len(rows)
    first_reason_counts: dict[str, int] = {}
    for _prop_id, reasons in rows:
        reasons = reasons or []
        assert "flood" not in reasons, "flood must never appear as a top signal"
        if reasons:
            first_reason_counts[reasons[0]] = first_reason_counts.get(reasons[0], 0) + 1
    for label, count in first_reason_counts.items():
        share = count / n
        assert share <= 0.60, f"signal {label!r} is the #1 top signal for {share:.1%} of homes (must be <= 60%)"


def test_austin_energy_outage_is_distributor_saidi(conn):
    with conn.cursor() as cur:
        cur.execute(
            "select outage_minutes, outage_term, outage_basis from core.mv_home_signals "
            "where gate_reason is null and distributor_name = 'Austin Energy' limit 200"
        )
        rows = cur.fetchall()
    assert len(rows) > 0, "no gated Austin Energy homes found"
    for minutes, term, basis in rows:
        assert basis == "distributor_saidi"
        assert minutes is not None and minutes > 0
        assert term is not None and term > 0


def test_oncor_outage_uses_county_eaglei_proxy(conn):
    with conn.cursor() as cur:
        cur.execute(
            "select outage_minutes, outage_basis, outage_null_reason from core.mv_home_signals "
            "where gate_reason is null and territory_eia_id = '44372' limit 200"
        )
        rows = cur.fetchall()
    assert len(rows) > 0, "no gated Oncor-territory homes found"
    for minutes, basis, null_reason in rows:
        assert basis == "county_eaglei_proxy", f"expected county_eaglei_proxy, got {basis!r} (null_reason={null_reason!r})"
        assert minutes is not None


def test_permit_signals_null_never_false_outside_coverage(conn):
    with conn.cursor() as cur:
        cur.execute(
            "select home_solar, home_ev, home_generator, home_panel_upgrade, home_battery "
            "from core.mv_home_signals where gate_reason is null and permit_null_reason = 'no_permit_coverage' limit 500"
        )
        rows = cur.fetchall()
    assert len(rows) > 0, "no homes outside permit coverage found -- can't verify the null-not-false rule"
    for solar, ev, generator, panel, battery in rows:
        assert solar is None and ev is None and generator is None and panel is None and battery is None


def test_breakdown_contributions_sum_to_score(conn):
    with conn.cursor() as cur:
        cur.execute(
            "select prop_id, score from api.top_homes_weighted(%s::jsonb, '48453') limit 5",
            (EQUAL_WEIGHTS,),
        )
        top = cur.fetchall()
    assert len(top) > 0
    for prop_id, score in top:
        with conn.cursor() as cur:
            t0 = time.perf_counter()
            cur.execute(
                "select contribution from api.home_score_breakdown(%s, %s::jsonb)", (prop_id, EQUAL_WEIGHTS)
            )
            contributions = [r[0] for r in cur.fetchall() if r[0] is not None]
            elapsed = time.perf_counter() - t0
        total = sum(contributions)
        assert abs(float(total) - float(score)) <= 0.001, (
            f"prop_id={prop_id}: breakdown contributions sum to {total}, score is {score}"
        )
        assert elapsed < 1.0, f"api.home_score_breakdown took {elapsed:.3f}s, must be < 1s"


def test_default_weights_view_has_the_seeded_keys(conn):
    with conn.cursor() as cur:
        cur.execute("select signal_key, weight from api.default_weights order by signal_key")
        rows = dict(cur.fetchall())
    for key in (
        "outage", "home_value", "backup_intent", "age65", "home_permits",
        "electric_heat", "empower", "owner_65", "installability", "flood",
    ):
        assert key in rows, f"missing default weight for {key!r}"
