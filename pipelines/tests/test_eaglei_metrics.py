"""Real tests for pipelines/sources/eaglei_metrics.py.

No synthetic rows:

- fixtures/eaglei_metrics/eaglei_outages_2025_travis_harris_slice.csv is a
  real ~2 MB byte slice of the real 2025 EAGLE-I file (see its
  .source.json sidecar for the exact byte range), covering ~12 hours of
  every reporting county/utility including Travis and Harris. It has no
  header line (the slice starts mid-file), so tests prepend the real 2025
  header before calling module functions, same convention as
  test_eia861_reliability.py's MCC.csv slice test.

- fixtures/eaglei_metrics/eaglei_outages_2024_harris_beryl_slice.csv is a
  real, header-less 40,000-byte slice of the real 2024 EAGLE-I file
  (Harris County only rows, 2024-07-05 through 2024-07-12 — the file is
  sorted so that one county's rows are contiguous, and this window fully
  contains Hurricane Beryl's July 8 peak).

Every expected value below is recomputed independently from the same
fixture bytes with the plain csv module, never hardcoded.

The live-DB test recomputes Harris's Beryl peak directly from the full
real 2024 file in the main checkout (not the fixture) and checks it
against core.outage_metrics_county — the exact "direct pass over the raw
rows" the ticket's acceptance criterion asks for. It's skipped if either
that file or POSTGRES_URL_NON_POOLING isn't available, and requires a
real backfill to have already run
(`python -m pipelines.run eaglei_metrics --backfill`).
"""
from __future__ import annotations

import csv
import os
from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path

import pytest

from sources import eaglei_metrics

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "eaglei_metrics"
FIXTURE_2025 = FIXTURE_DIR / "eaglei_outages_2025_travis_harris_slice.csv"
FIXTURE_2024_BERYL = FIXTURE_DIR / "eaglei_outages_2024_harris_beryl_slice.csv"

HEADER_2025 = "fips_code,county,state,customers_out,run_start_time\n"
HEADER_2024 = "fips_code,county,state,customers_out,run_start_time,total_customers\n"

MAIN_CHECKOUT_2024_FILE = Path(
    "/Users/maheshbabugorantla/Code/Hackathons/BasePower_Deep_Tech_Hackathon_Sep_25_2026_Mavericks"
    "/data/raw/eaglei/eaglei_outages_2024.csv"
)


def _headered_copy(tmp_path: Path, fixture: Path, header: str, name: str) -> str:
    """The fixture slices start mid-file (no header row); prepend the
    real header so module functions, which always read the first line of
    the given path as the header, see the same shape as the real file."""
    out = tmp_path / name
    with open(fixture, "rb") as f:
        body = f.read()
    with open(out, "wb") as f:
        f.write(header.encode("utf-8"))
        f.write(body)
    return str(out)


# ---------------------------------------------------------------------------
# stream_county_series + longest_event, on the 2025 Travis/Harris slice
# ---------------------------------------------------------------------------


def _independent_series(path: str, fips: str, *, month_prefix: str | None = None) -> list[tuple[datetime, int]]:
    rows = []
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            if r["fips_code"] != fips:
                continue
            ts_raw = r["run_start_time"]
            if month_prefix is not None and not ts_raw.startswith(month_prefix):
                continue
            co = r["customers_out"]
            if co == "":
                continue
            co = int(co)
            if co <= 0:
                continue
            rows.append((datetime.strptime(ts_raw, "%Y-%m-%d %H:%M:%S"), co))
    return rows


def test_stream_county_series_matches_independent_recompute_on_2025_slice(tmp_path):
    path = _headered_copy(tmp_path, FIXTURE_2025, HEADER_2025, "2025_slice.csv")

    series = eaglei_metrics.stream_county_series(path, {"48453", "48201"})

    for fips in ("48453", "48201"):
        expected = sorted(_independent_series(path, fips))
        assert sorted(series[fips]) == expected
        assert len(expected) > 0  # the slice does contain rows for both counties


def test_longest_event_matches_independent_recompute_on_2025_slice(tmp_path):
    path = _headered_copy(tmp_path, FIXTURE_2025, HEADER_2025, "2025_slice.csv")
    series = eaglei_metrics.stream_county_series(path, {"48453", "48201"})

    for fips in ("48453", "48201"):
        rows = sorted(_independent_series(path, fips))
        assert rows  # sanity: this fixture has rows for both target counties

        # Independent recompute of the longest consecutive-15-minute run,
        # written differently from eaglei_metrics.longest_event (a plain
        # forward scan with an explicit best-so-far, no shared helpers).
        runs: list[list[tuple[datetime, int]]] = []
        for ts, co in rows:
            if runs and ts - runs[-1][-1][0] == timedelta(minutes=15):
                runs[-1].append((ts, co))
            else:
                runs.append([(ts, co)])
        best_run = max(runs, key=len)
        expected = {
            "hours": len(best_run) * 0.25,
            "peak_customers": max(c for _, c in best_run),
            "start": best_run[0][0],
            "end": best_run[-1][0],
        }

        got = eaglei_metrics.longest_event(series[fips])
        assert got == expected


# ---------------------------------------------------------------------------
# july_peak + read_total_customers_2024, on the 2024 Harris Beryl slice
# ---------------------------------------------------------------------------


def test_beryl_peak_matches_independent_recompute_on_harris_slice(tmp_path):
    path = _headered_copy(tmp_path, FIXTURE_2024_BERYL, HEADER_2024, "2024_beryl_slice.csv")

    series = eaglei_metrics.stream_county_series(path, {"48201"}, month_prefix="2024-07")
    peak = eaglei_metrics.july_peak(series["48201"])
    assert peak is not None
    peak_customers, peak_ts = peak

    total_customers = eaglei_metrics.read_total_customers_2024(path, "48201", peak_ts)

    # Independent recompute directly with csv.DictReader, no shared helpers.
    expected_peak = None
    expected_total = None
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            assert r["fips_code"] == "48201"  # this slice is Harris-only
            co = r["customers_out"]
            if co == "" or not r["run_start_time"].startswith("2024-07"):
                continue
            co = int(co)
            if co <= 0:
                continue
            if expected_peak is None or co > expected_peak:
                expected_peak = co
                expected_total = int(r["total_customers"])

    assert peak_customers == expected_peak == 1_660_703
    assert total_customers == expected_total == 1_344_930
    # Real EAGLE-I data anomaly during Beryl: peak customers_out exceeds
    # the file's own total_customers for Harris — reported as-is, not
    # clamped (see the module docstring).
    share = Decimal(peak_customers) / Decimal(total_customers)
    assert share > 1


# ---------------------------------------------------------------------------
# Live-DB check: Harris's Beryl peak, recomputed from the full real 2024
# file (not the fixture), matches core.outage_metrics_county.
# ---------------------------------------------------------------------------


@pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) to check the live backfill",
)
@pytest.mark.skipif(
    not MAIN_CHECKOUT_2024_FILE.is_file(),
    reason="requires the real eaglei_outages_2024.csv staged in the main checkout",
)
def test_harris_beryl_peak_in_db_matches_direct_pass_over_raw_2024_file():
    from pipelines.core import db

    expected_peak = None
    with open(MAIN_CHECKOUT_2024_FILE, "rb") as f:
        header = f.readline().decode("utf-8").rstrip("\r\n").split(",")
        idx = {name: i for i, name in enumerate(header)}
        fips_i, cust_i, ts_i = idx["fips_code"], idx["customers_out"], idx["run_start_time"]
        while True:
            line = f.readline()
            if not line:
                break
            text = line.decode("utf-8").rstrip("\r\n")
            if not text:
                continue
            fields = text.split(",")
            if fields[fips_i] != "48201" or not fields[ts_i].startswith("2024-07"):
                continue
            raw = fields[cust_i]
            if raw == "":
                continue
            val = int(raw)
            if expected_peak is None or val > expected_peak:
                expected_peak = val

    assert expected_peak == 1_660_703, "sanity: real Harris July-2024 peak has moved or file changed"

    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select value, source_ids from core.outage_metrics_county "
                "where county_fips = %s and metric = %s",
                ("48201", "beryl_2024_07_peak_customers"),
            )
            row = cur.fetchone()
            assert row is not None, "Harris beryl_2024_07_peak_customers not loaded"
            value, source_ids = row
            assert int(value) == expected_peak
            assert source_ids and len(source_ids) >= 1

            cur.execute(
                "select count(*) from ops.source_manifest where id = any(%s) and source = 'eaglei'",
                (source_ids,),
            )
            assert cur.fetchone()[0] >= 1, "Harris's source_ids do not resolve to an eaglei manifest row"
