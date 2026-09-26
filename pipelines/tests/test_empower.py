"""Real tests for pipelines/sources/empower.py.

No synthetic rows: the fixture is a real, unmodified byte slice of the
actual raw JSON-lines file this module wrote from the live HHS emPOWER
ArcGIS FeatureServer during a real backfill run (see
fixtures/empower/empower_tx_page0.jsonl.source.json for its exact byte
range in that raw file). This one page's raw response contains ZIP
78745 (a real, published, non-suppressed row — see checks/M2-H3.md's
Verification section, which confirms 78745's Medicare_Benes/
Power_Dependent_Devices_DME = 8102/274 both from the live REST query
and independently from HHS's own historical XLSX) plus real rows whose
Power_Dependent_Devices_DME is the literal suppression sentinel 11.

The live-DB test requires a real backfill to have already loaded
core.empower_zip (via `python -m pipelines.run empower --backfill`) and
is skipped if POSTGRES_URL_NON_POOLING isn't configured.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from sources import empower

FIXTURE = Path(__file__).parent / "fixtures" / "empower" / "empower_tx_page0.jsonl"


def _load_fixture_attributes() -> list[dict]:
    attrs = []
    with open(FIXTURE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            import json

            page = json.loads(line)
            for feature in page.get("features", []):
                attrs.append(feature.get("attributes", {}))
    return attrs


def test_fixture_is_real_raw_response_with_78745_and_a_suppressed_row():
    attrs = _load_fixture_attributes()
    assert len(attrs) > 0

    by_zip = {a["Zip_Code"]: a for a in attrs}
    assert "78745" in by_zip, "fixture slice was chosen to contain ZIP 78745"

    saw_any_suppressed = any(a.get("Power_Dependent_Devices_DME") == 11 for a in attrs)
    assert saw_any_suppressed, "fixture slice was chosen to contain a suppressed (==11) row"


def test_verified_zip_78745_medicare_benes_and_dme_counts():
    """checks/M2-H3.md's Verification section: ZIP 78745's Medicare_Benes
    and Power_Dependent_Devices_DME are 8102 and 274 (a real published
    value, not suppressed — 274 != 11)."""
    attrs = _load_fixture_attributes()
    by_zip = {a["Zip_Code"]: a for a in attrs}
    row_78745 = empower.record_to_empower_row(by_zip["78745"])
    assert row_78745 is not None
    assert row_78745["medicare_benes"] == 8102
    assert row_78745["power_dependent_devices_dme"] == 274
    assert row_78745["power_dependent_devices_dme_suppressed"] is False
    assert row_78745["empower_null_reason"] is None


def test_suppressed_11_never_stored_as_a_count():
    """Every real row in the fixture whose raw Power_Dependent_Devices_DME
    is exactly 11 must map to a NULL value, a True suppressed flag, and
    the 'suppressed_1_to_10' reason — never the literal integer 11."""
    attrs = _load_fixture_attributes()
    checked_any = False
    for raw in attrs:
        row = empower.record_to_empower_row(raw)
        assert row is not None
        checked_any = True

        if raw.get("Power_Dependent_Devices_DME") == 11:
            assert row["power_dependent_devices_dme"] is None
            assert row["power_dependent_devices_dme_suppressed"] is True
            assert row["empower_null_reason"] == "suppressed_1_to_10"
        else:
            assert row["power_dependent_devices_dme"] == raw.get("Power_Dependent_Devices_DME")
            assert row["power_dependent_devices_dme_suppressed"] is False

        # The literal 11 must never survive into the loaded row, in either count column.
        assert row["medicare_benes"] != 11
        assert row["power_dependent_devices_dme"] != 11

    assert checked_any


def test_missing_zip_code_dropped():
    assert empower.record_to_empower_row({"Zip_Code": None, "Medicare_Benes": 5, "Power_Dependent_Devices_DME": 1}) is None
    assert empower.record_to_empower_row({"Zip_Code": "", "Medicare_Benes": 5, "Power_Dependent_Devices_DME": 1}) is None


@pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) to check the live backfill",
)
def test_live_db_empower_zip_loaded_and_78745_matches():
    from pipelines.core import db

    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute("select count(*) from core.empower_zip")
            count = cur.fetchone()[0]
            assert count > 0, "core.empower_zip has no rows after backfill"

            cur.execute(
                """
                select medicare_benes, power_dependent_devices_dme,
                       power_dependent_devices_dme_suppressed, empower_null_reason
                from core.empower_zip
                where zip_code = '78745'
                """
            )
            row = cur.fetchone()
            assert row is not None, "ZIP 78745 not loaded in core.empower_zip"
            medicare_benes, dme, suppressed, null_reason = row
            assert medicare_benes == 8102
            assert dme == 274
            assert suppressed is False
            assert null_reason is None

            cur.execute(
                """
                select count(*) from core.empower_zip ez
                join ops.source_manifest sm on sm.id = ez.source_id
                where sm.source = 'empower'
                """
            )
            assert cur.fetchone()[0] == count, "some core.empower_zip rows don't resolve to an empower manifest row"

            cur.execute(
                "select count(*) from core.empower_zip where power_dependent_devices_dme = 11 or medicare_benes = 11"
            )
            assert cur.fetchone()[0] == 0, "the literal suppression sentinel 11 must never be stored as a count"
