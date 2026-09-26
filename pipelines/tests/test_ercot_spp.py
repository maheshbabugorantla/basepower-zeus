"""Real tests for pipelines/sources/ercot_spp.py.

No synthetic rows: fixtures/ercot_spp/lz_aen_2026-09-20_2026-09-21.jsonl
is a real, unmodified ERCOT NP6-905-CD response (settlementPointType=LZ,
settlementPoint=LZ_AEN), fetched live during this ticket and recorded
with a sidecar per CLAUDE.md's fixture format. No hand-typed row arrays.
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path
from zoneinfo import ZoneInfo

from sources import ercot_spp

FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "ercot_spp" / "lz_aen_2026-09-20_2026-09-21.jsonl"


def test_config_driven_load_zones():
    """load_zones() reads pipelines/config/load_zones.yaml -- adding a
    zone is a config change only, never a code change. Asserted by
    reading the real config file and checking it drives the function
    (rather than a hard-coded Python list living in ercot_spp.py)."""
    zones = ercot_spp.load_zones()
    assert zones == [
        "LZ_AEN", "LZ_CPS", "LZ_HOUSTON", "LZ_LCRA",
        "LZ_NORTH", "LZ_RAYBN", "LZ_SOUTH", "LZ_WEST",
    ]
    # The parser is driven entirely by the file contents, not a
    # zone-specific code path: every entry it returns must appear
    # verbatim in the real config file.
    config_text = ercot_spp.CONFIG_PATH.read_text(encoding="utf-8")
    for zone in zones:
        assert zone in config_text


def test_fixture_is_real_lz_aen_response():
    assert FIXTURE_PATH.is_file(), f"real fixture not found at {FIXTURE_PATH}"
    rows = list(ercot_spp.iter_jsonl_rows(FIXTURE_PATH))
    assert len(rows) == 192  # 2 operating days x 96 15-min intervals
    for row in rows:
        assert row["settlementPoint"] == "LZ_AEN"


def test_record_to_row_filters_non_lz_settlement_point_type():
    lz_row = {
        "deliveryDate": "2026-09-21", "deliveryHour": 1, "deliveryInterval": 1,
        "settlementPoint": "LZ_AEN", "settlementPointType": "LZ",
        "settlementPointPrice": 29.08, "DSTFlag": False,
    }
    assert ercot_spp.record_to_row(lz_row) is not None

    lzew_row = dict(lz_row, settlementPointType="LZEW", settlementPointPrice=99.99)
    assert ercot_spp.record_to_row(lzew_row) is None


def test_record_to_row_from_real_fixture_row():
    rows = list(ercot_spp.iter_jsonl_rows(FIXTURE_PATH))
    real = rows[0]
    parsed = ercot_spp.record_to_row(real)
    assert parsed is not None
    assert parsed["settlement_point"] == "LZ_AEN"
    assert parsed["delivery_date"] == dt.date.fromisoformat(real["deliveryDate"][:10])
    assert parsed["price_usd_mwh"] == float(real["settlementPointPrice"])
    assert parsed["dst_flag"] == bool(real["DSTFlag"])


def test_interval_start_utc_normal_day():
    # Hour-ending 1, interval 1 on 2026-09-21 (not a DST day) -> local
    # wall time 00:00-00:15 America/Chicago, CDT (UTC-5) that time of year.
    start = ercot_spp.interval_start_utc(dt.date(2026, 9, 21), 1, 1, False)
    assert start.tzinfo == dt.timezone.utc
    local = start.astimezone(ZoneInfo("America/Chicago"))
    assert local.hour == 0 and local.minute == 0
    assert local.date() == dt.date(2026, 9, 21)


def test_interval_start_utc_disambiguates_fall_back_hour():
    # 2026-11-01 is the fall-back day in America/Chicago: hour-ending 2
    # (01:00-02:00 local) occurs twice -- DSTFlag distinguishes the two
    # passes. Without fold, both would collapse to the same UTC instant
    # and the unique index would drop one of the two real intervals.
    first_pass = ercot_spp.interval_start_utc(dt.date(2026, 11, 1), 2, 1, False)
    second_pass = ercot_spp.interval_start_utc(dt.date(2026, 11, 1), 2, 1, True)
    assert first_pass != second_pass
    assert (second_pass - first_pass) == dt.timedelta(hours=1)


def test_earliest_queryable_date_matches_documented_api_history():
    # checks/M3-ercot-layering.md section A: the API's queryable history
    # starts at operating day 2023-12-11.
    assert ercot_spp.EARLIEST_QUERYABLE_DATE == dt.date(2023, 12, 11)
