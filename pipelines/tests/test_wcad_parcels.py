"""Real tests for pipelines/sources/wcad_parcels.py.

No synthetic rows: every fixture under fixtures/wcad_parcels/ is a
contiguous byte-0 prefix of the real WCAD Socrata CSV export (see each
fixture's <file>.source.json sidecar for its exact byte range and
source object -- data/raw/wcad/<source_object>, downloaded live from
data.wcad.org for this ticket). All five fixtures share WCAD PropertyID
'63689' (1605 Barcus Dr, Georgetown, TX 78626) -- a real single-family
homestead property picked because its rows happen to sit early in all
five raw files, keeping the fixtures small while still real, byte-sliced
extracts.

Each parsing-function test recomputes its expected result independently
by reading the raw fixture text with csv.DictReader directly (not by
calling wcad_parcels.py's own helpers) and comparing that independent
recompute to what wcad_parcels.py actually returns on the same fixture.

The spatial-overlap and batched-load tests require a live Postgres
connection (POSTGRES_URL_NON_POOLING) and are skipped otherwise.
"""
from __future__ import annotations

import csv
import os
from pathlib import Path

import pytest

from sources import wcad_parcels

FIXTURES = Path(__file__).parent / "fixtures" / "wcad_parcels"
PID = "63689"


def _rows(fixture_name: str) -> list[dict]:
    with open(FIXTURES / fixture_name, newline="", encoding="utf-8", errors="replace") as f:
        return list(csv.DictReader(f))


def test_read_land_state_codes_matches_independent_recompute():
    expected = {}
    rows_in = 0
    for row in _rows("land_slice.csv"):
        rows_in += 1
        pid, code = row["PropertyID"], (row.get("StateCode") or "").strip()
        if not pid or not code:
            continue
        if code.startswith("A1"):
            expected[pid] = "A1"
        elif pid not in expected:
            expected[pid] = code

    result, actual_rows_in = wcad_parcels._read_land_state_codes(str(FIXTURES / "land_slice.csv"))

    assert actual_rows_in == rows_in
    assert result[PID] == "A1"
    assert result == expected


def test_read_active_homesteads_matches_independent_recompute():
    expected = set()
    rows_in = 0
    for row in _rows("exemptions_slice.csv"):
        rows_in += 1
        if row.get("ExemptionTypeDescription") == "Homestead" and row.get("ExemptionStatusCode") == "A":
            expected.add(row["PropertyID"])

    result, actual_rows_in = wcad_parcels._read_active_homesteads(str(FIXTURES / "exemptions_slice.csv"))

    assert actual_rows_in == rows_in
    assert PID in result
    assert result == expected
    # Real fixture fact, checked directly against the raw rows (not
    # hardcoded from memory): 63689 also carries an active "Disabled
    # Veteran" exemption row, which must NOT make it into the homestead
    # set on its own.
    dv_only_pids = {
        row["PropertyID"] for row in _rows("exemptions_slice.csv")
        if row.get("ExemptionTypeDescription") == "Disabled Veteran" and row.get("ExemptionStatusCode") == "A"
    } - expected
    assert dv_only_pids, "fixture must contain at least one Disabled-Veteran-only row to prove the homestead filter is type-specific"
    assert dv_only_pids.isdisjoint(result)


def test_read_property_rows_matches_independent_recompute():
    candidates = {PID}
    result, rows_in = wcad_parcels._read_property_rows(str(FIXTURES / "property_slice.csv"), candidates)

    raw_rows = [row for row in _rows("property_slice.csv") if row["PropertyID"] == PID]
    assert len(raw_rows) == 1
    raw = raw_rows[0]

    assert result[PID]["market_value"] == pytest.approx(float(raw["CurrMarketValue"]))
    assert result[PID]["situs_num"] == raw["SitusStreetNumber"]
    assert result[PID]["situs_street"] == "BARCUS DR"
    assert result[PID]["situs_city"] == raw["SitusCity"]
    assert result[PID]["situs_zip"] == raw["SitusZip"]
    assert rows_in == sum(1 for _ in _rows("property_slice.csv"))


def test_read_improvements_matches_independent_recompute():
    candidates = {PID}
    result, rows_in = wcad_parcels._read_improvements(str(FIXTURES / "segment_slice.csv"), candidates)

    raw_rows = [row for row in _rows("segment_slice.csv") if row["PropertyID"] == PID]
    # Real fixture fact: all of 63689's segments belong to one InstanceID
    # (400446), with an 'MA' (Main Area, 1717 sqft) and an 'MA2' (Second
    # Floor, 646 sqft) row among non-floor segments (Garage, Fireplace,
    # Patio, Open Porch) that must be excluded from living_area.
    ma_rows = [r for r in raw_rows if (r.get("Type") or "").startswith("MA")]
    non_ma_rows = [r for r in raw_rows if not (r.get("Type") or "").startswith("MA")]
    assert len(ma_rows) == 2
    assert non_ma_rows, "fixture must contain a non-floor segment to prove it's excluded"

    expected_living_area = sum(float(r["Area"]) for r in ma_rows)
    expected_yr_built = int(next(r["ActYrBuilt"] for r in ma_rows if r["Type"] == "MA"))

    assert result[PID]["living_area"] == pytest.approx(expected_living_area)
    assert result[PID]["yr_built"] == expected_yr_built
    assert rows_in == sum(1 for _ in _rows("segment_slice.csv"))


def test_read_geometries_matches_independent_recompute():
    candidates = {PID}
    result, rows_in = wcad_parcels._read_geometries(str(FIXTURES / "parcels_slice.csv"), candidates)

    raw_rows = [row for row in _rows("parcels_slice.csv") if row.get("PropertyID") == PID]
    assert len(raw_rows) == 1
    assert result[PID] == raw_rows[0]["the_geom"].strip()
    assert result[PID].upper().startswith("MULTIPOLYGON")
    assert rows_in == sum(1 for _ in _rows("parcels_slice.csv"))


def test_build_final_rows_end_to_end_on_real_fixtures():
    """Chain every _read_* function across the five real fixtures (all
    sharing PID 63689) into build_final_rows, and check the assembled
    row + the single-family/homestead/prefixed-id contract."""
    land_state_codes, _ = wcad_parcels._read_land_state_codes(str(FIXTURES / "land_slice.csv"))
    active_homesteads, _ = wcad_parcels._read_active_homesteads(str(FIXTURES / "exemptions_slice.csv"))
    candidates = {pid for pid, code in land_state_codes.items() if code == "A1"} & active_homesteads
    assert PID in candidates

    property_rows, _ = wcad_parcels._read_property_rows(str(FIXTURES / "property_slice.csv"), candidates)
    improvements, _ = wcad_parcels._read_improvements(str(FIXTURES / "segment_slice.csv"), candidates)
    geometries, _ = wcad_parcels._read_geometries(str(FIXTURES / "parcels_slice.csv"), candidates)

    parcel_rows, geom_rows, improvement_rows, filter_drops = wcad_parcels.build_final_rows(
        land_state_codes=land_state_codes,
        active_homesteads=active_homesteads,
        property_rows=property_rows,
        improvements=improvements,
        geometries=geometries,
        overlap_pids=set(),
        source_id="00000000-0000-0000-0000-000000000000",
    )

    by_prop_id = {row[0]: row for row in parcel_rows}
    assert "W63689" in by_prop_id
    row = by_prop_id["W63689"]
    assert row[2] == wcad_parcels.WCAD_FIPS  # county_fips
    assert row[5] == "A1"                    # land_state_cd
    assert row[6] == "T"                     # hs_exempt
    assert row[7] is None                    # ov65_exempt — never guessed
    assert row[13] == wcad_parcels.TAX_YEAR

    geom_by_id = {r[0]: r for r in geom_rows}
    assert "W63689" in geom_by_id
    imp_by_id = {r[0]: r for r in improvement_rows}
    assert imp_by_id["W63689"][1] == 2000  # yr_built
    assert imp_by_id["W63689"][2] == pytest.approx(2363.0)  # living_area

    assert filter_drops["not_a1_residential"] == len(
        set(land_state_codes) - {pid for pid, code in land_state_codes.items() if code == "A1"}
    )


def test_build_final_rows_excludes_tcad_overlap_pid():
    """A candidate present in overlap_pids (the 137-TCAD-roll spatial
    match) must be dropped and counted, never loaded."""
    land_state_codes = {PID: "A1"}
    active_homesteads = {PID}
    parcel_rows, geom_rows, improvement_rows, filter_drops = wcad_parcels.build_final_rows(
        land_state_codes=land_state_codes,
        active_homesteads=active_homesteads,
        property_rows={},
        improvements={},
        geometries={PID: "MULTIPOLYGON(((0 0,0 1,1 1,1 0,0 0)))"},
        overlap_pids={PID},
        source_id="00000000-0000-0000-0000-000000000000",
    )
    assert parcel_rows == []
    assert geom_rows == []
    assert improvement_rows == []
    assert filter_drops["on_tcad_roll"] == 1


@pytest.mark.skipif(not os.environ.get("POSTGRES_URL_NON_POOLING"), reason="requires a live Postgres connection")
def test_tcad_williamson_overlap_query_runs_against_live_db():
    """Live-DB smoke test for `_tcad_williamson_overlap_prop_ids`: the
    real 63689 polygon (Georgetown, nowhere near any of the 137 TCAD-
    rolled Williamson homes) must never be reported as overlapping."""
    from pipelines.core import db

    geometries, _ = wcad_parcels._read_geometries(str(FIXTURES / "parcels_slice.csv"), {PID})
    assert PID in geometries

    with db.connect(pooled=False) as conn:
        overlap = wcad_parcels._tcad_williamson_overlap_prop_ids(conn, geometries)
    assert PID not in overlap
