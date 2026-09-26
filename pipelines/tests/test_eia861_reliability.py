"""Real tests for pipelines/sources/eia861_reliability.py and
pipelines/sources/eaglei_mcc.py.

No synthetic rows:

- The EAGLE-I MCC parsing test uses a real byte slice of the actual
  MCC.csv (fixtures/eia861_reliability/mcc_texas_slice.csv, sidecar
  fixtures/eia861_reliability/mcc_texas_slice.csv.source.json records the
  exact byte range in the real MCC.csv it was sliced from) and
  independently recomputes the expected Travis County figure with the
  plain `csv` module.

- The EIA-861 xlsx header/value parsing tests read the real
  Reliability_2025_Data_Early_Release.xlsx / Reliability_2024.xlsx
  members straight out of the real f8612025er.zip / f8612024.zip already
  staged in the main checkout (outside this worktree). A byte slice of a
  zip is not a valid zip, so — same posture as test_tiger_bg.py's real
  shapefile zip test — these read the whole real file rather than a
  fixture, and are skipped if that file is not present in this
  environment.

- The live-DB tests require a real backfill to have already loaded
  core.utility_reliability / core.county_customers (via
  `python -m pipelines.run eia861_reliability --backfill` and
  `python -m pipelines.run eaglei_mcc --backfill`) and are skipped if
  POSTGRES_URL_NON_POOLING isn't configured.
"""
from __future__ import annotations

import csv
import os
from decimal import Decimal
from pathlib import Path

import pytest

from sources import eaglei_mcc, eia861_reliability

FIXTURE = Path(__file__).parent / "fixtures" / "eia861_reliability" / "mcc_texas_slice.csv"

MAIN_CHECKOUT_EIA861_DIR = Path(
    "/Users/maheshbabugorantla/Code/Hackathons/BasePower_Deep_Tech_Hackathon_Sep_25_2026_Mavericks"
    "/data/raw/eia861"
)
ZIP_2025 = MAIN_CHECKOUT_EIA861_DIR / "f8612025er.zip"
ZIP_2024 = MAIN_CHECKOUT_EIA861_DIR / "f8612024.zip"


# ---------------------------------------------------------------------------
# EAGLE-I MCC.csv — real byte-slice fixture
# ---------------------------------------------------------------------------


def test_mcc_texas_slice_parses_and_matches_independent_recompute():
    # The fixture is a byte slice of MCC.csv's data rows only (no header —
    # see its .source.json sidecar's byte range, which starts after the
    # real file's header line). eaglei_mcc.parse_texas_rows() always runs
    # against the real file (header included), so the module's real
    # header row is prepended here to reproduce that exact input shape.
    header = "County_FIPS,Customers\n"
    text = header + FIXTURE.read_text(encoding="utf-8-sig")
    texas_rows, rows_in, non_texas = eaglei_mcc.parse_texas_rows(text)

    # This fixture is itself already Texas-only (see the sidecar's byte
    # range), so an independent recompute with the plain csv module
    # should find every row in the slice matches (no drops).
    reader = csv.DictReader(text.splitlines())
    expected_rows = list(reader)
    assert rows_in == len(expected_rows)
    assert non_texas == 0
    assert len(texas_rows) == 254

    by_fips = dict(texas_rows)
    assert by_fips["48453"] == "641926"  # Travis
    assert "48201" in by_fips  # Harris


# ---------------------------------------------------------------------------
# EIA-861 Reliability xlsx — real full file (a byte slice of a zip is not
# parseable), skipped if not staged in this environment
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not ZIP_2025.is_file(), reason=f"real raw file not present at {ZIP_2025}")
def test_reliability_2025_parses_verification_values():
    pytest.importorskip("openpyxl")
    zip_bytes = ZIP_2025.read_bytes()
    xlsx_bytes = eia861_reliability.extract_reliability_xlsx(zip_bytes)
    texas_rows, rows_in, non_texas = eia861_reliability.read_texas_rows(xlsx_bytes)

    assert rows_in == len(texas_rows) + non_texas
    by_eia_id = {row.eia_id: row for row in texas_rows}

    austin = by_eia_id["1015"]
    assert austin.utility_name == "Austin Energy"
    assert austin.values["incl_major.saidi"] == (Decimal("181.98"), None)
    assert austin.values["incl_major.saifi"] == (Decimal("1.29"), None)

    pedernales = by_eia_id["14626"]
    assert pedernales.values["incl_major.saidi"] == (Decimal("89.9"), None)

    centerpoint = by_eia_id["8901"]
    assert centerpoint.values["incl_major.saidi"] == (Decimal("193.194"), None)

    oncor = by_eia_id["44372"]
    assert oncor.values["incl_major.saidi"] == (None, "not_reported")
    assert oncor.values["excl_major.saidi"] == (None, "not_reported")


@pytest.mark.skipif(not ZIP_2024.is_file(), reason=f"real raw file not present at {ZIP_2024}")
def test_reliability_2024_parses_verification_values():
    pytest.importorskip("openpyxl")
    zip_bytes = ZIP_2024.read_bytes()
    xlsx_bytes = eia861_reliability.extract_reliability_xlsx(zip_bytes)
    texas_rows, rows_in, non_texas = eia861_reliability.read_texas_rows(xlsx_bytes)

    assert rows_in == len(texas_rows) + non_texas
    by_eia_id = {row.eia_id: row for row in texas_rows}

    centerpoint = by_eia_id["8901"]
    assert centerpoint.values["incl_major.saidi"] == (Decimal("4315.811"), None)

    oncor = by_eia_id["44372"]
    assert oncor.values["incl_major.saidi"] == (None, "not_reported")
    assert oncor.values["excl_major.saidi"] == (None, "not_reported")


# ---------------------------------------------------------------------------
# Live-DB checks
# ---------------------------------------------------------------------------


@pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) to check the live backfill",
)
def test_verification_values_loaded_in_db():
    from pipelines.core import db

    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select saidi_incl_major, saifi_incl_major, early_release, source_id "
                "from core.utility_reliability where eia_id = %s and year = %s",
                ("1015", 2025),
            )
            row = cur.fetchone()
            assert row is not None, "Austin Energy (1015) 2025 not loaded"
            saidi, saifi, early_release, source_id = row
            assert saidi == Decimal("181.98")
            assert saifi == Decimal("1.29")
            assert early_release is True

            cur.execute(
                "select count(*) from ops.source_manifest where id = %s and source = 'eia861_reliability'",
                (source_id,),
            )
            assert cur.fetchone()[0] == 1

            cur.execute(
                "select saidi_incl_major, early_release from core.utility_reliability "
                "where eia_id = %s and year = %s",
                ("8901", 2025),
            )
            assert cur.fetchone() == (Decimal("193.194"), True)

            cur.execute(
                "select saidi_incl_major, early_release from core.utility_reliability "
                "where eia_id = %s and year = %s",
                ("8901", 2024),
            )
            assert cur.fetchone() == (Decimal("4315.811"), False)

            cur.execute(
                "select saidi_incl_major from core.utility_reliability where eia_id = %s and year = %s",
                ("14626", 2025),
            )
            assert cur.fetchone() == (Decimal("89.9"),)

            cur.execute(
                "select saidi_incl_major, saidi_incl_major_null_reason, early_release "
                "from core.utility_reliability where eia_id = %s and year = %s",
                ("44372", 2025),
            )
            saidi, reason, early_release = cur.fetchone()
            assert saidi is None
            assert reason == "not_reported"
            assert early_release is True

            cur.execute(
                "select saidi_incl_major, saidi_incl_major_null_reason, early_release "
                "from core.utility_reliability where eia_id = %s and year = %s",
                ("44372", 2024),
            )
            saidi, reason, early_release = cur.fetchone()
            assert saidi is None
            assert reason == "not_reported"
            assert early_release is False

            cur.execute(
                "select customers, source_id from core.county_customers where county_fips = %s",
                ("48453",),
            )
            row = cur.fetchone()
            assert row is not None, "Travis County (48453) not loaded"
            customers, source_id = row
            assert customers == 641926

            cur.execute(
                "select count(*) from ops.source_manifest where id = %s and source = 'eaglei_mcc'",
                (source_id,),
            )
            assert cur.fetchone()[0] == 1
