"""Real tests for pipelines/sources/territories.py.

No synthetic rows: the fixture is a real row-filtered extract of the
actual HIFLD GeoParquet mirror already staged in the main checkout (see
fixtures/territories/territories_slice0.parquet.source.json -- it is not
a contiguous byte range because the source is zstd-compressed columnar
Parquet, so the sidecar explains why and records the source file's own
sha256 and the row filter used). It is skipped if that fixture is not
present in this environment (it is committed by this ticket, so normally
present).

The live-DB test requires a real backfill to have already loaded
core.territories (via `python -m pipelines.run territories --backfill`)
and requires core.parcel_geoms to already hold TCAD parcel 101325 (from
M1). Skipped if POSTGRES_URL_NON_POOLING isn't configured.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from sources import territories

FIXTURE = Path(__file__).parent / "fixtures" / "territories" / "territories_slice0.parquet"


@pytest.mark.skipif(
    not FIXTURE.is_file(),
    reason=f"real fixture not present at {FIXTURE}",
)
def test_reads_real_records_from_fixture():
    rows_in, records = territories.read_records(FIXTURE, state="TX")

    # The fixture holds exactly the two real rows it was extracted for
    # (Austin Energy 1015, CenterPoint 8901) -- both TX -- so rows_in
    # (the parquet's total row count) equals the TX-filtered count here.
    assert rows_in == 2
    assert len(records) == 2

    by_id = {eia_id: (name, state, wkb_bytes) for eia_id, name, state, wkb_bytes in records}

    assert "1015" in by_id
    name, state, wkb_bytes = by_id["1015"]
    assert name == "AUSTIN ENERGY"
    assert state == "TX"
    assert isinstance(wkb_bytes, bytes)
    assert len(wkb_bytes) > 0
    # WKB byte-order flag (offset 0) plus its geometry-type uint32 must be
    # Polygon (3) or MultiPolygon (6) per the GeoParquet metadata's
    # declared geometry_types -- catches any accidental non-geometry
    # column being read as `geometry`. This source's WKB is big-endian
    # (byte-order flag 0x00), which PostGIS's ST_GeomFromWKB handles
    # natively (the WKB spec itself carries the byte-order flag).
    import struct
    byte_order = wkb_bytes[0]
    fmt = ">I" if byte_order == 0 else "<I"
    geom_type = struct.unpack_from(fmt, wkb_bytes, 1)[0]
    assert geom_type in (3, 6), f"unexpected WKB geometry type {geom_type} for eia_id 1015"

    assert "8901" in by_id
    name8901, state8901, _wkb8901 = by_id["8901"]
    assert name8901 == "CENTERPOINT ENERGY"
    assert state8901 == "TX"


@pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) to check the live backfill",
)
def test_austin_energy_contains_tcad_parcel_101325_and_centerpoint_exists():
    from pipelines.core import db

    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute("select count(*) from core.territories where state = 'TX'")
            (tx_count,) = cur.fetchone()
            assert tx_count == 141, f"expected 141 TX territories, got {tx_count}"

            cur.execute("select count(*) from core.territories where eia_id = %s", ("8901",))
            assert cur.fetchone()[0] == 1, "CenterPoint (8901) not loaded into core.territories"

            # Austin Energy's (1015) polygon must contain TCAD parcel
            # 101325's real centroid (core.parcel_geoms, loaded by M1).
            cur.execute(
                """
                select extensions.ST_Within(pg.centroid, t.geom), t.source_id
                from core.parcel_geoms pg
                join core.territories t on t.eia_id = %s
                where pg.prop_id = %s
                """,
                ("1015", "101325"),
            )
            row = cur.fetchone()
            assert row is not None, "prop_id 101325 not found in core.parcel_geoms (M1 backfill missing)"
            within, source_id = row
            assert within is True, "Austin Energy (1015) polygon does not contain TCAD parcel 101325's centroid"

            cur.execute(
                # Since M2-H2 the Austin Energy polygon is the City of Austin's
                # official service area (territory override), so its source is
                # that manifest row, not the HIFLD territories file.
                "select count(*) from ops.source_manifest where id = %s and source in ('territories', 'austin_energy_service_area')",
                (source_id,),
            )
            assert cur.fetchone()[0] == 1, "Austin Energy row's source_id does not resolve to a territories or City of Austin service-area manifest row"
