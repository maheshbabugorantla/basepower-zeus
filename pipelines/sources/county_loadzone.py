"""County/utility -> ERCOT load zone crosswalk
(data/manual/county_loadzone.csv, checks/M3-H1.md) -> core.county_loadzone.

Same pattern as pipelines/sources/retail_market.py: this CSV IS the raw
file (a small, hand-curated, cited crosswalk -- Austin Energy -> LZ_AEN,
Travis co-ops (Pedernales, Bluebonnet) -> LZ_LCRA, CenterPoint Houston ->
LZ_HOUSTON, each row citing an ERCOT source URL and retrieval time). Its
bytes are uploaded UNCHANGED to Storage and recorded in
ops.source_manifest with `url` set to the file's GitHub blob URL --
never re-derived or re-fetched.

Row mapping is a direct 1:1 copy of the CSV's own columns into
core.county_loadzone's identically-named columns, keyed by
(county_fips, utility_name).
"""
from __future__ import annotations

import csv
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pipelines.core import db, fetch, manifest, runs, storage

SOURCE = "county_loadzone"

# pipelines/sources/county_loadzone.py -> parents[2] is the repo root.
CSV_PATH = Path(__file__).resolve().parents[2] / "data" / "manual" / "county_loadzone.csv"

SOURCE_URL = (
    "https://github.com/maheshbabugorantla/basepower-zeus/blob/main/"
    "data/manual/county_loadzone.csv"
)

Runner = Literal["cron", "cli"]

_CSV_COLUMNS = (
    "county_fips", "county_name", "utility_name", "ercot_load_zone",
    "settlement_point", "source_url", "retrieved_at", "notes",
)


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    v = value.strip()
    return v or None


def _parse_ts(value: str | None) -> datetime | None:
    v = _clean(value)
    if v is None:
        return None
    return datetime.fromisoformat(v.replace("Z", "+00:00"))


# ---------------------------------------------------------------------------
# CSV parsing: real rows only, every column copied verbatim.
# ---------------------------------------------------------------------------


def read_records(path: Path | str) -> tuple[int, list[dict[str, Any]]]:
    with open(path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        missing = [c for c in _CSV_COLUMNS if c not in (reader.fieldnames or [])]
        if missing:
            raise RuntimeError(f"{path} is missing expected column(s): {missing}")
        records: list[dict[str, Any]] = []
        for row in reader:
            county_fips = _clean(row.get("county_fips"))
            utility_name = _clean(row.get("utility_name"))
            ercot_load_zone = _clean(row.get("ercot_load_zone"))
            settlement_point = _clean(row.get("settlement_point"))
            source_url = _clean(row.get("source_url"))
            retrieved_at = _parse_ts(row.get("retrieved_at"))
            if not county_fips:
                raise RuntimeError(f"{path}: row missing county_fips: {row}")
            if not utility_name:
                raise RuntimeError(f"{path}: row missing utility_name: {row}")
            if not ercot_load_zone:
                raise RuntimeError(f"{path}: row missing ercot_load_zone: {row}")
            if not settlement_point:
                raise RuntimeError(f"{path}: row missing settlement_point: {row}")
            if not source_url:
                raise RuntimeError(f"{path}: row missing source_url: {row}")
            if retrieved_at is None:
                raise RuntimeError(f"{path}: row missing retrieved_at: {row}")
            records.append({
                "county_fips": county_fips,
                "county_name": _clean(row.get("county_name")),
                "utility_name": utility_name,
                "ercot_load_zone": ercot_load_zone,
                "settlement_point": settlement_point,
                "source_url": source_url,
                "retrieved_at": retrieved_at,
                "notes": _clean(row.get("notes")),
            })
    return len(records), records


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------


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
    data = CSV_PATH.read_bytes()
    sha256 = fetch.sha256_of(data)
    size = len(data)

    existing = _existing_manifest(sha256)
    if existing is not None:
        return {"id": existing["id"], "storage_key": existing["storage_key"]}

    when = datetime.now(timezone.utc)
    key = storage.storage_key(SOURCE, sha256, when=when, ext=".csv")
    storage.upload_raw(data, key, content_type="text/csv")

    with db.connect(pooled=False) as conn:
        manifest_id = manifest.insert(
            conn,
            source=SOURCE,
            url=SOURCE_URL,
            retrieved_at=when,
            sha256=sha256,
            bytes_=size,
            rows=None,
            runner=runner,
            storage_key=key,
        )
    return {"id": manifest_id, "storage_key": key}


def _set_manifest_rows(manifest_id: str, rows: int) -> None:
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute("update ops.source_manifest set rows = %s where id = %s", (rows, manifest_id))


# ---------------------------------------------------------------------------
# Load core.county_loadzone
# ---------------------------------------------------------------------------


def load_core(conn, manifest_id: str, records: list[dict[str, Any]]) -> int:
    loaded = 0
    with conn.cursor() as cur:
        for r in records:
            cur.execute(
                """
                insert into core.county_loadzone (
                    county_fips, county_name, utility_name, ercot_load_zone,
                    settlement_point, source_url, retrieved_at, notes, source_id
                ) values (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                on conflict (county_fips, utility_name) do update set
                    county_name      = excluded.county_name,
                    ercot_load_zone  = excluded.ercot_load_zone,
                    settlement_point = excluded.settlement_point,
                    source_url       = excluded.source_url,
                    retrieved_at     = excluded.retrieved_at,
                    notes            = excluded.notes,
                    source_id        = excluded.source_id
                """,
                (
                    r["county_fips"], r["county_name"], r["utility_name"], r["ercot_load_zone"],
                    r["settlement_point"], r["source_url"], r["retrieved_at"], r["notes"],
                    manifest_id,
                ),
            )
            loaded += 1
    return loaded


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def run(*, runner: Runner, backfill: bool = False, cursor: dict[str, Any] | None = None) -> None:
    manifest_row = _ensure_manifest(runner)
    manifest_id = manifest_row["id"]

    with db.connect(pooled=False) as conn:
        run_id = runs.start(conn, source=SOURCE, runner=runner, cursor=None)
        with conn.cursor() as cur:
            cur.execute("update ops.pipeline_runs set manifest_id = %s where id = %s", (manifest_id, run_id))

    try:
        rows_in, records = read_records(CSV_PATH)

        with db.connect(pooled=False) as conn:
            loaded = load_core(conn, manifest_id, records)

        _set_manifest_rows(manifest_id, rows_in)
        with db.connect(pooled=False) as conn:
            runs.finish(
                conn, run_id, status="success",
                rows_in=rows_in, rows_loaded=loaded, filter_drops={}, cursor=None,
            )
    except Exception as exc:
        with db.connect(pooled=False) as conn:
            runs.finish(conn, run_id, status="failed", error=str(exc), cursor=None)
        raise
