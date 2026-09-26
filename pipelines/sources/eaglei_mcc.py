"""EAGLE-I MCC.csv (figshare file 42547708) -> core.county_customers.

Source file: staged unchanged in the MAIN checkout at
data/raw/eaglei_mcc/MCC.csv (read-only; this module never downloads it —
see agent_preamble.md's raw-data convention). Its sidecars
(SOURCE_URL.txt/retrieved_at.txt/SHA256SUMS) are the source of truth for
the real URL, retrieval time, and expected sha256 (cross-checked against
the bytes actually read, never trusted blindly):

    https://ndownloader.figshare.com/files/42547708

Format: two columns, County_FIPS,Customers (no state column — every US
county in one file). The header carries a UTF-8 BOM (`﻿County_FIPS`),
read with utf-8-sig so it never breaks the header match. County_FIPS is
zero-padded to 5 digits (a handful of counties, e.g. Alabama's 1001, are
written as 4-digit numbers with the leading state-FIPS zero dropped);
Texas rows are exactly the ones whose zero-padded fips starts with '48'
(all 254 Texas counties are present, verified by inspection, e.g. Travis
48453 = 641,926 customers).

Never zero-fills: every Texas county row present in the file is loaded
as-is (a real customer count is never anything but a real positive
number here); rows_loaded == rows_in - non_texas for every run, checked
by `python -m pipelines.check reconcile --source eaglei_mcc`.
"""
from __future__ import annotations

import csv
from datetime import datetime
from typing import Any, Literal

from pipelines.core import db, fetch, manifest, runs, storage

SOURCE = "eaglei_mcc"

RAW_DIR = (
    "/Users/maheshbabugorantla/Code/Hackathons/BasePower_Deep_Tech_Hackathon_Sep_25_2026_Mavericks"
    "/data/raw/eaglei_mcc"
)
CSV_FILENAME = "MCC.csv"
FIGSHARE_URL = "https://ndownloader.figshare.com/files/42547708"

TEXAS_FIPS_PREFIX = "48"

Runner = Literal["cron", "cli"]


# --------------------------------------------------------------------------
# Sidecars (retrieved_at.txt, SHA256SUMS) — cross-checked, never trusted
# blindly
# --------------------------------------------------------------------------


def _read_retrieved_at() -> datetime:
    with open(f"{RAW_DIR}/retrieved_at.txt", "r", encoding="utf-8") as f:
        text = f.read().strip()
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


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


def _obtain_bytes() -> bytes:
    with open(f"{RAW_DIR}/{CSV_FILENAME}", "rb") as f:
        return f.read()


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
    data = _obtain_bytes()
    sha256 = fetch.sha256_of(data)

    expected = _read_sha256sums().get(CSV_FILENAME)
    if expected is not None and expected != sha256:
        raise RuntimeError(
            f"{CSV_FILENAME}: sha256 mismatch against SHA256SUMS "
            f"(sidecar={expected}, computed={sha256})"
        )

    existing = _existing_manifest(sha256)
    if existing is not None:
        return {"id": existing["id"], "storage_key": existing["storage_key"], "data": data}

    retrieved_at = _read_retrieved_at()
    key = storage.storage_key(SOURCE, sha256, when=retrieved_at, ext=".csv")
    storage.upload_raw(data, key, content_type="text/csv")

    with db.connect(pooled=False) as conn:
        manifest_id = manifest.insert(
            conn,
            source=SOURCE,
            url=FIGSHARE_URL,
            retrieved_at=retrieved_at,
            sha256=sha256,
            bytes_=len(data),
            rows=None,
            runner=runner,
            storage_key=key,
        )
    return {"id": manifest_id, "storage_key": key, "data": data}


def _set_manifest_rows(manifest_id: str, rows: int) -> None:
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute("update ops.source_manifest set rows = %s where id = %s", (rows, manifest_id))


# --------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------


def parse_texas_rows(text: str) -> tuple[list[tuple[str, str]], int, int]:
    """Returns (texas_rows [(county_fips, customers_raw), ...], rows_in,
    non_texas_count). county_fips is zero-padded to 5 digits."""
    reader = csv.DictReader(text.splitlines())
    rows_in = 0
    non_texas = 0
    texas_rows: list[tuple[str, str]] = []
    for record in reader:
        rows_in += 1
        raw_fips = (record.get("County_FIPS") or "").strip()
        fips = raw_fips.zfill(5)
        if not fips.startswith(TEXAS_FIPS_PREFIX):
            non_texas += 1
            continue
        customers_raw = (record.get("Customers") or "").strip()
        texas_rows.append((fips, customers_raw))
    return texas_rows, rows_in, non_texas


# --------------------------------------------------------------------------
# Load core.county_customers
# --------------------------------------------------------------------------


def load_core(conn, manifest_id: str, texas_rows: list[tuple[str, str]]) -> int:
    loaded = 0
    with conn.cursor() as cur:
        for fips, customers_raw in texas_rows:
            cur.execute(
                """
                insert into core.county_customers (county_fips, customers, source_id)
                values (%s, %s, %s)
                on conflict (county_fips) do update
                    set customers = excluded.customers,
                        source_id = excluded.source_id
                """,
                (fips, customers_raw, manifest_id),
            )
            loaded += 1
    return loaded


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------


def run(*, runner: Runner, backfill: bool = False, cursor: dict[str, Any] | None = None) -> None:
    manifest_row = _ensure_manifest(runner)
    manifest_id = manifest_row["id"]

    with db.connect(pooled=False) as conn:
        run_id = runs.start(conn, source=SOURCE, runner=runner, cursor=None)
        with conn.cursor() as cur:
            cur.execute("update ops.pipeline_runs set manifest_id = %s where id = %s", (manifest_id, run_id))

    try:
        text = manifest_row["data"].decode("utf-8-sig")
        texas_rows, rows_in, non_texas = parse_texas_rows(text)

        with db.connect(pooled=False) as conn:
            loaded = load_core(conn, manifest_id, texas_rows)

        _set_manifest_rows(manifest_id, rows_in)
        filter_drops = {"non_texas": non_texas}
        with db.connect(pooled=False) as conn:
            runs.finish(
                conn, run_id, status="success",
                rows_in=rows_in, rows_loaded=loaded, filter_drops=filter_drops, cursor=None,
            )
    except Exception as exc:
        with db.connect(pooled=False) as conn:
            runs.finish(conn, run_id, status="failed", error=str(exc), cursor=None)
        raise
