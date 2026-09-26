"""Base's pricing.md "Search your area" utility list -> core.base_service_areas.

Source: https://www.basepowercompany.com/pricing.md — the machine-readable
markdown summary Base publishes alongside its HTML /pricing page (see
that file's own "Where to go next" / agents.md pointers). A snapshot is
already staged, unchanged, in the main checkout at
data/raw/base_service_areas/ (pricing.md + retrieved_at.txt +
SOURCE_URL.txt + SHA256SUMS — SOURCE_URL.txt holds the exact URL below).

Fetch path: `_obtain_bytes()` reads that staged snapshot file if it
exists on disk (the initial-backfill path, using the bytes exactly as
staged — never re-derived); a fresh run with no staged file on disk
(e.g. a future cron invocation after the staged copy is gone, or with
BASE_SERVICE_AREAS_LOCAL_FILE unset/pointing nowhere) re-downloads the
.md fresh over the network via core.fetch.fetch(SOURCE_URL). Either way
the manifest `url` column is always SOURCE_URL — the canonical markdown
URL — regardless of which path supplied the bytes (same convention as
sources/tiger_bg.py's TIGER_URL).

Parsing (never hard-codes utility names): the page's "## Page outline"
section lists the live HTML page's own bulleted heading outline. Under
the top-level bullet "- Search your area", the child bullets are, in
page order, first every utility name Base currently lists, then a run of
non-utility bullets ("See your exact rate in two minutes", "How it
works", "Members", "Partnerships", "Resources", "Company").
`parse_utilities()` walks those child bullets in order and keeps every
one up to (not including) the first bullet that fails
`_looks_like_utility_name()`: a bullet counts as a name if every
whitespace-separated token containing a letter starts with an uppercase
letter — true of "AEP Texas Central", "Texas–New Mexico Power", "ComEd",
etc., and false of "See your exact rate in two minutes" (tokens "your",
"in", "two", "minutes" start lowercase). This is a structural rule over
the page's own bullet formatting and capitalization, not a lookup table.

State: core.base_service_areas (migration 0201) declares only
`utility_name` (primary key) and `source_id` — no state column — so no
state is persisted here, even though the page's own "About Base Power"
paragraph states Base serves "Texas and Illinois" (ComEd is Base's only
Illinois utility). If a later ticket adds a state column, that fact
lives in pricing.md itself and this module's docstring, not a hard-coded
mapping.

Load: utility_name is the primary key, so each run upserts (on conflict
do update source_id) every parsed name to point at the latest manifest
row. A name Base has since removed from the page is left in place, never
deleted — this module only ever adds/refreshes rows for names currently
on the page.
"""
from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pipelines.core import db, fetch, manifest, runs, storage

SOURCE = "base_service_areas"
SOURCE_URL = "https://www.basepowercompany.com/pricing.md"

STAGED_PATH = Path(
    "/Users/maheshbabugorantla/Code/Hackathons/BasePower_Deep_Tech_Hackathon_Sep_25_2026_Mavericks"
    "/data/raw/base_service_areas/pricing.md"
)
LOCAL_FILE_ENV = "BASE_SERVICE_AREAS_LOCAL_FILE"

Runner = Literal["cron", "cli"]

_TOP_BULLET_RE = re.compile(r"^- (.+)$")
_CHILD_BULLET_RE = re.compile(r"^  - (.+)$")
_OUTLINE_HEADING = "## Page outline"
_SEARCH_BULLET = "Search your area"


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def _looks_like_utility_name(text: str) -> bool:
    """True if every token of `text` that contains a letter starts with an
    uppercase letter (punctuation-only tokens, e.g. "&", never disqualify).
    See the module docstring for why this distinguishes a utility name
    bullet from the sentence-like bullets that follow it in the outline."""
    text = text.strip()
    if not text:
        return False
    for token in text.split():
        letters = [c for c in token if c.isalpha()]
        if not letters:
            continue
        if not letters[0].isupper():
            return False
    return True


def parse_utilities(markdown_text: str) -> list[str]:
    """Return the utility names listed under "Search your area" in the
    "## Page outline" section, in page order, stopping at the first
    non-utility-looking bullet. Empty list if the section/bullet isn't
    found (never invents names)."""
    lines = markdown_text.splitlines()

    try:
        outline_start = next(i for i, line in enumerate(lines) if line.strip() == _OUTLINE_HEADING)
    except StopIteration:
        return []

    search_idx = None
    for i in range(outline_start + 1, len(lines)):
        line = lines[i]
        if line.startswith("## "):
            break
        match = _TOP_BULLET_RE.match(line)
        if match and match.group(1).strip() == _SEARCH_BULLET:
            search_idx = i
            break
    if search_idx is None:
        return []

    names: list[str] = []
    for i in range(search_idx + 1, len(lines)):
        match = _CHILD_BULLET_RE.match(lines[i])
        if not match:
            break
        candidate = match.group(1).strip()
        if not _looks_like_utility_name(candidate):
            break
        names.append(candidate)
    return names


# ---------------------------------------------------------------------------
# Fetch + manifest (reuse an existing row for the same sha256; else
# upload + insert)
# ---------------------------------------------------------------------------


def _obtain_bytes(*, backfill: bool) -> tuple[bytes, str, int]:
    """Return (content, sha256, bytes) of pricing.md. `backfill=True` (the
    initial-load path) reuses the already-staged snapshot on disk if
    present — BASE_SERVICE_AREAS_LOCAL_FILE overrides which file, else
    STAGED_PATH. Every other run (backfill=False: cron / a fresh run) is
    a live re-download of SOURCE_URL, per the ticket's "the fetch path
    for fresh runs re-downloads the .md"."""
    if backfill:
        local = os.environ.get(LOCAL_FILE_ENV)
        candidate = Path(local) if local else STAGED_PATH
        if candidate.is_file():
            data = candidate.read_bytes()
            return data, fetch.sha256_of(data), len(data)

    fetched = fetch.fetch(SOURCE_URL)
    return fetched.content, fetched.sha256, fetched.bytes


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


def _ensure_manifest(runner: Runner, rows: int, data: bytes, sha256: str, size: int) -> dict[str, Any]:
    existing = _existing_manifest(sha256)
    if existing is not None:
        return {"id": existing["id"], "storage_key": existing["storage_key"], "data": data}

    retrieved_at = datetime.now(timezone.utc)
    key = storage.storage_key(SOURCE, sha256, when=retrieved_at, ext=".md")
    storage.upload_raw(data, key, content_type="text/markdown")

    with db.connect(pooled=False) as conn:
        manifest_id = manifest.insert(
            conn,
            source=SOURCE,
            url=SOURCE_URL,
            retrieved_at=retrieved_at,
            sha256=sha256,
            bytes_=size,
            rows=rows,
            runner=runner,
            storage_key=key,
        )
    return {"id": manifest_id, "storage_key": key, "data": data}


# ---------------------------------------------------------------------------
# Load core.base_service_areas
# ---------------------------------------------------------------------------


def load_core(conn, manifest_id: str, utility_names: list[str]) -> int:
    with conn.cursor() as cur:
        # A future run stuck behind a lock on this tiny table should fail
        # fast with a clear error rather than sit through the pooler's
        # much longer default statement_timeout.
        cur.execute("set local lock_timeout = '10s'")
        for name in utility_names:
            cur.execute(
                """
                insert into core.base_service_areas (utility_name, source_id)
                values (%s, %s)
                on conflict (utility_name) do update set source_id = excluded.source_id
                """,
                (name, manifest_id),
            )
    return len(utility_names)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def run(*, runner: Runner, backfill: bool = False, cursor: dict[str, Any] | None = None) -> None:
    data, sha256, size = _obtain_bytes(backfill=backfill)
    utility_names = parse_utilities(data.decode("utf-8"))

    manifest_row = _ensure_manifest(runner, rows=len(utility_names), data=data, sha256=sha256, size=size)
    manifest_id = manifest_row["id"]

    with db.connect(pooled=False) as conn:
        run_id = runs.start(conn, source=SOURCE, runner=runner)
        with conn.cursor() as cur:
            cur.execute("update ops.pipeline_runs set manifest_id = %s where id = %s", (manifest_id, run_id))

    try:
        with db.connect(pooled=False) as conn:
            rows_loaded = load_core(conn, manifest_id, utility_names)

        with db.connect(pooled=False) as conn:
            runs.finish(
                conn, run_id, status="success",
                rows_in=len(utility_names), rows_loaded=rows_loaded, filter_drops={},
            )
    except Exception as exc:
        with db.connect(pooled=False) as conn:
            runs.finish(conn, run_id, status="failed", error=str(exc))
        raise
