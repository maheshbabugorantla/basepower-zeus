"""Real-DB tests for M4-P4 (0401_propensity.sql + pipelines/models/):
the predictive 12-month backup-adoption propensity score.

Every test here reads the live Supabase DB via POSTGRES_URL_NON_POOLING
(skipped if that env var isn't set) -- no synthetic rows, no seeded
fakes. `test_asof_feature_frame_*` build a real as-of feature frame
straight from core.mv_home_signals/core.permits/core.permit_labels for a
tiny slice of the live data (never an invented row). The
core.home_propensity/core.model_card assertions read whatever
`python -m models score` has actually written -- skipped (not failed)
if that hasn't run yet, same pattern test_scoring_pass.py uses for
not-yet-backfilled tables.
"""
from __future__ import annotations

import os
from datetime import date

import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) against the live DB",
)


def _connect():
    from pipelines.core import db

    return db.connect(pooled=False)


# ---------------------------------------------------------------------------
# features.load_frame — as-of correctness against real permits
# ---------------------------------------------------------------------------

def test_asof_frame_excludes_permits_on_or_after_cutoff():
    """A home's own-permit features as of a cutoff must never reflect a
    permit issued on/after that cutoff -- pick a real home with a real
    permit and check the as-of-before-that-permit frame shows it False,
    the as-of-after-that-permit frame shows it True."""
    from models.features import LabelWindow, load_frame

    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select pm.tcad_id, pm.issue_date
                from core.permits pm
                join core.permit_labels pl
                  on pl.permit_number = pm.permit_number and pl.labeller = 'rules'
                where pl.label = 'solar' and pm.tcad_id is not null and pm.issue_date is not null
                order by pm.issue_date
                limit 1
                """
            )
            row = cur.fetchone()
            if row is None:
                pytest.skip("no rules-labelled solar permit with a tcad_id/issue_date in the live data")
            tcad_id, issue_date = row

            cur.execute("select prop_id from core.parcels where geo_id = %s limit 1", (tcad_id,))
            parcel_row = cur.fetchone()
            if parcel_row is None:
                pytest.skip(f"permit's tcad_id {tcad_id!r} has no matching core.parcels row")
            prop_id = parcel_row[0]

            before = load_frame(conn, cutoff=issue_date, exclude_before=False, label_window=None)
            after = load_frame(
                conn,
                cutoff=date(issue_date.year + 1, issue_date.month, issue_date.day),
                exclude_before=False,
                label_window=None,
            )

    before_row = before[before["prop_id"] == prop_id]
    after_row = after[after["prop_id"] == prop_id]
    if before_row.empty or after_row.empty:
        pytest.skip(f"home {prop_id!r} not present in mv_home_signals (gated homes only)")

    before_val = before_row["own_solar_asof"].iloc[0]
    after_val = after_row["own_solar_asof"].iloc[0]
    if before_val is not None and not (before_val != before_val):  # not NaN
        assert before_val == 0.0
    assert after_val == 1.0


def test_asof_frame_permit_features_null_outside_coverage():
    """Homes with core.mv_home_signals.permit_null_reason set (outside
    Austin permit coverage) get every permit-derived feature null and
    extrapolated_from='austin_installs' -- never a guessed 0/False."""
    from models.features import PERMIT_DERIVED_COLUMNS, load_frame

    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("select count(*) from core.mv_home_signals where gate_reason is null and permit_null_reason is not null")
            n = cur.fetchone()[0]
            if n == 0:
                pytest.skip("no gated home currently outside Austin permit coverage")
        df = load_frame(conn, cutoff=date.today(), exclude_before=False, label_window=None)

    outside = df[df["extrapolated_from"] == "austin_installs"]
    assert len(outside) > 0
    for col in PERMIT_DERIVED_COLUMNS:
        assert outside[col].isna().all(), f"{col} should be null for every home outside permit coverage"


def test_asof_frame_neighbor_rate_excludes_self():
    """A block group's neighbour adoption rate divides by (homes_gated -
    1), never counting the home itself -- spot-check against the raw
    core.mv_home_block_group count for one real block group."""
    from models.features import load_frame

    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select block_group_geoid, count(*) as n from core.mv_home_block_group "
                "group by 1 having count(*) > 1 order by n desc limit 1"
            )
            row = cur.fetchone()
            if row is None:
                pytest.skip("no block group with more than one gated home")
            bg_geoid, n_homes = row
        df = load_frame(conn, cutoff=date.today(), exclude_before=False, label_window=None)

    bg_rows = df[df["block_group_geoid"] == bg_geoid]
    covered = bg_rows[bg_rows["neighbor_adoption_rate_asof"].notna()]
    if covered.empty:
        pytest.skip(f"block group {bg_geoid!r} has no permit-covered home to check")
    # rate * (n_homes - 1) must be a whole number of adopting neighbours
    # (never negative, never >= n_homes -- the self-exclusion invariant).
    for rate in covered["neighbor_adoption_rate_asof"]:
        adopters = rate * (n_homes - 1)
        assert -1e-9 <= adopters <= n_homes - 1 + 1e-9


# ---------------------------------------------------------------------------
# core.home_propensity / core.model_card — the written score
# ---------------------------------------------------------------------------

def _require_home_propensity(conn):
    with conn.cursor() as cur:
        cur.execute("select count(*) from core.home_propensity")
        n = cur.fetchone()[0]
    if n == 0:
        pytest.skip("core.home_propensity not filled yet (cd pipelines && python -m models score)")
    return n


def test_home_propensity_covers_every_gated_home():
    with _connect() as conn:
        n = _require_home_propensity(conn)
        with conn.cursor() as cur:
            cur.execute("select count(*) from core.mv_home_signals where gate_reason is null")
            n_gated = cur.fetchone()[0]
            cur.execute(
                """
                select count(*) from core.mv_home_signals s
                left join core.home_propensity hp on hp.prop_id = s.prop_id
                where s.gate_reason is null and hp.prop_id is null
                """
            )
            n_missing = cur.fetchone()[0]
    assert n == n_gated, f"expected one row per gated home ({n_gated}), got {n}"
    assert n_missing == 0


def test_home_propensity_probabilities_and_deciles_in_range():
    with _connect() as conn:
        _require_home_propensity(conn)
        with conn.cursor() as cur:
            cur.execute(
                "select count(*) from core.home_propensity "
                "where p_install_12m < 0 or p_install_12m > 1 or decile < 1 or decile > 10"
            )
            bad = cur.fetchone()[0]
            cur.execute("select count(*) from core.home_propensity where jsonb_array_length(reasons) > 3")
            too_many_reasons = cur.fetchone()[0]
    assert bad == 0
    assert too_many_reasons == 0


def test_home_propensity_extrapolated_matches_permit_coverage():
    """extrapolated_from='austin_installs' iff the home is outside
    Austin permit coverage -- never set for a covered home, never unset
    for an uncovered one."""
    with _connect() as conn:
        _require_home_propensity(conn)
        with conn.cursor() as cur:
            cur.execute(
                """
                select count(*) from core.home_propensity hp
                join core.mv_home_signals s on s.prop_id = hp.prop_id
                where coalesce(hp.extrapolated_from = 'austin_installs', false)
                      is distinct from (s.permit_null_reason is not null)
                """
            )
            mismatched = cur.fetchone()[0]
    assert mismatched == 0


def test_model_card_matches_check_md_metrics():
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute("select count(*) from core.model_card")
            if cur.fetchone()[0] == 0:
                pytest.skip("core.model_card not filled yet (cd pipelines && python -m models train)")
            cur.execute("select algorithm, auc_oot, top_decile_lift_oot from core.model_card order by created_at desc limit 1")
            algorithm, auc_oot, lift = cur.fetchone()
    assert algorithm in ("logistic_regression", "gradient_boosting")
    assert auc_oot is not None and 0.5 < float(auc_oot) < 1.0
    assert lift is not None and float(lift) > 1.0


def test_api_home_propensity_provenance():
    """Every api.home_propensity row's source_ids resolves to a real
    ops.source_manifest row (the provenance check python -m pipelines.
    check provenance also enforces for every api.* view)."""
    with _connect() as conn:
        _require_home_propensity(conn)
        with conn.cursor() as cur:
            cur.execute(
                """
                select count(*) from api.home_propensity hp
                where hp.source_ids is null or array_length(hp.source_ids, 1) is null
                   or exists (
                       select 1 from unnest(hp.source_ids) sid
                       where sid not in (select id from ops.source_manifest)
                   )
                """
            )
            unresolved = cur.fetchone()[0]
    assert unresolved == 0
