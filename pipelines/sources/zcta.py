"""TIGER/Line 2024 ZCTA5 (national) -> core.zcta, scoped to ZCTAs that
actually intersect Travis (48453) or Harris (48201) county block groups.

Source file: the Census TIGER/Line 2024 national ZCTA5 shapefile bundle
(one zip holding .shp/.shx/.dbf/.prj/.cpg/.iso.xml), ~500 MB+:

    https://www2.census.gov/geo/tiger/TIGER2024/ZCTA520/tl_2024_us_zcta520.zip

Fetch: `run()` fetches this URL fresh over the network by default. For
this ticket the file was already downloaded once into the main
checkout; set env var ZCTA_LOCAL_FILE to that path to reuse it instead
of re-downloading (its sha256 is still computed and used exactly as if
freshly fetched — the manifest `url` is always the Census URL regardless
of which path supplied the bytes) — same convention as
sources/tiger_bg.py's TIGER_BG_LOCAL_FILE.

Storage: the raw zip (~500 MB+, over storage.TUS_THRESHOLD_BYTES) is
uploaded UNCHANGED to bucket `raw` via core.storage.upload_raw(), which
routes it through Supabase's TUS resumable-upload endpoint. Reused (no
re-upload) if a manifest row for the same sha256 already exists.

Parsing: the zip is extracted to a temp dir and read with pyshp (no
GDAL/PROJ dependency, same approach as tiger_bg.py). Each record's
ZCTA5CE20 field (the 5-digit ZIP code) and geometry come straight off
the shapefile's .dbf/.shp. The shapefile's native datum is NAD83
(EPSG:4269, confirmed from the .prj sidecar, same as tiger_bg.py's
TIGER file) — reprojected to EPSG:4326 by PostGIS at insert time, same
as tiger_bg.py.

Scope (this ticket's brief: "load only ZCTAs intersecting Travis+Harris"):
a national ZCTA file holds ~33.8k records — nationwide load is neither
needed nor sized for this milestone. Two-stage filter:

  1. Cheap prefix filter in Python: only ZCTA5 codes starting with one
     of PREFIXES (786-789 = greater Austin, 770-775 = greater Houston —
     these 3-digit ZIP prefix blocks are Texas-specific, so this is a
     coarse geographic net, not an exact county match) are even loaded
     into the staging table. This cuts ~33.8k candidate records down to
     ~450 before any spatial SQL runs.
  2. Exact spatial filter in SQL: of those ~450 candidates, only the ones
     that actually ST_Intersects a Travis (48453) or Harris (48201)
     core.block_groups polygon are inserted into core.zcta — dropping
     neighboring-county ZCTAs that share the same 3-digit prefix range
     but don't actually touch either target county. This is the precise
     "intersecting Travis+Harris" test the ticket asks for; the prefix
     filter is only there to avoid parsing/staging all 33.8k national
     records.

Not runnable on Vercel Hobby cron: this is a one-time/yearly-refresh,
CLI-only backfill (`python -m pipelines.run zcta --backfill`), like
tiger_bg.py — the ~500 MB+ download and extraction are far too large/slow
for a 300 s cron function anyway. `pyshp` is already in
pipelines/requirements.txt.
"""
from __future__ import annotations

import io
import os
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from typing import Any, Iterator, Literal

import shapefile  # pyshp

from pipelines.core import config, db, fetch, manifest, runs, storage

SOURCE = "zcta"
ZCTA_URL = "https://www2.census.gov/geo/tiger/TIGER2024/ZCTA520/tl_2024_us_zcta520.zip"
LOCAL_FILE_ENV = "ZCTA_LOCAL_FILE"
SHP_BASENAME = "tl_2024_us_zcta520"
SRC_SRID = 4269  # NAD83 — the shapefile's native datum (see its .prj)
DST_SRID = 4326  # WGS84 — core.zcta.geom's declared SRID
INSERT_CHUNK = 100
TARGET_COUNTY_FIPS = ("48453", "48201")  # Travis, Harris
PREFIXES = ("786", "787", "788", "789", "770", "771", "772", "773", "774", "775")

Runner = Literal["cron", "cli"]


# --------------------------------------------------------------------------
# Obtain the raw zip (network fetch, or a pre-downloaded local file)
# --------------------------------------------------------------------------


def _obtain_bytes() -> tuple[bytes, str, int]:
    """Return (content, sha256, bytes) of the raw tl_2024_us_zcta520.zip."""
    local = os.environ.get(LOCAL_FILE_ENV)
    if local and os.path.isfile(local):
        with open(local, "rb") as f:
            data = f.read()
        return data, fetch.sha256_of(data), len(data)

    fetched = fetch.fetch(ZCTA_URL, timeout=600.0)
    return fetched.content, fetched.sha256, fetched.bytes


# --------------------------------------------------------------------------
# Manifest: reuse an existing row for the same (source, sha256); otherwise
# upload + insert.
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


def _ensure_manifest(runner: Runner) -> dict[str, Any]:
    data, sha256, size = _obtain_bytes()

    existing = _existing_manifest(sha256)
    if existing is not None:
        return {"id": existing["id"], "storage_key": existing["storage_key"], "data": data, "sha256": sha256, "bytes": size}

    retrieved_at = datetime.now(timezone.utc)
    key = storage.storage_key(SOURCE, sha256, when=retrieved_at, ext=".zip")
    storage.upload_raw(data, key, content_type="application/zip")

    with db.connect(pooled=False) as conn:
        manifest_id = manifest.insert(
            conn,
            source=SOURCE,
            url=ZCTA_URL,
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
# Shapefile parsing (pyshp, no GDAL/PROJ) -> (zcta5, wkt), prefix-filtered
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
    shapely/GDAL dependency. Same logic as tiger_bg.py's `_polygon_wkt`
    (duplicated rather than imported — ticket boundary: this ticket owns
    only sources/zcta.py, not sources/tiger_bg.py)."""
    if geo["type"] == "Polygon":
        rings = geo["coordinates"]
        return "POLYGON(" + ", ".join(_ring_wkt(r) for r in rings) + ")"
    if geo["type"] == "MultiPolygon":
        polys = geo["coordinates"]
        poly_wkts = ["(" + ", ".join(_ring_wkt(r) for r in rings) + ")" for rings in polys]
        return "MULTIPOLYGON(" + ", ".join(poly_wkts) + ")"
    raise ValueError(f"unexpected geometry type {geo['type']!r} (expected Polygon/MultiPolygon)")


def read_candidate_records(shp_base: str) -> Iterator[tuple[str, str]]:
    """Yield (zcta5, wkt) for every record whose ZCTA5CE20 starts with one
    of PREFIXES — the coarse Texas-prefix net described in the module
    docstring, applied before any spatial SQL."""
    reader = shapefile.Reader(shp_base)
    for shape_record in reader.iterShapeRecords():
        fields = shape_record.record.as_dict()
        zcta5 = fields["ZCTA5CE20"]
        if not zcta5.startswith(PREFIXES):
            continue
        wkt = _polygon_wkt(shape_record.shape.__geo_interface__)
        yield zcta5, wkt


# --------------------------------------------------------------------------
# Load core.zcta via a staging temp table, then an exact spatial filter
# against Travis/Harris core.block_groups
# --------------------------------------------------------------------------


def _insert_staging_batch(cur, batch: list[tuple[str, str]]) -> None:
    row_sql = "(%s, extensions.ST_Multi(extensions.ST_Transform(extensions.ST_SetSRID(extensions.ST_GeomFromText(%s), %s), %s)))"
    values_sql = ", ".join(row_sql for _ in batch)
    params: list[Any] = []
    for zcta5, wkt in batch:
        params.extend([zcta5, wkt, SRC_SRID, DST_SRID])
    cur.execute(
        f"insert into _zcta_staging (zcta5, geom) values {values_sql}",
        params,
    )


def load_core(conn, manifest_id: str, candidates: Iterator[tuple[str, str]]) -> tuple[int, int]:
    """Stage every prefix-matched candidate, then insert into core.zcta
    only the ones that ST_Intersects a Travis or Harris core.block_groups
    polygon. Returns (rows_in, rows_loaded)."""
    rows_in = 0
    with conn.cursor() as cur:
        cur.execute("create temp table _zcta_staging (zcta5 text, geom extensions.geometry(MultiPolygon, 4326)) on commit drop")
        batch: list[tuple[str, str]] = []
        for zcta5, wkt in candidates:
            rows_in += 1
            batch.append((zcta5, wkt))
            if len(batch) >= INSERT_CHUNK:
                _insert_staging_batch(cur, batch)
                batch = []
        if batch:
            _insert_staging_batch(cur, batch)

        cur.execute(
            """
            insert into core.zcta (zcta5, geom, source_id)
            select distinct on (s.zcta5) s.zcta5, s.geom, %s
            from _zcta_staging s
            where exists (
                select 1
                from core.block_groups bg
                where bg.county_fips = any(%s)
                  and extensions.ST_Intersects(bg.geom, s.geom)
            )
            on conflict (zcta5) do update
                set geom      = excluded.geom,
                    source_id = excluded.source_id
            """,
            (manifest_id, list(TARGET_COUNTY_FIPS)),
        )
        rows_loaded = cur.rowcount
    return rows_in, rows_loaded


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

    tmp_dir = tempfile.mkdtemp(prefix="zcta_")
    try:
        shp_base = extract_shapefile(manifest_row["data"], tmp_dir)
        candidates = list(read_candidate_records(shp_base))
        rows_candidates = len(candidates)

        with db.connect(pooled=False) as conn:
            rows_in, rows_loaded = load_core(conn, manifest_id, iter(candidates))

        _set_manifest_rows(manifest_id, rows_candidates)
        filter_drops = {"not_intersecting_travis_harris": rows_in - rows_loaded}
        with db.connect(pooled=False) as conn:
            runs.finish(
                conn, run_id, status="success",
                rows_in=rows_in, rows_loaded=rows_loaded, filter_drops=filter_drops, cursor=None,
            )
    except Exception as exc:
        with db.connect(pooled=False) as conn:
            runs.finish(conn, run_id, status="failed", error=str(exc), cursor=None)
        raise
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
