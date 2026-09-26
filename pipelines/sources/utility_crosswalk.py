"""Base <-> HIFLD territory <-> EIA-861 utility crosswalk
(data/manual/utility_crosswalk.csv, checks/M2-H1.md) -> core.utility_crosswalk.

This is a manual, hand-curated, cited source: `checks/M2-H1.md` already
did the research (Base's pricing.md utility list vs. the HIFLD territory
mirror vs. EIA-861), and its output IS `data/manual/utility_crosswalk.csv`
-- committed to the repo, not downloaded. Per
scratchpad/m2_pipeline_brief.md / agent_preamble.md's real-data rule
("Only load data that comes from a raw file with an
ops.source_manifest row"), this module treats that CSV file itself as
the raw file: its bytes are uploaded UNCHANGED to Storage and recorded
in ops.source_manifest with `url` set to the file's GitHub blob URL
(SOURCE_URL below) -- never re-derived or re-fetched from anywhere else.

Row mapping is a direct 1:1 copy of the CSV's own columns into
core.utility_crosswalk's identically-named columns (the 0201_m2.sql
contract) -- no parsing beyond stripping blank strings to null and
parsing the two ISO-8601 timestamp columns. Mapped rows (mapped='yes')
keep their real `eia_utility_number`; unmapped rows (mapped='no': AEP
Texas Central, AEP Texas North, CoServ) keep `eia_utility_number = null`
plus their `note` explaining why -- never guessed, per checks/M2-H1.md.

The join to core.territories and the fail-closed gate itself live in
core.mv_home_signals (0201_m2.sql, refreshed by
core.refresh_all_scores() -- NOT run by this module, per the brief: "Do
NOT run refresh_all_scores() yourself"). Once both core.territories
(M2-P1) and core.utility_crosswalk (this module) hold rows, that
materialized view's `gate` CTE goes fail-closed: a home whose parcel
centroid falls inside a HIFLD territory this crosswalk does not mark
mapped='yes' (e.g. Travis County's Pedernales Electric Co-op 14626 or
Bluebonnet Electric Co-op 1892, neither on Base's list) gets
gate_reason = 'territory_not_base_served'.
"""
from __future__ import annotations

import csv
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pipelines.core import db, fetch, manifest, runs, storage

SOURCE = "utility_crosswalk"

# pipelines/sources/utility_crosswalk.py -> parents[2] is the repo root
# (sibling of pipelines/, data/, supabase/) -> data/manual/... . This CSV
# is a normally-tracked repo file (not under data/raw/, not Git-LFS), so
# it reads real, current bytes from this worktree directly -- no need
# for the MAIN-checkout-absolute-path convention that data/raw/* sources
# use to dodge LFS smudge-skipping.
CSV_PATH = Path(__file__).resolve().parents[2] / "data" / "manual" / "utility_crosswalk.csv"

SOURCE_URL = (
    "https://github.com/maheshbabugorantla/basepower-zeus/blob/main/"
    "data/manual/utility_crosswalk.csv"
)

Runner = Literal["cron", "cli"]

_CSV_COLUMNS = (
    "base_name", "eia_utility_number", "polygon_name", "state", "mapped",
    "note", "base_source_url", "base_retrieved_at", "polygon_source_url",
    "polygon_retrieved_at",
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
# CSV parsing: real rows only, no synthesis. Every column is copied
# verbatim (blank string -> null); nothing is inferred or guessed here --
# the crosswalk's own hand-research already lives in the CSV
# (checks/M2-H1.md).
# ---------------------------------------------------------------------------


def read_records(path: Path | str) -> tuple[int, list[dict[str, Any]]]:
    """Read every data row of the crosswalk CSV. Returns (rows_in,
    records); rows_in == len(records) always -- there is no filtering
    here, every row (mapped or not) is loaded, per checks/M2-H1.md."""
    with open(path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        missing = [c for c in _CSV_COLUMNS if c not in (reader.fieldnames or [])]
        if missing:
            raise RuntimeError(f"{path} is missing expected column(s): {missing}")
        records: list[dict[str, Any]] = []
        for row in reader:
            records.append({
                "base_name": _clean(row.get("base_name")),
                "eia_utility_number": _clean(row.get("eia_utility_number")),
                "polygon_name": _clean(row.get("polygon_name")),
                "state": _clean(row.get("state")),
                "mapped": _clean(row.get("mapped")),
                "note": _clean(row.get("note")),
                "base_source_url": _clean(row.get("base_source_url")),
                "base_retrieved_at": _parse_ts(row.get("base_retrieved_at")),
                "polygon_source_url": _clean(row.get("polygon_source_url")),
                "polygon_retrieved_at": _parse_ts(row.get("polygon_retrieved_at")),
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
# Load core.utility_crosswalk
# ---------------------------------------------------------------------------


def load_core(conn, manifest_id: str, records: list[dict[str, Any]]) -> int:
    loaded = 0
    with conn.cursor() as cur:
        for r in records:
            cur.execute(
                """
                insert into core.utility_crosswalk (
                    base_name, eia_utility_number, polygon_name, state, mapped, note,
                    base_source_url, base_retrieved_at, polygon_source_url, polygon_retrieved_at,
                    source_id
                ) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                on conflict (base_name) do update set
                    eia_utility_number  = excluded.eia_utility_number,
                    polygon_name        = excluded.polygon_name,
                    state               = excluded.state,
                    mapped              = excluded.mapped,
                    note                = excluded.note,
                    base_source_url     = excluded.base_source_url,
                    base_retrieved_at   = excluded.base_retrieved_at,
                    polygon_source_url  = excluded.polygon_source_url,
                    polygon_retrieved_at= excluded.polygon_retrieved_at,
                    source_id           = excluded.source_id
                """,
                (
                    r["base_name"], r["eia_utility_number"], r["polygon_name"], r["state"], r["mapped"], r["note"],
                    r["base_source_url"], r["base_retrieved_at"], r["polygon_source_url"], r["polygon_retrieved_at"],
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
