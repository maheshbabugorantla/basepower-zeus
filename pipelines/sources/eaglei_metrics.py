"""Per-county EAGLE-I outage metrics for Travis (48453) and Harris (48201)
-> core.outage_metrics_county.

core.outage_county_year (loaded by pipelines/sources/eaglei.py) only holds
annual customer-hours totals — no event boundaries, no peak. This module
re-streams the raw EAGLE-I CSVs directly (filtering to the two target
counties as early as possible, since neither 1.4 GB file is loaded into
memory at once) to compute, per county:

  longest_event_hours / _peak_customers / _start_epoch / _end_epoch
      The longest run of consecutive 15-minute snapshots with
      customers_out > 0 in the latest published year (2025, same file
      pipelines/sources/eaglei.py uses). "Consecutive" means each row's
      run_start_time is exactly 15 minutes after the previous row kept for
      that county — any gap (including a snapshot where customers_out was
      absent or 0, which EAGLE-I simply omits rather than writing a zero
      row) closes the run. hours = row_count * 0.25 (each row represents
      its following 15-minute interval, same convention as eaglei.py's
      customer-hours formula). Note: Harris County's real 2025 data never
      reads exactly zero customers_out for months at a stretch (a chronic
      low-level background outage count in a county this large), so its
      "longest event" by this literal definition spans most of the summer
      — a genuine feature of the raw data, not a bug in this module or an
      invented threshold to make it look like a discrete storm event.

  beryl_2024_07_peak_customers / _peak_share
      _peak_customers is the single highest customers_out value for that
      county in July 2024 (Hurricane Beryl), from the 2024 file
      (eaglei_outages_2024.csv, figshare file 53581661). _peak_share
      divides that by core.county_customers.customers (EAGLE-I's
      separate MCC.csv county customer count, already loaded by
      eaglei_mcc.py) rather than the 2024 file's own total_customers
      column: for Harris County, that column reports a lower figure
      (1,344,930) than the file's own peak customers_out for the same
      rows (1,660,703 at 2024-07-08 19:15/19:30) — a genuine EAGLE-I data
      anomaly during Beryl (share > 1, not physically meaningful), left
      unmodified in the raw file but not used as this metric's
      denominator. core.county_customers (1,827,686 for Harris) gives a
      share ≤ 1 for both target counties instead. read_total_customers_2024()
      below still surfaces the raw column for diagnostics/tests; the
      anomaly is checkable directly:
          grep '^48201,' eaglei_outages_2024.csv | grep 2024-07-08
      Travis's July 2024 peak (5,550 at 2024-07-06 22:45) shows no such
      anomaly (2024 file total_customers and MCC agree closely).

Manifest: pipelines/sources/eaglei.py already manifests the 2025 file
(source='eaglei') during its own backfill; this module reuses that row by
sha256 match. The 2024 file is staged locally (main checkout,
data/raw/eaglei/eaglei_outages_2024.csv) but was never fetched by any
pipeline module before this ticket, so run() manifests it here too (same
source='eaglei', since it's the same dataset, a different year's file) —
no network fetch (`_obtain_local` only ever opens the file already on
disk under data/raw/eaglei/), sha256 computed from those exact bytes and
cross-checked against the sidecar SHA256SUMS, then uploaded unchanged to
Storage bucket `raw` via a streamed TUS resumable upload (ported from
eaglei.py's proven _tus_create/_tus_upload_file — storage.upload_raw()
loads its whole payload into memory, which a 1.4 GB file can't fit).

Cannot run on Vercel Hobby (two 1.4 GB streamed scans well over 300 s);
CLI-only (`python -m pipelines.run eaglei_metrics --backfill`), same
posture as eaglei.py.
"""
from __future__ import annotations

import base64
import hashlib
import os
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Literal

import httpx

from pipelines.core import config, db, manifest, runs, storage

SOURCE = "eaglei_metrics"
EAGLEI_DATASET_SOURCE = "eaglei"  # ops.source_manifest.source for both raw files

RAW_DIR = (
    "/Users/maheshbabugorantla/Code/Hackathons/BasePower_Deep_Tech_Hackathon_Sep_25_2026_Mavericks"
    "/data/raw/eaglei"
)
FILE_2025 = "eaglei_outages_2025.csv"
FILE_2024 = "eaglei_outages_2024.csv"
URL_2025 = "https://ndownloader.figshare.com/files/62164877"
URL_2024 = "https://ndownloader.figshare.com/files/53581661"

LATEST_YEAR = 2025
BERYL_YEAR = 2024
BERYL_MONTH_PREFIX = "2024-07"

TARGET_COUNTIES = {"48453": "Travis", "48201": "Harris"}

TUS_CHUNK_BYTES = 6 * 1024 * 1024  # Supabase's documented resumable-upload chunk size

Runner = Literal["cron", "cli"]


# --------------------------------------------------------------------------
# Sidecars (SHA256SUMS, retrieved_at.txt) — cross-checked, never trusted
# blindly
# --------------------------------------------------------------------------


def _read_sha256sums() -> dict[str, str]:
    out: dict[str, str] = {}
    with open(f"{RAW_DIR}/SHA256SUMS", "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            sha, name = line.split(maxsplit=1)
            out[name.strip()] = sha.strip()
    return out


def _read_retrieved_at_map() -> dict[str, datetime]:
    """retrieved_at.txt has one line per staged file, but only some lines
    name their file explicitly ("<iso> <filename>"); a bare "<iso>" line
    (no filename) is assigned to whichever of the two known EAGLE-I raw
    files has no explicit line, since exactly two files are staged here.
    Raises rather than guessing if that leaves more than one candidate."""
    explicit: dict[str, datetime] = {}
    bare: list[datetime] = []
    with open(f"{RAW_DIR}/retrieved_at.txt", "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            parts = line.split(maxsplit=1)
            ts = datetime.fromisoformat(parts[0].replace("Z", "+00:00"))
            if len(parts) == 2:
                explicit[parts[1].strip()] = ts
            else:
                bare.append(ts)
    for fname in (FILE_2024, FILE_2025):
        if fname not in explicit:
            if len(bare) != 1:
                raise RuntimeError(
                    f"retrieved_at.txt: cannot unambiguously determine retrieved_at "
                    f"for {fname} ({len(bare)} unlabeled timestamp(s) remaining)"
                )
            explicit[fname] = bare.pop(0)
    return explicit


def _sha256_of_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


# --------------------------------------------------------------------------
# TUS resumable upload to Supabase Storage, streamed from a local path
# (ported from pipelines/sources/eaglei.py's proven _tus_create /
# _tus_upload_file — storage.upload_raw() loads its whole `content`
# argument into memory, which can't hold a 1.4 GB file).
# --------------------------------------------------------------------------


def _tus_b64(s: str) -> str:
    return base64.b64encode(s.encode()).decode()


def _tus_create(*, base_url: str, service_key: str, bucket: str, object_name: str,
                 content_type: str, length: int) -> str:
    meta = (
        f"bucketName {_tus_b64(bucket)},"
        f"objectName {_tus_b64(object_name)},"
        f"contentType {_tus_b64(content_type)}"
    )
    headers = {
        "Authorization": f"Bearer {service_key}",
        "apikey": service_key,
        "Tus-Resumable": "1.0.0",
        "Upload-Length": str(length),
        "Upload-Metadata": meta,
        "x-upsert": "true",
    }
    resp = httpx.post(f"{base_url}/storage/v1/upload/resumable", headers=headers, timeout=60.0)
    resp.raise_for_status()
    location = resp.headers.get("location")
    if not location:
        raise RuntimeError("TUS create response had no Location header")
    return location


def _tus_upload_file(path: str, *, base_url: str, service_key: str, bucket: str, object_name: str) -> None:
    length = os.path.getsize(path)
    location = _tus_create(
        base_url=base_url, service_key=service_key, bucket=bucket,
        object_name=object_name, content_type="text/csv", length=length,
    )
    offset = 0
    headers_base = {
        "Authorization": f"Bearer {service_key}",
        "apikey": service_key,
        "Tus-Resumable": "1.0.0",
        "Content-Type": "application/offset+octet-stream",
    }
    with open(path, "rb") as f, httpx.Client(timeout=120.0) as client:
        while offset < length:
            f.seek(offset)
            chunk = f.read(TUS_CHUNK_BYTES)
            if not chunk:
                break
            headers = dict(headers_base, **{"Upload-Offset": str(offset)})
            resp = client.patch(location, headers=headers, content=chunk)
            resp.raise_for_status()
            offset = int(resp.headers["upload-offset"])


# --------------------------------------------------------------------------
# Manifest: reuse an existing (source='eaglei', sha256) row; otherwise
# upload (streamed from the already-staged local file, no network fetch)
# and insert.
# --------------------------------------------------------------------------


def _existing_manifest(sha256: str) -> dict[str, Any] | None:
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select id, storage_key from ops.source_manifest "
                "where source = %s and sha256 = %s order by retrieved_at desc limit 1",
                (EAGLEI_DATASET_SOURCE, sha256),
            )
            row = cur.fetchone()
    if row is None:
        return None
    return {"id": str(row[0]), "storage_key": row[1]}


def ensure_manifest_for_file(csv_filename: str, url: str, *, runner: Runner) -> dict[str, Any]:
    """Return {"id", "path", "sha256"} for the manifest row covering
    data/raw/eaglei/<csv_filename>, reusing an existing row for the same
    sha256 if one exists (e.g. the 2025 file, already manifested by
    eaglei.py's own backfill), otherwise uploading the already-staged
    local bytes (never re-fetched over the network) and inserting one."""
    path = f"{RAW_DIR}/{csv_filename}"
    sha256 = _sha256_of_file(path)

    expected = _read_sha256sums().get(csv_filename)
    if expected is not None and expected != sha256:
        raise RuntimeError(
            f"{csv_filename}: sha256 mismatch against SHA256SUMS "
            f"(sidecar={expected}, computed={sha256})"
        )

    existing = _existing_manifest(sha256)
    if existing is not None:
        return {"id": existing["id"], "path": path, "sha256": sha256}

    retrieved_at = _read_retrieved_at_map()[csv_filename]
    base_url = config.supabase_url()
    service_key = config.supabase_secret_key()
    key = storage.storage_key(EAGLEI_DATASET_SOURCE, sha256, when=retrieved_at, ext=".csv")

    _tus_upload_file(path, base_url=base_url, service_key=service_key, bucket=config.RAW_BUCKET, object_name=key)

    with db.connect(pooled=False) as conn:
        manifest_id = manifest.insert(
            conn,
            source=EAGLEI_DATASET_SOURCE,
            url=url,
            retrieved_at=retrieved_at,
            sha256=sha256,
            bytes_=os.path.getsize(path),
            rows=None,
            runner=runner,
            storage_key=key,
        )
    return {"id": manifest_id, "path": path, "sha256": sha256}


# --------------------------------------------------------------------------
# Streamed computation over the raw CSVs — filters to TARGET_COUNTIES as
# early as possible (checked before any other field is parsed), never
# loads either file into memory at once.
# --------------------------------------------------------------------------


FILTER_NAMES = (
    "not_target_county",
    "outside_month_window",
    "missing_customers_out",
    "unparseable_customers_out",
    "non_positive_customers_out",
)


def scan_counties(path: str, fips_set: set[str], *,
                   month_prefix: str | None = None) -> tuple[dict[str, list[tuple[datetime, int]]], dict[str, Any]]:
    """Stream `path` once, keeping only rows whose fips_code is in
    `fips_set` (and, if `month_prefix` given, whose run_start_time starts
    with it — e.g. "2024-07" for the Beryl window), with a positive
    customers_out. Returns ({fips: [(timestamp, customers_out), ...]}
    (not yet sorted), stats) where stats = {"rows_in": int, "filter_drops":
    {name: int}} and rows_in - sum(filter_drops.values()) always equals
    the total number of rows kept across every fips in `fips_set` (the
    invariant `python -m pipelines.check reconcile` verifies)."""
    series: dict[str, list[tuple[datetime, int]]] = {fips: [] for fips in fips_set}
    stats = {"rows_in": 0, "filter_drops": {name: 0 for name in FILTER_NAMES}}
    drops = stats["filter_drops"]

    with open(path, "rb") as f:
        header = f.readline().decode("utf-8").rstrip("\r\n").split(",")
        idx = {name: i for i, name in enumerate(header)}
        fips_i = idx["fips_code"]
        cust_i = idx["customers_out"]
        ts_i = idx["run_start_time"]

        while True:
            line = f.readline()
            if not line:
                break
            text = line.decode("utf-8").rstrip("\r\n")
            if not text:
                continue
            stats["rows_in"] += 1
            fields = text.split(",")
            fips = fields[fips_i]
            if fips not in fips_set:
                drops["not_target_county"] += 1
                continue
            ts_raw = fields[ts_i]
            if month_prefix is not None and not ts_raw.startswith(month_prefix):
                drops["outside_month_window"] += 1
                continue
            raw_val = fields[cust_i]
            if raw_val == "":
                drops["missing_customers_out"] += 1
                continue
            try:
                val = int(raw_val)
            except ValueError:
                drops["unparseable_customers_out"] += 1
                continue
            if val <= 0:
                drops["non_positive_customers_out"] += 1
                continue
            ts = datetime.strptime(ts_raw, "%Y-%m-%d %H:%M:%S")
            series[fips].append((ts, val))
    return series, stats


def stream_county_series(path: str, fips_set: set[str], *,
                          month_prefix: str | None = None) -> dict[str, list[tuple[datetime, int]]]:
    """Convenience wrapper over scan_counties() for callers (tests) that
    don't need the rows_in/filter_drops bookkeeping."""
    series, _stats = scan_counties(path, fips_set, month_prefix=month_prefix)
    return series


def longest_event(rows: list[tuple[datetime, int]]) -> dict[str, Any] | None:
    """Given one county's (timestamp, customers_out>0) rows, return the
    longest run of consecutive 15-minute snapshots (a gap of any size, or
    a snapshot EAGLE-I omitted, ends the run): {hours, peak_customers,
    start, end}. None if `rows` is empty."""
    if not rows:
        return None
    ordered = sorted(rows)
    best: dict[str, Any] | None = None
    run: list[tuple[datetime, int]] = []

    def flush(current: list[tuple[datetime, int]]) -> dict[str, Any] | None:
        if not current:
            return None
        return {
            "hours": len(current) * 0.25,
            "peak_customers": max(c for _, c in current),
            "start": current[0][0],
            "end": current[-1][0],
        }

    prev_ts: datetime | None = None
    for ts, val in ordered:
        if prev_ts is not None and (ts - prev_ts) != timedelta(minutes=15):
            candidate = flush(run)
            if candidate is not None and (best is None or candidate["hours"] > best["hours"]):
                best = candidate
            run = []
        run.append((ts, val))
        prev_ts = ts
    candidate = flush(run)
    if candidate is not None and (best is None or candidate["hours"] > best["hours"]):
        best = candidate
    return best


def july_peak(rows: list[tuple[datetime, int]]) -> tuple[int, datetime] | None:
    """Peak (customers_out, timestamp) among already-July-filtered rows."""
    if not rows:
        return None
    return max(((val, ts) for ts, val in rows), key=lambda pair: pair[0])


def read_total_customers_2024(path: str, fips: str, at: datetime) -> int | None:
    """Diagnostic only (not used for the persisted share — see
    load_beryl_peak): the 2024 file's own total_customers column for
    `fips` at exactly `at` (the row the July peak was read from). For
    Harris County this reveals the real EAGLE-I data anomaly documented
    in the module docstring (customers_out > total_customers during
    Beryl); core.county_customers (EAGLE-I's separate, canonical MCC.csv
    customer count, already loaded by eaglei_mcc.py) is used instead as
    the share denominator, since it never produces a share above 1 for
    either target county. None if the exact row can't be found (never
    guessed)."""
    target = at.strftime("%Y-%m-%d %H:%M:%S")
    with open(path, "rb") as f:
        header = f.readline().decode("utf-8").rstrip("\r\n").split(",")
        idx = {name: i for i, name in enumerate(header)}
        if "total_customers" not in idx:
            return None
        fips_i = idx["fips_code"]
        ts_i = idx["run_start_time"]
        tot_i = idx["total_customers"]
        while True:
            line = f.readline()
            if not line:
                break
            text = line.decode("utf-8").rstrip("\r\n")
            if not text:
                continue
            fields = text.split(",")
            if fields[fips_i] != fips or fields[ts_i] != target:
                continue
            raw = fields[tot_i]
            return int(raw) if raw != "" else None
    return None


# --------------------------------------------------------------------------
# Load core.outage_metrics_county
# --------------------------------------------------------------------------


def _upsert_metric(cur, *, county_fips: str, metric: str, value: Decimal | None,
                    value_null_reason: str | None, unit: str, period: str, source_ids: list[str]) -> None:
    cur.execute(
        """
        insert into core.outage_metrics_county
            (county_fips, metric, value, value_null_reason, unit, period, source_ids)
        values (%s, %s, %s, %s, %s, %s, %s::uuid[])
        on conflict (county_fips, metric) do update
            set value = excluded.value,
                value_null_reason = excluded.value_null_reason,
                unit = excluded.unit,
                period = excluded.period,
                source_ids = excluded.source_ids
        """,
        (county_fips, metric, value, value_null_reason, unit, period, source_ids),
    )


def _epoch(ts: datetime) -> int:
    return int(ts.replace(tzinfo=timezone.utc).timestamp())


def load_longest_event(conn, county_fips: str, event: dict[str, Any] | None, *, source_id: str) -> None:
    period = str(LATEST_YEAR)
    with conn.cursor() as cur:
        if event is None:
            for metric, unit in (
                ("longest_event_hours", "hours"),
                ("longest_event_peak_customers", "customers"),
                ("longest_event_start_epoch", "epoch_seconds_utc"),
                ("longest_event_end_epoch", "epoch_seconds_utc"),
            ):
                _upsert_metric(
                    cur, county_fips=county_fips, metric=metric, value=None,
                    value_null_reason="no_positive_customers_out_rows_in_2025_file",
                    unit=unit, period=period, source_ids=[source_id],
                )
            return
        _upsert_metric(cur, county_fips=county_fips, metric="longest_event_hours",
                        value=Decimal(str(event["hours"])), value_null_reason=None,
                        unit="hours", period=period, source_ids=[source_id])
        _upsert_metric(cur, county_fips=county_fips, metric="longest_event_peak_customers",
                        value=Decimal(event["peak_customers"]), value_null_reason=None,
                        unit="customers", period=period, source_ids=[source_id])
        _upsert_metric(cur, county_fips=county_fips, metric="longest_event_start_epoch",
                        value=Decimal(_epoch(event["start"])), value_null_reason=None,
                        unit="epoch_seconds_utc", period=period, source_ids=[source_id])
        _upsert_metric(cur, county_fips=county_fips, metric="longest_event_end_epoch",
                        value=Decimal(_epoch(event["end"])), value_null_reason=None,
                        unit="epoch_seconds_utc", period=period, source_ids=[source_id])


def read_county_customers(conn, county_fips: str) -> tuple[Decimal | None, str | None]:
    """core.county_customers (EAGLE-I MCC.csv, loaded by eaglei_mcc.py) —
    the canonical customer-count denominator for the Beryl peak share
    (see load_beryl_peak's docstring for why this is used instead of the
    2024 file's own, anomalous total_customers column). Returns
    (customers, source_id) — either may be None if not yet loaded."""
    with conn.cursor() as cur:
        cur.execute(
            "select customers, source_id from core.county_customers where county_fips = %s",
            (county_fips,),
        )
        row = cur.fetchone()
    if row is None:
        return None, None
    customers, source_id = row
    return customers, (str(source_id) if source_id is not None else None)


def load_beryl_peak(conn, county_fips: str, peak: tuple[int, datetime] | None, *,
                     source_id_2024: str, mcc_customers: Decimal | None, mcc_source_id: str | None) -> None:
    """Persists beryl_2024_07_peak_customers (from the 2024 file alone)
    and beryl_2024_07_peak_share (peak / core.county_customers.customers
    — EAGLE-I's own separate MCC.csv customer count, chosen over the 2024
    file's own total_customers column because the latter is unreliable
    during Beryl for Harris County: it reports customers_out above its
    own total_customers for the same rows, a real EAGLE-I data anomaly
    documented in this module's docstring, not corrected here. The share
    row's source_ids therefore names both datasets: the 2024 file
    (numerator) and the eaglei_mcc manifest (denominator)."""
    period = BERYL_MONTH_PREFIX
    with conn.cursor() as cur:
        if peak is None:
            for metric, unit in (
                ("beryl_2024_07_peak_customers", "customers"),
                ("beryl_2024_07_peak_share", "ratio"),
            ):
                _upsert_metric(
                    cur, county_fips=county_fips, metric=metric, value=None,
                    value_null_reason="no_positive_customers_out_rows_in_2024_07_file",
                    unit=unit, period=period, source_ids=[source_id_2024],
                )
            return
        peak_customers, _ts = peak
        _upsert_metric(cur, county_fips=county_fips, metric="beryl_2024_07_peak_customers",
                        value=Decimal(peak_customers), value_null_reason=None,
                        unit="customers", period=period, source_ids=[source_id_2024])
        if mcc_customers is None or mcc_customers == 0 or mcc_source_id is None:
            _upsert_metric(
                cur, county_fips=county_fips, metric="beryl_2024_07_peak_share", value=None,
                value_null_reason="county_customers_not_loaded",
                unit="ratio", period=period, source_ids=[source_id_2024],
            )
        else:
            share = Decimal(peak_customers) / Decimal(mcc_customers)
            _upsert_metric(cur, county_fips=county_fips, metric="beryl_2024_07_peak_share",
                            value=share, value_null_reason=None,
                            unit="ratio", period=period, source_ids=[source_id_2024, mcc_source_id])


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------


def _merge_stats(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
    merged_drops = {name: a["filter_drops"][name] + b["filter_drops"][name] for name in FILTER_NAMES}
    return {"rows_in": a["rows_in"] + b["rows_in"], "filter_drops": merged_drops}


def run(*, runner: Runner, backfill: bool = False, cursor: dict[str, Any] | None = None) -> None:
    fips_set = set(TARGET_COUNTIES)

    manifest_2025 = ensure_manifest_for_file(FILE_2025, URL_2025, runner=runner)
    manifest_2024 = ensure_manifest_for_file(FILE_2024, URL_2024, runner=runner)

    with db.connect(pooled=False) as conn:
        run_id = runs.start(conn, source=SOURCE, runner=runner, cursor=None)

    try:
        series_2025, stats_2025 = scan_counties(manifest_2025["path"], fips_set)
        series_2024_july, stats_2024 = scan_counties(
            manifest_2024["path"], fips_set, month_prefix=BERYL_MONTH_PREFIX
        )
        stats = _merge_stats(stats_2025, stats_2024)

        with db.connect(pooled=False) as conn:
            for fips in TARGET_COUNTIES:
                event = longest_event(series_2025.get(fips, []))
                load_longest_event(conn, fips, event, source_id=manifest_2025["id"])

                peak = july_peak(series_2024_july.get(fips, []))
                mcc_customers, mcc_source_id = read_county_customers(conn, fips)
                load_beryl_peak(
                    conn, fips, peak,
                    source_id_2024=manifest_2024["id"],
                    mcc_customers=mcc_customers, mcc_source_id=mcc_source_id,
                )

        rows_in = stats["rows_in"]
        rows_loaded = rows_in - sum(stats["filter_drops"].values())
        with db.connect(pooled=False) as conn:
            runs.finish(
                conn, run_id, status="success",
                rows_in=rows_in, rows_loaded=rows_loaded, filter_drops=stats["filter_drops"], cursor=None,
            )
    except Exception as exc:
        with db.connect(pooled=False) as conn:
            runs.finish(conn, run_id, status="failed", error=str(exc), cursor=None)
        raise
