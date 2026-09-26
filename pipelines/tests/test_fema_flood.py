"""Real tests for pipelines/sources/fema_flood.py.

No synthetic rows: the fixture is a single real Esri JSON feature object,
byte-sliced verbatim out of the real fema_flood raw ndjson file this
module's own `run()` fetched from the live NFHL ArcGIS REST service (see
fixtures/fema_flood/fema_flood_feature0.json.source.json for its exact
byte range in that file) — OBJECTID 25779456, DFIRM_ID 48453C (Travis
County), FLD_ZONE 'AE', with 2 rings (an exterior ring plus one hole), so
the fixture exercises both the DFIRM_ID -> county_fips mapping and the
ring hole-grouping logic on real geometry.

The live-DB test requires a real backfill to have already loaded
core.flood_zones (via `python -m pipelines.run fema_flood --backfill`)
and is skipped if POSTGRES_URL_NON_POOLING isn't configured.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from sources import fema_flood

FIXTURE = Path(__file__).parent / "fixtures" / "fema_flood" / "fema_flood_feature0.json"


def _load_fixture_feature() -> dict:
    with open(FIXTURE, "r", encoding="ascii") as f:
        return json.load(f)


def test_dfirm_county_fips_matches_real_fixture():
    feature = _load_fixture_feature()
    dfirm_id = feature["attributes"]["DFIRM_ID"]
    assert dfirm_id == "48453C"

    # Independent recompute: the county FIPS is literally the first 5
    # characters of the DFIRM_ID (Esri's <5-digit FIPS><letter>
    # convention), not anything derived from the module's own function.
    assert dfirm_id[:5] == "48453"
    assert fema_flood.dfirm_county_fips(dfirm_id) == "48453"
    assert "48453" in fema_flood.COUNTY_ENVELOPES


def test_rings_to_multipolygon_wkt_groups_real_hole_correctly():
    feature = _load_fixture_feature()
    rings = feature["geometry"]["rings"]
    assert len(rings) == 2, "fixture was chosen to have exactly one exterior ring plus one hole"

    # Independent recompute of ring orientation via the shoelace formula,
    # not fema_flood._signed_area itself.
    def shoelace(ring):
        area = 0.0
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            area += x1 * y2 - x2 * y1
        return area / 2.0

    exterior_area = shoelace(rings[0])
    hole_area = shoelace(rings[1])
    assert exterior_area < 0, "fixture's first ring must be a clockwise (Esri exterior) ring"
    assert hole_area >= 0, "fixture's second ring must be a counterclockwise (Esri hole) ring"

    wkt = fema_flood.rings_to_multipolygon_wkt(rings)
    # Both rings must be grouped into the SAME (single) polygon, since
    # there is only one exterior ring in this fixture.
    assert wkt.count("((") == 1, f"expected exactly one polygon group, got: {wkt[:80]}..."
    assert wkt.startswith("MULTIPOLYGON(((")

    # Every coordinate pair in both real source rings must appear,
    # verbatim, in the rendered WKT text (catches any silent
    # coordinate drop/reorder/rounding).
    for ring in rings:
        for x, y in ring:
            assert f"{x} {y}" in wkt


def test_feature_to_row_matches_real_fixture():
    feature = _load_fixture_feature()
    row = fema_flood.feature_to_row(feature)
    assert row is not None

    county_fips, fld_zone, wkt = row
    attrs = feature["attributes"]
    assert county_fips == attrs["DFIRM_ID"][:5] == "48453"
    assert fld_zone == attrs["FLD_ZONE"] == "AE"
    assert wkt.startswith("MULTIPOLYGON(")


def test_feature_to_row_drops_feature_with_no_fld_zone():
    feature = _load_fixture_feature()
    stripped = dict(feature)
    stripped["attributes"] = dict(feature["attributes"])
    stripped["attributes"]["FLD_ZONE"] = None
    assert fema_flood.feature_to_row(stripped) is None


def test_feature_to_row_drops_feature_outside_travis_or_harris():
    feature = _load_fixture_feature()
    other_county = dict(feature)
    other_county["attributes"] = dict(feature["attributes"])
    # A real DFIRM_ID seen in the same raw pull, for a county this ticket
    # does not load (Burnet County, 48053).
    other_county["attributes"]["DFIRM_ID"] = "48053C"
    assert fema_flood.feature_to_row(other_county) is None


@pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) to check the live backfill",
)
def test_live_db_travis_flood_zones_loaded_and_sourced():
    from pipelines.core import db

    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute("select count(*) from core.flood_zones where county_fips = %s", ("48453",))
            count = cur.fetchone()[0]
            assert count > 0, "no Travis County (48453) flood zone polygons loaded"

            cur.execute(
                """
                select fz.fld_zone, fz.source_id
                from core.flood_zones fz
                where fz.county_fips = %s
                limit 1
                """,
                ("48453",),
            )
            fld_zone, source_id = cur.fetchone()
            assert fld_zone is not None

            cur.execute(
                "select count(*) from ops.source_manifest where id = %s and source = 'fema_flood'",
                (source_id,),
            )
            assert cur.fetchone()[0] == 1, "Travis flood_zones row's source_id does not resolve to a fema_flood manifest row"

            # Every loaded county_fips must be Travis or Harris only —
            # no neighboring-county DFIRM leaked through.
            cur.execute("select distinct county_fips from core.flood_zones")
            counties = {r[0] for r in cur.fetchall()}
            assert counties <= {"48453", "48201"}, f"unexpected county_fips in core.flood_zones: {counties}"
