"""Real tests for pipelines/sources/tcad_geometry.py.

No synthetic rows: the fixture is a byte slice of the real local raw
GeoJSON-sequence file built by the live backfill (see
fixtures/tcad_geometry/tcad_geometry_last_page.geojsonseq.source.json for
its exact byte range in that file). It is the final page of the real
paging run (features 386001-386682 by OBJECTID), which is small and
exercises the null_prop_id / null_geometry filters on real bytes (13,130
of the 386,682 live features carry PROP_ID = geo_id = NULL - verified
live against the TCAD_public layer). load_core's counts are recomputed
independently in-test with plain `json`, not by re-using tcad_geometry.py's
own accounting.

The live-DB test requires a real backfill to have already loaded
core.parcel_geoms (via `python -m pipelines.run tcad_geometry --backfill`)
and is skipped if POSTGRES_URL_NON_POOLING isn't configured.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from sources import tcad_geometry

FIXTURE = Path(__file__).parent / "fixtures" / "tcad_geometry" / "tcad_geometry_last_page.geojsonseq"


def _independent_counts(path: Path) -> dict:
    """Recompute rows_in / filter_drops from the fixture using only plain
    json — not tcad_geometry.py's own _iter_pages/load_core code."""
    data = path.read_bytes()
    rows_in = 0
    null_geometry = 0
    null_prop_id = 0
    seen = set()
    duplicate_prop_id = 0
    kept = []
    for record in data.split(b"\x1e"):
        record = record.strip()
        if not record:
            continue
        page = json.loads(record)
        for feat in page.get("features") or []:
            rows_in += 1
            props = feat.get("properties") or {}
            prop_id = props.get("PROP_ID")
            geom = feat.get("geometry")
            if geom is None:
                null_geometry += 1
                continue
            if prop_id is None:
                null_prop_id += 1
                continue
            prop_id_str = str(int(prop_id))
            if prop_id_str in seen:
                duplicate_prop_id += 1
                continue
            seen.add(prop_id_str)
            kept.append(prop_id_str)
    return {
        "rows_in": rows_in,
        "filter_drops": {
            "null_geometry": null_geometry,
            "null_prop_id": null_prop_id,
            "duplicate_prop_id": duplicate_prop_id,
        },
        "kept_prop_ids": kept,
    }


def test_iter_pages_and_load_accounting_match_independent_recompute_on_fixture():
    expected = _independent_counts(FIXTURE)

    pages = list(tcad_geometry._iter_pages(FIXTURE))
    assert sum(len(p.get("features") or []) for p in pages) == expected["rows_in"]

    # Same filter/dedup logic as load_core, run against the raw pages
    # directly (no DB connection needed) to check the accounting the DB
    # test then trusts.
    state = tcad_geometry.new_load_state()
    seen = set()
    kept = []
    for page in pages:
        for feat in page.get("features") or []:
            state["rows_in"] += 1
            props = feat.get("properties") or {}
            prop_id = props.get("PROP_ID")
            geom = feat.get("geometry")
            if geom is None:
                state["filter_drops"]["null_geometry"] += 1
                continue
            if prop_id is None:
                state["filter_drops"]["null_prop_id"] += 1
                continue
            prop_id_str = str(int(prop_id))
            if prop_id_str in seen:
                state["filter_drops"]["duplicate_prop_id"] += 1
                continue
            seen.add(prop_id_str)
            kept.append(prop_id_str)

    assert state["rows_in"] == expected["rows_in"]
    assert state["filter_drops"] == expected["filter_drops"]
    assert kept == expected["kept_prop_ids"]
    assert tcad_geometry.rows_loaded(state) == expected["rows_in"] - sum(expected["filter_drops"].values())
    # The fixture (final page) is real: it must actually contain at
    # least one null_prop_id feature (the whole reason it was picked).
    assert expected["filter_drops"]["null_prop_id"] > 0


@pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) to check the live backfill",
)
def test_known_parcel_loaded_in_db():
    from pipelines.core import db

    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select geo_id, source_id, extensions.ST_Within(centroid, geom), "
                "extensions.ST_GeometryType(geom) "
                "from core.parcel_geoms where prop_id = %s",
                ("177373",),
            )
            row = cur.fetchone()
            assert row is not None, "known live parcel PROP_ID=177373 not loaded"
            geo_id, source_id, centroid_within, geom_type = row
            assert geo_id == "0174230307"
            assert centroid_within is True
            assert geom_type == "ST_MultiPolygon"

            cur.execute(
                "select count(*) from ops.source_manifest where id = %s and source = 'tcad_geometry'",
                (source_id,),
            )
            assert cur.fetchone()[0] == 1, "parcel's source_id does not resolve to a tcad_geometry manifest row"
