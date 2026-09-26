"""Real tests for pipelines/sources/permit_rules.py.

No synthetic rows: `data/manual/permit_rules.csv` IS the raw file for
this source (SB 1252 text fetched from TDLR + capitol.texas.gov, and
Austin Energy / Travis County citations reused from
data/manual/ahj_facts.csv) -- this test reads that real, committed file
directly, mirroring pipelines/tests/test_retail_market.py.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from sources import permit_rules

CSV_PATH = Path(__file__).resolve().parents[2] / "data" / "manual" / "permit_rules.csv"


def test_reads_real_records_from_csv():
    assert CSV_PATH.is_file(), f"real permit-rules CSV not found at {CSV_PATH}"

    rows_in, records = permit_rules.read_records(CSV_PATH)

    assert rows_in == len(records)
    assert rows_in > 0

    by_key = {(r["authority"], r["rule"]): r for r in records}

    sb1252 = by_key[("State of Texas (SB 1252)", "effective_date")]
    assert "2025" in sb1252["value"]
    assert "tdlr.texas.gov" in sb1252["source_url"]
    assert "September 1, 2025" in sb1252["quote"]

    definition = by_key[("State of Texas (SB 1252)", "residential_energy_backup_system_definition")]
    assert "50 kilowatts" in definition["quote"]
    assert "100 kilowatt hours" in definition["quote"]

    barred = by_key[("State of Texas (SB 1252)", "municipal_regulation_barred")]
    assert "capitol.texas.gov" in barred["source_url"]
    assert "may not adopt or enforce" in barred["quote"]

    exception = by_key[("State of Texas (SB 1252)", "municipally_owned_utility_exception")]
    assert "municipally owned utility" in exception["quote"].lower()

    austin_energy = by_key[("City of Austin (Austin Energy)", "residential_ess_permit_required")]
    assert "Auxiliary Power Electrical Permit" in austin_energy["quote"]
    assert "austinenergy.com" in austin_energy["source_url"]

    travis_ifc = by_key[("Unincorporated Travis County", "adopted_ifc_edition")]
    assert "January 1, 2026" in travis_ifc["quote"]

    travis_ess = by_key[("Unincorporated Travis County", "ess_standard_referenced")]
    assert "NFPA" in travis_ess["quote"] or "855" in travis_ess["quote"]

    # Every row's required fields are real, non-empty strings -- never a
    # placeholder inserted to satisfy a missing-value check.
    for record in records:
        assert record["authority"]
        assert record["rule"]
        assert record["value"]
        assert record["source_url"].startswith("https://")
        assert record["quote"]


def test_missing_expected_column_raises(tmp_path):
    bad_csv = tmp_path / "bad.csv"
    bad_csv.write_text("authority,rule\nFoo,bar\n")
    with pytest.raises(RuntimeError, match="missing expected column"):
        permit_rules.read_records(bad_csv)


def test_missing_quote_raises(tmp_path):
    bad_csv = tmp_path / "bad.csv"
    bad_csv.write_text(
        "authority,rule,value,source_url,retrieved_at,quote\n"
        "Foo,bar,some value,https://example.com,2026-01-01T00:00:00Z,\n"
    )
    with pytest.raises(RuntimeError, match="value/source_url/quote"):
        permit_rules.read_records(bad_csv)
