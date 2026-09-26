"""Real tests for pipelines/sources/tcad_improvements.py.

No synthetic rows: the fixture is a byte slice of the real 2026 TCAD
IMP_DET.TXT (see fixtures/tcad_improvements/imp_det_slice0.txt.source.json
for its exact byte range inside the export zip's IMP_DET.TXT member) --
prop 100008's 8 detail rows, including a '1ST' floor detail. The parser
test recomputes the expected main-improvement/yr_built/living_area result
independently in-test (plain string slicing against the raw fixture text,
not tcad_improvements.py's own code).

The live-DB test requires a real backfill to have already loaded
core.parcel_improvements (via `python -m pipelines.run tcad_improvements
--backfill`) and is skipped if POSTGRES_URL_NON_POOLING isn't configured.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from sources import tcad_improvements

FIXTURE = Path(__file__).parent / "fixtures" / "tcad_improvements" / "imp_det_slice0.txt"


def _iter_fixture_lines():
    with open(FIXTURE, "rb") as f:
        while True:
            line = f.readline()
            if not line:
                break
            yield line.decode("latin-1").rstrip("\r\n")


def test_process_with_fallback_matches_independent_recompute_on_fixture():
    expected_rows = 0
    rows_for_100008 = 0
    expected_floor_rows = 0
    per_imprv: dict[tuple[str, str], dict] = {}
    for text in _iter_fixture_lines():
        expected_rows += 1
        prop_id = str(int(text[0:12].strip()))
        imprv_id = text[16:28].strip()
        type_cd = text[40:50].strip()
        area_raw = text[93:108].strip()
        area = float(area_raw) if area_raw else 0.0
        yr_built_raw = text[85:89].strip()
        yr_built = int(yr_built_raw) if yr_built_raw and int(yr_built_raw) != 0 else None

        if prop_id != "100008":
            continue
        rows_for_100008 += 1
        if type_cd not in tcad_improvements.FLOOR_TYPE_CODES:
            continue
        expected_floor_rows += 1
        key = (prop_id, imprv_id)
        rec = per_imprv.setdefault(
            key, {"total_area": 0.0, "first_floor_yr_built": None, "largest_area": -1.0, "largest_area_yr_built": None}
        )
        rec["total_area"] += area
        if type_cd == "1ST" and yr_built is not None:
            rec["first_floor_yr_built"] = yr_built
        if area > rec["largest_area"]:
            rec["largest_area"] = area
            rec["largest_area_yr_built"] = yr_built

    assert expected_rows == 8
    assert expected_floor_rows >= 1

    # Winning improvement per prop_id = largest total floor area.
    by_prop: dict[str, list[tuple[str, dict]]] = {}
    for (prop_id, imprv_id), rec in per_imprv.items():
        by_prop.setdefault(prop_id, []).append((imprv_id, rec))
    expected: dict[str, dict] = {}
    for prop_id, imprvs in by_prop.items():
        winner_id, winner = max(imprvs, key=lambda kv: kv[1]["total_area"])
        yr_built = winner["first_floor_yr_built"] or winner["largest_area_yr_built"]
        expected[prop_id] = {
            "yr_built": yr_built,
            "living_area": winner["total_area"] if winner["total_area"] > 0 else None,
        }

    assert "100008" in expected
    assert expected["100008"]["yr_built"] == 2013
    assert expected["100008"]["living_area"] == pytest.approx(2986.0)

    with open(FIXTURE, "rb") as f:
        result, filter_drops = tcad_improvements._process_with_fallback(
            f, target_prop_ids={"100008"}
        )

    assert result == expected
    assert filter_drops["not_floor_detail"] == rows_for_100008 - expected_floor_rows
    assert filter_drops["prop_id_not_targeted"] == expected_rows - rows_for_100008


def test_process_with_fallback_drops_untargeted_prop_ids():
    with open(FIXTURE, "rb") as f:
        result, filter_drops = tcad_improvements._process_with_fallback(
            f, target_prop_ids=set()
        )
    assert result == {}
    assert filter_drops["prop_id_not_targeted"] == 8


@pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) to check the live backfill",
)
def test_parcel_improvements_loaded_in_db():
    from pipelines.core import db

    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute("select count(*) from core.parcel_improvements")
            (total,) = cur.fetchone()
            assert total > 0, "no core.parcel_improvements rows loaded"

            cur.execute(
                "select count(*) from core.parcel_improvements pi "
                "join ops.source_manifest sm on sm.id = pi.source_id "
                "where sm.source = 'tcad_export'"
            )
            (with_manifest,) = cur.fetchone()
            assert with_manifest == total, (
                "every core.parcel_improvements row must resolve to the tcad_export manifest row"
            )

            cur.execute(
                "select count(*) from core.parcel_improvements "
                "where yr_built is not null and (yr_built < 1800 or yr_built > 2027)"
            )
            (bad_years,) = cur.fetchone()
            assert bad_years == 0, "yr_built must be a plausible year, never a placeholder"
