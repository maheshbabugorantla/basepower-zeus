"""Real tests for pipelines/sources/retail_market.py.

No synthetic rows: `data/manual/retail_market.csv` IS the raw file for
this source (a small, hand-curated, cited file from Base's own
basepowercompany.com pages) -- the first test reads that real, committed
file directly, mirroring pipelines/tests/test_utility_crosswalk.py.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from sources import retail_market

CSV_PATH = Path(__file__).resolve().parents[2] / "data" / "manual" / "retail_market.csv"


def test_reads_real_records_from_csv():
    assert CSV_PATH.is_file(), f"real retail-market CSV not found at {CSV_PATH}"

    rows_in, records = retail_market.read_records(CSV_PATH)

    assert rows_in == len(records)
    assert rows_in > 0

    by_eia = {r["eia_utility_number"]: r for r in records}

    oncor = by_eia["44372"]
    assert oncor["utility_name"] == "Oncor Electric Delivery"
    assert oncor["retail_market"] == "deregulated"
    assert oncor["source_url"]
    assert oncor["quote"]
    assert oncor["plain_language"]

    austin = by_eia["1015"]
    assert austin["utility_name"] == "Austin Energy"
    assert austin["retail_market"] == "not_deregulated"
    assert "no retail choice" in austin["plain_language"].lower() or "municipal" in austin["plain_language"].lower()

    # Every retail_market value is one of the two the schema allows --
    # never a third, guessed value.
    for record in records:
        assert record["retail_market"] in {"deregulated", "not_deregulated"}


def test_missing_expected_column_raises(tmp_path):
    bad_csv = tmp_path / "bad.csv"
    bad_csv.write_text("eia_utility_number,retail_market\n1015,not_deregulated\n")
    with pytest.raises(RuntimeError, match="missing expected column"):
        retail_market.read_records(bad_csv)


def test_invalid_retail_market_value_raises(tmp_path):
    bad_csv = tmp_path / "bad.csv"
    bad_csv.write_text(
        "eia_utility_number,utility_name,retail_market,plain_language,source_url,quote,retrieved_at\n"
        "9999,Made Up Utility,somewhere_else,x,https://example.com,\"a quote\",2026-01-01T00:00:00Z\n"
    )
    with pytest.raises(RuntimeError, match="retail_market"):
        retail_market.read_records(bad_csv)
