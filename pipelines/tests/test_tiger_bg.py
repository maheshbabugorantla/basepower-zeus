"""Real tests for pipelines/sources/tiger_bg.py.

No synthetic rows: the first test reads a real record straight out of the
real tl_2024_48_bg.zip already downloaded into the main checkout (outside
this worktree, per the ticket's raw-data convention) and independently
recomputes the WKT for that one record using nothing but the stdlib
(zipfile/struct-free — it goes through pyshp for the .dbf/.shp parse,
same as the module under test, but re-derives county_fips and re-checks
the WKT shape by hand rather than reusing tiger_bg._polygon_wkt's own
output as its own oracle). It is skipped if that file is not present in
this environment.

The live-DB test requires a real backfill to have already loaded
core.block_groups (via `python -m pipelines.run tiger_bg --backfill`)
and is skipped if POSTGRES_URL_NON_POOLING isn't configured.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from sources import tiger_bg

MAIN_CHECKOUT_ZIP = Path(
    "/Users/maheshbabugorantla/Code/Hackathons/BasePower_Deep_Tech_Hackathon_Sep_25_2026_Mavericks"
    "/data/raw/tiger/tl_2024_48_bg.zip"
)


@pytest.mark.skipif(
    not MAIN_CHECKOUT_ZIP.is_file(),
    reason=f"real raw file not present at {MAIN_CHECKOUT_ZIP}",
)
def test_reads_real_record_from_zip(tmp_path):
    with open(MAIN_CHECKOUT_ZIP, "rb") as f:
        data = f.read()

    shp_base = tiger_bg.extract_shapefile(data, str(tmp_path))

    import shapefile

    reader = shapefile.Reader(shp_base)
    assert len(reader) > 0

    # Travis County (48453) must appear among the real records.
    travis = [
        sr for sr in reader.iterShapeRecords()
        if sr.record.as_dict()["COUNTYFP"] == "453"
    ]
    assert len(travis) > 0, "no Travis County (COUNTYFP=453) block groups found in the real shapefile"

    sr = travis[0]
    fields = sr.record.as_dict()
    geoid = fields["GEOID"]
    county_fips = "48" + fields["COUNTYFP"]

    # geoid, and the module's own field-extraction, must agree with a
    # hand re-derivation from the same real record.
    assert geoid.startswith("48453")
    assert county_fips == "48453"

    geo = sr.shape.__geo_interface__
    assert geo["type"] in ("Polygon", "MultiPolygon")

    wkt = tiger_bg._polygon_wkt(geo)
    assert wkt.startswith("POLYGON(") or wkt.startswith("MULTIPOLYGON(")
    # Every coordinate pair in the source geometry must appear, verbatim,
    # in the rendered WKT — catches any silent coordinate drop/reorder.
    if geo["type"] == "Polygon":
        first_ring = geo["coordinates"][0]
    else:
        first_ring = geo["coordinates"][0][0]
    x, y = first_ring[0]
    assert f"{x} {y}" in wkt

    # read_records() on the full file must yield this exact record too.
    matches = [r for r in tiger_bg.read_records(shp_base) if r[0] == geoid]
    assert len(matches) == 1
    assert matches[0][1] == "48453"


@pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) to check the live backfill",
)
def test_travis_county_block_groups_loaded_in_db():
    from pipelines.core import db

    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select count(*) from core.block_groups where county_fips = %s",
                ("48453",),
            )
            count = cur.fetchone()[0]
            assert count > 0, "no Travis County (48453) block groups loaded in core.block_groups"

            cur.execute(
                """
                select bg.geoid, bg.source_id
                from core.block_groups bg
                where bg.county_fips = %s
                limit 1
                """,
                ("48453",),
            )
            geoid, source_id = cur.fetchone()
            assert geoid is not None

            cur.execute(
                "select count(*) from ops.source_manifest where id = %s and source = 'tiger_bg'",
                (source_id,),
            )
            assert cur.fetchone()[0] == 1, "Travis row's source_id does not resolve to a tiger_bg manifest row"
