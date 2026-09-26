"""EAGLE-I outages source: Texas rows -> core.outage_county_year.

Formula (customer-hours without power per county-year): EAGLE-I is a
15-minute snapshot feed. Each row's `customers_out` is the count of
customers without power at that snapshot, held constant to represent the
following 0.25 h interval. Summing `customers_out * 0.25` across every
15-minute snapshot for a county-year gives that county-year's total
customer-hours without power:

    customer_hours_out = sum(customers_out for every 15-min snapshot) * 0.25
                        = Decimal(sum_int) / Decimal(4)   (exact, no floats)

Source file: figshare article 24237376 v4, one CSV per year. This module
covers the 2025 file (2025 is the latest published year; no 2026 file
exists yet):

    https://ndownloader.figshare.com/files/62164877   (eaglei_outages_2025.csv)

Fetch: `run()` fetches this URL fresh over the network by default (the
cron / fresh-run path — streamed to a temp file, sha256 computed on the
fly, never loaded into memory at once). For the 2025 backfill the file
was already downloaded once into the main checkout; set env var
EAGLEI_LOCAL_FILE to that path to reuse it instead of re-downloading 1.4
GB (its sha256 is still computed and used exactly as if freshly fetched
— the manifest `url` is always the figshare URL regardless of which path
supplied the bytes).

Storage: the raw file is uploaded UNCHANGED to bucket `raw`, keyed
`eaglei/<date>/<sha256>.csv`. core/storage.upload_raw() loads its `content`
argument into memory, which can't hold a 1.4 GB file, so this module
uploads via Supabase Storage's TUS-compatible resumable-upload endpoint
directly (6 MiB PATCH chunks) instead. After upload, the object is
streamed back and re-hashed to verify byte-for-byte fidelity before the
manifest row is written.

Cannot run on Vercel Hobby: a 1.4 GB upload/parse cannot fit the 300 s
function limit or the small /tmp on that plan. Only the CLI path
(`runner="cli"`, via `python -m pipelines.run eaglei --backfill`) is
exercised for the 2025 backfill; the cron route exists for contract
completeness (a future year's smaller file, or a bigger Vercel plan).

Aggregation: streamed line-by-line in binary mode (never loaded into
memory), Texas rows only (`state == 'Texas'`), grouped by
(county fips, year parsed from `run_start_time`). The file has no quoted
fields (verified: zero `"` characters), so a byte offset always lands on
a line boundary — this backs the resumable cursor stored in
`ops.pipeline_runs.cursor`: {byte_offset, header, rows_in, filter_drops,
sums, counts}. If `backfill=True` and no `cursor` is passed, `run()`
looks up the latest non-success eaglei run with the same sha256 and
resumes from its cursor instead of rescanning from byte 0.

Never zero-fills: a Texas county absent from the file simply gets no
core.outage_county_year row (for 2025, all 254 Texas counties are
present, so this path is untested against real absence, but the load
loop makes no assumption that every county appears).
"""
from __future__ import annotations

import base64
import hashlib
import os
import tempfile
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Literal

import httpx

from pipelines.core import config, db, manifest, runs, storage

SOURCE = "eaglei"
SOURCE_YEAR = 2025
FIGSHARE_URL = "https://ndownloader.figshare.com/files/62164877"
LOCAL_FILE_ENV = "EAGLEI_LOCAL_FILE"

TUS_CHUNK_BYTES = 6 * 1024 * 1024  # Supabase's documented resumable-upload chunk size
CHECKPOINT_BYTES = 200 * 1024 * 1024  # persist cursor roughly every 200 MB scanned

FILTER_NAMES = ("non_texas", "missing_customers_out", "unparseable_customers_out")

Runner = Literal["cron", "cli"]


# --------------------------------------------------------------------------
# Obtain the raw file (network fetch, or a pre-downloaded local file)
# --------------------------------------------------------------------------


def _sha256_of_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _obtain_file() -> tuple[str, str, int]:
    """Return (path, sha256, bytes) of the raw 2025 EAGLE-I CSV."""
    local = os.environ.get(LOCAL_FILE_ENV)
    if local and os.path.isfile(local):
        return local, _sha256_of_file(local), os.path.getsize(local)

    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".csv")
    os.close(tmp_fd)
    digest = hashlib.sha256()
    size = 0
    with httpx.Client(timeout=600.0, follow_redirects=True) as client:
        with client.stream("GET", FIGSHARE_URL) as resp:
            resp.raise_for_status()
            with open(tmp_path, "wb") as out:
                for chunk in resp.iter_bytes(chunk_size=1024 * 1024):
                    out.write(chunk)
                    digest.update(chunk)
                    size += len(chunk)
    return tmp_path, digest.hexdigest(), size


# --------------------------------------------------------------------------
# TUS resumable upload to Supabase Storage (bypasses core/storage.upload_raw,
# which loads its `content` argument into memory)
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


def _tus_offset(location: str, service_key: str) -> int:
    resp = httpx.head(
        location,
        headers={"Authorization": f"Bearer {service_key}", "apikey": service_key, "Tus-Resumable": "1.0.0"},
        timeout=30.0,
    )
    resp.raise_for_status()
    return int(resp.headers["upload-offset"])


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


def _verify_uploaded_sha256(*, base_url: str, service_key: str, bucket: str, object_name: str) -> str:
    url = f"{base_url}/storage/v1/object/{bucket}/{object_name}"
    digest = hashlib.sha256()
    with httpx.Client(timeout=300.0) as client:
        with client.stream(
            "GET", url, headers={"Authorization": f"Bearer {service_key}", "apikey": service_key}
        ) as resp:
            resp.raise_for_status()
            for chunk in resp.iter_bytes(chunk_size=1024 * 1024):
                digest.update(chunk)
    return digest.hexdigest()


# --------------------------------------------------------------------------
# Manifest: reuse an existing row for the same (source, sha256); otherwise
# upload + insert.
# --------------------------------------------------------------------------


def _existing_manifest(sha256: str) -> dict[str, Any] | None:
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select id, storage_key from ops.source_manifest "
                "where source = %s and sha256 = %s order by retrieved_at desc limit 1",
                (SOURCE, sha256),
            )
            row = cur.fetchone()
    if row is None:
        return None
    return {"id": str(row[0]), "storage_key": row[1]}


def _ensure_manifest(runner: Runner) -> dict[str, Any]:
    path, sha256, size = _obtain_file()

    existing = _existing_manifest(sha256)
    if existing is not None:
        return {"id": existing["id"], "storage_key": existing["storage_key"], "path": path, "sha256": sha256, "bytes": size}

    base_url = config.supabase_url()
    service_key = config.supabase_secret_key()
    retrieved_at = datetime.now(timezone.utc)
    key = storage.storage_key(SOURCE, sha256, when=retrieved_at, ext=".csv")

    _tus_upload_file(path, base_url=base_url, service_key=service_key, bucket=config.RAW_BUCKET, object_name=key)

    verified_sha256 = _verify_uploaded_sha256(
        base_url=base_url, service_key=service_key, bucket=config.RAW_BUCKET, object_name=key
    )
    if verified_sha256 != sha256:
        raise RuntimeError(
            f"uploaded object sha256 mismatch for {key}: expected {sha256}, got {verified_sha256}"
        )

    with db.connect(pooled=False) as conn:
        manifest_id = manifest.insert(
            conn,
            source=SOURCE,
            url=FIGSHARE_URL,
            retrieved_at=retrieved_at,
            sha256=sha256,
            bytes_=size,
            rows=None,
            runner=runner,
            storage_key=key,
        )
    return {"id": manifest_id, "storage_key": key, "path": path, "sha256": sha256, "bytes": size}


def _set_manifest_rows(manifest_id: str, rows: int) -> None:
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute("update ops.source_manifest set rows = %s where id = %s", (rows, manifest_id))


# --------------------------------------------------------------------------
# Streamed aggregation over the raw CSV (never loaded into memory at once)
# --------------------------------------------------------------------------


def new_state() -> dict[str, Any]:
    return {
        "byte_offset": 0,
        "header": None,
        "rows_in": 0,
        "filter_drops": {name: 0 for name in FILTER_NAMES},
        "sums": {},
        "counts": {},
    }


def aggregate(path: str, *, state: dict[str, Any] | None = None, on_checkpoint=None) -> dict[str, Any]:
    """Stream `path`, keep Texas rows, sum customers_out by fips|year.
    Resumes from `state["byte_offset"]` if given (must be a line
    boundary — guaranteed here since the file has no quoted fields).
    Mutates and returns `state`.
    """
    state = state or new_state()
    with open(path, "rb") as f:
        if state["byte_offset"] == 0:
            header_line = f.readline()
            state["header"] = header_line.decode("utf-8").rstrip("\r\n").split(",")
            state["byte_offset"] = f.tell()
        else:
            f.seek(state["byte_offset"])

        header = state["header"]
        idx = {name: i for i, name in enumerate(header)}
        fips_i = idx["fips_code"]
        state_i = idx["state"]
        cust_i = idx["customers_out"]
        ts_i = idx["run_start_time"]

        last_checkpoint = state["byte_offset"]
        while True:
            line = f.readline()
            if not line:
                break
            pos = f.tell()
            text = line.decode("utf-8").rstrip("\r\n")
            if not text:
                state["byte_offset"] = pos
                continue

            fields = text.split(",")
            state["rows_in"] += 1

            if fields[state_i] != "Texas":
                state["filter_drops"]["non_texas"] += 1
                state["byte_offset"] = pos
                continue

            raw_val = fields[cust_i]
            if raw_val == "":
                state["filter_drops"]["missing_customers_out"] += 1
                state["byte_offset"] = pos
                continue
            try:
                val = int(raw_val)
            except ValueError:
                state["filter_drops"]["unparseable_customers_out"] += 1
                state["byte_offset"] = pos
                continue

            year = fields[ts_i][:4]
            key = f"{fields[fips_i]}|{year}"
            state["sums"][key] = state["sums"].get(key, 0) + val
            state["counts"][key] = state["counts"].get(key, 0) + 1
            state["byte_offset"] = pos

            if on_checkpoint is not None and (pos - last_checkpoint) >= CHECKPOINT_BYTES:
                on_checkpoint(state)
                last_checkpoint = pos

    return state


def rows_loaded(state: dict[str, Any]) -> int:
    """rows_in minus every filter-drop bucket: input rows that passed
    every filter and were aggregated (not the ~254 output county-year
    rows)."""
    return state["rows_in"] - sum(state["filter_drops"].values())


# --------------------------------------------------------------------------
# Load core.outage_county_year
# --------------------------------------------------------------------------


def load_core(conn, manifest_id: str, sums: dict[str, int], *, year: int = SOURCE_YEAR) -> int:
    loaded = 0
    with conn.cursor() as cur:
        for key, total in sums.items():
            fips, year_str = key.split("|")
            if int(year_str) != year:
                continue
            hours = Decimal(total) / Decimal(4)
            cur.execute(
                """
                insert into core.outage_county_year
                    (county_fips, year, customer_hours_out, source_ids, customer_hours_out_null_reason)
                values (%s, %s, %s, %s::uuid[], null)
                on conflict (county_fips, year) do update
                    set customer_hours_out = excluded.customer_hours_out,
                        source_ids = excluded.source_ids,
                        customer_hours_out_null_reason = null
                """,
                (fips, year, hours, [manifest_id]),
            )
            loaded += 1
    return loaded


# --------------------------------------------------------------------------
# Resumable cursor lookup
# --------------------------------------------------------------------------


def _find_resumable_cursor(sha256: str) -> dict[str, Any] | None:
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select pr.cursor
                from ops.pipeline_runs pr
                join ops.source_manifest sm on sm.id = pr.manifest_id
                where pr.source = %s and pr.status != 'success' and sm.sha256 = %s
                order by pr.started_at desc
                limit 1
                """,
                (SOURCE, sha256),
            )
            row = cur.fetchone()
    if row is None or row[0] is None:
        return None
    return row[0]


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------


def run(*, runner: Runner, backfill: bool = False, cursor: dict[str, Any] | None = None) -> None:
    manifest_row = _ensure_manifest(runner)
    manifest_id = manifest_row["id"]

    resumed_state = cursor
    if resumed_state is None and backfill:
        resumed_state = _find_resumable_cursor(manifest_row["sha256"])

    with db.connect(pooled=False) as conn:
        run_id = runs.start(conn, source=SOURCE, runner=runner, cursor=resumed_state)
        with conn.cursor() as cur:
            cur.execute("update ops.pipeline_runs set manifest_id = %s where id = %s", (manifest_id, run_id))

    def checkpoint(state: dict[str, Any]) -> None:
        with db.connect(pooled=False) as c:
            runs.finish(
                c, run_id, status="running",
                rows_in=state["rows_in"], rows_loaded=rows_loaded(state),
                filter_drops=state["filter_drops"], cursor=state,
            )

    try:
        state = aggregate(manifest_row["path"], state=resumed_state, on_checkpoint=checkpoint)
        with db.connect(pooled=False) as conn:
            load_core(conn, manifest_id, state["sums"], year=SOURCE_YEAR)
        _set_manifest_rows(manifest_id, state["rows_in"])
        with db.connect(pooled=False) as conn:
            runs.finish(
                conn, run_id, status="success",
                rows_in=state["rows_in"], rows_loaded=rows_loaded(state),
                filter_drops=state["filter_drops"], cursor=state,
            )
    except Exception as exc:
        with db.connect(pooled=False) as conn:
            runs.finish(conn, run_id, status="failed", error=str(exc), cursor=resumed_state)
        raise
