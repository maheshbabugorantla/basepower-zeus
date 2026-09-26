"""Real tests for pipelines/sources/parcels.py.

No synthetic rows: the fixture is a byte slice of the real 2026 TCAD
PROP.TXT (see fixtures/parcels/prop_slice0.txt.source.json for its exact
byte range inside the export zip's PROP.TXT member), and the parser test
recomputes expected filtering/dedup/field-extraction independently in-test
(plain string slicing against the raw text, not parcels.py's own code)
rather than hardcoding magic numbers.

The live-DB test requires a real backfill to have already loaded
core.parcels (via `python -m pipelines.run parcels --backfill`) and is
skipped if POSTGRES_URL_NON_POOLING isn't configured.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from sources import parcels

FIXTURE = Path(__file__).parent / "fixtures" / "parcels" / "prop_slice0.txt"


def _iter_fixture_lines():
    with open(FIXTURE, "rb") as f:
        while True:
            line = f.readline()
            if not line:
                break
            yield line.decode("latin-1").rstrip("\r\n")


def test_process_matches_independent_recompute_on_fixture():
    # Independent recomputation directly off the raw fixture bytes, using
    # none of parcels.py's own extraction/filter/dedup code.
    expected_rows_in = 0
    expected_not_r = 0
    expected_duplicate = 0
    seen_expected: set[str] = set()
    expected_kept: dict[str, tuple] = {}
    for text in _iter_fixture_lines():
        expected_rows_in += 1
        prop_id = text[0:12].strip()
        prop_type = text[12:17].strip()
        if prop_type != "R":
            expected_not_r += 1
            continue
        if prop_id in seen_expected:
            expected_duplicate += 1
            continue
        seen_expected.add(prop_id)
        expected_kept[prop_id] = (
            text[546:596].strip() or None,   # geo_id
            text[2731:2741].strip() or None,  # imprv_state_cd
            text[2741:2751].strip() or None,  # land_state_cd
            text[2608:2609].strip() or None,  # hs_exempt
            int(text[4213:4227].strip()) if text[4213:4227].strip() else None,  # market_value
        )

    assert len(expected_kept) > 0
    assert expected_duplicate > 0  # this slice is chosen to contain a real multi-owner dup

    batches: list[list[tuple]] = []

    def fake_load(_conn, batch: list[tuple]) -> None:
        batches.append(list(batch))

    state = parcels.new_state()
    with open(FIXTURE, "rb") as f:
        parcels._process(
            f,
            state=state,
            seen=set(),
            conn=None,
            manifest_id="00000000-0000-0000-0000-000000000000",
            county_fips="48453",
            tax_year=2026,
            batch_size=1000,
            on_checkpoint=lambda s: None,
            load_batch=fake_load,
        )

    assert state["rows_in"] == expected_rows_in
    assert state["filter_drops"]["not_r"] == expected_not_r
    assert state["filter_drops"]["duplicate_prop_id"] == expected_duplicate
    assert state["loaded"] == len(expected_kept)
    assert parcels.rows_loaded(state) == state["rows_in"] - sum(state["filter_drops"].values())
    assert parcels.rows_loaded(state) == state["loaded"]

    loaded_rows = {row[0]: row for batch in batches for row in batch}
    assert set(loaded_rows) == set(expected_kept)
    for prop_id, (geo_id, imprv, land, hs, market_value) in expected_kept.items():
        # row layout: prop_id, geo_id, county_fips, prop_type_cd, imprv_state_cd,
        # land_state_cd, hs_exempt, ov65_exempt, situs_num, situs_street,
        # situs_city, situs_zip, market_value, tax_year, source_id
        row = loaded_rows[prop_id]
        assert row[1] == geo_id
        assert row[2] == "48453"
        assert row[3] == "R"
        assert row[4] == imprv
        assert row[5] == land
        assert row[6] == hs
        assert row[12] == market_value
        assert row[13] == 2026
        assert row[14] == "00000000-0000-0000-0000-000000000000"


@pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) to check the live backfill",
)
def test_travis_parcels_loaded_in_db():
    from pipelines.core import db

    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select count(*), count(*) filter (where prop_type_cd != 'R') "
                "from core.parcels where county_fips = %s",
                ("48453",),
            )
            total, non_r = cur.fetchone()
            assert total > 0, "no Travis (48453) parcels loaded"
            assert non_r == 0, "core.parcels must only contain prop_type_cd = 'R' rows"

            cur.execute(
                "select count(*) from core.parcels p "
                "join ops.source_manifest sm on sm.id = p.source_id "
                "where p.county_fips = %s and sm.source = 'tcad_export'",
                ("48453",),
            )
            traceable = cur.fetchone()[0]
            assert traceable == total, "every Travis parcel must trace to a tcad_export manifest row"

            cur.execute("select count(distinct prop_id) from core.parcels where county_fips = %s", ("48453",))
            assert cur.fetchone()[0] == total, "core.parcels must have one row per prop_id (deduped)"
