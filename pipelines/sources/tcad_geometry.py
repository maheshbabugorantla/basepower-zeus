"""Travis County TCAD_public parcel geometry: MapServer layer 0 -> core.parcel_geoms.

Source: Travis County GIS ArcGIS REST layer (checks/T0-H3.md)

    https://gis.traviscountytx.gov/server1/rest/services/Boundaries_and_Jurisdictions/TCAD_public/MapServer/0

386,682 parcels, server maxRecordCount 2000 (verified live). Paged with a
keyset cursor (`where=OBJECTID > <last_objectid>`, `orderByFields=OBJECTID`,
`resultRecordCount=2000`) rather than resultOffset, so a page never shifts
under us if rows are added upstream between requests. Requests are strictly
sequential with a small delay between them, and retried with exponential
backoff on a 5xx *or* on an ArcGIS "error" body returned with HTTP 200 (this
server does that on transient failures — checked live).

Each page's raw response body is written UNCHANGED into one local file, as
an RFC 8142 GeoJSON text sequence: 0x1E, then the exact response bytes, then
"\n" (verified live: no page body contains 0x1E or \n, so this is a safe,
lossless framing). The paging cursor {last_objectid, byte_offset,
pages_fetched, features_written, done} is checkpointed into
ops.pipeline_runs after every page, so a crashed run resumes by truncating
the local file back to its last checkpointed byte_offset (discarding any
partially-written page) and re-querying from last_objectid.

Once paging is done, the file's sha256 is computed, it is uploaded UNCHANGED
to Storage via the TUS resumable-upload endpoint (same pattern as
pipelines/sources/eaglei.py; reimplemented here rather than imported, since
each source module owns its own upload path), and one ops.source_manifest
row is written (source='tcad_geometry', url=the layer's query URL).

Loading into core.parcel_geoms then re-reads that same local file (not the
network) and, per feature:
  - a null geometry is skipped and counted as filter_drops.null_geometry
    (explicit in the ticket);
  - a null PROP_ID is skipped and counted as filter_drops.null_prop_id
    (not explicit in the ticket, but forced: PROP_ID is core.parcel_geoms's
    primary key, and 13,130 of 386,682 live features carry a real geometry
    but PROP_ID = geo_id = NULL -- verified live via
    `where=PROP_ID IS NULL&returnCountOnly=true`. These are unmatched
    geometries with no TCAD attribute join and cannot be keyed);
  - a repeated PROP_ID (first-seen wins, by ascending OBJECTID order) is
    skipped and counted as filter_drops.duplicate_prop_id, purely as
    insurance -- no duplicates were found live, but the primary key would
    otherwise make a second occurrence clobber the first with no record of
    the drop.
Geometry is built server-side from the page's own GeoJSON geometry via
extensions.ST_GeomFromGeoJSON, normalized to MultiPolygon with ST_Multi, and
the centroid taken with ST_PointOnSurface (always inside the polygon,
unlike ST_Centroid). Rows are upserted in batches (ON CONFLICT (prop_id) DO
UPDATE), so a rerun of the load phase against the same file is idempotent.
"""
from __future__ import annotations

import base64
import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Literal

import httpx

from pipelines.core import config, db, manifest, runs, storage

SOURCE = "tcad_geometry"
LAYER_URL = (
    "https://gis.traviscountytx.gov/server1/rest/services/"
    "Boundaries_and_Jurisdictions/TCAD_public/MapServer/0"
)
QUERY_URL = f"{LAYER_URL}/query"

PAGE_SIZE = 2000
REQUEST_DELAY_SECONDS = 0.25  # politeness: sequential requests, small gap
MAX_RETRIES = 5
RETRY_BACKOFF_BASE_SECONDS = 2.0

RAW_DIR = Path(
    "/Users/maheshbabugorantla/Code/Hackathons/BasePower_Deep_Tech_Hackathon_Sep_25_2026_Mavericks"
    "/data/raw/tcad_geometry"
)
RAW_FILENAME = "tcad_public_layer0.geojsonseq"

TUS_CHUNK_BYTES = 6 * 1024 * 1024

FILTER_NAMES = ("null_geometry", "null_prop_id", "duplicate_prop_id")

Runner = Literal["cron", "cli"]


def _raw_file_path() -> Path:
    return RAW_DIR / RAW_FILENAME


# --------------------------------------------------------------------------
# Phase 1: page the ArcGIS layer, writing raw response bodies unchanged
# into one local GeoJSON-sequence file, resumable via a keyset cursor.
# --------------------------------------------------------------------------


def new_paging_state() -> dict[str, Any]:
    return {
        "last_objectid": 0,
        "byte_offset": 0,
        "pages_fetched": 0,
        "features_written": 0,
        "done": False,
    }


def _page_params(last_objectid: int) -> dict[str, Any]:
    return {
        "where": f"OBJECTID > {last_objectid}",
        "outFields": "PROP_ID,geo_id,OBJECTID",
        "orderByFields": "OBJECTID",
        "resultRecordCount": PAGE_SIZE,
        "outSR": 4326,
        "f": "geojson",
    }


def _fetch_page(last_objectid: int) -> tuple[bytes, dict[str, Any]]:
    """GET one page. Retries with exponential backoff on a 5xx response,
    a transport error, or an ArcGIS error body returned with HTTP 200 (all
    treated as transient). Returns (raw_response_bytes, parsed_json)."""
    params = _page_params(last_objectid)
    attempt = 0
    while True:
        attempt += 1
        try:
            resp = httpx.get(QUERY_URL, params=params, timeout=60.0)
        except httpx.TransportError:
            if attempt >= MAX_RETRIES:
                raise
            time.sleep(RETRY_BACKOFF_BASE_SECONDS ** attempt)
            continue

        if resp.status_code >= 500:
            if attempt >= MAX_RETRIES:
                resp.raise_for_status()
            time.sleep(RETRY_BACKOFF_BASE_SECONDS ** attempt)
            continue
        resp.raise_for_status()

        content = resp.content
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError:
            if attempt >= MAX_RETRIES:
                raise RuntimeError(f"non-JSON page response at last_objectid={last_objectid}")
            time.sleep(RETRY_BACKOFF_BASE_SECONDS ** attempt)
            continue

        if "error" in parsed:
            if attempt >= MAX_RETRIES:
                raise RuntimeError(f"ArcGIS error body at last_objectid={last_objectid}: {parsed['error']}")
            time.sleep(RETRY_BACKOFF_BASE_SECONDS ** attempt)
            continue

        return content, parsed


def fetch_all_pages(state: dict[str, Any] | None = None, *, on_checkpoint=None) -> dict[str, Any]:
    """Page the layer to completion (or until `state["done"]`), appending
    each page's raw bytes to the local raw file. Resumable: if `state`
    carries a nonzero byte_offset and the file already exists, truncates
    it to that offset first (discarding any partial page from a crash)
    before appending."""
    state = state or new_paging_state()
    path = _raw_file_path()
    RAW_DIR.mkdir(parents=True, exist_ok=True)

    resuming = path.is_file() and state["byte_offset"] > 0
    mode = "r+b" if resuming else "wb"
    with open(path, mode) as f:
        if resuming:
            f.seek(state["byte_offset"])
            f.truncate(state["byte_offset"])
        else:
            f.seek(0)

        while not state["done"]:
            content, parsed = _fetch_page(state["last_objectid"])
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

            if len(features) < PAGE_SIZE:
                state["done"] = True
                break

            time.sleep(REQUEST_DELAY_SECONDS)

    return state


# --------------------------------------------------------------------------
# sha256 of the finished raw file
# --------------------------------------------------------------------------


def _sha256_and_size(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


# --------------------------------------------------------------------------
# TUS resumable upload to Supabase Storage (same pattern as
# pipelines/sources/eaglei.py's _tus_* helpers, reimplemented here so this
# module owns its own upload path without modifying eaglei.py).
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


def _tus_upload_file(path: Path, *, base_url: str, service_key: str, bucket: str, object_name: str) -> None:
    length = path.stat().st_size
    location = _tus_create(
        base_url=base_url, service_key=service_key, bucket=bucket,
        object_name=object_name, content_type="application/octet-stream", length=length,
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
# upload + insert. Also (re)writes the raw-dir sidecar files.
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


def _write_sidecars(path: Path, sha256: str, *, retrieved_at: datetime) -> None:
    (RAW_DIR / "retrieved_at.txt").write_text(retrieved_at.isoformat() + "\n")
    (RAW_DIR / "SOURCE_URL.txt").write_text(QUERY_URL + "\n")
    (RAW_DIR / "SHA256SUMS").write_text(f"{sha256}  {path.name}\n")


def _ensure_manifest(runner: Runner, path: Path) -> dict[str, Any]:
    sha256, size = _sha256_and_size(path)

    existing = _existing_manifest(sha256)
    if existing is not None:
        _write_sidecars(path, sha256, retrieved_at=datetime.now(timezone.utc))
        return {"id": existing["id"], "sha256": sha256}

    base_url = config.supabase_url()
    service_key = config.supabase_secret_key()
    retrieved_at = datetime.now(timezone.utc)
    key = storage.storage_key(SOURCE, sha256, when=retrieved_at, ext=".geojsonseq")

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
            url=QUERY_URL,
            retrieved_at=retrieved_at,
            sha256=sha256,
            bytes_=size,
            rows=None,
            runner=runner,
            storage_key=key,
        )

    _write_sidecars(path, sha256, retrieved_at=retrieved_at)
    return {"id": manifest_id, "sha256": sha256}


def _set_manifest_rows(manifest_id: str, rows: int) -> None:
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute("update ops.source_manifest set rows = %s where id = %s", (rows, manifest_id))


# --------------------------------------------------------------------------
# Phase 2: load core.parcel_geoms from the local raw file (not the
# network). Idempotent (ON CONFLICT DO UPDATE), so rerunning it is safe.
# --------------------------------------------------------------------------


_UPSERT_SQL = """
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


def _iter_pages(path: Path) -> Iterator[dict[str, Any]]:
    """Yield each page's parsed JSON from the local RFC 8142 sequence
    file. Pages are delimited by 0x1E; no page body contains 0x1E or \n
    (verified live), so a plain split is exact and lossless."""
    data = path.read_bytes()
    for record in data.split(b"\x1e"):
        record = record.strip()
        if not record:
            continue
        yield json.loads(record)


def new_load_state() -> dict[str, Any]:
    return {"rows_in": 0, "rows_loaded": 0, "filter_drops": {name: 0 for name in FILTER_NAMES}}


def load_core(conn, manifest_id: str, path: Path, *, batch_size: int = 1000) -> dict[str, Any]:
    state = new_load_state()
    seen_prop_ids: set[str] = set()
    batch_prop: list[str] = []
    batch_geo: list[str | None] = []
    batch_gj: list[str] = []

    def flush() -> None:
        if not batch_prop:
            return
        with conn.cursor() as cur:
            cur.execute(
                _UPSERT_SQL,
                {
                    "prop_ids": batch_prop,
                    "geo_ids": batch_geo,
                    "gjs": batch_gj,
                    "source_id": manifest_id,
                },
            )
        state["rows_loaded"] += len(batch_prop)
        batch_prop.clear()
        batch_geo.clear()
        batch_gj.clear()

    for page in _iter_pages(path):
        for feat in page.get("features") or []:
            state["rows_in"] += 1
            props = feat.get("properties") or {}
            prop_id = props.get("PROP_ID")
            geom = feat.get("geometry")

            if geom is None:
                state["filter_drops"]["null_geometry"] += 1
                continue
            if prop_id is None:
                state["filter_drops"]["null_prop_id"] += 1
                continue

            prop_id_str = str(int(prop_id))
            if prop_id_str in seen_prop_ids:
                state["filter_drops"]["duplicate_prop_id"] += 1
                continue
            seen_prop_ids.add(prop_id_str)

            geo_id = props.get("geo_id")
            batch_prop.append(prop_id_str)
            batch_geo.append(str(geo_id) if geo_id is not None else None)
            batch_gj.append(json.dumps(geom))

            if len(batch_prop) >= batch_size:
                flush()

    flush()
    return state


def rows_loaded(state: dict[str, Any]) -> int:
    return state["rows_in"] - sum(state["filter_drops"].values())


# --------------------------------------------------------------------------
# Resumable paging cursor lookup
# --------------------------------------------------------------------------


def _find_resumable_paging_cursor() -> dict[str, Any] | None:
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select cursor
                from ops.pipeline_runs
                where source = %s and status != 'success'
                order by started_at desc
                limit 1
                """,
                (SOURCE,),
            )
            row = cur.fetchone()
    if row is None or row[0] is None:
        return None
    return row[0]


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------


def run(*, runner: Runner, backfill: bool = False, cursor: dict[str, Any] | None = None) -> None:
    paging_state = cursor
    if paging_state is None and backfill:
        paging_state = _find_resumable_paging_cursor()
    if paging_state is None:
        paging_state = new_paging_state()

    with db.connect(pooled=False) as conn:
        run_id = runs.start(conn, source=SOURCE, runner=runner, cursor=paging_state)

    def checkpoint(state: dict[str, Any]) -> None:
        with db.connect(pooled=False) as c:
            runs.finish(c, run_id, status="running", cursor=state)

    try:
        paging_state = fetch_all_pages(paging_state, on_checkpoint=checkpoint)
        path = _raw_file_path()

        manifest_row = _ensure_manifest(runner, path)
        manifest_id = manifest_row["id"]

        with db.connect(pooled=False) as conn:
            with conn.cursor() as cur:
                cur.execute("update ops.pipeline_runs set manifest_id = %s where id = %s", (manifest_id, run_id))

        with db.connect(pooled=False) as conn:
            load_state = load_core(conn, manifest_id, path)

        _set_manifest_rows(manifest_id, load_state["rows_in"])

        with db.connect(pooled=False) as conn:
            runs.finish(
                conn, run_id, status="success",
                rows_in=load_state["rows_in"], rows_loaded=load_state["rows_loaded"],
                filter_drops=load_state["filter_drops"], cursor=paging_state,
            )
    except Exception as exc:
        with db.connect(pooled=False) as conn:
            runs.finish(conn, run_id, status="failed", error=str(exc), cursor=paging_state)
        raise
