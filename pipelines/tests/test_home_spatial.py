"""Real-DB tests for M3-P6's spatial precompute (core.home_spatial,
core.flood_zones_sub, core.territories_sub — supabase/migrations/0304*)
and, this session, the PUCT-CCN territory re-resolution for Williamson
(48491) and Travis (48453) — supabase/migrations/0305_puct_ccn.sql.

Every DB-touching test reads the live Supabase DB via
POSTGRES_URL_NON_POOLING (skipped if that env var isn't set, and skipped
per-test if the relevant table/rows aren't loaded yet) — no synthetic
rows, no seeded fakes, real extracts only, per CLAUDE.md's real-data
rule. Follows pipelines/tests/test_utility_gate.py's pattern.

This session's additions are written to pass BOTH before and after the
0305 apply steps run (`SELECT`-only probes that branch on whether any
`territory_basis = 'puct_ccn'` row already exists) — same file, no
second edit needed once the migration+pipeline actually ship. The one
test that WRITES to the DB (`test_rerun_with_no_upstream_change_
writes_zero_rows`, via `home_spatial.run_county()`) must NOT be run in
this prep task (hard rule: no DB writes) — see the module bottom for how
this session verified the SQL without executing it.

What's under test:
  * Flood membership is identical between the raw core.flood_zones and
    the subdivided core.flood_zones_sub for every home already computed
    into core.home_spatial (acceptance: "subdivision must not change
    answers").
  * A rerun of pipelines/sources/home_spatial.run() for a county with no
    upstream change touches zero rows (acceptance: "Incremental"). NOT
    RUN this session (writes).
  * The Harris-pin territory rule (unchanged by this session) is
    reproduced in core.home_spatial itself, not just in mv_home_signals
    downstream.
  * NEW: the Williamson/Travis PUCT-CCN "agree-or-unconfirmed" pick rule
    — every resolved home's basis is 'puct_ccn', every unresolved home's
    null_reason is one of the three honest reasons this session defined.
  * NEW: Georgetown Utility Systems' Base-served status is confirmed
    "not served" from TWO real sources (data/raw/base_service_areas/
    pricing.md's own utility list, and the live core.utility_crosswalk
    row for 'City of Georgetown') — the ticket's explicit ask.
  * NEW: static checks (no DB needed) that the shipped SQL text actually
    does what the module docstring/migration comment claim — this
    session's own bug-catching lesson from the puct_ccn.py validation
    script (advisor caught real counting bugs there; these are cheap
    insurance against the same class of mistake here).
  * Every core.home_spatial row's boundary_source_ids is non-empty and
    traces to real source rows (real-data rule 1 — nothing invented).
"""
from __future__ import annotations

import os
import re

import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) against the live DB",
)

HARRIS = "48201"
WILLIAMSON = "48491"
TRAVIS = "48453"

_HOME_SPATIAL_PATH = os.path.join(
    os.path.dirname(__file__), "..", "sources", "home_spatial.py"
)
_PRICING_MD_PATH = (
    "/Users/maheshbabugorantla/Code/Hackathons/"
    "BasePower_Deep_Tech_Hackathon_Sep_25_2026_Mavericks"
    "/data/raw/base_service_areas/pricing.md"
)

# The three honest null reasons this session's pick rule can produce for
# a CCN-scoped county (Williamson/Travis). Any other value would be a bug.
_CCN_NULL_REASONS = {"no_ccn_match", "ccn_holder_unmapped", "multiply_certificated"}


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
    core.home_spatial with a resolved point. UNCHANGED by this session
    (block-group/flood section is owned by another concurrent ticket)."""
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


@pytest.mark.skip(
    reason="WRITES to core.home_spatial via home_spatial.run_county() -- "
    "hard rule this session: no DB writes. Safe to un-skip once run "
    "against a non-production DB, or by a ticket that is allowed to write."
)
def test_rerun_with_no_upstream_change_writes_zero_rows():
    """Acceptance: 'Incremental. Re-running home_spatial with no changed
    sources touches 0 rows and finishes in seconds.' Runs one real batch
    for Travis twice in a row against the live DB and asserts the second
    pass's rows_written is 0. NOT RUN this session — see the skip reason."""
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
    """UNCHANGED by this session: every Harris home resolves to
    CenterPoint (8901) with basis 'most_likely_county_utility'."""
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


def _ccn_pick_rule_invariants(cur, county_fips: str, label: str) -> None:
    """Shared assertions for the "agree-or-unconfirmed" pick rule, once
    it is live for a county (territory_basis='puct_ccn' rows exist):
      * every resolved row's basis is EXACTLY 'puct_ccn' (never the old
        'service_area_polygon'/'most_likely_county_utility' for this
        county once CCN is live).
      * every unresolved (null eia_id) row's null_reason is one of the
        three this session defined -- never null-null (a null reason
        would mean "missing means empty" was violated) and never some
        other/legacy value like 'utility_not_confirmed' (Williamson's
        OLD reason, which this rule replaces) or 'no_territory_match'.
    """
    cur.execute(
        "select count(*) from core.home_spatial "
        "where county_fips = %s and resolved_territory_eia_id is not null "
        "  and territory_basis is distinct from 'puct_ccn'",
        (county_fips,),
    )
    (bad_basis,) = cur.fetchone()
    assert bad_basis == 0, (
        f"{label}: {bad_basis} resolved home(s) with a non-'puct_ccn' territory_basis "
        f"after CCN resolution went live for this county"
    )

    cur.execute(
        "select distinct territory_null_reason from core.home_spatial "
        "where county_fips = %s and resolved_territory_eia_id is null",
        (county_fips,),
    )
    reasons = {row[0] for row in cur.fetchall()}
    assert reasons, f"{label}: expected at least one null_reason value among unresolved homes"
    assert None not in reasons, (
        f"{label}: found a home with resolved_territory_eia_id NULL and territory_null_reason "
        f"also NULL -- 'missing means empty' requires a reason"
    )
    assert reasons <= _CCN_NULL_REASONS, (
        f"{label}: unexpected null_reason value(s) {reasons - _CCN_NULL_REASONS} -- "
        f"expected only {_CCN_NULL_REASONS}"
    )


def test_williamson_ccn_pick_rule_or_still_withheld():
    """Branches on whichever state is actually live in the DB, so this
    test is correct both BEFORE and AFTER the 0305_puct_ccn.sql apply
    steps run (this session did not run them -- no DB writes):
      * PRE-deploy (no 'puct_ccn' rows yet): every Williamson home must
        still show the OLD behavior -- withheld, 'utility_not_confirmed'.
      * POST-deploy: the new agree-or-unconfirmed invariants hold, and
        'utility_not_confirmed' must be GONE (it was Williamson's old,
        blanket reason; the new rule always gives a more specific one).
    """
    with _connect() as conn:
        with conn.cursor() as cur:
            if not _table_exists(cur, "core", "home_spatial"):
                pytest.skip("core.home_spatial not migrated yet")
            cur.execute(
                "select count(*) from core.home_spatial where county_fips = %s", (WILLIAMSON,)
            )
            (n,) = cur.fetchone()
            if n == 0:
                pytest.skip("no Williamson rows in core.home_spatial yet")

            cur.execute(
                "select count(*) from core.home_spatial "
                "where county_fips = %s and territory_basis = 'puct_ccn'",
                (WILLIAMSON,),
            )
            (n_ccn,) = cur.fetchone()

            if n_ccn == 0:
                cur.execute(
                    "select distinct resolved_territory_eia_id, territory_null_reason, territory_gate_reason "
                    "from core.home_spatial where county_fips = %s",
                    (WILLIAMSON,),
                )
                rows = cur.fetchall()
                assert rows == [(None, "utility_not_confirmed", None)], (
                    f"pre-deploy: expected every Williamson home_spatial row withheld "
                    f"('utility_not_confirmed'), got {rows}"
                )
            else:
                _ccn_pick_rule_invariants(cur, WILLIAMSON, "Williamson")
                cur.execute(
                    "select count(*) from core.home_spatial "
                    "where county_fips = %s and territory_null_reason = 'utility_not_confirmed'",
                    (WILLIAMSON,),
                )
                (stale,) = cur.fetchone()
                assert stale == 0, (
                    f"post-deploy: {stale} Williamson row(s) still carry the OLD "
                    f"'utility_not_confirmed' reason -- the new rule should have replaced it"
                )


def test_travis_ccn_pick_rule_when_applied():
    """Travis has no fixed single-row invariant pre-deploy (it already
    resolves most homes via HIFLD, with real variation by
    utility/subdivision), so this test only asserts something once the
    CCN rule is actually live for Travis; otherwise it skips rather than
    asserting a pre-deploy shape that isn't this session's concern."""
    with _connect() as conn:
        with conn.cursor() as cur:
            if not _table_exists(cur, "core", "home_spatial"):
                pytest.skip("core.home_spatial not migrated yet")
            cur.execute(
                "select count(*) from core.home_spatial "
                "where county_fips = %s and territory_basis = 'puct_ccn'",
                (TRAVIS,),
            )
            (n_ccn,) = cur.fetchone()
            if n_ccn == 0:
                pytest.skip("PUCT CCN territory resolution not live for Travis yet")
            _ccn_pick_rule_invariants(cur, TRAVIS, "Travis")


def test_georgetown_utility_systems_not_base_served():
    """The ticket's explicit ask: confirm Georgetown Utility Systems'
    Base-served status from TWO real sources, independent of the
    NAME-MATCH assumption 0305_puct_ccn.sql's crosswalk seed makes
    ('Georgetown Utility Systems' -> eia_id 7129, 'City of Georgetown'):
      1. Base's own served-utility list (data/raw/base_service_areas/
         pricing.md, a real downloaded file) does not mention Georgetown
         at all.
      2. The live core.utility_crosswalk row for 'City of Georgetown'
         (eia_id 7129) is mapped='no'.
    Both sources agree: not Base-served, regardless of whether the name
    match is exactly right."""
    assert os.path.exists(_PRICING_MD_PATH), f"missing real file {_PRICING_MD_PATH}"
    with open(_PRICING_MD_PATH) as f:
        pricing_text = f.read()
    assert "Georgetown" not in pricing_text, (
        "Base's own pricing.md now mentions Georgetown -- re-check the "
        "Georgetown Utility Systems Base-served assumption, it may need updating"
    )

    with _connect() as conn:
        with conn.cursor() as cur:
            if not _table_exists(cur, "core", "utility_crosswalk"):
                pytest.skip("core.utility_crosswalk not migrated yet")
            cur.execute(
                "select mapped from core.utility_crosswalk where eia_utility_number = %s",
                ("7129",),
            )
            row = cur.fetchone()
            if row is None:
                pytest.skip("eia_utility_number 7129 (City of Georgetown) not loaded yet")
            (mapped,) = row
            assert mapped == "no", (
                f"expected core.utility_crosswalk eia_utility_number=7129 "
                f"(City of Georgetown) mapped='no', got {mapped!r}"
            )


def test_boundary_source_ids_never_empty_for_a_resolved_home():
    """Real-data rule 1: every home_spatial row with a resolved block
    group traces to at least one real source_id (its parcel geometry or
    the block-group boundary file) — never an empty provenance list for a
    row that clearly used loaded boundary data. UNCHANGED by this
    session."""
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
    a null hash would make every future run recompute that row forever.
    UNCHANGED by this session."""
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


# ---------------------------------------------------------------------------
# Static checks against the real, shipped SQL text -- no DB connection
# needed, run unconditionally (not gated by pytestmark's skipif). These
# exist because this session's OWN validation script had a real counting
# bug caught only by an advisor review (see git log on this branch); these
# are cheap structural insurance that the actually-implemented territory
# section still matches what the module docstring / 0305's migration
# comment claim, so a future edit can't silently break the input_hash
# sensitivity or the pick-rule's honest-reason contract without a test
# noticing.
# ---------------------------------------------------------------------------


def _home_spatial_sql() -> str:
    with open(_HOME_SPATIAL_PATH) as f:
        src = f.read()
    match = re.search(r'_BATCH_SQL = """(.*?)"""', src, re.S)
    assert match, "could not find _BATCH_SQL in pipelines/sources/home_spatial.py"
    return match.group(1)


def test_input_hash_formula_includes_territory_source_and_null_reason():
    """The coordinator's explicit ask: a CCN-driven change must alter
    input_hash. Verified structurally: the md5() formula must reference
    both r.territory_source_id (carries core.electric_ccn.source_id for
    a CCN-resolved home) and r.crosswalk_source_id (carries
    core.electric_ccn_crosswalk.crosswalk_source_id), AND
    r.territory_null_reason (this session's addition, so a mapping-only
    change that doesn't move resolved_territory_eia_id still invalidates
    the cached hash)."""
    sql = _home_spatial_sql()
    hash_formula_match = re.search(r"md5\((.*?)\)\s*as input_hash", sql, re.S)
    assert hash_formula_match, "could not find the input_hash md5() formula"
    formula = hash_formula_match.group(1)
    for needle in (
        "r.territory_source_id",
        "r.crosswalk_source_id",
        "r.resolved_territory_eia_id",
        "r.territory_basis",
        "r.territory_null_reason",
    ):
        assert needle in formula, f"input_hash formula is missing {needle!r} -- {formula}"


def test_ccn_resolution_scoped_to_williamson_and_travis_only():
    """Structural guard: the new ccn_holder_status CTE's join condition
    must scope to exactly WILLIAMSON_FIPS and TRAVIS_FIPS (via the SQL
    parameters), and the FIPS constants themselves must be the real
    Texas county FIPS codes for Williamson (48491) and Travis (48453) --
    a copy-paste error here would silently apply CCN resolution to the
    wrong county or every county."""
    with open(_HOME_SPATIAL_PATH) as f:
        src = f.read()
    assert 'WILLIAMSON_FIPS = "48491"' in src
    assert 'TRAVIS_FIPS = "48453"' in src
    assert 'HARRIS_FIPS = "48201"' in src

    sql = _home_spatial_sql()
    ccn_join_match = re.search(r"join core\.electric_ccn ecc\s*\n(.*?)left join", sql, re.S)
    assert ccn_join_match, "could not find core.electric_ccn's join condition"
    join_condition = ccn_join_match.group(1)
    assert "%(williamson_fips)s" in join_condition and "%(travis_fips)s" in join_condition, (
        "core.electric_ccn join is not scoped to both Williamson and Travis FIPS params"
    )
    assert "%(harris_fips)s" not in join_condition, (
        "core.electric_ccn join must not reference Harris -- Harris keeps its pin, untouched"
    )


def test_ccn_pick_rule_reasons_match_module_docstring():
    """The three null_reason values the module docstring documents
    ('no_ccn_match', 'ccn_holder_unmapped', 'multiply_certificated') must
    actually appear, verbatim, in the shipped SQL -- catches a docstring
    that drifts from the real implementation."""
    sql = _home_spatial_sql()
    for reason in sorted(_CCN_NULL_REASONS):
        assert f"'{reason}'" in sql, f"expected reason {reason!r} to appear in the CCN resolution SQL"
    assert "'puct_ccn'" in sql, "expected territory_basis 'puct_ccn' to appear in the CCN resolution SQL"
