"""TCAD 2026 Certified Appraisal Export source: Travis County parcel
attributes -> core.parcels.

Adapter name (declared for this county in pipelines/config/counties.yaml):
tcad_certified_export.

Source files (already downloaded to data/raw/tcad/ by the T0-H3 check;
see checks/T0-H3.md):

    Export (557 MB zip, PROP.TXT inside is 4.9 GB fixed-width):
    https://traviscad.org/wp-content/largefiles/2026%20Certified%20Appraisal%20Export%20Supp%200_07182026.zip

    Layout (Legacy 8.0.33 PDF + XLSX describing PROP.TXT's field positions):
    https://traviscad.org/wp-content/largefiles/Website_Legacy8.0.33-AppraisalExportLayout_06182026.zip

Both zips are uploaded UNCHANGED to Storage bucket `raw` (TUS resumable
upload, copied from pipelines/sources/eaglei.py's pattern since that
module must not be modified) and each gets its own ops.source_manifest
row under source 'tcad_export', keyed by its own sha256/url. Field
positions come from pipelines/sources/tcad_layout.py, itself confirmed
against the layout XLSX (not from memory) — see checks/T0-H3.md.

PROP.TXT is streamed straight out of the export zip via zipfile's
ZipExtFile (never extracted to disk): one 9922-char fixed-width record
per line, each followed by a "\\r\\n" terminator, so plain readline()
lands on a record boundary every time (verified: file_size == 493,324 *
9924 bytes exactly). Records are filtered to prop_type_cd == 'R' (Real
property; drops business personal property / mobile home / mineral /
automobile records) and de-duplicated to one row per prop_id (multi-owner
rows share a prop_id — see the layout's partial_owner / udi_group fields
— but this module makes no assumption about the source's row order: it
keeps the first prop_id it sees and drops every later occurrence via an
in-memory `seen` set). Owner-name fields (py_owner_name, jan1_owner_name,
appr_owner_name) are never read.

Loading: batches of BATCH_SIZE rows are COPYed into a session-temporary
staging table, then upserted into core.parcels (ON CONFLICT prop_id DO
UPDATE, so a re-run or a resumed batch is idempotent), committing after
every batch so a resumed run only redoes the batch in flight, never the
whole file.

Resumable cursor: {byte_offset, rows_in, loaded, filter_drops}, persisted
into ops.pipeline_runs.cursor after every batch. byte_offset is the
ZipExtFile's stream position (per fixed-width record, so always a record
boundary). On resume, this module re-scans PROP.TXT from byte 0 up to
byte_offset purely to rebuild the in-memory `seen` set (the export's
PROP.TXT member is only ~129 MB compressed, so a full forward scan takes
low single-digit seconds — cheap enough that no separate serialization of
`seen` into the jsonb cursor column is needed) before resuming real
loading from byte_offset onward. If `backfill=True` and no `cursor` is
passed, `run()` looks up the latest non-success tcad_export run with the
same export sha256 and resumes from its cursor, exactly like eaglei.py.

Too big for a 300 s Vercel call: only the CLI path
(`python -m pipelines.run parcels --backfill`) is exercised for the
backfill; the cron route exists for contract completeness.
"""
from __future__ import annotations

import base64
import hashlib
import os
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Literal

import httpx
import psycopg

from pipelines.core import config, db, manifest, runs, storage
from sources import tcad_layout

SOURCE = "tcad_export"
ADAPTER_NAME = "tcad_certified_export"

EXPORT_URL = (
    "https://traviscad.org/wp-content/largefiles/"
    "2026%20Certified%20Appraisal%20Export%20Supp%200_07182026.zip"
)
LAYOUT_URL = (
    "https://traviscad.org/wp-content/largefiles/"
    "Website_Legacy8.0.33-AppraisalExportLayout_06182026.zip"
)
EXPORT_SHA256 = "62d0d1cd22b03f31db8d3986160eb181c5d00044df98a303fce9e17a44e9aa02"
LAYOUT_SHA256 = "c51352d2eba2f436c82b88ad156ebcc9a1d9c7fd546aee06bcfc83e69d61535b"
EXPORT_FILENAME = "2026_Certified_Appraisal_Export_Supp0_07182026.zip"
LAYOUT_FILENAME = "AppraisalExportLayout_06182026.zip"
PROP_MEMBER = "PROP.TXT"

TCAD_RAW_DIR_ENV = "TCAD_RAW_DIR"
EXPORT_LOCAL_FILE_ENV = "TCAD_EXPORT_LOCAL_FILE"
LAYOUT_LOCAL_FILE_ENV = "TCAD_LAYOUT_LOCAL_FILE"
DEFAULT_RAW_DIR = (
    "/Users/maheshbabugorantla/Code/Hackathons/"
    "BasePower_Deep_Tech_Hackathon_Sep_25_2026_Mavericks/data/raw/tcad"
)

TUS_CHUNK_BYTES = 6 * 1024 * 1024  # Supabase's documented resumable-upload chunk size
BATCH_SIZE = 5000

FILTER_NAMES = ("not_r", "missing_prop_id", "duplicate_prop_id")

Runner = Literal["cron", "cli"]

_COUNTIES_YAML = Path(__file__).resolve().parents[1] / "config" / "counties.yaml"

_STAGE_COLUMNS = (
    "prop_id", "geo_id", "county_fips", "prop_type_cd", "imprv_state_cd",
    "land_state_cd", "hs_exempt", "ov65_exempt", "situs_num", "situs_street",
    "situs_city", "situs_zip", "market_value", "tax_year", "source_id",
)


# --------------------------------------------------------------------------
# pipelines/config/counties.yaml — tiny hand-rolled loader.
#
# No PyYAML dependency is declared in pipelines/requirements.txt (the
# `python -m pipelines.run parcels --backfill` acceptance command installs
# only that file via --with-requirements, no extra --with packages), so
# this module owns a deliberately minimal parser for counties.yaml's
# deliberately minimal shape: top-level "county:" keys, each a flat map of
# "key: value" scalars (bare or double-quoted). No lists, no further
# nesting. If counties.yaml ever needs more than that, add PyYAML to
# requirements.txt instead of growing this parser.
# --------------------------------------------------------------------------


def _load_counties(path: Path = _COUNTIES_YAML) -> dict[str, dict[str, str]]:
    counties: dict[str, dict[str, str]] = {}
    current: dict[str, str] | None = None
    for raw_line in path.read_text().splitlines():
        line = raw_line.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        if not line[0].isspace():
            key = line.split(":", 1)[0].strip()
            current = {}
            counties[key] = current
            continue
        if current is None:
            continue
        stripped = line.strip()
        if ":" not in stripped:
            continue
        k, v = stripped.split(":", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == '"' and v[-1] == '"':
            v = v[1:-1]
        current[k.strip()] = v
    return counties


def _travis_config() -> dict[str, str]:
    counties = _load_counties()
    travis = counties.get("travis")
    if travis is None:
        raise RuntimeError(f"{_COUNTIES_YAML} has no 'travis' entry")
    if travis.get("parcel_adapter") != ADAPTER_NAME:
        raise RuntimeError(
            f"counties.yaml travis.parcel_adapter={travis.get('parcel_adapter')!r} "
            f"does not match this module's adapter name {ADAPTER_NAME!r}"
        )
    return travis


# --------------------------------------------------------------------------
# Raw file locations (already downloaded; env vars only override for
# testing — the default path is the fixed main-checkout location named in
# tickets/M1/M1-P1.md).
# --------------------------------------------------------------------------


def _raw_dir() -> str:
    return os.environ.get(TCAD_RAW_DIR_ENV, DEFAULT_RAW_DIR)


def _export_path() -> str:
    return os.environ.get(EXPORT_LOCAL_FILE_ENV) or os.path.join(_raw_dir(), EXPORT_FILENAME)


def _layout_path() -> str:
    return os.environ.get(LAYOUT_LOCAL_FILE_ENV) or os.path.join(_raw_dir(), LAYOUT_FILENAME)


def _retrieved_at() -> datetime:
    """Use the real retrieval timestamp recorded alongside the raw files
    (data/raw/tcad/retrieved_at.txt) rather than "now" — the file was
    fetched from traviscad.org once, earlier, not at pipeline-run time."""
    try:
        text = Path(_raw_dir(), "retrieved_at.txt").read_text().strip()
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except (FileNotFoundError, ValueError):
        return datetime.now(timezone.utc)


def _sha256_of_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


# --------------------------------------------------------------------------
# TUS resumable upload to Supabase Storage, copied from eaglei.py's
# pattern (eaglei.py itself is not modified/imported from, per the
# ticket). core.storage.upload_raw() loads its `content` argument into
# memory, which can't hold a 557 MB / multi-hundred-MB zip.
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
        object_name=object_name, content_type="application/zip", length=length,
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
# Manifest: one row per (source='tcad_export', sha256) — export zip and
# layout zip each get their own row, reused across runs by sha256.
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


def _ensure_manifest_for_file(*, path: str, url: str, expected_sha256: str, ext: str, runner: Runner) -> dict[str, Any]:
    if not os.path.isfile(path):
        raise RuntimeError(
            f"raw file not found: {path} — real-data rule forbids substituting a "
            f"different file; stop and report this instead"
        )
    sha256 = _sha256_of_file(path)
    if sha256 != expected_sha256:
        raise RuntimeError(
            f"sha256 mismatch for {path}: expected {expected_sha256}, got {sha256} — "
            f"refusing to load a file that doesn't match the recorded checksum"
        )
    size = os.path.getsize(path)

    existing = _existing_manifest(sha256)
    if existing is not None:
        return {"id": existing["id"], "storage_key": existing["storage_key"], "path": path, "sha256": sha256, "bytes": size}

    base_url = config.supabase_url()
    service_key = config.supabase_secret_key()
    retrieved_at = _retrieved_at()
    key = storage.storage_key(SOURCE, sha256, when=retrieved_at, ext=ext)

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
            conn, source=SOURCE, url=url, retrieved_at=retrieved_at, sha256=sha256,
            bytes_=size, rows=None, runner=runner, storage_key=key,
        )
    return {"id": manifest_id, "storage_key": key, "path": path, "sha256": sha256, "bytes": size}


def _set_manifest_rows(manifest_id: str, rows: int) -> None:
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute("update ops.source_manifest set rows = %s where id = %s", (rows, manifest_id))


# --------------------------------------------------------------------------
# Row extraction (never touches owner-name fields)
# --------------------------------------------------------------------------


def _build_row(text: str, *, manifest_id: str, county_fips: str, tax_year: int, prop_id: str) -> tuple:
    market_value_raw = tcad_layout.extract_stripped(text, "market_value")
    market_value = int(market_value_raw) if market_value_raw else None
    return (
        prop_id,
        tcad_layout.extract_stripped(text, "geo_id"),
        county_fips,
        "R",
        tcad_layout.extract_stripped(text, "imprv_state_cd"),
        tcad_layout.extract_stripped(text, "land_state_cd"),
        tcad_layout.extract_stripped(text, "hs_exempt"),
        tcad_layout.extract_stripped(text, "ov65_exempt"),
        tcad_layout.extract_stripped(text, "situs_num"),
        tcad_layout.extract_stripped(text, "situs_street"),
        tcad_layout.extract_stripped(text, "situs_city"),
        tcad_layout.extract_stripped(text, "situs_zip"),
        market_value,
        tax_year,
        manifest_id,
    )


# --------------------------------------------------------------------------
# Streamed processing over PROP.TXT (never loaded into memory at once)
# --------------------------------------------------------------------------


def new_state() -> dict[str, Any]:
    return {
        "byte_offset": 0,
        "rows_in": 0,
        "loaded": 0,
        "filter_drops": {name: 0 for name in FILTER_NAMES},
    }


def rows_loaded(state: dict[str, Any]) -> int:
    return state["rows_in"] - sum(state["filter_drops"].values())


def _rebuild_seen_up_to(f, byte_offset: int) -> set[str]:
    """Forward re-scan from the member's current position (must be 0) up
    to `byte_offset`, rebuilding the de-dup `seen` set without touching
    the database. PROP.TXT's compressed member is ~129 MB, so this full
    pass costs low single-digit seconds even for the whole file."""
    seen: set[str] = set()
    if byte_offset <= 0:
        return seen
    while f.tell() < byte_offset:
        line = f.readline()
        if not line:
            break
        text = line.decode("latin-1").rstrip("\r\n")
        if not text:
            continue
        prop_type = tcad_layout.extract_stripped(text, "prop_type_cd")
        if prop_type != "R":
            continue
        prop_id = tcad_layout.extract_stripped(text, "prop_id")
        if prop_id:
            seen.add(prop_id)
    return seen


def _ensure_staging_table(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            create temporary table if not exists parcels_stage (
                prop_id text, geo_id text, county_fips text, prop_type_cd text,
                imprv_state_cd text, land_state_cd text, hs_exempt text,
                ov65_exempt text, situs_num text, situs_street text,
                situs_city text, situs_zip text, market_value numeric,
                tax_year int, source_id uuid
            ) on commit preserve rows
            """
        )
    conn.commit()


def _load_batch(conn: psycopg.Connection, batch: list[tuple]) -> None:
    cols = ", ".join(_STAGE_COLUMNS)
    with conn.cursor() as cur:
        cur.execute("truncate parcels_stage")
        with cur.copy(f"copy parcels_stage ({cols}) from stdin") as copy:
            for row in batch:
                copy.write_row(row)
        cur.execute(
            f"""
            insert into core.parcels ({cols})
            select {cols} from parcels_stage
            on conflict (prop_id) do update set
                geo_id = excluded.geo_id,
                county_fips = excluded.county_fips,
                prop_type_cd = excluded.prop_type_cd,
                imprv_state_cd = excluded.imprv_state_cd,
                land_state_cd = excluded.land_state_cd,
                hs_exempt = excluded.hs_exempt,
                ov65_exempt = excluded.ov65_exempt,
                situs_num = excluded.situs_num,
                situs_street = excluded.situs_street,
                situs_city = excluded.situs_city,
                situs_zip = excluded.situs_zip,
                market_value = excluded.market_value,
                tax_year = excluded.tax_year,
                source_id = excluded.source_id
            """
        )
    conn.commit()


def _process(
    f,
    *,
    state: dict[str, Any],
    seen: set[str],
    conn: psycopg.Connection | None,
    manifest_id: str,
    county_fips: str,
    tax_year: int,
    batch_size: int,
    on_checkpoint: Callable[[dict[str, Any]], None],
    load_batch: Callable[[psycopg.Connection | None, list[tuple]], None] | None = None,
) -> None:
    """Stream `f` (an open PROP.TXT zip member, already positioned at
    state["byte_offset"]), filter to prop_type_cd == 'R', de-dup by
    prop_id, and load in batches. `load_batch` is injectable for tests
    (default: the real COPY + upsert against `conn`)."""
    load = load_batch or _load_batch
    batch: list[tuple] = []

    def flush() -> None:
        if not batch:
            return
        load(conn, batch)
        state["loaded"] += len(batch)
        batch.clear()
        on_checkpoint(state)

    while True:
        line = f.readline()
        if not line:
            break
        pos = f.tell()
        text = line.decode("latin-1").rstrip("\r\n")
        if not text:
            state["byte_offset"] = pos
            continue

        state["rows_in"] += 1
        prop_type = tcad_layout.extract_stripped(text, "prop_type_cd")
        if prop_type != "R":
            state["filter_drops"]["not_r"] += 1
            state["byte_offset"] = pos
            continue

        prop_id = tcad_layout.extract_stripped(text, "prop_id")
        if not prop_id:
            state["filter_drops"]["missing_prop_id"] += 1
            state["byte_offset"] = pos
            continue

        if prop_id in seen:
            state["filter_drops"]["duplicate_prop_id"] += 1
            state["byte_offset"] = pos
            continue
        seen.add(prop_id)

        batch.append(_build_row(text, manifest_id=manifest_id, county_fips=county_fips, tax_year=tax_year, prop_id=prop_id))
        state["byte_offset"] = pos
        if len(batch) >= batch_size:
            flush()

    flush()


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
    travis = _travis_config()
    county_fips = travis["fips"]
    tax_year = int(travis["tax_year"])

    export_manifest = _ensure_manifest_for_file(
        path=_export_path(), url=EXPORT_URL, expected_sha256=EXPORT_SHA256, ext=".zip", runner=runner,
    )
    _ensure_manifest_for_file(
        path=_layout_path(), url=LAYOUT_URL, expected_sha256=LAYOUT_SHA256, ext=".zip", runner=runner,
    )
    manifest_id = export_manifest["id"]

    resumed_state = cursor
    if resumed_state is None and backfill:
        resumed_state = _find_resumable_cursor(export_manifest["sha256"])
    state = resumed_state or new_state()

    with db.connect(pooled=False) as conn:
        run_id = runs.start(conn, source=SOURCE, runner=runner, cursor=state)
        with conn.cursor() as cur:
            cur.execute("update ops.pipeline_runs set manifest_id = %s where id = %s", (manifest_id, run_id))
        conn.commit()
        _ensure_staging_table(conn)

        def checkpoint(s: dict[str, Any]) -> None:
            runs.finish(
                conn, run_id, status="running",
                rows_in=s["rows_in"], rows_loaded=s["loaded"], filter_drops=s["filter_drops"], cursor=s,
            )
            conn.commit()

        try:
            with zipfile.ZipFile(export_manifest["path"]) as zf, zf.open(PROP_MEMBER) as f:
                seen = _rebuild_seen_up_to(f, state["byte_offset"])
                _process(
                    f, state=state, seen=seen, conn=conn, manifest_id=manifest_id,
                    county_fips=county_fips, tax_year=tax_year,
                    batch_size=BATCH_SIZE, on_checkpoint=checkpoint,
                )
            _set_manifest_rows(manifest_id, state["rows_in"])
            runs.finish(
                conn, run_id, status="success",
                rows_in=state["rows_in"], rows_loaded=state["loaded"], filter_drops=state["filter_drops"], cursor=state,
            )
        except Exception as exc:
            runs.finish(conn, run_id, status="failed", error=str(exc), cursor=state)
            raise
