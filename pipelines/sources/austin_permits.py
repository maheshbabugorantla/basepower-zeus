"""Austin Issued Construction Permits (Socrata 3syk-w9eu) -> core.permits,
plus a rules-based backup-intent classifier -> core.permit_labels, plus a
deterministic 100-permit sample -> ops.label_queue for M1-H1.

Source: https://data.austintexas.gov/resource/3syk-w9eu.json, no API key.
Window: last 36 months by issue_date, paged with $limit=50000&$offset=N,
ordered by $order=permit_number so the same query always returns rows in
the same order (required for the raw file to be reproducible byte-for-
byte given the same underlying data).

Raw file: every page's records are written UNCHANGED, in page order, one
JSON object per line (JSON-lines), to
    data/raw/austin_permits/austin_permits_<YYYYMMDD>.jsonl
(the absolute path from the ticket, in the MAIN checkout, never git-added
by this module — see AGENTS/CLAUDE.md's real-data rule). Sidecar files in
the same directory: retrieved_at.txt, SOURCE_URL.txt (the exact query,
minus the paging $offset which increments per page), and SHA256SUMS.

Rules classifier: RULES below is a small, reviewable dict-of-lists (one
row per label, a handful of keywords each) matched case-insensitively
with word boundaries against `description + work_class + permit_type_desc`.
A permit may match several labels; the first matching keyword per label
is stored as that label's rationale. This is intentionally simple (no
ML) — a keyword table an M1-P3 reviewer (P2) can read top to bottom.

Sampling: ops.label_queue is filled exactly once (skipped if it already
holds rows) with 100 permits, deterministically ordered by md5(permit_number)
(no `random` module, per the real-data rule and no_mock_check.py's ban on
random in pipeline code): up to 50 from permits the rules classifier
labelled battery/generator, and the rest from every other permit in the
same 36-month window, so M1-H1 sees a mix skewed toward true positives.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Literal

import httpx

from pipelines.core import config, db, manifest, runs, storage

# supabase-py 2.15.1's Client rejects the newer `sb_secret_`-format service
# key (it expects a legacy three-segment JWT), so storage.upload_raw's
# supabase-py client can't be used here. Upload directly via the Storage
# REST API instead (same approach as scripts/no_mock_check.py's cousin,
# pipelines/pipelines/check.py, uses for downloads).

SOURCE = "austin_permits"
SOCRATA_DATASET = "3syk-w9eu"
SOCRATA_BASE_URL = f"https://data.austintexas.gov/resource/{SOCRATA_DATASET}.json"
PAGE_LIMIT = 50_000
WINDOW_MONTHS = 36

RAW_DIR = Path(
    "/Users/maheshbabugorantla/Code/Hackathons/BasePower_Deep_Tech_Hackathon_Sep_25_2026_Mavericks"
    "/data/raw/austin_permits"
)

LABEL_QUEUE_SIZE = 100
LABEL_QUEUE_POSITIVE_LABELS = ("battery", "generator")
LABEL_QUEUE_POSITIVE_TARGET = 50

Runner = Literal["cron", "cli"]

# ---------------------------------------------------------------------------
# Rules classifier keyword table (checks/no_mock_check.py allows a dict of
# lists here — it only flags literal List/Tuple-of-record arrays, and this
# is a dict whose values are plain string lists). Each entry is a handful
# of keywords, reviewed top to bottom by P2.
# ---------------------------------------------------------------------------

RULES: dict[str, list[str]] = {
    "battery":   ["battery", "energy storage", "ess", "powerwall"],
    "generator": ["standby generator", "generac", "generator"],
    "solar":     ["photovoltaic", "solar pv", "solar"],
    "panel":     ["service upgrade", "panel change", "panel upgrade", "meter"],
    "ev":        ["ev charger", "electric vehicle", "ev charging"],
}


def classify_text(text: str) -> list[tuple[str, str]]:
    """Return [(label, matched_keyword), ...] for every RULES label whose
    keyword list has at least one case-insensitive, word-bounded match in
    `text`. At most one (first) matching keyword per label is returned."""
    lowered = (text or "").lower()
    matches: list[tuple[str, str]] = []
    for label, keywords in RULES.items():
        for kw in keywords:
            if re.search(r"\b" + re.escape(kw) + r"\b", lowered):
                matches.append((label, kw))
                break
    return matches


# ---------------------------------------------------------------------------
# Field mapping: Socrata record -> core.permits columns
# ---------------------------------------------------------------------------

def _clean_str(value: Any) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    return s or None


def _parse_date(value: Any) -> date | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).date()
    except ValueError:
        return None


def _parse_numeric(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def record_to_permit_row(record: dict[str, Any]) -> dict[str, Any] | None:
    """Map one raw Socrata record to a core.permits row dict, or None if
    it has no permit_number (the primary key — never invented)."""
    permit_number = _clean_str(record.get("permit_number"))
    if permit_number is None:
        return None
    return {
        "permit_number": permit_number,
        "tcad_id": _clean_str(record.get("tcad_id")),
        "issue_date": _parse_date(record.get("issue_date")),
        "work_class": _clean_str(record.get("work_class")),
        "permit_class": _clean_str(record.get("permit_class")),
        "permit_type_desc": _clean_str(record.get("permit_type_desc")),
        "description": _clean_str(record.get("description")),
        "status_current": _clean_str(record.get("status_current")),
        "original_address1": _clean_str(record.get("original_address1")),
        "latitude": _parse_numeric(record.get("latitude")),
        "longitude": _parse_numeric(record.get("longitude")),
    }


def classify_permit_row(row: dict[str, Any]) -> list[tuple[str, str]]:
    text = " ".join(
        part for part in (row.get("description"), row.get("work_class"), row.get("permit_type_desc")) if part
    )
    return classify_text(text)


# ---------------------------------------------------------------------------
# Fetch: page through Socrata, write the raw JSON-lines file unchanged
# ---------------------------------------------------------------------------

def _cutoff_date(now: datetime | None = None) -> date:
    """Calendar-exact WINDOW_MONTHS-months-back cutoff (matches
    api.blockgroup_scores' `current_date - interval '36 months'`)."""
    now = now or datetime.now(timezone.utc)
    year = now.year
    month = now.month - WINDOW_MONTHS
    while month <= 0:
        month += 12
        year -= 1
    day = min(now.day, 28)  # avoid day-of-month overflow across shorter months
    return date(year, month, day)


def _where_clause(cutoff: date) -> str:
    return f"issue_date >= '{cutoff.isoformat()}T00:00:00'"


def source_url(cutoff: date) -> str:
    """The exact query (minus the paging $offset, which increments per
    page from 0), for SOURCE_URL.txt."""
    return (
        f"{SOCRATA_BASE_URL}?$where={_where_clause(cutoff)}"
        f"&$order=permit_number&$limit={PAGE_LIMIT}&$offset=N"
    )


def _fetch_page_bytes(cutoff: date, offset: int, *, client: httpx.Client) -> bytes:
    params = {
        "$where": _where_clause(cutoff),
        "$order": "permit_number",
        "$limit": str(PAGE_LIMIT),
        "$offset": str(offset),
    }
    resp = client.get(SOCRATA_BASE_URL, params=params, timeout=120.0)
    resp.raise_for_status()
    return resp.content


def _page_records_unchanged(body: bytes) -> list[bytes]:
    """Split a Socrata page response body into one raw byte-string per
    record, with each record's own bytes byte-for-byte unchanged.

    Socrata's JSON array response is itself already formatted one record
    per physical line: `[{...}\\n,{...}\\n,...,{...}]\\n` (confirmed by
    inspecting a live response — no field value contains a literal
    newline byte, only backslash-escaped ones inside JSON strings, so
    splitting on b"\\n" never cuts through a record). This strips only
    the array's own `[`, leading `,`, and trailing `]` punctuation —
    never touches a record's own bytes — so every returned element is
    exactly what Socrata sent for that record."""
    lines = [line.strip() for line in body.split(b"\n") if line.strip()]
    records: list[bytes] = []
    for line in lines:
        if line in (b"[]", b"[", b"]"):
            continue
        if line.startswith(b"["):
            line = line[1:]
        if line.startswith(b","):
            line = line[1:]
        if line.endswith(b"]"):
            line = line[:-1]
        if line:
            records.append(line)
    return records


def fetch_all_to_jsonl(dest_path: Path, cutoff: date) -> dict[str, Any]:
    """Page through the whole 36-month window and write every record's
    bytes UNCHANGED, one per line, in page order, to `dest_path` (a true
    JSON-lines file: each line is valid standalone JSON, never
    re-serialized — see `_page_records_unchanged`). Returns
    {rows, sha256, bytes}."""
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    total_rows = 0
    total_bytes = 0
    offset = 0
    with httpx.Client(follow_redirects=True) as client, open(dest_path, "wb") as out:
        while True:
            body = _fetch_page_bytes(cutoff, offset, client=client)
            records = _page_records_unchanged(body)
            if not records:
                break
            for record_bytes in records:
                line = record_bytes + b"\n"
                out.write(line)
                digest.update(line)
                total_bytes += len(line)
                total_rows += 1
            offset += PAGE_LIMIT
            if len(records) < PAGE_LIMIT:
                break
    return {"rows": total_rows, "sha256": digest.hexdigest(), "bytes": total_bytes}


def _write_sidecars(dest_path: Path, cutoff: date, retrieved_at: datetime, sha256: str) -> None:
    name = dest_path.name
    (RAW_DIR / "SOURCE_URL.txt").write_text(source_url(cutoff) + "\n")
    (RAW_DIR / "retrieved_at.txt").write_text(f"{retrieved_at.isoformat().replace('+00:00', 'Z')} {name}\n")
    (RAW_DIR / "SHA256SUMS").write_text(f"{sha256}  {name}\n")


def _upload_raw_via_rest(content: bytes, key: str, *, content_type: str) -> None:
    base_url = config.supabase_url().rstrip("/")
    service_key = config.supabase_secret_key()
    url = f"{base_url}/storage/v1/object/{config.RAW_BUCKET}/{key}"
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": content_type,
        "x-upsert": "true",
    }
    resp = httpx.post(url, headers=headers, content=content, timeout=300.0)
    resp.raise_for_status()


def iter_jsonl(path: Path):
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            yield json.loads(line)


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


def _ensure_manifest(runner: Runner, dest_path: Path, cutoff: date) -> dict[str, Any]:
    fetch_result = fetch_all_to_jsonl(dest_path, cutoff)
    retrieved_at = datetime.now(timezone.utc)
    sha256 = fetch_result["sha256"]
    _write_sidecars(dest_path, cutoff, retrieved_at, sha256)

    existing = _existing_manifest(sha256)
    if existing is not None:
        return {"id": existing["id"], "storage_key": existing["storage_key"], "rows": fetch_result["rows"]}

    content = dest_path.read_bytes()
    key = storage.storage_key(SOURCE, sha256, when=retrieved_at, ext=".jsonl")
    _upload_raw_via_rest(content, key, content_type="application/x-ndjson")

    with db.connect(pooled=False) as conn:
        manifest_id = manifest.insert(
            conn,
            source=SOURCE,
            url=source_url(cutoff),
            retrieved_at=retrieved_at,
            sha256=sha256,
            bytes_=fetch_result["bytes"],
            rows=fetch_result["rows"],
            runner=runner,
            storage_key=key,
        )
    return {"id": manifest_id, "storage_key": key, "rows": fetch_result["rows"]}


# ---------------------------------------------------------------------------
# Load core.permits (via COPY into a staging temp table, then upsert)
# ---------------------------------------------------------------------------

_PERMIT_COLUMNS = (
    "permit_number", "tcad_id", "issue_date", "work_class", "permit_class",
    "permit_type_desc", "description", "status_current", "original_address1",
    "latitude", "longitude",
)


def load_core(conn, manifest_id: str, path: Path) -> tuple[int, int, list[dict[str, Any]]]:
    """Stream `path`, COPY every valid row into a staging temp table, then
    upsert into core.permits. Returns (rows_in, rows_loaded, permit_rows)
    where permit_rows is every loaded row (for classification)."""
    rows_in = 0
    missing_permit_number = 0
    permit_rows: list[dict[str, Any]] = []

    with conn.cursor() as cur:
        cur.execute(
            f"""
            create temp table _austin_permits_staging (
                {", ".join(f"{c} text" for c in _PERMIT_COLUMNS)}
            ) on commit drop
            """
        )
        with cur.copy(
            f"copy _austin_permits_staging ({', '.join(_PERMIT_COLUMNS)}) from stdin"
        ) as copy:
            for record in iter_jsonl(path):
                rows_in += 1
                row = record_to_permit_row(record)
                if row is None:
                    missing_permit_number += 1
                    continue
                permit_rows.append(row)
                copy.write_row(tuple(
                    None if row[c] is None else str(row[c]) for c in _PERMIT_COLUMNS
                ))

        cur.execute(
            f"""
            insert into core.permits ({", ".join(_PERMIT_COLUMNS)}, source_id)
            select distinct on (permit_number)
                permit_number, tcad_id, issue_date::date, work_class, permit_class,
                permit_type_desc, description, status_current, original_address1,
                latitude::numeric, longitude::numeric, %s::uuid
            from _austin_permits_staging
            on conflict (permit_number) do update set
                tcad_id = excluded.tcad_id,
                issue_date = excluded.issue_date,
                work_class = excluded.work_class,
                permit_class = excluded.permit_class,
                permit_type_desc = excluded.permit_type_desc,
                description = excluded.description,
                status_current = excluded.status_current,
                original_address1 = excluded.original_address1,
                latitude = excluded.latitude,
                longitude = excluded.longitude,
                source_id = excluded.source_id
            """,
            (manifest_id,),
        )

    rows_loaded = rows_in - missing_permit_number
    return rows_in, rows_loaded, permit_rows


# ---------------------------------------------------------------------------
# Rules classifier -> core.permit_labels
# ---------------------------------------------------------------------------

def load_labels(conn, manifest_id: str, permit_rows: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {label: 0 for label in RULES}
    params: list[tuple[str, str, str, str]] = []
    for row in permit_rows:
        for label, keyword in classify_permit_row(row):
            params.append((row["permit_number"], label, keyword, manifest_id))
            counts[label] += 1

    if params:
        with conn.cursor() as cur:
            cur.executemany(
                """
                insert into core.permit_labels (permit_number, label, labeller, rationale, source_id)
                values (%s, %s, 'rules', %s, %s)
                on conflict (permit_number, labeller, label) do update
                    set rationale = excluded.rationale, source_id = excluded.source_id
                """,
                params,
            )
    return counts


# ---------------------------------------------------------------------------
# Deterministic stratified sample -> ops.label_queue
# ---------------------------------------------------------------------------

def sample_label_queue(conn) -> int:
    """Fill ops.label_queue with exactly LABEL_QUEUE_SIZE permits, ~half
    rules-positive battery/generator and the rest other permits, ordered
    deterministically by md5(permit_number). No-op if the queue already
    holds rows (one-time sample for M1-H1)."""
    with conn.cursor() as cur:
        cur.execute("select count(*) from ops.label_queue")
        row = cur.fetchone()
        assert row is not None
        if row[0] > 0:
            return 0

        cur.execute(
            """
            select permit_number from (
                select distinct pm.permit_number
                from core.permits pm
                join core.permit_labels pl
                    on pl.permit_number = pm.permit_number and pl.labeller = 'rules'
                where pl.label = any(%s)
            ) distinct_positives
            order by md5(permit_number)
            limit %s
            """,
            (list(LABEL_QUEUE_POSITIVE_LABELS), LABEL_QUEUE_POSITIVE_TARGET),
        )
        positives = [r[0] for r in cur.fetchall()]

        remaining = LABEL_QUEUE_SIZE - len(positives)
        cur.execute(
            """
            select pm.permit_number
            from core.permits pm
            where not exists (
                select 1 from core.permit_labels pl
                where pl.permit_number = pm.permit_number
                  and pl.labeller = 'rules'
                  and pl.label = any(%s)
            )
            order by md5(pm.permit_number)
            limit %s
            """,
            (list(LABEL_QUEUE_POSITIVE_LABELS), remaining),
        )
        others = [r[0] for r in cur.fetchall()]

        sample = positives + others
        for permit_number in sample:
            cur.execute(
                "insert into ops.label_queue (permit_number) values (%s) on conflict (permit_number) do nothing",
                (permit_number,),
            )
        return len(sample)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run(*, runner: Runner, backfill: bool = False, cursor: dict[str, Any] | None = None) -> None:
    cutoff = _cutoff_date()
    retrieved_at = datetime.now(timezone.utc)
    dest_path = RAW_DIR / f"austin_permits_{retrieved_at.strftime('%Y%m%d')}.jsonl"

    manifest_row = _ensure_manifest(runner, dest_path, cutoff)
    manifest_id = manifest_row["id"]

    with db.connect(pooled=False) as conn:
        run_id = runs.start(conn, source=SOURCE, runner=runner)
        with conn.cursor() as cur:
            cur.execute("update ops.pipeline_runs set manifest_id = %s where id = %s", (manifest_id, run_id))

    try:
        with db.connect(pooled=False) as conn:
            rows_in, rows_loaded, permit_rows = load_core(conn, manifest_id, dest_path)
            label_counts = load_labels(conn, manifest_id, permit_rows)
            sample_label_queue(conn)

        filter_drops = {"missing_permit_number": rows_in - rows_loaded}
        with db.connect(pooled=False) as conn:
            runs.finish(
                conn, run_id, status="success",
                rows_in=rows_in, rows_loaded=rows_loaded, filter_drops=filter_drops,
                cursor={"label_counts": label_counts},
            )
    except Exception as exc:
        with db.connect(pooled=False) as conn:
            runs.finish(conn, run_id, status="failed", error=str(exc))
        raise
