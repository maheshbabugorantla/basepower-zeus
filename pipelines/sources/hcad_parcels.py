"""HCAD (Harris Central Appraisal District) parcels -> core.parcels /
core.parcel_geoms. See checks/M3-P2.md for the source discovery notes
(how the HCAD "PDATA" JS-driven download page's API was found, and why
the shapefile-labelled "Parcels.zip" download turned out to be an Esri
File Geodatabase this repo has no library for, replaced by HCAD's own
public ArcGIS REST parcel layer for geometry).

Adapter name (declared for Harris in pipelines/config/counties.yaml):
hcad_bulk_export.

Source files (already downloaded to data/raw/hcad/ by this ticket's
discovery work; see checks/M3-P2.md):

    Account attributes (state class code, mailing/situs address, values):
    https://download.hcad.org/data/CAMA/2026/Real_acct_owner.zip
    -> real_acct.txt (tab-delimited, header row, \\r\\n terminated,
       primary key acct -- one row per account, no in-file dedup needed)

    Homestead exemption flag (per-account list of exemption category
    codes; 'RES' = Residential Homestead, see checks/M3-P2.md):
    https://download.hcad.org/data/CAMA/2026/Real_jur_exempt.zip
    -> jur_exempt_cd.txt (tab-delimited: acct, space-separated
       exempt_cat token list, e.g. 'RES', 'HIS RES', 'RES V14 VTX')

    Reference only (confirms HCAD's state_class codes are the same
    Texas PTAD codes TCAD uses -- 'A1' = "Real, Residential,
    Single-Family" in both -- never loaded into any table):
    https://download.hcad.org/data/CAMA/2026/Code_description_real.zip
    -> desc_r_01_state_class.txt

Each zip is uploaded UNCHANGED to Storage bucket `raw` (TUS resumable
upload, same pattern as pipelines/sources/parcels.py's, reimplemented
here since parcels.py must not be modified/imported from) and gets its
own ops.source_manifest row under its own source name, keyed by sha256:
'hcad_real_acct', 'hcad_jur_exempt', 'hcad_code_description'.

Gate mapping to Travis's TCAD conventions (checks/T0-H3.md,
migration 0101_m1.sql):
  single-family  = imprv_state_cd or land_state_cd starts with 'A1'
                   -- identical PTAD code on both counties (verified
                   live against desc_r_01_state_class.txt: 'A1' =
                   "Real, Residential, Single-Family", same text TCAD's
                   own layout uses).
  owner-occupied = hs_exempt = 'T'
                   -- TCAD's PROP.TXT carries a direct hs_exempt flag
                   field; HCAD's real_acct.txt has no equivalent column,
                   so the homestead flag comes from a JOIN against
                   jur_exempt_cd.txt's per-account exemption category
                   list (token 'RES' present). Every row this module
                   loads is pre-filtered to homestead == True (see load
                   strategy below), so hs_exempt is always 'T' on every
                   loaded Harris row -- there is no non-homestead Harris
                   row in core.parcels to carry 'F'.

HCAD's real_acct.txt has one unified `state_class` column (Property Use
Code) rather than TCAD's separate improvement/land state-class columns,
so this module writes the same value into both core.parcels
.imprv_state_cd and .land_state_cd -- the gate above (an OR of the two)
is satisfied identically either way, and no information is lost.

core.parcels.prop_id / .geo_id are both set to the HCAD account number
(acct, e.g. '0020720000014') exactly as real_acct.txt and the geometry
layer's HCAD_NUM/acct_num fields give it -- a 13-character, left
zero-padded string. Unlike Travis's TCAD prop_id, this is NOT
normalized by stripping leading zeros: HCAD's own geometry layer already
uses the zero-padded form as its natural key (verified live: HCAD_NUM ==
acct_num == '0440300000049' for a real feature), so keeping it as-is is
the canonical form for this county, not a workaround. ov65_exempt is
left null (no needed-for-this-ticket source was verified for that
specific code) -- see checks/M3-P2.md for what was and wasn't sourced.

Load strategy (Supabase Small, disk-IO budget -- binding, per
tickets/M3/M3-P2.md): filter to single-family homesteads BEFORE loading
(target ~1M rows or fewer), never load all ~1.85M Harris accounts and
filter in a view like Travis does. Concretely:
  1. Stream jur_exempt_cd.txt once, building an in-memory set of
     homestead account numbers (acct where 'RES' is one of the
     whitespace-separated exempt_cat tokens). ~114 MB zip, ~30 MB member
     -- the resulting set is well under 1M short strings, cheap to hold
     in memory for the life of one CLI process.
  2. Stream real_acct.txt once. A row is loaded only if state_class
     starts with 'A1' AND its acct is in the homestead set. Every other
     row is dropped and counted in filter_drops, never loaded and never
     later deleted -- this is a load-time filter, not a soft-deletable
     one, exactly as the ticket specifies.
  3. Geometry: HCAD's own public ArcGIS REST parcel layer (found live,
     see checks/M3-P2.md) --
     https://www.gis.hctx.net/arcgis/rest/services/HCAD/Parcels/MapServer/0
     -- is paged server-side filtered to `state_class='A1'` (drops
     ~400k/1.55M rows before they ever cross the network), written
     UNCHANGED into a local RFC 8142 GeoJSON text-sequence file exactly
     like pipelines/sources/tcad_geometry.py's pattern (reimplemented
     here, not imported, per the ticket owning only this one file), then
     loaded into core.parcel_geoms filtered again, locally, against the
     SAME homestead set built in step 1 (acct_num membership) so
     core.parcel_geoms only carries geometry for the identical
     single-family-homestead row set core.parcels does.

Before every batch COPY into core.parcels or core.parcel_geoms, this
module polls ops-visible `pg_stat_activity` for any other session
running a query matching '%refresh materialized view%' or
'%refresh_all_scores%' and sleeps (bounded retries) until none is found,
per the ticket's binding load-strategy instruction. This module never
calls refresh_all_scores or REFRESH MATERIALIZED VIEW itself.

Harris permit features (core.permits join) are left out of scope for
this ticket entirely -- there is no public Harris permit feed -- and
stay null with reason "no public feed", handled by a later ticket, not
here.

Too big for a 300 s Vercel call (streaming two large zips plus paging
~1.15M live geometry features): only the CLI path
(`python -m pipelines.run hcad_parcels --backfill`) is exercised for the
real backfill; the cron route exists for contract completeness only.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Literal

import httpx
import psycopg

from pipelines.core import config, db, manifest, runs

PIPELINE_SOURCE = "hcad_parcels"
ADAPTER_NAME = "hcad_bulk_export"

REAL_ACCT_SOURCE = "hcad_real_acct"
JUR_EXEMPT_SOURCE = "hcad_jur_exempt"
CODE_DESC_SOURCE = "hcad_code_description"
GEOM_SOURCE = "hcad_geometry"

REAL_ACCT_URL = "https://download.hcad.org/data/CAMA/2026/Real_acct_owner.zip"
JUR_EXEMPT_URL = "https://download.hcad.org/data/CAMA/2026/Real_jur_exempt.zip"
CODE_DESC_URL = "https://download.hcad.org/data/CAMA/2026/Code_description_real.zip"
GEOM_LAYER_URL = "https://www.gis.hctx.net/arcgis/rest/services/HCAD/Parcels/MapServer/0"
GEOM_QUERY_URL = f"{GEOM_LAYER_URL}/query"

REAL_ACCT_FILENAME = "Real_acct_owner.zip"
JUR_EXEMPT_FILENAME = "Real_jur_exempt.zip"
CODE_DESC_FILENAME = "Code_description_real.zip"

REAL_ACCT_SHA256 = "a75c079413828dd33dc05f9f83d21e73b33a507b35be52a3bbfbd9acf0006a0f"
JUR_EXEMPT_SHA256 = "602fbdeb47de76af4a3bca8f5a344fc37495f37a7d10940a12a2fffdb4d4aca4"
CODE_DESC_SHA256 = "e5c35a4918b88ecfef9c60cefbee9ced26f83b168832b733abb7ca13c5dfbe32"

REAL_ACCT_MEMBER = "real_acct.txt"
JUR_EXEMPT_MEMBER = "jur_exempt_cd.txt"

HCAD_RAW_DIR_ENV = "HCAD_RAW_DIR"
DEFAULT_RAW_DIR = (
    "/Users/maheshbabugorantla/Code/Hackathons/"
    "BasePower_Deep_Tech_Hackathon_Sep_25_2026_Mavericks/data/raw/hcad"
)
GEOM_RAW_FILENAME = "hcad_gis_parcels_a1.geojsonseq"

TUS_CHUNK_BYTES = 6 * 1024 * 1024  # Supabase's documented resumable-upload chunk size
BATCH_SIZE = 5000
GEOM_PAGE_SIZE = 1000  # server's own maxRecordCount, verified live against MapServer/0?f=json
GEOM_REQUEST_DELAY_SECONDS = 0.25
GEOM_MAX_RETRIES = 5
GEOM_RETRY_BACKOFF_BASE_SECONDS = 2.0

REFRESH_QUERY_PATTERNS = ("%refresh materialized view%", "%refresh_all_scores%")
REFRESH_POLL_SECONDS = 5.0
REFRESH_MAX_POLLS = 120  # 10 minutes of waiting before giving up loudly

FILTER_NAMES = ("not_a1", "not_homestead", "missing_acct")
GEOM_FILTER_NAMES = ("not_homestead", "missing_hcad_num", "duplicate_hcad_num", "null_geometry")

Runner = Literal["cron", "cli"]

_COUNTIES_YAML = Path(__file__).resolve().parents[1] / "config" / "counties.yaml"

_STAGE_COLUMNS = (
    "prop_id", "geo_id", "county_fips", "prop_type_cd", "imprv_state_cd",
    "land_state_cd", "hs_exempt", "ov65_exempt", "situs_num", "situs_street",
    "situs_city", "situs_zip", "market_value", "tax_year", "source_id",
)


# --------------------------------------------------------------------------
# pipelines/config/counties.yaml -- reuses the same tiny hand-rolled parser
# convention pipelines/sources/parcels.py documents (no PyYAML dependency
# declared in pipelines/requirements.txt). Reimplemented here rather than
# imported from parcels.py, which this ticket must not modify or import.
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


def _harris_config() -> dict[str, str]:
    counties = _load_counties()
    harris = counties.get("harris")
    if harris is None:
        raise RuntimeError(f"{_COUNTIES_YAML} has no 'harris' entry")
    if harris.get("parcel_adapter") != ADAPTER_NAME:
        raise RuntimeError(
            f"counties.yaml harris.parcel_adapter={harris.get('parcel_adapter')!r} "
            f"does not match this module's adapter name {ADAPTER_NAME!r}"
        )
    return harris


# --------------------------------------------------------------------------
# Raw file locations (already downloaded; env var only overrides for
# testing -- default path is the fixed main-checkout location this
# ticket downloaded to, data/raw/hcad/).
# --------------------------------------------------------------------------


def _raw_dir() -> str:
    return os.environ.get(HCAD_RAW_DIR_ENV, DEFAULT_RAW_DIR)


def _real_acct_path() -> str:
    return os.path.join(_raw_dir(), REAL_ACCT_FILENAME)


def _jur_exempt_path() -> str:
    return os.path.join(_raw_dir(), JUR_EXEMPT_FILENAME)


def _code_desc_path() -> str:
    return os.path.join(_raw_dir(), CODE_DESC_FILENAME)


def _geom_raw_path() -> Path:
    return Path(_raw_dir(), GEOM_RAW_FILENAME)


def _retrieved_at() -> datetime:
    """Use the real retrieval timestamp recorded alongside the raw files
    (data/raw/hcad/retrieved_at.txt) rather than "now" -- the files were
    fetched from hcad.org once, earlier, not at pipeline-run time."""
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


def _storage_key(source: str, sha256: str, *, when: datetime, ext: str) -> str:
    date = when.strftime("%Y-%m-%d")
    return f"{source}/{date}/{sha256}{ext}"


# --------------------------------------------------------------------------
# TUS resumable upload to Supabase Storage, reimplemented here (same
# pattern as pipelines/sources/parcels.py's, which itself is not imported
# from per the ticket boundary) since core.storage.upload_raw() loads its
# whole `content` argument into memory, which can't hold these 100-200 MB
# zips.
# --------------------------------------------------------------------------


def _tus_b64(s: str) -> str:
    return base64.b64encode(s.encode()).decode()


_UPLOAD_MAX_RETRIES = 5
_UPLOAD_RETRY_BACKOFF_BASE_SECONDS = 3.0


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
    attempt = 0
    while True:
        attempt += 1
        try:
            resp = httpx.post(f"{base_url}/storage/v1/upload/resumable", headers=headers, timeout=60.0)
            resp.raise_for_status()
        except (httpx.HTTPStatusError, httpx.TransportError):
            if attempt >= _UPLOAD_MAX_RETRIES:
                raise
            time.sleep(_UPLOAD_RETRY_BACKOFF_BASE_SECONDS ** attempt)
            continue
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
            attempt = 0
            while True:
                attempt += 1
                try:
                    resp = client.patch(location, headers=headers, content=chunk)
                    resp.raise_for_status()
                except (httpx.HTTPStatusError, httpx.TransportError):
                    if attempt >= _UPLOAD_MAX_RETRIES:
                        raise
                    time.sleep(_UPLOAD_RETRY_BACKOFF_BASE_SECONDS ** attempt)
                    continue
                break
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
# Manifest: one row per (source, sha256), reused across runs.
# --------------------------------------------------------------------------


def _existing_manifest(source: str, sha256: str) -> dict[str, Any] | None:
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select id, storage_key from ops.source_manifest "
                "where source = %s and sha256 = %s order by retrieved_at desc limit 1",
                (source, sha256),
            )
            row = cur.fetchone()
    if row is None:
        return None
    return {"id": str(row[0]), "storage_key": row[1]}


def _ensure_manifest_for_file(
    *, source: str, path: str, url: str, expected_sha256: str, ext: str, runner: Runner,
) -> dict[str, Any]:
    if not os.path.isfile(path):
        raise RuntimeError(
            f"raw file not found: {path} -- real-data rule forbids substituting a "
            f"different file; stop and report this instead"
        )
    sha256 = _sha256_of_file(path)
    if sha256 != expected_sha256:
        raise RuntimeError(
            f"sha256 mismatch for {path}: expected {expected_sha256}, got {sha256} -- "
            f"refusing to load a file that doesn't match the recorded checksum"
        )
    size = os.path.getsize(path)

    existing = _existing_manifest(source, sha256)
    if existing is not None:
        return {"id": existing["id"], "storage_key": existing["storage_key"], "path": path, "sha256": sha256, "bytes": size}

    base_url = config.supabase_url()
    service_key = config.supabase_secret_key()
    retrieved_at = _retrieved_at()
    key = _storage_key(source, sha256, when=retrieved_at, ext=ext)

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
            conn, source=source, url=url, retrieved_at=retrieved_at, sha256=sha256,
            bytes_=size, rows=None, runner=runner, storage_key=key,
        )
    return {"id": manifest_id, "storage_key": key, "path": path, "sha256": sha256, "bytes": size}


def _set_manifest_rows(manifest_id: str, rows: int) -> None:
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute("update ops.source_manifest set rows = %s where id = %s", (rows, manifest_id))


# --------------------------------------------------------------------------
# Disk-IO budget: pause any batch COPY while a materialized-view refresh
# or refresh_all_scores() is running elsewhere. Never called to trigger a
# refresh itself, only to detect and wait one out.
# --------------------------------------------------------------------------


def _refresh_in_progress(conn: psycopg.Connection) -> bool:
    with conn.cursor() as cur:
        where = " or ".join(["query ilike %s"] * len(REFRESH_QUERY_PATTERNS))
        cur.execute(
            f"select count(*) from pg_stat_activity "
            f"where state = 'active' and pid != pg_backend_pid() and ({where})",
            REFRESH_QUERY_PATTERNS,
        )
        row = cur.fetchone()
    return bool(row and row[0] > 0)


_CHECKPOINT_MAX_RETRIES = 5
_CHECKPOINT_RETRY_BACKOFF_SECONDS = 5.0


def _finish_run_resilient(run_id: str, **finish_kwargs: Any) -> None:
    """Call runs.finish() against a FRESH connection each attempt,
    retrying (bounded) on any psycopg error -- observed live during this
    ticket's own backfill: the shared Supabase "Small" project this
    session runs against occasionally rejects a write with
    psycopg.errors.ReadOnlySqlTransaction for a few seconds (other
    sessions' heavy concurrent writes/refreshes), then accepts writes
    again. A lost checkpoint write is not fatal (fetch_all_geom_pages /
    process_real_acct simply resume from the last checkpoint that DID
    land, or redo a little extra work), so after exhausting retries this
    logs to stderr and returns rather than crashing the whole backfill
    over one missed progress checkpoint."""
    import sys

    for attempt in range(1, _CHECKPOINT_MAX_RETRIES + 1):
        try:
            with db.connect(pooled=False) as conn:
                runs.finish(conn, run_id, **finish_kwargs)
            return
        except psycopg.Error as exc:
            if attempt >= _CHECKPOINT_MAX_RETRIES:
                print(
                    f"hcad_parcels: checkpoint write for run {run_id} failed "
                    f"after {attempt} attempts, continuing without it: {exc}",
                    file=sys.stderr,
                )
                return
            time.sleep(_CHECKPOINT_RETRY_BACKOFF_SECONDS)


def _wait_for_refresh_clear(conn: psycopg.Connection) -> None:
    """Block (bounded) while any other session is running a materialized
    view refresh or refresh_all_scores(), per this ticket's binding
    load-strategy instruction. Never runs a refresh itself."""
    for _ in range(REFRESH_MAX_POLLS):
        try:
            if not _refresh_in_progress(conn):
                return
        except psycopg.Error:
            # pg_stat_activity should always be readable; if some
            # transient error occurs, don't block the whole backfill on
            # it -- log by re-raising only on the last attempt below.
            conn.rollback()
            return
        conn.rollback()  # release the read-only snapshot before sleeping
        time.sleep(REFRESH_POLL_SECONDS)


# --------------------------------------------------------------------------
# Phase 1: homestead account set, built from jur_exempt_cd.txt
# (acct -> whether 'RES' is one of its whitespace-separated exempt_cat
# tokens; see checks/M3-P2.md for how 'RES' == Residential Homestead was
# confirmed against desc_r_14_exemption_category.txt).
# --------------------------------------------------------------------------


def build_homestead_set(jur_exempt_zip_path: str) -> set[str]:
    homestead: set[str] = set()
    with zipfile.ZipFile(jur_exempt_zip_path) as zf, zf.open(JUR_EXEMPT_MEMBER) as f:
        header = f.readline().decode("latin-1").rstrip("\r\n").split("\t")
        idx_acct = header.index("acct")
        idx_cat = header.index("exempt_cat")
        while True:
            line = f.readline()
            if not line:
                break
            text = line.decode("latin-1").rstrip("\r\n")
            if not text:
                continue
            parts = text.split("\t")
            if len(parts) <= max(idx_acct, idx_cat):
                continue
            acct = parts[idx_acct].strip()
            cat = parts[idx_cat].strip()
            if acct and "RES" in cat.split():
                homestead.add(acct)
    return homestead


# --------------------------------------------------------------------------
# Phase 2: real_acct.txt -> core.parcels, filtered to single-family
# homesteads before loading.
# --------------------------------------------------------------------------


def new_attr_state() -> dict[str, Any]:
    return {"rows_in": 0, "loaded": 0, "filter_drops": {name: 0 for name in FILTER_NAMES}}


def rows_loaded(state: dict[str, Any]) -> int:
    return state["rows_in"] - sum(state["filter_drops"].values())


def _build_parcel_row(
    field: dict[str, str], *, manifest_id: str, county_fips: str, default_tax_year: int, acct: str,
) -> tuple:
    state_class = field.get("state_class", "").strip() or None
    market_value_raw = field.get("tot_mkt_val", "").strip()
    market_value = int(market_value_raw) if market_value_raw else None
    yr_raw = field.get("yr", "").strip()
    tax_year = int(yr_raw) if yr_raw else default_tax_year
    street = " ".join(
        p for p in (field.get("str", "").strip(), field.get("str_sfx", "").strip()) if p
    ) or None
    return (
        acct,
        acct,  # geo_id: no Harris permit feed exists yet (ticket: "no public feed") --
               # set equal to the HCAD account number itself so a future
               # Harris permit source has a real key to join on, rather
               # than an unusable null.
        county_fips,
        "R",
        state_class,
        state_class,  # land_state_cd: real_acct.txt has one unified state_class
                      # column, not TCAD's separate improvement/land codes.
        "T",  # hs_exempt: every loaded row is pre-filtered to homestead == True.
        None,  # ov65_exempt: not sourced by this ticket.
        field.get("str_num", "").strip() or None,
        street,
        field.get("site_addr_2", "").strip() or None,
        field.get("site_addr_3", "").strip() or None,
        market_value,
        tax_year,
        manifest_id,
    )


def _ensure_staging_table(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            create temporary table if not exists hcad_parcels_stage (
                prop_id text, geo_id text, county_fips text, prop_type_cd text,
                imprv_state_cd text, land_state_cd text, hs_exempt text,
                ov65_exempt text, situs_num text, situs_street text,
                situs_city text, situs_zip text, market_value numeric,
                tax_year int, source_id uuid
            ) on commit preserve rows
            """
        )
    conn.commit()


def _load_parcel_batch(conn: psycopg.Connection, batch: list[tuple]) -> None:
    cols = ", ".join(_STAGE_COLUMNS)
    with conn.cursor() as cur:
        cur.execute("truncate hcad_parcels_stage")
        with cur.copy(f"copy hcad_parcels_stage ({cols}) from stdin") as copy:
            for row in batch:
                copy.write_row(row)
        cur.execute(
            f"""
            insert into core.parcels ({cols})
            select {cols} from hcad_parcels_stage
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


def process_real_acct(
    f,
    *,
    homestead_set: set[str],
    state: dict[str, Any],
    conn: psycopg.Connection | None,
    manifest_id: str,
    county_fips: str,
    default_tax_year: int,
    batch_size: int,
    on_checkpoint: Callable[[dict[str, Any]], None],
    load_batch: Callable[[psycopg.Connection | None, list[tuple]], None] | None = None,
    wait_for_refresh: Callable[[psycopg.Connection | None], None] | None = None,
) -> None:
    """Stream `f` (an open real_acct.txt handle, positioned at its first
    data row -- caller has already consumed the header line), filter to
    state_class starting 'A1' AND acct present in `homestead_set`, and
    load in batches. `load_batch` is injectable for tests."""
    header = getattr(f, "_hcad_header", None)
    if header is None:
        raise RuntimeError("process_real_acct requires f._hcad_header (set by the caller after reading the header line)")
    load = load_batch or _load_parcel_batch
    wait = wait_for_refresh or _wait_for_refresh_clear
    batch: list[tuple] = []

    def flush() -> None:
        if not batch:
            return
        if conn is not None:
            wait(conn)
        load(conn, batch)
        state["loaded"] += len(batch)
        batch.clear()
        on_checkpoint(state)

    while True:
        line = f.readline()
        if not line:
            break
        text = line.decode("latin-1").rstrip("\r\n") if isinstance(line, bytes) else line.rstrip("\r\n")
        if not text:
            continue

        state["rows_in"] += 1
        parts = text.split("\t")
        field = dict(zip(header, parts))

        acct = field.get("acct", "").strip()
        if not acct:
            state["filter_drops"]["missing_acct"] += 1
            continue

        state_class = field.get("state_class", "").strip()
        if not state_class.startswith("A1"):
            state["filter_drops"]["not_a1"] += 1
            continue

        if acct not in homestead_set:
            state["filter_drops"]["not_homestead"] += 1
            continue

        batch.append(_build_parcel_row(
            field, manifest_id=manifest_id, county_fips=county_fips,
            default_tax_year=default_tax_year, acct=acct,
        ))
        if len(batch) >= batch_size:
            flush()

    flush()


# --------------------------------------------------------------------------
# Phase 3: HCAD ArcGIS REST parcel layer -> core.parcel_geoms, paged
# server-side filtered to state_class='A1', reimplementing
# pipelines/sources/tcad_geometry.py's proven paging/framing/upload
# pattern (not imported, per the ticket owning only this one file).
# --------------------------------------------------------------------------


def new_paging_state() -> dict[str, Any]:
    return {
        "last_objectid": 0,
        "byte_offset": 0,
        "pages_fetched": 0,
        "features_written": 0,
        "done": False,
    }


def _geom_page_params(last_objectid: int) -> dict[str, Any]:
    return {
        "where": f"state_class='A1' AND OBJECTID > {last_objectid}",
        "outFields": "HCAD_NUM,acct_num,state_class,OBJECTID",
        "orderByFields": "OBJECTID",
        "resultRecordCount": GEOM_PAGE_SIZE,
        "outSR": 4326,
        "f": "geojson",
    }


def _fetch_geom_page(last_objectid: int) -> tuple[bytes, dict[str, Any]]:
    params = _geom_page_params(last_objectid)
    attempt = 0
    while True:
        attempt += 1
        try:
            resp = httpx.get(GEOM_QUERY_URL, params=params, timeout=60.0)
        except httpx.TransportError:
            if attempt >= GEOM_MAX_RETRIES:
                raise
            time.sleep(GEOM_RETRY_BACKOFF_BASE_SECONDS ** attempt)
            continue

        if resp.status_code >= 500:
            if attempt >= GEOM_MAX_RETRIES:
                resp.raise_for_status()
            time.sleep(GEOM_RETRY_BACKOFF_BASE_SECONDS ** attempt)
            continue
        resp.raise_for_status()

        content = resp.content
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError:
            if attempt >= GEOM_MAX_RETRIES:
                raise RuntimeError(f"non-JSON geometry page response at last_objectid={last_objectid}")
            time.sleep(GEOM_RETRY_BACKOFF_BASE_SECONDS ** attempt)
            continue

        if "error" in parsed:
            if attempt >= GEOM_MAX_RETRIES:
                raise RuntimeError(f"ArcGIS error body at last_objectid={last_objectid}: {parsed['error']}")
            time.sleep(GEOM_RETRY_BACKOFF_BASE_SECONDS ** attempt)
            continue

        return content, parsed


def fetch_all_geom_pages(state: dict[str, Any] | None = None, *, on_checkpoint=None) -> dict[str, Any]:
    state = state or new_paging_state()
    path = _geom_raw_path()
    path.parent.mkdir(parents=True, exist_ok=True)

    resuming = path.is_file() and state["byte_offset"] > 0
    mode = "r+b" if resuming else "wb"
    with open(path, mode) as f:
        if resuming:
            f.seek(state["byte_offset"])
            f.truncate(state["byte_offset"])
        else:
            f.seek(0)

        while not state["done"]:
            content, parsed = _fetch_geom_page(state["last_objectid"])
            features = parsed.get("features") or []
            if not features:
                state["done"] = True
                break

            f.write(b"\x1e")
            f.write(content)
            f.write(b"\n")
            f.flush()

            state["byte_offset"] = f.tell()
            state["pages_fetched"] += 1
            state["features_written"] += len(features)
            state["last_objectid"] = max(
                feat.get("properties", {}).get("OBJECTID", state["last_objectid"]) for feat in features
            )

            if on_checkpoint is not None:
                on_checkpoint(state)

            if len(features) < GEOM_PAGE_SIZE:
                state["done"] = True
                break

            time.sleep(GEOM_REQUEST_DELAY_SECONDS)

    return state


def _iter_geom_pages(path: Path) -> Iterator[dict[str, Any]]:
    """Stream one page (one 0x1E-delimited record, terminated by \\n) at a
    time rather than reading the whole (~hundreds of MB) file into memory
    -- each page body itself never contains 0x1E or \\n (verified live,
    same as tcad_geometry.py's identical framing)."""
    with open(path, "rb") as f:
        buf = b""
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            buf += chunk
            while b"\x1e" in buf[1:]:
                # keep the leading 0x1E (or empty prefix) attached to
                # this record; split on the NEXT 0x1E marking the start
                # of the following record.
                next_marker = buf.index(b"\x1e", 1)
                record = buf[:next_marker].strip(b"\x1e\n")
                buf = buf[next_marker:]
                if record:
                    yield json.loads(record)
        record = buf.strip(b"\x1e\n")
        if record:
            yield json.loads(record)


def new_geom_load_state() -> dict[str, Any]:
    return {"rows_in": 0, "rows_loaded": 0, "filter_drops": {name: 0 for name in GEOM_FILTER_NAMES}}


_GEOM_UPSERT_SQL = """
    insert into core.parcel_geoms (prop_id, geo_id, geom, centroid, source_id)
    select
        x.prop_id,
        x.geo_id,
        extensions.ST_Multi(extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON(x.gj), 4326)),
        extensions.ST_PointOnSurface(extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON(x.gj), 4326)),
        %(source_id)s::uuid
    from unnest(%(prop_ids)s::text[], %(geo_ids)s::text[], %(gjs)s::text[]) as x(prop_id, geo_id, gj)
    on conflict (prop_id) do update
        set geo_id = excluded.geo_id,
            geom = excluded.geom,
            centroid = excluded.centroid,
            source_id = excluded.source_id
"""


def load_geom_core(
    conn: psycopg.Connection | None,
    manifest_id: str,
    path: Path,
    *,
    homestead_set: set[str],
    batch_size: int = 1000,
    wait_for_refresh: Callable[[psycopg.Connection | None], None] | None = None,
    upsert_batch: Callable[[psycopg.Connection | None, list[str], list[str], list[str], str], None] | None = None,
) -> dict[str, Any]:
    state = new_geom_load_state()
    wait = wait_for_refresh or _wait_for_refresh_clear
    seen: set[str] = set()
    batch_prop: list[str] = []
    batch_geo: list[str] = []
    batch_gj: list[str] = []

    def upsert(prop_ids: list[str], geo_ids: list[str], gjs: list[str]) -> None:
        if upsert_batch is not None:
            upsert_batch(conn, prop_ids, geo_ids, gjs, manifest_id)
            return
        assert conn is not None
        with conn.cursor() as cur:
            cur.execute(
                _GEOM_UPSERT_SQL,
                {"prop_ids": prop_ids, "geo_ids": geo_ids, "gjs": gjs, "source_id": manifest_id},
            )
        conn.commit()

    def flush() -> None:
        if not batch_prop:
            return
        if conn is not None:
            wait(conn)
        upsert(list(batch_prop), list(batch_geo), list(batch_gj))
        state["rows_loaded"] += len(batch_prop)
        batch_prop.clear()
        batch_geo.clear()
        batch_gj.clear()

    for page in _iter_geom_pages(path):
        for feat in page.get("features") or []:
            state["rows_in"] += 1
            props = feat.get("properties") or {}
            hcad_num = props.get("HCAD_NUM")
            geom = feat.get("geometry")

            if not hcad_num:
                state["filter_drops"]["missing_hcad_num"] += 1
                continue
            hcad_num = str(hcad_num).strip()
            if hcad_num not in homestead_set:
                # Not a load-time error: this is the SAME single-family
                # A1-only, homestead-only row set core.parcels loads (the
                # server-side `state_class='A1'` filter already dropped
                # non-single-family features; this local check narrows to
                # homestead, matching core.parcels exactly).
                state["filter_drops"]["not_homestead"] += 1
                continue
            if hcad_num in seen:
                state["filter_drops"]["duplicate_hcad_num"] += 1
                continue
            if geom is None:
                # A homestead single-family account with no polygon on
                # this layer -- real, just ungeocoded; core.parcels still
                # carries the account, core.parcel_geoms simply has no
                # row for it (missing means empty, not a load failure).
                # Still counted, so rows_loaded == rows_in - sum(filter_drops)
                # holds for `pipelines.check reconcile`.
                state["filter_drops"]["null_geometry"] += 1
                continue
            seen.add(hcad_num)

            acct_num = props.get("acct_num")
            batch_prop.append(hcad_num)
            batch_geo.append(str(acct_num).strip() if acct_num else hcad_num)
            batch_gj.append(json.dumps(geom))

            if len(batch_prop) >= batch_size:
                flush()

    flush()
    return state


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------


def _phase_already_succeeded(phase: str, manifest_id: str) -> bool:
    """True if an ops.pipeline_runs row already recorded a successful run
    of this phase against this exact manifest -- lets a retried CLI
    backfill (e.g. after phase B fails) skip re-streaming and re-COPYing
    the whole multi-hundred-MB phase A file, protecting the disk-IO
    budget the ticket calls out, rather than blindly starting over."""
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select 1 from ops.pipeline_runs "
                "where source = %s and status = 'success' "
                "and manifest_id = %s and cursor ->> 'phase' = %s "
                "limit 1",
                (PIPELINE_SOURCE, manifest_id, phase),
            )
            return cur.fetchone() is not None


def run(*, runner: Runner, backfill: bool = False, cursor: dict[str, Any] | None = None) -> None:
    harris = _harris_config()
    county_fips = harris["fips"]
    default_tax_year = int(harris["tax_year"])

    real_acct_manifest = _ensure_manifest_for_file(
        source=REAL_ACCT_SOURCE, path=_real_acct_path(), url=REAL_ACCT_URL,
        expected_sha256=REAL_ACCT_SHA256, ext=".zip", runner=runner,
    )
    jur_exempt_manifest = _ensure_manifest_for_file(
        source=JUR_EXEMPT_SOURCE, path=_jur_exempt_path(), url=JUR_EXEMPT_URL,
        expected_sha256=JUR_EXEMPT_SHA256, ext=".zip", runner=runner,
    )
    _ensure_manifest_for_file(
        source=CODE_DESC_SOURCE, path=_code_desc_path(), url=CODE_DESC_URL,
        expected_sha256=CODE_DESC_SHA256, ext=".zip", runner=runner,
    )

    homestead_set = build_homestead_set(jur_exempt_manifest["path"])

    # --- Phase A: attributes -> core.parcels ---------------------------
    if backfill and _phase_already_succeeded("attributes", real_acct_manifest["id"]):
        attr_state = None  # already loaded against this exact manifest; skip re-streaming + re-COPYing
    else:
        attr_state = new_attr_state()
        _run_phase_a(
            attr_state, real_acct_manifest=real_acct_manifest, homestead_set=homestead_set,
            county_fips=county_fips, default_tax_year=default_tax_year, runner=runner,
        )

    # --- Phase B: geometry -> core.parcel_geoms -------------------------
    _run_phase_b(homestead_set=homestead_set, runner=runner, backfill=backfill)


def _run_phase_a(
    attr_state: dict[str, Any], *, real_acct_manifest: dict[str, Any], homestead_set: set[str],
    county_fips: str, default_tax_year: int, runner: Runner,
) -> None:
    with db.connect(pooled=False) as conn:
        run_id = runs.start(conn, source=PIPELINE_SOURCE, runner=runner, cursor={"phase": "attributes"})
        with conn.cursor() as cur:
            cur.execute("update ops.pipeline_runs set manifest_id = %s where id = %s", (real_acct_manifest["id"], run_id))
        conn.commit()
        _ensure_staging_table(conn)

        def attr_checkpoint(s: dict[str, Any]) -> None:
            runs.finish(
                conn, run_id, status="running",
                rows_in=s["rows_in"], rows_loaded=s["loaded"], filter_drops=s["filter_drops"],
                cursor={"phase": "attributes", **s},
            )
            conn.commit()

        try:
            with zipfile.ZipFile(real_acct_manifest["path"]) as zf, zf.open(REAL_ACCT_MEMBER) as f:
                header_line = f.readline().decode("latin-1").rstrip("\r\n")
                header = header_line.split("\t")
                f._hcad_header = header  # type: ignore[attr-defined]
                process_real_acct(
                    f, homestead_set=homestead_set, state=attr_state, conn=conn,
                    manifest_id=real_acct_manifest["id"], county_fips=county_fips,
                    default_tax_year=default_tax_year, batch_size=BATCH_SIZE,
                    on_checkpoint=attr_checkpoint,
                )
            _set_manifest_rows(real_acct_manifest["id"], attr_state["rows_in"])
            runs.finish(
                conn, run_id, status="success",
                rows_in=attr_state["rows_in"], rows_loaded=attr_state["loaded"],
                filter_drops=attr_state["filter_drops"], cursor={"phase": "attributes", **attr_state},
            )
        except Exception as exc:
            runs.finish(conn, run_id, status="failed", error=str(exc), cursor={"phase": "attributes", **attr_state})
            raise


def _find_resumable_geom_cursor() -> dict[str, Any] | None:
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select cursor from ops.pipeline_runs "
                "where source = %s and status != 'success' and cursor ->> 'phase' = 'geometry' "
                "order by started_at desc limit 1",
                (PIPELINE_SOURCE,),
            )
            row = cur.fetchone()
    if row is None or row[0] is None:
        return None
    state = dict(row[0])
    state.pop("phase", None)
    return state


def _run_phase_b(*, homestead_set: set[str], runner: Runner, backfill: bool) -> None:
    # Resolve the resumable cursor BEFORE inserting this run's own
    # ops.pipeline_runs row: querying "most recent non-success geometry
    # row" AFTER that insert would find our own just-inserted row (cursor
    # {"phase": "geometry"}, no byte_offset) instead of a real prior
    # checkpoint, silently discarding it and restarting paging from byte
    # 0 -- exactly the bug this ordering avoids.
    paging_state = (backfill and _find_resumable_geom_cursor()) or new_paging_state()

    with db.connect(pooled=False) as conn:
        geom_run_id = runs.start(conn, source=PIPELINE_SOURCE, runner=runner, cursor={"phase": "geometry", **paging_state})

    def geom_checkpoint(s: dict[str, Any]) -> None:
        _finish_run_resilient(geom_run_id, status="running", cursor={"phase": "geometry", **s})

    try:
        paging_state = fetch_all_geom_pages(paging_state, on_checkpoint=geom_checkpoint)
        path = _geom_raw_path()
        sha256 = _sha256_of_file(str(path))
        size = os.path.getsize(path)

        existing = _existing_manifest(GEOM_SOURCE, sha256)
        if existing is not None:
            geom_manifest_id = existing["id"]
        else:
            base_url = config.supabase_url()
            service_key = config.supabase_secret_key()
            retrieved_at = datetime.now(timezone.utc)
            key = _storage_key(GEOM_SOURCE, sha256, when=retrieved_at, ext=".geojsonseq")
            _tus_upload_file(str(path), base_url=base_url, service_key=service_key, bucket=config.RAW_BUCKET, object_name=key)
            verified = _verify_uploaded_sha256(base_url=base_url, service_key=service_key, bucket=config.RAW_BUCKET, object_name=key)
            if verified != sha256:
                raise RuntimeError(f"uploaded object sha256 mismatch for {key}: expected {sha256}, got {verified}")
            with db.connect(pooled=False) as conn:
                geom_manifest_id = manifest.insert(
                    conn, source=GEOM_SOURCE, url=GEOM_QUERY_URL, retrieved_at=retrieved_at,
                    sha256=sha256, bytes_=size, rows=None, runner=runner, storage_key=key,
                )

        with db.connect(pooled=False) as conn:
            with conn.cursor() as cur:
                cur.execute("update ops.pipeline_runs set manifest_id = %s where id = %s", (geom_manifest_id, geom_run_id))
            conn.commit()

        with db.connect(pooled=False) as conn:
            geom_state = load_geom_core(conn, geom_manifest_id, path, homestead_set=homestead_set)

        _set_manifest_rows(geom_manifest_id, geom_state["rows_in"])
        _finish_run_resilient(
            geom_run_id, status="success",
            rows_in=geom_state["rows_in"], rows_loaded=geom_state["rows_loaded"],
            filter_drops=geom_state["filter_drops"], cursor={"phase": "geometry", **paging_state},
        )
    except Exception as exc:
        _finish_run_resilient(geom_run_id, status="failed", error=str(exc), cursor={"phase": "geometry", **paging_state})
        raise
