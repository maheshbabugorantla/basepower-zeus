"""Real tests for pipelines/sources/hcad_parcels.py.

No synthetic rows: every fixture is either a byte slice of a real HCAD
bulk-export file (see the .source.json sidecars in
fixtures/hcad_parcels/) or a real, live-fetched page from HCAD's own
public ArcGIS REST parcel layer, saved unchanged to data/raw/hcad/ first
(so it is a real downloaded raw file, not a network mock) and then
sliced/copied into the fixture. Expected values (which accounts are
single-family, which carry the 'RES' homestead exemption token) are
independently re-derived from the raw bytes in-test, and cross-checked
against real lookups this ticket already performed against the full raw
files (recorded in checks/M3-P2.md), never invented.

The live-DB test requires a real backfill to have already loaded
core.parcels / core.parcel_geoms (via
`python -m pipelines.run hcad_parcels --backfill`) and is skipped if
POSTGRES_URL_NON_POOLING isn't configured.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from sources import hcad_parcels

FIXTURES = Path(__file__).parent / "fixtures" / "hcad_parcels"
REAL_ACCT_FIXTURE = FIXTURES / "real_acct_slice0.txt"
JUR_EXEMPT_FIXTURE = FIXTURES / "jur_exempt_cd_slice0.txt"
GEOM_FIXTURE = FIXTURES / "hcad_geometry_page0.geojsonseq"


# --------------------------------------------------------------------------
# build_homestead_set() against a real jur_exempt_cd.txt slice
# --------------------------------------------------------------------------


def test_build_homestead_set_from_fixture_slice(tmp_path):
    # Reimplemented independently of hcad_parcels.build_homestead_set:
    # plain string parsing of the raw fixture bytes.
    expected = set()
    for raw_line in JUR_EXEMPT_FIXTURE.read_bytes().split(b"\r\n"):
        if not raw_line:
            continue
        acct, _, cat = raw_line.decode("latin-1").partition("\t")
        if "RES" in cat.strip().split():
            expected.add(acct.strip())

    # This slice was chosen (checks/M3-P2.md) to contain 3 accounts with
    # no homestead exemption (exempt_cat 'TOT') and 2 real accounts
    # confirmed to carry the 'RES' (Residential Homestead) token.
    assert expected == {"0021440000001", "0021440000003"}

    # build_homestead_set reads straight from a zip member; wrap the
    # fixture bytes in an in-memory zip with the same member name so we
    # exercise the real function against real bytes without needing the
    # full 114 MB Real_jur_exempt.zip on disk.
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        header = b"acct\texempt_cat\r\n"
        zf.writestr(hcad_parcels.JUR_EXEMPT_MEMBER, header + JUR_EXEMPT_FIXTURE.read_bytes())
    buf.seek(0)

    tmp_zip = tmp_path / "_tmp_jur_exempt_for_test.zip"
    tmp_zip.write_bytes(buf.getvalue())
    actual = hcad_parcels.build_homestead_set(str(tmp_zip))

    assert actual == expected


# --------------------------------------------------------------------------
# process_real_acct() against a real real_acct.txt slice
# --------------------------------------------------------------------------


def test_process_real_acct_filters_to_single_family_homestead():
    raw = REAL_ACCT_FIXTURE.read_bytes()
    lines = [line for line in raw.split(b"\r\n") if line]
    header = [
        "acct", "yr", "mailto", "mail_addr_1", "mail_addr_2", "mail_city", "mail_state",
        "mail_zip", "mail_country", "undeliverable", "str_pfx", "str_num", "str_num_sfx",
        "str", "str_sfx", "str_sfx_dir", "str_unit", "site_addr_1", "site_addr_2",
        "site_addr_3", "state_class", "school_dist", "map_facet", "key_map",
        "Neighborhood_Code", "Neighborhood_Grp", "Market_Area_1", "Market_Area_1_Dscr",
        "Market_Area_2", "Market_Area_2_Dscr", "econ_area", "econ_bld_class", "center_code",
        "yr_impr", "yr_annexed", "splt_dt", "dsc_cd", "nxt_bld", "bld_ar", "land_ar",
        "acreage", "Cap_acct", "shared_cad", "land_val", "bld_val", "x_features_val",
        "ag_val", "assessed_val", "tot_appr_val", "tot_mkt_val", "prior_land_val",
        "prior_bld_val", "prior_x_features_val", "prior_ag_val", "prior_tot_appr_val",
        "prior_tot_mkt_val", "new_construction_val", "tot_rcn_val", "value_status",
        "noticed", "notice_dt", "protested", "certified_date", "rev_dt", "rev_by",
        "new_own_dt", "lgl_1", "lgl_2", "lgl_3", "lgl_4", "jurs",
    ]

    # Independent recomputation directly off the raw fixture bytes, using
    # none of hcad_parcels.py's own filter/extraction code.
    homestead_set = {"0021440000001", "0021440000003"}
    expected_rows_in = len(lines)
    expected_not_a1 = 0
    expected_not_homestead = 0
    expected_kept: set[str] = set()
    for raw_line in lines:
        parts = raw_line.decode("latin-1").split("\t")
        field = dict(zip(header, parts))
        acct = field["acct"].strip()
        state_class = field["state_class"].strip()
        if not state_class.startswith("A1"):
            expected_not_a1 += 1
            continue
        if acct not in homestead_set:
            expected_not_homestead += 1
            continue
        expected_kept.add(acct)

    # This slice (checks/M3-P2.md) has 4 non-A1 rows (3 'X1' plus one
    # 'B2' that does carry the homestead exemption but is not
    # single-family) and exactly 1 real single-family homestead row
    # (0021440000001, state_class 'A1').
    assert expected_not_a1 == 4
    assert expected_not_homestead == 0
    assert expected_kept == {"0021440000001"}

    class _Handle:
        """Minimal readline() wrapper carrying the parsed header, exactly
        as hcad_parcels.run() attaches it to the real zip member handle."""

        def __init__(self, data: bytes, header: list[str]):
            self._lines = iter(data.split(b"\r\n"))
            self._hcad_header = header

        def readline(self):
            try:
                line = next(self._lines)
            except StopIteration:
                return b""
            return line + b"\r\n" if line else b""

    handle = _Handle(raw, header)

    batches: list[list[tuple]] = []

    def fake_load(_conn, batch):
        batches.append(list(batch))

    state = hcad_parcels.new_attr_state()
    hcad_parcels.process_real_acct(
        handle,
        homestead_set=homestead_set,
        state=state,
        conn=None,
        manifest_id="00000000-0000-0000-0000-000000000000",
        county_fips="48201",
        default_tax_year=2026,
        batch_size=1000,
        on_checkpoint=lambda s: None,
        load_batch=fake_load,
    )

    assert state["rows_in"] == expected_rows_in
    assert state["filter_drops"]["not_a1"] == expected_not_a1
    assert state["filter_drops"]["not_homestead"] == expected_not_homestead
    assert state["loaded"] == len(expected_kept)
    assert hcad_parcels.rows_loaded(state) == state["loaded"]

    loaded_rows = {row[0]: row for batch in batches for row in batch}
    assert set(loaded_rows) == expected_kept
    row = loaded_rows["0021440000001"]
    # row layout: prop_id, geo_id, county_fips, prop_type_cd, imprv_state_cd,
    # land_state_cd, hs_exempt, ov65_exempt, situs_num, situs_street,
    # situs_city, situs_zip, market_value, tax_year, source_id
    assert row[0] == "0021440000001"
    assert row[1] == "0021440000001"
    assert row[2] == "48201"
    assert row[3] == "R"
    assert row[4] == "A1"
    assert row[5] == "A1"
    assert row[6] == "T"
    assert row[13] == 2026
    assert row[14] == "00000000-0000-0000-0000-000000000000"


# --------------------------------------------------------------------------
# load_geom_core() against a real ArcGIS page fixture
# --------------------------------------------------------------------------


def test_load_geom_core_filters_to_homestead_set():
    # Real homestead facts for 4 of the first 10 of these 1000 real,
    # live-fetched features, looked up directly against the full
    # Real_jur_exempt.zip (checks/M3-P2.md) -- not invented.
    homestead_set = {
        "0181060000033", "0181140000003", "0181140000029", "0181140000031",
    }

    captured: list[tuple[list[str], list[str], list[str]]] = []

    def fake_upsert(_conn, prop_ids, geo_ids, gjs, _manifest_id):
        captured.append((list(prop_ids), list(geo_ids), list(gjs)))

    state = hcad_parcels.load_geom_core(
        None,
        "00000000-0000-0000-0000-000000000000",
        GEOM_FIXTURE,
        homestead_set=homestead_set,
        batch_size=1000,
        wait_for_refresh=lambda _conn: None,
        upsert_batch=fake_upsert,
    )

    assert state["rows_in"] == 1000
    assert state["filter_drops"]["not_homestead"] == 1000 - len(homestead_set)
    assert state["filter_drops"]["missing_hcad_num"] == 0
    assert state["filter_drops"]["duplicate_hcad_num"] == 0
    assert state["rows_loaded"] == len(homestead_set)

    loaded_prop_ids = {p for batch in captured for p in batch[0]}
    assert loaded_prop_ids == homestead_set


@pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) to check the live backfill",
)
def test_harris_parcels_loaded_in_db():
    from pipelines.core import db

    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select count(*), count(*) filter (where prop_type_cd != 'R'), "
                "count(*) filter (where hs_exempt != 'T'), "
                "count(*) filter (where imprv_state_cd not like 'A1%%' and land_state_cd not like 'A1%%') "
                "from core.parcels where county_fips = %s",
                ("48201",),
            )
            total, non_r, non_homestead, non_a1 = cur.fetchone()
            assert total > 0, "no Harris (48201) parcels loaded"
            assert non_r == 0, "core.parcels must only contain prop_type_cd = 'R' rows"
            assert non_homestead == 0, "every loaded Harris row must be pre-filtered to homestead == True"
            assert non_a1 == 0, "every loaded Harris row must be pre-filtered to single-family (A1)"
            assert total <= 1_200_000, "Harris load-time filter should keep row count near the ~1M target"

            cur.execute(
                "select count(*) from core.parcels p "
                "join ops.source_manifest sm on sm.id = p.source_id "
                "where p.county_fips = %s and sm.source = %s",
                ("48201", hcad_parcels.REAL_ACCT_SOURCE),
            )
            traceable = cur.fetchone()[0]
            assert traceable == total, "every Harris parcel must trace to an hcad_real_acct manifest row"

            cur.execute("select count(distinct prop_id) from core.parcels where county_fips = %s", ("48201",))
            assert cur.fetchone()[0] == total, "core.parcels must have one row per prop_id (deduped)"
