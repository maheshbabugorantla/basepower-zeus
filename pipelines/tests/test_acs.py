"""Real tests for pipelines/sources/acs.py.

No synthetic rows: the fixture (fixtures/acs/travis_acs5_2024_slice0.json,
sidecar fixtures/acs/travis_acs5_2024_slice0.json.source.json) is a real
byte slice -- header line plus five real Travis block-group rows -- of
the actual ACS5 2024 API response for Travis County (48453), fetched
live from https://api.census.gov/data/2024/acs/acs5 with CENSUS_API_KEY.
It is line-delimited the way the live API returns it (one JSON array per
physical line), so it's parsed the same way sources/austin_permits.py's
tests parse their JSON-lines slice: strip the array punctuation per line,
`json.loads` each line on its own -- never re-serialized, never invented.

The live-DB tests require a real backfill to have already loaded
core.acs_bg (via `python -m pipelines.run acs --backfill`) and are
skipped if POSTGRES_URL_NON_POOLING isn't configured.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from sources import acs

FIXTURE = Path(__file__).parent / "fixtures" / "acs" / "travis_acs5_2024_slice0.json"


def _load_fixture_rows() -> list[list[str]]:
    """Parse the real header-plus-5-rows byte slice into
    [[header], [row], ...], exactly as acs.rows_from_response expects."""
    text = FIXTURE.read_text(encoding="utf-8")
    lines = [l for l in text.split("\n") if l.strip()]
    rows: list[list[str]] = []
    for i, line in enumerate(lines):
        line = line.strip()
        if i == 0:
            assert line.startswith("[[")
            line = line[1:]  # strip the whole-document's own leading '['
        if line.endswith(","):
            line = line[:-1]
        rows.append(json.loads(line))
    return rows


def test_fixture_is_real_travis_slice():
    rows = _load_fixture_rows()
    header = rows[0]
    assert header[0] == "NAME"
    for var in acs.VARIABLES:
        assert var in header
    for col in acs.GEO_COLS:
        assert col in header
    assert len(rows) == 6  # header + 5 real block-group rows
    for row in rows[1:]:
        assert "Travis County" in row[header.index("NAME")]


def test_rows_from_response_matches_hand_computation_for_3_block_groups():
    """Verify 3 block groups' derived core.acs_bg row against values taken
    straight from the real API response (independent hand computation,
    not a reuse of the module's own summing code as its own oracle)."""
    data = _load_fixture_rows()
    header = data[0]
    idx = {name: i for i, name in enumerate(header)}

    rows = acs.rows_from_response(data, "48453")
    assert len(rows) == 5

    checked = 0
    for raw_row, out in zip(data[1:], rows):
        geoid_expected = "".join(raw_row[idx[c]] for c in acs.GEO_COLS)
        assert out["geoid"] == geoid_expected
        assert len(out["geoid"]) == 12
        assert out["county_fips"] == "48453"

        assert out["pop_total"] == int(raw_row[idx["B01001_001E"]])
        assert out["housing_units_total"] == int(raw_row[idx["B25040_001E"]])
        assert out["heating_electric"] == int(raw_row[idx["B25040_004E"]])
        assert out["heating_electric_null_reason"] is None

        expected_65_plus = sum(int(raw_row[idx[v]]) for v in acs.AGE65_VARS)
        assert out["pop_65_plus"] == expected_65_plus
        assert out["pop_65_plus_null_reason"] is None
        checked += 1

    assert checked == 3 + 2  # every fixture row checked; at least 3 required by the ticket


def test_clean_count_nulls_census_annotation_and_missing_never_invents():
    # Census's documented negative sentinel for a suppressed/unavailable
    # cell (e.g. a small-sample block group), and a missing/None cell --
    # both must become None + an explicit reason, never a fabricated 0.
    value, reason = acs._clean_count("-666666666")
    assert value is None and reason == "census_annotation_-666666666"

    value, reason = acs._clean_count(None)
    assert value is None and reason == "census_null"

    value, reason = acs._clean_count("42")
    assert value == 42 and reason is None


def test_sum_components_nulls_whole_sum_on_any_annotation_never_partial_sum():
    row = {v: "10" for v in acs.AGE65_VARS}
    row[acs.AGE65_VARS[3]] = "-666666666"  # one annotated component
    total, reason = acs._sum_components(row, acs.AGE65_VARS)
    assert total is None
    assert reason == f"{acs.AGE65_VARS[3]}_census_annotation_-666666666"

    row_clean = {v: "10" for v in acs.AGE65_VARS}
    total, reason = acs._sum_components(row_clean, acs.AGE65_VARS)
    assert total == 10 * len(acs.AGE65_VARS)
    assert reason is None


def test_source_url_and_sanitize_never_carry_the_api_key():
    url = acs.source_url(2024, "453")
    assert "key=" not in url
    assert "SECRET" not in url

    sanitized = acs._sanitize("request failed for key=SECRETVALUE123", "SECRETVALUE123")
    assert "SECRETVALUE123" not in sanitized
    assert "REDACTED" in sanitized


@pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) to check the live backfill",
)
def test_live_db_acs_bg_loaded_and_traces_to_manifest():
    from pipelines.core import db

    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute("select count(*) from core.acs_bg")
            total = cur.fetchone()[0]
            assert total > 0, "core.acs_bg has no rows after backfill"

            cur.execute("select count(distinct county_fips) from core.acs_bg")
            assert cur.fetchone()[0] >= 2, "expected both Travis and Harris block groups"

            cur.execute(
                """
                select count(*) from core.acs_bg a
                join ops.source_manifest sm on sm.id = a.source_id
                where sm.source = 'acs'
                """
            )
            traced = cur.fetchone()[0]
            assert traced == total, "some core.acs_bg rows don't resolve to an acs manifest row"


@pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) to check the live backfill",
)
def test_live_db_3_block_groups_match_real_api_response():
    """Verify 3 real Travis block groups' core.acs_bg row against the
    fixture's own real API values (same fixture the offline test uses)."""
    from pipelines.core import db

    data = _load_fixture_rows()
    header = data[0]
    idx = {name: i for i, name in enumerate(header)}

    checked = 0
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            for raw_row in data[1:4]:
                geoid = "".join(raw_row[idx[c]] for c in acs.GEO_COLS)
                cur.execute(
                    "select pop_total, pop_65_plus, housing_units_total, heating_electric "
                    "from core.acs_bg where geoid = %s",
                    (geoid,),
                )
                row = cur.fetchone()
                assert row is not None, f"{geoid} not loaded into core.acs_bg"
                pop_total, pop_65_plus, housing_units_total, heating_electric = row

                assert pop_total == int(raw_row[idx["B01001_001E"]])
                assert housing_units_total == int(raw_row[idx["B25040_001E"]])
                assert heating_electric == int(raw_row[idx["B25040_004E"]])
                expected_65_plus = sum(int(raw_row[idx[v]]) for v in acs.AGE65_VARS)
                assert pop_65_plus == expected_65_plus
                checked += 1
    assert checked == 3


# ---------------------------------------------------------------------------
# M2-P10: income/age (real byte slice of the actual ACS5 2024
# acs_income_age query response for Travis County, fetched live via
# acs._fetch_variables with CENSUS_API_KEY -- header + 5 real block-group
# rows, sidecar fixtures/acs/travis_income_age_2024_slice0.json.source.json).
# ---------------------------------------------------------------------------

INCOME_AGE_FIXTURE = Path(__file__).parent / "fixtures" / "acs" / "travis_income_age_2024_slice0.json"


def _load_income_age_fixture_rows() -> list[list[str]]:
    text = INCOME_AGE_FIXTURE.read_text(encoding="utf-8")
    lines = [l for l in text.split("\n") if l.strip()]
    rows: list[list[str]] = []
    for i, line in enumerate(lines):
        line = line.strip()
        if i == 0:
            assert line.startswith("[[")
            line = line[1:]
        if line.endswith(","):
            line = line[:-1]
        rows.append(json.loads(line))
    return rows


def test_income_age_fixture_is_real_travis_slice():
    rows = _load_income_age_fixture_rows()
    header = rows[0]
    for var in acs.INCOME_AGE_VARIABLES:
        assert var in header
    assert len(rows) == 6  # header + 5 real block-group rows
    for row in rows[1:]:
        assert "Travis County" in row[header.index("NAME")]


def test_rows_from_income_age_response_matches_hand_computation_for_3_block_groups():
    data = _load_income_age_fixture_rows()
    header = data[0]
    idx = {name: i for i, name in enumerate(header)}

    rows = acs.rows_from_income_age_response(data, "48453")
    assert len(rows) == 5

    checked = 0
    for raw_row, out in zip(data[1:], rows):
        geoid_expected = "".join(raw_row[idx[c]] for c in acs.GEO_COLS)
        assert out["geoid"] == geoid_expected
        assert out["county_fips"] == "48453"

        median_income_raw = int(raw_row[idx["B19013_001E"]])
        if median_income_raw < 0:
            assert out["median_household_income"] is None
        else:
            assert out["median_household_income"] == median_income_raw

        income_num = sum(int(raw_row[idx[v]]) for v in acs.INCOME_100K_VARS)
        income_den = int(raw_row[idx["B19001_001E"]])
        if income_den > 0 and all(int(raw_row[idx[v]]) >= 0 for v in acs.INCOME_100K_VARS):
            expected_share = income_num / income_den
            if out["income_100k_share"] is not None:
                assert abs(out["income_100k_share"] - expected_share) < 1e-9
        checked += 1

    assert checked == 5


def test_clean_float_nulls_census_annotation_never_invents():
    value, reason = acs._clean_float("-666666666")
    assert value is None and reason == "census_annotation_-666666666.0"

    value, reason = acs._clean_float(None)
    assert value is None and reason == "census_null"

    value, reason = acs._clean_float("42.0")
    assert value == 42.0 and reason is None


def test_share_with_cv_nulls_on_high_cv_never_clamps():
    # A real-shaped example: small numerator with a MOE nearly as large
    # as the estimate itself -> CV far over 40% -> nulled, never clamped
    # to a guessed value (unlike the hyperlocal-claude reference, which
    # has no CV check at all).
    share, cv, reason = acs._share_with_cv(num=5.0, num_moe=8.0, den=100.0, den_moe=10.0)
    assert share is None
    assert reason == "unreliable_estimate"
    assert cv is not None and cv > acs.CV_UNRELIABLE_THRESHOLD

    # A well-estimated share (small MOEs relative to the estimate) is
    # kept, with its CV under the threshold.
    share, cv, reason = acs._share_with_cv(num=400.0, num_moe=20.0, den=1000.0, den_moe=15.0)
    assert reason is None
    assert share is not None and abs(share - 0.4) < 1e-9
    assert cv is not None and cv < acs.CV_UNRELIABLE_THRESHOLD


def test_share_with_cv_nulls_on_missing_component_or_zero_denominator():
    share, cv, reason = acs._share_with_cv(None, 8.0, 100.0, 10.0)
    assert share is None and reason == "census_component_missing"

    share, cv, reason = acs._share_with_cv(5.0, 8.0, 0.0, 10.0)
    assert share is None and reason == "zero_denominator"


@pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) to check the live backfill",
)
def test_live_db_acs_income_age_bg_loaded_and_traces_to_manifest():
    from pipelines.core import db

    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute("select count(*) from core.acs_income_age_bg")
            total = cur.fetchone()[0]
            assert total > 0, "core.acs_income_age_bg has no rows after backfill"

            cur.execute(
                """
                select count(*) from core.acs_income_age_bg a
                join ops.source_manifest sm on sm.id = a.source_id
                where sm.source = 'acs_income_age'
                """
            )
            traced = cur.fetchone()[0]
            assert traced == total, "some core.acs_income_age_bg rows don't resolve to an acs_income_age manifest row"


@pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) to check the live backfill",
)
def test_live_db_income_age_3_block_groups_match_real_api_response():
    from pipelines.core import db

    data = _load_income_age_fixture_rows()
    header = data[0]
    idx = {name: i for i, name in enumerate(header)}

    checked = 0
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            for raw_row in data[1:4]:
                geoid = "".join(raw_row[idx[c]] for c in acs.GEO_COLS)
                cur.execute(
                    "select median_household_income from core.acs_income_age_bg where geoid = %s",
                    (geoid,),
                )
                row = cur.fetchone()
                assert row is not None, f"{geoid} not loaded into core.acs_income_age_bg"
                median_income_raw = int(raw_row[idx["B19013_001E"]])
                if median_income_raw >= 0:
                    assert row[0] == median_income_raw
                checked += 1
    assert checked == 3
