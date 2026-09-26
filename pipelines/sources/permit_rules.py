"""Small, hand-curated, cited permitting rules
(data/manual/permit_rules.csv) -> core.permit_rules.

Same pattern as pipelines/sources/retail_market.py: Texas SB 1252
(effective 2025-09-01, bars municipalities from regulating installation/
inspection of residential energy backup systems <=50 kW / <=100 kWh,
except municipally owned utilities within their own service area --
TDLR's news release + the enrolled bill text on capitol.texas.gov),
Austin Energy's Auxiliary Power Electrical Permit requirement for ESS,
and unincorporated Travis County's fire-code ESS standard (both reusing
the citations already fetched into data/manual/ahj_facts.csv).

Per the real-data rule ("Only load data that comes from a raw file with
an ops.source_manifest row"), this module treats the CSV file itself as
the raw file: its bytes are uploaded UNCHANGED to Storage and recorded
in ops.source_manifest with `url` set to the file's GitHub blob URL
(SOURCE_URL below) -- never re-derived or re-fetched.
"""
from __future__ import annotations

import csv
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pipelines.core import db, fetch, manifest, runs, storage

SOURCE = "permit_rules"

# pipelines/sources/permit_rules.py -> parents[2] is the repo root
# (sibling of pipelines/, data/, supabase/) -> data/manual/... . This CSV
# is a normally-tracked repo file (not under data/raw/, not Git-LFS), so
# it reads real, current bytes from this worktree directly.
CSV_PATH = Path(__file__).resolve().parents[2] / "data" / "manual" / "permit_rules.csv"

SOURCE_URL = (
    "https://github.com/maheshbabugorantla/basepower-zeus/blob/main/"
    "data/manual/permit_rules.csv"
)

Runner = Literal["cron", "cli"]

_CSV_COLUMNS = ("authority", "rule", "value", "source_url", "retrieved_at", "quote")


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
# CSV parsing: real rows only, no synthesis. Every column is copied
# verbatim (blank string -> null); authority/rule/value/source_url/quote
# are required (never a placeholder if missing -- raise instead).
# ---------------------------------------------------------------------------


def read_records(path: Path | str) -> tuple[int, list[dict[str, Any]]]:
    """Read every data row of the permit-rules CSV. Returns (rows_in,
    records); rows_in == len(records) always."""
    with open(path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        missing = [c for c in _CSV_COLUMNS if c not in (reader.fieldnames or [])]
        if missing:
            raise RuntimeError(f"{path} is missing expected column(s): {missing}")
        records: list[dict[str, Any]] = []
        for row in reader:
            authority = _clean(row.get("authority"))
            rule = _clean(row.get("rule"))
            value = _clean(row.get("value"))
            source_url = _clean(row.get("source_url"))
            quote = _clean(row.get("quote"))
            if not authority or not rule:
                raise RuntimeError(f"{path}: row missing authority/rule: {row}")
            if not value or not source_url or not quote:
                raise RuntimeError(
                    f"{path}: row for authority={authority!r} rule={rule!r} is missing "
                    "value/source_url/quote -- never substitute a placeholder"
                )
            records.append({
                "authority": authority,
                "rule": rule,
                "value": value,
                "source_url": source_url,
                "quote": quote,
                "retrieved_at": _parse_ts(row.get("retrieved_at")),
            })
    return len(records), records


# ---------------------------------------------------------------------------
# Manifest (reuse an existing row for the same sha256; else upload + insert)
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
# Load core.permit_rules
# ---------------------------------------------------------------------------


def load_core(conn, manifest_id: str, records: list[dict[str, Any]]) -> int:
    loaded = 0
    with conn.cursor() as cur:
        for r in records:
            cur.execute(
                """
                insert into core.permit_rules (
                    authority, rule, value, source_url, quote, retrieved_at, source_id
                ) values (%s, %s, %s, %s, %s, %s, %s)
                on conflict (authority, rule) do update set
                    value        = excluded.value,
                    source_url   = excluded.source_url,
                    quote        = excluded.quote,
                    retrieved_at = excluded.retrieved_at,
                    source_id    = excluded.source_id
                """,
                (
                    r["authority"], r["rule"], r["value"], r["source_url"], r["quote"],
                    r["retrieved_at"], manifest_id,
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
