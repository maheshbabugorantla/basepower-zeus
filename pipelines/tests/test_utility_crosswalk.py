"""Real tests for pipelines/sources/utility_crosswalk.py.

No synthetic rows: `data/manual/utility_crosswalk.csv` IS the raw file
for this source (a small, hand-curated, cited crosswalk -- see
checks/M2-H1.md) -- there is nothing to slice a byte-range fixture out
of, so the first test reads that real, committed file directly.

The live-DB test requires a real backfill of BOTH core.territories
(M2-P1) and core.utility_crosswalk (this module, `python -m
pipelines.run utility_crosswalk --backfill`) and re-derives, via a
read-only SQL query mirroring core.mv_home_signals' own `territory_match`
/ `gate` CTEs (0201_m2.sql), the expected Travis County gate outcome:
Austin Energy (1015) homes pass, Pedernales (14626) and Bluebonnet
(1892) homes are gated out with 'territory_not_base_served'. It never
calls core.refresh_all_scores() (owned by the orchestrator, per
scratchpad/m2_pipeline_brief.md) and never writes to mv_home_signals --
strictly a read-only SELECT. Skipped if POSTGRES_URL_NON_POOLING isn't
configured.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

import pytest

from sources import utility_crosswalk

CSV_PATH = Path(__file__).resolve().parents[2] / "data" / "manual" / "utility_crosswalk.csv"


def test_reads_real_records_from_csv():
    assert CSV_PATH.is_file(), f"real crosswalk CSV not found at {CSV_PATH}"

    rows_in, records = utility_crosswalk.read_records(CSV_PATH)

    assert rows_in == len(records)
    assert rows_in == 11  # 11 real data rows in data/manual/utility_crosswalk.csv

    by_name = {r["base_name"]: r for r in records}

    austin = by_name["Austin Energy"]
    assert austin["eia_utility_number"] == "1015"
    assert austin["polygon_name"] == "AUSTIN ENERGY"
    assert austin["mapped"] == "yes"
    assert austin["note"] is None
    assert austin["base_retrieved_at"] == datetime(2026, 9, 26, 7, 46, 7, tzinfo=timezone.utc)

    centerpoint = by_name["CenterPoint Energy"]
    assert centerpoint["eia_utility_number"] == "8901"
    assert centerpoint["mapped"] == "yes"

    # Unmapped rows keep eia_utility_number null and carry a real,
    # non-guessed note -- never a placeholder (real-data rule).
    aep_central = by_name["AEP Texas Central"]
    assert aep_central["mapped"] == "no"
    assert aep_central["eia_utility_number"] is None
    assert aep_central["note"]
    assert "AEP" in aep_central["note"]

    coserv = by_name["CoServ"]
    assert coserv["mapped"] == "no"
    assert coserv["eia_utility_number"] is None
    assert "not confirmed" in coserv["note"]


def test_missing_expected_column_raises(tmp_path):
    bad_csv = tmp_path / "bad.csv"
    bad_csv.write_text("base_name,mapped\nFoo,yes\n")
    with pytest.raises(RuntimeError, match="missing expected column"):
        utility_crosswalk.read_records(bad_csv)


@pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) to check the live backfill",
)
def test_travis_territory_gate_matches_expectation():
    """Re-derive, for real Travis County (48453) homes, whether each of
    the three territories named in checks/M2-H1.md -- Austin Energy
    (1015, mapped='yes'), Pedernales (14626) and Bluebonnet (1892, both
    unmapped) -- contains the home's real parcel centroid, and whether
    core.utility_crosswalk marks that territory Base-served. This is the
    same ST_Within + crosswalk join core.mv_home_signals' territory_match
    CTE (0201_m2.sql) does, restricted to these 3 (of 141) TX polygons so
    the read-only SELECT finishes quickly -- it never refreshes or writes
    to the materialized view itself."""
    from pipelines.core import db

    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute("select count(*) from core.utility_crosswalk")
            (crosswalk_count,) = cur.fetchone()
            assert crosswalk_count == 11, f"expected 11 core.utility_crosswalk rows, got {crosswalk_count}"

            cur.execute(
                "select count(*) from core.utility_crosswalk where mapped = 'no' and eia_utility_number is null"
            )
            assert cur.fetchone()[0] == 3, "expected 3 unmapped (eia_utility_number null) crosswalk rows"

            cur.execute(
                "select count(*) from core.territories where state = 'TX' and eia_id in ('1015', '14626', '1892')"
            )
            assert cur.fetchone()[0] == 3, "Austin Energy/Pedernales/Bluebonnet territories not all loaded (M2-P1)"

            cur.execute(
                """
                select t.eia_id, cw.mapped, count(*)
                from core.mv_home_block_group hb
                join core.block_groups bg on bg.geoid = hb.block_group_geoid
                join core.parcel_geoms pg on pg.prop_id = hb.prop_id
                join core.territories t
                    on t.eia_id in ('1015', '14626', '1892')
                    and extensions.ST_Within(pg.centroid, t.geom)
                left join core.utility_crosswalk cw on cw.eia_utility_number = t.eia_id
                where bg.county_fips = '48453'
                group by t.eia_id, cw.mapped
                order by t.eia_id
                """
            )
            rows = cur.fetchall()

    by_eia = {eia_id: (mapped, n) for eia_id, mapped, n in rows}

    # Austin Energy (1015) IS on Base's list -> mapped='yes' -> passes the gate.
    assert "1015" in by_eia, "no Travis homes matched to Austin Energy (1015) territory"
    assert by_eia["1015"][0] == "yes"
    assert by_eia["1015"][1] > 0

    # Pedernales (14626) and Bluebonnet (1892) are NOT on Base's list ->
    # no crosswalk row -> mapped is null -> any home whose ONLY territory
    # match is one of these (i.e. not also inside Austin Energy) would
    # get gate_reason = 'territory_not_base_served'.
    for eia_id, name in (("14626", "Pedernales"), ("1892", "Bluebonnet")):
        if eia_id in by_eia:
            mapped, n = by_eia[eia_id]
            assert mapped is None, f"{name} ({eia_id}) unexpectedly mapped={mapped!r} -- should be unmapped"
            assert n > 0
