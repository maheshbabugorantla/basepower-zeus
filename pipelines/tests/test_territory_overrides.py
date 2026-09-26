"""Real tests for pipelines/sources/territory_overrides.py.

No synthetic rows: the fixture is the real Socrata w5fd-ctq4 export
already staged in the main checkout (see
fixtures/austin_energy_service_area/austin_energy_service_area.json.source.json
-- it is the whole raw file, not a partial byte range, because the
source holds exactly one record/one MultiPolygon and there is no smaller
real slice to take).

The live-DB test requires a real backfill to have already run both
`python -m pipelines.run territories --backfill` and
`python -m pipelines.run territory_overrides --backfill` against Supabase.
Skipped if POSTGRES_URL_NON_POOLING isn't configured.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from sources import territory_overrides

FIXTURE = Path(__file__).parent / "fixtures" / "austin_energy_service_area" / "austin_energy_service_area.json"


@pytest.mark.skipif(
    not FIXTURE.is_file(),
    reason=f"real fixture not present at {FIXTURE}",
)
def test_reads_real_the_geom_from_fixture():
    the_geom = territory_overrides.read_the_geom(FIXTURE)

    assert the_geom["type"] == "MultiPolygon"
    assert isinstance(the_geom["coordinates"], list)
    assert len(the_geom["coordinates"]) >= 1
    # Real coordinates, not placeholders: Austin sits at roughly
    # lon in [-98.1, -97.4], lat in [30.0, 30.6]. Spot-check the first
    # ring's first point falls in that real bounding box.
    lon, lat = the_geom["coordinates"][0][0][0]
    assert -98.2 < lon < -97.3
    assert 29.9 < lat < 30.7


@pytest.mark.skipif(
    not FIXTURE.is_file(),
    reason=f"real fixture not present at {FIXTURE}",
)
def test_rejects_a_file_that_is_not_exactly_one_record(tmp_path):
    import json

    bad = tmp_path / "two_records.json"
    with open(FIXTURE) as f:
        records = json.load(f)
    bad.write_text(json.dumps(records + records))

    with pytest.raises(RuntimeError, match="expected exactly 1"):
        territory_overrides.read_the_geom(bad)


@pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) to check the live backfill",
)
def test_austin_energy_geom_matches_official_polygon_and_source_id_resolves():
    from pipelines.core import db

    the_geom = territory_overrides.read_the_geom(territory_overrides._json_path())

    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            # core.territories.geom for eia_id=1015 must now equal the
            # official polygon read straight from the staged raw file
            # (ST_Equals, not ST_Within -- this checks the override
            # actually replaced the HIFLD geometry, not just overlaps it).
            cur.execute(
                """
                select
                    extensions.ST_Equals(
                        t.geom,
                        extensions.ST_Multi(
                            extensions.ST_CollectionExtract(
                                case
                                    when extensions.ST_IsValid(g.raw_geom) then g.raw_geom
                                    else extensions.ST_MakeValid(g.raw_geom)
                                end,
                                3
                            )
                        )
                    ),
                    t.source_id
                from core.territories t,
                     (select extensions.ST_SetSRID(
                                 extensions.ST_GeomFromGeoJSON(%s), 4326
                             ) as raw_geom) g
                where t.eia_id = %s
                """,
                (__import__("json").dumps(the_geom), territory_overrides.TARGET_EIA_ID),
            )
            row = cur.fetchone()
            assert row is not None, "core.territories has no row for eia_id=1015 (run territories backfill first)"
            geoms_equal, source_id = row
            assert geoms_equal is True, (
                "core.territories.geom for eia_id=1015 does not equal the official "
                "Austin Energy Service Area polygon -- run "
                "`python -m pipelines.run territory_overrides --backfill`"
            )

            cur.execute(
                "select count(*) from ops.source_manifest where id = %s and source = %s",
                (source_id, territory_overrides.SOURCE),
            )
            assert cur.fetchone()[0] == 1, (
                "eia_id=1015's source_id does not resolve to an "
                "austin_energy_service_area manifest row"
            )
