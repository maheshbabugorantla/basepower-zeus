"""Regulated vs deregulated electricity market per EIA utility number
(data/manual/retail_market.csv) -> core.retail_market.

Same pattern as pipelines/sources/utility_crosswalk.py: this is a small,
hand-curated, cited source (Base's own basepowercompany.com pages —
llms.txt's power-to-choose utility list, and the Cedar Park rate page
explaining Austin Energy is a municipal, not-deregulated exception).
Per the real-data rule ("Only load data that comes from a raw file with
an ops.source_manifest row"), this module treats that CSV file itself
as the raw file: its bytes are uploaded UNCHANGED to Storage and
recorded in ops.source_manifest with `url` set to the file's GitHub
blob URL (SOURCE_URL below) — never re-derived or re-fetched.

Row mapping is a direct 1:1 copy of the CSV's own columns into
core.retail_market's identically-named columns (the 0206_retail_market.sql
contract), keyed by eia_utility_number — the same EIA-861 utility
number core.mv_home_signals.territory_eia_id carries (via
core.territories.eia_id / core.utility_crosswalk.eia_utility_number), so
downstream lookups are index/PK lookups, never a new spatial join.
"""
from __future__ import annotations

import csv
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pipelines.core import db, fetch, manifest, runs, storage

SOURCE = "retail_market"

# pipelines/sources/retail_market.py -> parents[2] is the repo root
# (sibling of pipelines/, data/, supabase/) -> data/manual/... . This CSV
# is a normally-tracked repo file (not under data/raw/, not Git-LFS), so
# it reads real, current bytes from this worktree directly.
CSV_PATH = Path(__file__).resolve().parents[2] / "data" / "manual" / "retail_market.csv"

SOURCE_URL = (
    "https://github.com/maheshbabugorantla/basepower-zeus/blob/main/"
    "data/manual/retail_market.csv"
)

Runner = Literal["cron", "cli"]

_CSV_COLUMNS = (
    "eia_utility_number", "utility_name", "retail_market", "plain_language",
    "source_url", "quote", "retrieved_at",
)

_VALID_MARKETS = {"deregulated", "not_deregulated"}


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
# verbatim (blank string -> null); the only validation is that
# retail_market is one of the two values core.retail_market's check
# constraint allows -- never a guessed third value.
# ---------------------------------------------------------------------------


def read_records(path: Path | str) -> tuple[int, list[dict[str, Any]]]:
    """Read every data row of the retail-market CSV. Returns (rows_in,
    records); rows_in == len(records) always."""
    with open(path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        missing = [c for c in _CSV_COLUMNS if c not in (reader.fieldnames or [])]
        if missing:
            raise RuntimeError(f"{path} is missing expected column(s): {missing}")
        records: list[dict[str, Any]] = []
        for row in reader:
            eia_utility_number = _clean(row.get("eia_utility_number"))
            retail_market = _clean(row.get("retail_market"))
            if not eia_utility_number:
                raise RuntimeError(f"{path}: row missing eia_utility_number: {row}")
            if retail_market not in _VALID_MARKETS:
                raise RuntimeError(
                    f"{path}: row for eia_utility_number={eia_utility_number} has "
                    f"retail_market={retail_market!r}, expected one of {_VALID_MARKETS}"
                )
            records.append({
                "eia_utility_number": eia_utility_number,
                "utility_name": _clean(row.get("utility_name")),
                "retail_market": retail_market,
                "plain_language": _clean(row.get("plain_language")),
                "source_url": _clean(row.get("source_url")),
                "quote": _clean(row.get("quote")),
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
# Load core.retail_market
# ---------------------------------------------------------------------------


def load_core(conn, manifest_id: str, records: list[dict[str, Any]]) -> int:
    loaded = 0
    with conn.cursor() as cur:
        for r in records:
            cur.execute(
                """
                insert into core.retail_market (
                    eia_utility_number, utility_name, retail_market, plain_language,
                    source_url, quote, retrieved_at, source_id
                ) values (%s, %s, %s, %s, %s, %s, %s, %s)
                on conflict (eia_utility_number) do update set
                    utility_name   = excluded.utility_name,
                    retail_market  = excluded.retail_market,
                    plain_language = excluded.plain_language,
                    source_url     = excluded.source_url,
                    quote          = excluded.quote,
                    retrieved_at   = excluded.retrieved_at,
                    source_id      = excluded.source_id
                """,
                (
                    r["eia_utility_number"], r["utility_name"], r["retail_market"], r["plain_language"],
                    r["source_url"], r["quote"], r["retrieved_at"],
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
