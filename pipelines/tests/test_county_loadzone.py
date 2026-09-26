"""Real tests for pipelines/sources/county_loadzone.py.

No synthetic rows: `data/manual/county_loadzone.csv` (checks/M3-H1.md) IS
the raw file for this source -- the first test reads that real,
committed file directly, mirroring pipelines/tests/test_retail_market.py.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from sources import county_loadzone

CSV_PATH = Path(__file__).resolve().parents[2] / "data" / "manual" / "county_loadzone.csv"


def test_reads_real_records_from_csv():
    assert CSV_PATH.is_file(), f"real county_loadzone CSV not found at {CSV_PATH}"

    rows_in, records = county_loadzone.read_records(CSV_PATH)

    assert rows_in == len(records)
    assert rows_in > 0

    by_key = {(r["county_fips"], r["utility_name"]): r for r in records}

    austin = by_key[("48453", "Austin Energy")]
    assert austin["ercot_load_zone"] == "LZ_AEN"
    assert austin["settlement_point"] == "LZ_AEN"
    assert austin["source_url"]
    assert austin["retrieved_at"] is not None

    pedernales = by_key[("48453", "Pedernales Electric Cooperative")]
    assert pedernales["ercot_load_zone"] == "LZ_LCRA"

    houston = by_key[("48201", "CenterPoint Energy Houston Electric")]
    assert houston["ercot_load_zone"] == "LZ_HOUSTON"

    for record in records:
        assert record["county_fips"]
        assert record["ercot_load_zone"]
        assert record["source_url"]
        assert record["retrieved_at"] is not None


def test_missing_expected_column_raises(tmp_path):
    bad_csv = tmp_path / "bad.csv"
    bad_csv.write_text("county_fips,utility_name\n48453,Austin Energy\n")
    with pytest.raises(RuntimeError, match="missing expected column"):
        county_loadzone.read_records(bad_csv)


def test_row_missing_load_zone_raises(tmp_path):
    bad_csv = tmp_path / "bad.csv"
    bad_csv.write_text(
        "county_fips,county_name,utility_name,ercot_load_zone,settlement_point,"
        "source_url,retrieved_at,notes\n"
        "48453,Travis,Some Utility,,,https://example.com,2026-01-01T00:00:00Z,\n"
    )
    with pytest.raises(RuntimeError, match="ercot_load_zone"):
        county_loadzone.read_records(bad_csv)
