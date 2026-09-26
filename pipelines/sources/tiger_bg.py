"""TIGER/Line block groups source: tl_2024_48_bg.zip -> core.block_groups.

Source file: Census TIGER/Line 2024 Texas block group shapefile bundle
(one zip holding .shp/.shx/.dbf/.prj):

    https://www2.census.gov/geo/tiger/TIGER2024/BG/tl_2024_48_bg.zip

Fetch: `run()` fetches this URL fresh over the network by default (the
cron / fresh-run path, via core.fetch.fetch — the zip is ~50 MB, small
enough to hold in memory unlike EAGLE-I's 1.4 GB file). For the backfill
the file was already downloaded once into the main checkout; set env var
TIGER_BG_LOCAL_FILE to that path to reuse it instead of re-downloading
(its sha256 is still computed and used exactly as if freshly fetched —
the manifest `url` is always the Census URL regardless of which path
supplied the bytes).

Storage: the raw zip is uploaded UNCHANGED to bucket `raw`, keyed
`tiger_bg/<date>/<sha256>.zip`. core/storage.upload_raw() goes through
supabase-py's create_client(), whose SyncClient.__init__ regex-checks
`supabase_key` as a 2/3-part JWT — the new `sb_secret_...` service-role
key format (this repo's SUPABASE_SECRET_KEY) has no dots, so that check
raises `SupabaseException("Invalid API key")` for every call, unrelated
to this ticket's data. `_upload_zip()` here bypasses the SDK client
entirely and PUTs directly to the Storage REST endpoint with a Bearer
header, the same low-level approach eaglei.py uses for its (much larger)
TUS resumable upload. Reused (no re-upload) if a manifest row for the
same sha256 already exists.

Parsing: the zip is extracted to a temp dir and read with pyshp
(`shapefile` package — pure Python, no GDAL/PROJ dependency, so it
installs cleanly on py3.12). Each record's GEOID and COUNTYFP fields
come straight off the shapefile's .dbf; county_fips is '48' + COUNTYFP
(Texas state FIPS + 3-digit county FIPS), per tickets/M1/M1-P2.md and
supabase/migrations/0101_m1.sql's core.block_groups contract.

Geometry: pyshp's `Shape.__geo_interface__` gives GeoJSON-style
Polygon/MultiPolygon coordinates in the shapefile's native datum (NAD83,
EPSG:4269, per the .prj sidecar and Census's TIGER/Line documentation).
`_polygon_wkt()` renders that into WKT text with no shapely/GDAL
dependency. The reprojection to EPSG:4326 (WGS84) that
core.block_groups.geom requires is then done by PostGIS itself at insert
time: `ST_Transform(ST_SetSRID(ST_GeomFromText(wkt), 4269), 4326)`,
wrapped in `ST_Multi(...)` so every row lands as a MultiPolygon (a small
number of block groups are single-part Polygons in the shapefile).

Not runnable on Vercel Hobby today: `pyshp` is not in
pipelines/requirements.txt (owned by M0-D1, outside this ticket's `owns`
paths), so the /cron/tiger_bg route would fail to import on Vercel until
someone adds it there. TIGER/Line is a yearly-refresh source anyway, so
only the CLI path (`runner="cli"`, via
`python -m pipelines.run tiger_bg --backfill`) is exercised for now —
same posture eaglei.py documents for its own 1.4 GB file. Run pytest and
the CLI with `uv run --with pyshp ...` until requirements.txt is
updated.

Never zero-fills: every Texas block group in the shapefile is loaded;
there is no filtering, so `filter_drops` is always empty and
`rows_loaded == rows_in` for every run (checked by
`python -m pipelines.check reconcile --source tiger_bg`).
"""
from __future__ import annotations

import io
import os
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from typing import Any, Iterator, Literal

import httpx
import shapefile  # pyshp

from pipelines.core import config, db, fetch, manifest, runs, storage

SOURCE = "tiger_bg"
TIGER_URL = "https://www2.census.gov/geo/tiger/TIGER2024/BG/tl_2024_48_bg.zip"
LOCAL_FILE_ENV = "TIGER_BG_LOCAL_FILE"
SHP_BASENAME = "tl_2024_48_bg"
SRC_SRID = 4269  # NAD83 — the shapefile's native datum (see its .prj)
DST_SRID = 4326  # WGS84 — core.block_groups.geom's declared SRID
INSERT_CHUNK = 300

Runner = Literal["cron", "cli"]


# --------------------------------------------------------------------------
# Obtain the raw zip (network fetch, or a pre-downloaded local file)
# --------------------------------------------------------------------------


def _obtain_bytes() -> tuple[bytes, str, int]:
    """Return (content, sha256, bytes) of the raw tl_2024_48_bg.zip."""
    local = os.environ.get(LOCAL_FILE_ENV)
    if local and os.path.isfile(local):
        with open(local, "rb") as f:
            data = f.read()
        return data, fetch.sha256_of(data), len(data)

    fetched = fetch.fetch(TIGER_URL)
    return fetched.content, fetched.sha256, fetched.bytes


# --------------------------------------------------------------------------
# Manifest: reuse an existing row for the same (source, sha256); otherwise
# upload + insert.
# --------------------------------------------------------------------------


def _upload_zip(data: bytes, key: str) -> None:
    """PUT `data` unchanged to bucket `raw` at `key`, direct against the
    Storage REST endpoint (bypasses supabase-py's create_client(), which
    rejects the sb_secret_ key format as an invalid JWT — see the module
    docstring). Raises on any non-2xx response."""
    base_url = config.supabase_url().rstrip("/")
    service_key = config.supabase_secret_key()
    url = f"{base_url}/storage/v1/object/{config.RAW_BUCKET}/{key}"
    headers = {
        "Authorization": f"Bearer {service_key}",
        "apikey": service_key,
        "Content-Type": "application/zip",
        "x-upsert": "true",
    }
    resp = httpx.put(url, headers=headers, content=data, timeout=120.0)
    resp.raise_for_status()


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
    data, sha256, size = _obtain_bytes()

    existing = _existing_manifest(sha256)
    if existing is not None:
        return {"id": existing["id"], "storage_key": existing["storage_key"], "data": data, "sha256": sha256, "bytes": size}

    retrieved_at = datetime.now(timezone.utc)
    key = storage.storage_key(SOURCE, sha256, when=retrieved_at, ext=".zip")
    _upload_zip(data, key)

    with db.connect(pooled=False) as conn:
        manifest_id = manifest.insert(
            conn,
            source=SOURCE,
            url=TIGER_URL,
            retrieved_at=retrieved_at,
            sha256=sha256,
            bytes_=size,
            rows=None,
            runner=runner,
            storage_key=key,
        )
    return {"id": manifest_id, "storage_key": key, "data": data, "sha256": sha256, "bytes": size}


def _set_manifest_rows(manifest_id: str, rows: int) -> None:
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute("update ops.source_manifest set rows = %s where id = %s", (rows, manifest_id))


# --------------------------------------------------------------------------
# Shapefile parsing (pyshp, no GDAL/PROJ) -> (geoid, county_fips, wkt)
# --------------------------------------------------------------------------


def extract_shapefile(data: bytes, dest_dir: str) -> str:
    """Extract the zip's .shp/.shx/.dbf/.prj bundle into dest_dir. Returns
    the shapefile basename path (no extension) to hand to shapefile.Reader."""
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        zf.extractall(dest_dir)
    return os.path.join(dest_dir, SHP_BASENAME)


def _ring_wkt(ring: list[tuple[float, float]]) -> str:
    return "(" + ", ".join(f"{x} {y}" for x, y in ring) + ")"


def _polygon_wkt(geo: dict[str, Any]) -> str:
    """Render a pyshp __geo_interface__ dict (Polygon or MultiPolygon,
    GeoJSON-style nested coordinate lists) as WKT text, with no
    shapely/GDAL dependency."""
    if geo["type"] == "Polygon":
        rings = geo["coordinates"]
        return "POLYGON(" + ", ".join(_ring_wkt(r) for r in rings) + ")"
    if geo["type"] == "MultiPolygon":
        polys = geo["coordinates"]
        poly_wkts = ["(" + ", ".join(_ring_wkt(r) for r in rings) + ")" for rings in polys]
        return "MULTIPOLYGON(" + ", ".join(poly_wkts) + ")"
    raise ValueError(f"unexpected geometry type {geo['type']!r} (expected Polygon/MultiPolygon)")


def read_records(shp_base: str) -> Iterator[tuple[str, str, str]]:
    """Yield (geoid, county_fips, wkt) for every record in the shapefile."""
    reader = shapefile.Reader(shp_base)
    for shape_record in reader.iterShapeRecords():
        fields = shape_record.record.as_dict()
        geoid = fields["GEOID"]
        county_fips = "48" + fields["COUNTYFP"]
        wkt = _polygon_wkt(shape_record.shape.__geo_interface__)
        yield geoid, county_fips, wkt


# --------------------------------------------------------------------------
# Load core.block_groups
# --------------------------------------------------------------------------


def _insert_batch(cur, batch: list[tuple[str, str, str, str]]) -> None:
    """One multi-row INSERT per chunk (not executemany): psycopg3's
    executemany auto-enables pipeline mode against this connection, which
    dropped the connection ('SSL error: bad length') when sending
    thousand-row chunks of large WKT text through the session pooler. A
    single ordinary INSERT with a VALUES list per chunk avoids that
    entirely."""
    row_sql = "(%s, %s, extensions.ST_Multi(extensions.ST_Transform(extensions.ST_SetSRID(extensions.ST_GeomFromText(%s), %s), %s)), %s)"
    values_sql = ", ".join(row_sql for _ in batch)
    params: list[Any] = []
    for geoid, county_fips, wkt, manifest_id in batch:
        params.extend([geoid, county_fips, wkt, SRC_SRID, DST_SRID, manifest_id])
    cur.execute(
        f"""
        insert into core.block_groups (geoid, county_fips, geom, source_id)
        values {values_sql}
        on conflict (geoid) do update
            set county_fips = excluded.county_fips,
                geom        = excluded.geom,
                source_id   = excluded.source_id
        """,
        params,
    )


def load_core(conn, manifest_id: str, records: Iterator[tuple[str, str, str]]) -> int:
    loaded = 0
    batch: list[tuple[str, str, str, str]] = []
    with conn.cursor() as cur:
        for geoid, county_fips, wkt in records:
            batch.append((geoid, county_fips, wkt, manifest_id))
            if len(batch) >= INSERT_CHUNK:
                _insert_batch(cur, batch)
                loaded += len(batch)
                batch = []
        if batch:
            _insert_batch(cur, batch)
            loaded += len(batch)
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

    tmp_dir = tempfile.mkdtemp(prefix="tiger_bg_")
    try:
        shp_base = extract_shapefile(manifest_row["data"], tmp_dir)
        records = list(read_records(shp_base))
        rows_in = len(records)

        with db.connect(pooled=False) as conn:
            loaded = load_core(conn, manifest_id, iter(records))

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
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
