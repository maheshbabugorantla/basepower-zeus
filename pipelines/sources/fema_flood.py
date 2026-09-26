"""FEMA National Flood Hazard Layer (NFHL) Flood Hazard Zones (S_FLD_HAZ_AR)
-> core.flood_zones, for Travis (48453) and Harris (48201).

Source: the public NFHL ArcGIS REST service. Its "Flood Hazard Zones"
layer (S_FLD_HAZ_AR) is layer id 28, found via a one-off
`https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer?f=json`
lookup (its `layers` array names it "Flood Hazard Zones"):

    https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query

Queried per county, by that county's real bbox from core.block_groups
(loaded by tiger_bg, M1-P2) — `COUNTY_ENVELOPES` below is the literal
result of
    select county_fips, ST_Extent(geom)
    from core.block_groups where county_fips in ('48453','48201')
    group by county_fips
against the live DB (block_groups shape never changes at runtime, so this
is checked in rather than re-queried every run) — with outSR=4326 and a
server-side `where SFHA_TF='T'` filter: core.flood_zones (0201_m2.sql)
has only `county_fips, fld_zone, geom, source_id` columns, no
SFHA_TF/ZONE_SUBTY/DFIRM_ID, and the only signal M2 needs is "inside the
100-year Special Flood Hazard Area", i.e. SFHA_TF='T' — so filtering
server-side both satisfies the ticket's "at minimum SFHA_TF='T'" floor
and keeps the pull small (~9.7k features total, well under the ~25 min
budget; ZONE_SUBTY/SFHA_TF/DFIRM_ID are still requested in `outFields` and
kept in the raw file for traceability, per the ticket, even though they
are not loaded into core.flood_zones).

Paging: the ticket asks for paging by OBJECTID (`where SFHA_TF='T' AND
OBJECTID > <cursor>`). That combination — `SFHA_TF='T' AND OBJECTID >
N`, for ANY N, with the envelope geometry filter — reproducibly returns
HTTP 202 with an empty body from this public server (confirmed by hand:
`SFHA_TF='T'` alone and `OBJECTID > N` alone each work fine; ANDing them
together does not, regardless of N or ordering). So paging instead uses
`resultOffset`/`resultRecordCount` with `orderByFields=OBJECTID ASC`
(confirmed working end-to-end, including on the last, partial page) —
still deterministic page order, just not an OBJECTID-cursor `where`.
PAGE_SIZE (1000) starts safely under the layer's documented
maxRecordCount of 2000 (`.../MapServer/28?f=json`), but this endpoint's
own failure threshold moves with which specific (heavy) polygons fall in
a given offset window, not with a fixed count — confirmed by hand: the
identical (offset, outFields) request can succeed at resultRecordCount
1000 yet fail (HTTP 200 body carrying `{"error": {"code": 500, ...}}`)
at 200 for a different offset, and succeed again at 100. So `_fetch_page`
treats that error body as retryable: it halves the requested record
count (down to MIN_PAGE_SIZE) and retries the SAME offset until a page
succeeds, and the caller advances its offset by however many features
actually came back — never fewer than requested unless the server itself
shrank the page, so no feature is ever skipped.

Raw file: every page's raw response bytes are written UNCHANGED (no
re-serialization), one per line, to one ndjson file under
data/raw/fema_flood/ in the MAIN checkout (never git-added — see
AGENTS/CLAUDE.md's real-data rule), Travis's pages first, then Harris's.
Sidecars in the same dir: retrieved_at.txt, SOURCE_URL.txt (base query
template — the literal per-request geometry/cursor vary per call),
SHA256SUMS.

Geometry: an Esri JSON polygon's `rings` is a flat list mixing exterior
rings (clockwise) and interior hole rings (counterclockwise), per Esri's
documented ArcGIS REST API polygon convention. `rings_to_multipolygon_wkt`
regroups them into a WKT MULTIPOLYGON using each ring's signed area
(negative/clockwise -> new polygon; non-negative/counterclockwise -> hole
of the polygon just opened) — no shapely/GDAL dependency, same posture as
tiger_bg.py's `_polygon_wkt` (which needs no such regrouping because
GeoJSON already nests rings per polygon). outSR=4326 means no
reprojection is needed at insert time, only
`ST_Multi(ST_GeomFromText(wkt, 4326))`.

county_fips: an envelope is a bounding box, not the county's real
boundary, so a Travis-envelope query also returns neighboring counties'
polygons whose bbox happens to overlap (confirmed by hand: the first
Travis-envelope page came back DFIRM_ID 48053C/48491C — Burnet/Williamson
County, not Travis at all). Esri's NFHL DFIRM_ID convention is
`<5-digit county FIPS><letter>` (a countywide DFIRM's letter is 'C'), so
`dfirm_county_fips()` derives the true county from DFIRM_ID's first 5
characters, and any feature whose derived county isn't Travis or Harris
is dropped (filter_drops["other_county_dfirm"]) — never assigned the
envelope's own county_fips, which would be invented data.

Idempotency: a rerun against the same content (same sha256) reuses the
existing ops.source_manifest row (no re-upload) and skips re-inserting
into core.flood_zones if rows already exist for that manifest id (the
table has no natural unique key to upsert on beyond its own uuid pk).
"""
from __future__ import annotations

import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import httpx

from pipelines.core import config, db, manifest, runs, storage

SOURCE = "fema_flood"
NFHL_QUERY_URL = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query"
# Layer 28 reports maxRecordCount=2000 (.../MapServer/28?f=json), but this
# public server's query endpoint returns an HTTP 200 body carrying
# {"error": {"code": 500, ...}} once a page's specific polygons are large
# enough to serialize (confirmed by hand: the SAME offset can succeed at
# 1000 records yet fail at 200, and a DIFFERENT offset can fail at 1000
# but succeed at 100 — it tracks which polygons land in the page, not a
# fixed count). 1000 is just a starting point comfortably under the
# documented maxRecordCount; _fetch_page() below halves it per-offset on
# error (see its docstring).
PAGE_SIZE = 1000

# (xmin, ymin, xmax, ymax), EPSG:4326 — see module docstring for how these
# were derived (real ST_Extent(geom) over the live core.block_groups).
COUNTY_ENVELOPES: dict[str, tuple[float, float, float, float]] = {
    "48453": (-98.172977, 30.023451, -97.369539, 30.628249),  # Travis
    "48201": (-95.960733, 29.497297, -94.908492, 30.170606),  # Harris
    # Williamson (M3-P5): live ST_Extent(geom) over core.block_groups
    # where county_fips='48491' (TIGER, already loaded) -- same recipe
    # the module docstring documents for Travis/Harris.
    "48491": (-98.049886, 30.402843, -97.155219, 30.904414),  # Williamson
}

OUT_FIELDS = "FLD_ZONE,ZONE_SUBTY,SFHA_TF,DFIRM_ID,OBJECTID"
SFHA_WHERE = "SFHA_TF='T'"

RAW_DIR = Path(
    "/Users/maheshbabugorantla/Code/Hackathons/BasePower_Deep_Tech_Hackathon_Sep_25_2026_Mavericks"
    "/data/raw/fema_flood"
)

INSERT_CHUNK = 50

Runner = Literal["cron", "cli"]


# ---------------------------------------------------------------------------
# Fetch: page one county's envelope by resultOffset (ordered by OBJECTID),
# write raw bytes unchanged
# ---------------------------------------------------------------------------


def source_url_template() -> str:
    """The base query shape (county envelope and page offset vary per
    request), for SOURCE_URL.txt."""
    return (
        f"{NFHL_QUERY_URL}?geometry=<county-envelope>&geometryType=esriGeometryEnvelope"
        f"&inSR=4326&spatialRel=esriSpatialRelIntersects"
        f"&where={SFHA_WHERE}"
        f"&outFields={OUT_FIELDS}&outSR=4326&orderByFields=OBJECTID ASC"
        f"&resultOffset=<offset>&resultRecordCount={PAGE_SIZE}&f=json"
    )


MIN_PAGE_SIZE = 1


def _is_error_body(content: bytes) -> bool:
    try:
        doc = json.loads(content)
    except json.JSONDecodeError:
        return False
    return isinstance(doc, dict) and "error" in doc


def _fetch_page_raw(
    envelope: tuple[float, float, float, float],
    offset: int,
    record_count: int,
    *,
    client: httpx.Client,
    return_geometry: bool = True,
) -> bytes:
    xmin, ymin, xmax, ymax = envelope
    params = {
        "geometry": f"{xmin},{ymin},{xmax},{ymax}",
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "where": SFHA_WHERE,
        "outFields": OUT_FIELDS,
        "outSR": "4326",
        "orderByFields": "OBJECTID ASC",
        "resultOffset": str(offset),
        "resultRecordCount": str(record_count),
        "returnGeometry": "true" if return_geometry else "false",
        "f": "json",
    }
    resp = client.get(NFHL_QUERY_URL, params=params, timeout=120.0)
    resp.raise_for_status()
    return resp.content


def _fetch_page(
    envelope: tuple[float, float, float, float],
    offset: int,
    *,
    client: httpx.Client,
) -> bytes:
    """GET one page, starting at PAGE_SIZE records and halving down to
    MIN_PAGE_SIZE on failure, then (only at the floor) retrying once more
    with returnGeometry=false.

    This public server's query endpoint returns HTTP 200 with a body of
    `{"error": {"code": 500, ...}}` for this heavy-geometry layer once a
    page's serialized response would be too large or too complex —
    confirmed by hand: the SAME (envelope, offset) request fails at
    resultRecordCount=200 but succeeds at 100, and this varies by offset
    (which specific polygons fall in that page), not by a fixed record
    count. So an error body is retried like a transient failure: halve
    the requested record count and retry the SAME offset, down to
    MIN_PAGE_SIZE (1). If even a single feature's geometry can't be
    served, retry that one feature once more with returnGeometry=false
    (its FLD_ZONE is still real data; its geometry is then genuinely
    absent, not invented, so the caller drops it as missing_geometry and
    still advances past it) before giving up for real. The caller always
    advances its offset by however many features actually came back, so
    a shrunk page never causes any feature to be skipped."""
    record_count = PAGE_SIZE
    while True:
        content = _fetch_page_raw(envelope, offset, record_count, client=client)
        if not _is_error_body(content):
            return content
        if record_count > MIN_PAGE_SIZE:
            record_count = max(MIN_PAGE_SIZE, record_count // 2)
            time.sleep(1.0)
            continue
        content = _fetch_page_raw(
            envelope, offset, record_count, client=client, return_geometry=False
        )
        if not _is_error_body(content):
            return content
        raise RuntimeError(
            f"NFHL query error at offset={offset}, even at the floor "
            f"resultRecordCount={MIN_PAGE_SIZE} with returnGeometry=false: {content!r}"
        )


def parse_features(page_bytes: bytes) -> list[dict[str, Any]]:
    doc = json.loads(page_bytes)
    if "error" in doc:
        raise RuntimeError(f"NFHL query error: {doc['error']}")
    return doc.get("features", [])


# ---------------------------------------------------------------------------
# Geometry: Esri JSON rings -> WKT MULTIPOLYGON (no shapely/GDAL)
# ---------------------------------------------------------------------------


def _ring_wkt(ring: list[list[float]]) -> str:
    return "(" + ", ".join(f"{x} {y}" for x, y in ring) + ")"


def _signed_area(ring: list[list[float]]) -> float:
    """Shoelace signed area. Negative = clockwise (Esri exterior ring
    convention); non-negative = counterclockwise (Esri interior/hole
    ring convention)."""
    area = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        area += x1 * y2 - x2 * y1
    return area / 2.0


def rings_to_multipolygon_wkt(rings: list[list[list[float]]]) -> str:
    """Regroup a flat Esri JSON `rings` list into a WKT MULTIPOLYGON.
    Each clockwise ring opens a new polygon; each counterclockwise ring
    is a hole belonging to the polygon most recently opened — see module
    docstring for why (Esri's documented ring-orientation convention)."""
    if not rings:
        raise ValueError("empty rings list")
    polygons: list[list[list[list[float]]]] = []
    for ring in rings:
        if not polygons or _signed_area(ring) < 0:
            polygons.append([ring])
        else:
            polygons[-1].append(ring)
    poly_wkts = [
        "(" + ", ".join(_ring_wkt(r) for r in rings_group) + ")" for rings_group in polygons
    ]
    return "MULTIPOLYGON(" + ", ".join(poly_wkts) + ")"


def dfirm_county_fips(dfirm_id: Any) -> str | None:
    """The first 5 characters of an NFHL DFIRM_ID are the county FIPS
    code (Esri convention: `<5-digit county FIPS><letter>`, the letter
    'C' for a countywide DFIRM) — see module docstring for why this,
    rather than the query envelope's own county, is the source of truth
    for county_fips."""
    if not isinstance(dfirm_id, str) or len(dfirm_id) < 5:
        return None
    return dfirm_id[:5]


def feature_to_row(feature: dict[str, Any]) -> tuple[str, str, str] | None:
    """(county_fips, fld_zone, wkt) for one Esri JSON feature, or None if
    it has no FLD_ZONE, doesn't resolve (via DFIRM_ID) to Travis or
    Harris, or has no polygon rings — never invented, just dropped
    (counted by the caller, which re-checks these same conditions to
    attribute the right drop reason)."""
    attrs = feature.get("attributes", {})
    fld_zone = attrs.get("FLD_ZONE")
    county_fips = dfirm_county_fips(attrs.get("DFIRM_ID"))
    if not fld_zone or county_fips not in COUNTY_ENVELOPES:
        return None
    rings = feature.get("geometry", {}).get("rings")
    if not rings:
        return None
    wkt = rings_to_multipolygon_wkt(rings)
    return county_fips, fld_zone, wkt


# ---------------------------------------------------------------------------
# Fetch every county's pages, write the raw ndjson file
# ---------------------------------------------------------------------------


def fetch_all(dest_path: Path) -> dict[str, Any]:
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    total_bytes = 0
    rows_in = 0
    drop_no_fld_zone = 0
    drop_other_county = 0
    drop_no_geometry = 0
    loaded_rows: list[tuple[str, str, str]] = []

    with httpx.Client(follow_redirects=True) as client, open(dest_path, "wb") as out:
        for envelope in COUNTY_ENVELOPES.values():
            offset = 0
            while True:
                page_bytes = _fetch_page(envelope, offset, client=client)
                line = page_bytes + b"\n"
                out.write(line)
                digest.update(line)
                total_bytes += len(line)

                features = parse_features(page_bytes)
                if not features:
                    # The definitive end of this county's results: an
                    # empty page. A page shorter than requested is NOT
                    # used as an early-stop signal, since _fetch_page may
                    # have silently shrunk resultRecordCount below what
                    # was asked for to work around a server error, in
                    # which case a short page does not mean "no more
                    # data" — an earlier version of this loop broke on a
                    # shrunk short page, silently truncating Travis's
                    # results to ~1125 of its real ~1405 rows.
                    break

                for feature in features:
                    rows_in += 1
                    row = feature_to_row(feature)
                    if row is not None:
                        loaded_rows.append(row)
                        continue
                    attrs = feature.get("attributes", {})
                    if not attrs.get("FLD_ZONE"):
                        drop_no_fld_zone += 1
                    elif dfirm_county_fips(attrs.get("DFIRM_ID")) not in COUNTY_ENVELOPES:
                        drop_other_county += 1
                    else:
                        drop_no_geometry += 1

                offset += len(features)

    return {
        "rows_in": rows_in,
        "rows": loaded_rows,
        "filter_drops": {
            "missing_fld_zone": drop_no_fld_zone,
            "other_county_dfirm": drop_other_county,
            "missing_geometry": drop_no_geometry,
        },
        "sha256": digest.hexdigest(),
        "bytes": total_bytes,
    }


# ---------------------------------------------------------------------------
# Manifest (reuse an existing row for the same sha256; else upload + insert)
# ---------------------------------------------------------------------------


def _write_sidecars(dest_path: Path, retrieved_at: datetime, sha256: str) -> None:
    name = dest_path.name
    (RAW_DIR / "SOURCE_URL.txt").write_text(source_url_template() + "\n")
    (RAW_DIR / "retrieved_at.txt").write_text(
        f"{retrieved_at.isoformat().replace('+00:00', 'Z')} {name}\n"
    )
    (RAW_DIR / "SHA256SUMS").write_text(f"{sha256}  {name}\n")


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


def _ensure_manifest(runner: Runner, dest_path: Path) -> dict[str, Any]:
    fetch_result = fetch_all(dest_path)
    retrieved_at = datetime.now(timezone.utc)
    sha256 = fetch_result["sha256"]
    _write_sidecars(dest_path, retrieved_at, sha256)

    existing = _existing_manifest(sha256)
    if existing is not None:
        manifest_id = existing["id"]
    else:
        content = dest_path.read_bytes()
        key = storage.storage_key(SOURCE, sha256, when=retrieved_at, ext=".ndjson")
        storage.upload_raw(content, key, content_type="application/x-ndjson")
        with db.connect(pooled=False) as conn:
            manifest_id = manifest.insert(
                conn,
                source=SOURCE,
                url=source_url_template(),
                retrieved_at=retrieved_at,
                sha256=sha256,
                bytes_=fetch_result["bytes"],
                rows=fetch_result["rows_in"],
                runner=runner,
                storage_key=key,
            )

    return {
        "id": manifest_id,
        "rows_in": fetch_result["rows_in"],
        "rows": fetch_result["rows"],
        "filter_drops": fetch_result["filter_drops"],
    }


# ---------------------------------------------------------------------------
# Load core.flood_zones
# ---------------------------------------------------------------------------


def _already_loaded(conn, manifest_id: str) -> int:
    with conn.cursor() as cur:
        cur.execute("select count(*) from core.flood_zones where source_id = %s", (manifest_id,))
        row = cur.fetchone()
        assert row is not None
        return row[0]


def _insert_batch(cur, batch: list[tuple[str, str, str, str]]) -> None:
    row_sql = "(%s, %s, extensions.ST_Multi(extensions.ST_GeomFromText(%s, 4326)), %s)"
    values_sql = ", ".join(row_sql for _ in batch)
    params: list[Any] = []
    for county_fips, fld_zone, wkt, manifest_id in batch:
        params.extend([county_fips, fld_zone, wkt, manifest_id])
    cur.execute(
        f"""
        insert into core.flood_zones (county_fips, fld_zone, geom, source_id)
        values {values_sql}
        """,
        params,
    )


def load_core(conn, manifest_id: str, rows: list[tuple[str, str, str]]) -> int:
    loaded = 0
    batch: list[tuple[str, str, str, str]] = []
    with conn.cursor() as cur:
        for county_fips, fld_zone, wkt in rows:
            batch.append((county_fips, fld_zone, wkt, manifest_id))
            if len(batch) >= INSERT_CHUNK:
                _insert_batch(cur, batch)
                loaded += len(batch)
                batch = []
        if batch:
            _insert_batch(cur, batch)
            loaded += len(batch)
    return loaded


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def run(*, runner: Runner, backfill: bool = False, cursor: dict[str, Any] | None = None) -> None:
    retrieved_at = datetime.now(timezone.utc)
    dest_path = RAW_DIR / f"fema_flood_{retrieved_at.strftime('%Y%m%d')}.ndjson"

    manifest_row = _ensure_manifest(runner, dest_path)
    manifest_id = manifest_row["id"]
    loaded_count = len(manifest_row["rows"])

    with db.connect(pooled=False) as conn:
        run_id = runs.start(conn, source=SOURCE, runner=runner)
        with conn.cursor() as cur:
            cur.execute(
                "update ops.pipeline_runs set manifest_id = %s where id = %s",
                (manifest_id, run_id),
            )

    try:
        with db.connect(pooled=False) as conn:
            already = _already_loaded(conn, manifest_id)
            if already == 0:
                load_core(conn, manifest_id, manifest_row["rows"])

        with db.connect(pooled=False) as conn:
            runs.finish(
                conn,
                run_id,
                status="success",
                rows_in=manifest_row["rows_in"],
                rows_loaded=loaded_count,
                filter_drops=manifest_row["filter_drops"],
                cursor=None,
            )
    except Exception as exc:
        with db.connect(pooled=False) as conn:
            runs.finish(conn, run_id, status="failed", error=str(exc), cursor=None)
        raise
