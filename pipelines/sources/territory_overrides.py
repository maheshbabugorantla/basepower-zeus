"""City of Austin "Austin Energy Service Area" polygon (Socrata w5fd-ctq4)
-> override for core.territories row eia_id='1015'.

Why this module exists (M2-H2 finding): the HIFLD mirror's Austin Energy
polygon (`pipelines/sources/territories.py`, ~847 km^2) disagrees with the
City of Austin's own official service-area polygon (~1,131 km^2) for
~29% of gated Travis homes near the boundary -- 33,089 homes pass the
territory gate under the HIFLD polygon but sit outside the official
polygon, and 28,939 are excluded under HIFLD but sit inside the official
polygon. Austin Energy is a municipal utility that draws and publishes
its own service-area boundary, so that boundary is the more authoritative
source for this one utility; this module overrides core.territories.geom
for eia_id='1015' with it, without touching any other territory row (no
other utility publishes a directly comparable authoritative polygon, so
this is a targeted override, not a general replacement of the HIFLD
territories load).

Raw file: already staged, read-only, in the MAIN checkout --
    data/raw/austin_energy_service_area/austin_energy_service_area.json
    data/raw/austin_energy_service_area/SOURCE_URL.txt   -> manifest `url`
    data/raw/austin_energy_service_area/retrieved_at.txt -> manifest `retrieved_at`
    data/raw/austin_energy_service_area/SHA256SUMS       -> expected sha256
(a plain Socrata `.json` export of resource w5fd-ctq4: a JSON array of one
record, whose `the_geom` field is a GeoJSON MultiPolygon). Bytes are
hashed and checked against SHA256SUMS before anything is uploaded or
updated -- a mismatch stops the run (real-data rule: never substitute or
silently proceed on a changed file). TERRITORY_OVERRIDES_LOCAL_FILE
overrides the default path (e.g. to point at a fixture), same convention
as sources/territories.py's TERRITORIES_LOCAL_FILE.

Geometry: `the_geom` is plain GeoJSON (not WKB), lon/lat, unspecified but
documented-WGS84 CRS (Austin's open-data portal publishes all point/
polygon layers in EPSG:4326) -- loaded via
`extensions.ST_GeomFromGeoJSON` with an explicit `ST_SetSRID(..., 4326)`
(never ST_Transform -- there is nothing to transform from). The geometry
is run through `ST_MakeValid` + `ST_CollectionExtract(..., 3)` (keep only
polygonal parts -- ST_MakeValid can return a mixed GeometryCollection for
an invalid input) before the final `ST_Multi`, so a not-quite-valid
source ring never breaks the update; core.territories.geom is declared
`MultiPolygon`, so the CollectionExtract step is required for that column
type to accept whatever ST_MakeValid hands back.

Load: this module does NOT insert a new core.territories row. It UPDATEs
the existing eia_id='1015' row's `geom` and `source_id` in place. That
row must already exist (loaded by `territories` from the HIFLD mirror) --
if it does not, this raises loudly rather than silently inserting a
made-up row (the real-data rule: never substitute). Ordering: because
this module UPDATEs a row `territories` also writes, **it must be re-run
after every `territories` reload** (a HIFLD-mirror backfill would
overwrite eia_id='1015'.geom back to the HIFLD polygon and undo this
override) -- `territories.py` does not call this module itself (ticket
boundary: this file owns that ordering fact, `territories.py` is
contract_in/read-only here), so whatever runs backfills must invoke
`python -m pipelines.run territory_overrides --backfill` immediately
after `python -m pipelines.run territories --backfill`, every time.

ops.pipeline_runs bookkeeping: rows_in=1, rows_loaded=1 (one polygon
overrides exactly one core.territories row), no filter_drops (nothing is
ever filtered here -- the file's one record is always the one used).
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pipelines.core import db, fetch, manifest, runs, storage

SOURCE = "austin_energy_service_area"

RAW_DIR = Path(
    "/Users/maheshbabugorantla/Code/Hackathons/BasePower_Deep_Tech_Hackathon_Sep_25_2026_Mavericks"
    "/data/raw/austin_energy_service_area"
)
DEFAULT_JSON = RAW_DIR / "austin_energy_service_area.json"
SOURCE_URL_FILE = RAW_DIR / "SOURCE_URL.txt"
RETRIEVED_AT_FILE = RAW_DIR / "retrieved_at.txt"
SHA256SUMS_FILE = RAW_DIR / "SHA256SUMS"

LOCAL_FILE_ENV = "TERRITORY_OVERRIDES_LOCAL_FILE"

# The one core.territories row this module overrides -- Austin Energy's
# EIA-861 utility number (see 0201_m2.sql's core.territories comment).
TARGET_EIA_ID = "1015"

DST_SRID = 4326

Runner = Literal["cron", "cli"]


# --------------------------------------------------------------------------
# Raw file + its sidecars (already staged in the main checkout)
# --------------------------------------------------------------------------


def _json_path() -> Path:
    override = os.environ.get(LOCAL_FILE_ENV)
    return Path(override) if override else DEFAULT_JSON


def _expected_sha256() -> str:
    """Parse SHA256SUMS (`<hex>  <filename>` lines) for the json file's own
    filename and return its expected hash."""
    text = SHA256SUMS_FILE.read_text()
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) == 2 and parts[1].strip() == _json_path().name:
            return parts[0]
    raise RuntimeError(f"no SHA256SUMS entry for {_json_path().name!r} in {SHA256SUMS_FILE}")


def source_url() -> str:
    return SOURCE_URL_FILE.read_text().strip()


def retrieved_at() -> datetime:
    text = RETRIEVED_AT_FILE.read_text().strip()
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def _obtain_bytes() -> tuple[bytes, str, int]:
    """Read the staged json's raw bytes, verify its sha256 against
    SHA256SUMS (stop, never substitute, on a mismatch), and return
    (content, sha256, bytes)."""
    path = _json_path()
    with open(path, "rb") as f:
        data = f.read()
    sha256 = fetch.sha256_of(data)
    expected = _expected_sha256()
    if sha256 != expected:
        raise RuntimeError(
            f"{path} sha256 {sha256} does not match SHA256SUMS entry {expected} -- "
            "real-data rule: refusing to load a changed/corrupt file"
        )
    return data, sha256, len(data)


# --------------------------------------------------------------------------
# Manifest: reuse an existing row for the same (source, sha256); else
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
        return {"id": existing["id"], "storage_key": existing["storage_key"], "sha256": sha256, "bytes": size}

    when = retrieved_at()
    key = storage.storage_key(SOURCE, sha256, when=when, ext=".json")
    storage.upload_raw(data, key, content_type="application/json")

    with db.connect(pooled=False) as conn:
        manifest_id = manifest.insert(
            conn,
            source=SOURCE,
            url=source_url(),
            retrieved_at=when,
            sha256=sha256,
            bytes_=size,
            rows=1,
            runner=runner,
            storage_key=key,
        )
    return {"id": manifest_id, "storage_key": key, "sha256": sha256, "bytes": size}


# --------------------------------------------------------------------------
# Parse: JSON array of 1 Socrata record -> its the_geom (GeoJSON dict)
# --------------------------------------------------------------------------


def read_the_geom(path: Path | str) -> dict[str, Any]:
    """Read the staged json array and return its single record's
    `the_geom` GeoJSON dict. Raises if the file does not hold exactly one
    record with a `the_geom` field -- this module has no fallback for a
    reshaped export (real-data rule: never substitute a guess)."""
    with open(path, "r", encoding="utf-8") as f:
        records = json.load(f)
    if not isinstance(records, list) or len(records) != 1:
        raise RuntimeError(
            f"{path} expected exactly 1 Socrata record, got "
            f"{len(records) if isinstance(records, list) else type(records)!r}"
        )
    the_geom = records[0].get("the_geom")
    if not isinstance(the_geom, dict) or the_geom.get("type") != "MultiPolygon":
        raise RuntimeError(f"{path} record 0 has no MultiPolygon the_geom (got {the_geom!r})")
    return the_geom


# --------------------------------------------------------------------------
# Override core.territories.geom for TARGET_EIA_ID
# --------------------------------------------------------------------------


def override_territory(conn, manifest_id: str, the_geom: dict[str, Any]) -> int:
    """UPDATE core.territories SET geom, source_id for TARGET_EIA_ID. The
    row must already exist (loaded by `territories.py` from the HIFLD
    mirror) -- raises loudly if it does not, per the real-data rule
    (never insert a made-up row here). Returns the number of rows updated
    (always 1 on success)."""
    geojson_text = json.dumps(the_geom)
    with conn.cursor() as cur:
        cur.execute(
            """
            update core.territories
            set geom = extensions.ST_Multi(
                            extensions.ST_CollectionExtract(
                                case
                                    when extensions.ST_IsValid(g.raw_geom) then g.raw_geom
                                    else extensions.ST_MakeValid(g.raw_geom)
                                end,
                                3
                            )
                        ),
                source_id = %(manifest_id)s
            from (
                select extensions.ST_SetSRID(
                           extensions.ST_GeomFromGeoJSON(%(geojson)s), %(srid)s
                       ) as raw_geom
            ) g
            where core.territories.eia_id = %(eia_id)s
            """,
            {
                "geojson": geojson_text,
                "srid": DST_SRID,
                "manifest_id": manifest_id,
                "eia_id": TARGET_EIA_ID,
            },
        )
        updated = cur.rowcount
    if updated != 1:
        raise RuntimeError(
            f"core.territories has no row for eia_id={TARGET_EIA_ID!r} -- "
            "run `python -m pipelines.run territories --backfill` first "
            "(real-data rule: refusing to insert a made-up row here)"
        )
    return updated


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

    try:
        the_geom = read_the_geom(_json_path())

        with db.connect(pooled=False) as conn:
            rows_loaded = override_territory(conn, manifest_id, the_geom)

        with db.connect(pooled=False) as conn:
            runs.finish(
                conn, run_id, status="success",
                rows_in=1, rows_loaded=rows_loaded, filter_drops={}, cursor=None,
            )
    except Exception as exc:
        with db.connect(pooled=False) as conn:
            runs.finish(conn, run_id, status="failed", error=str(exc), cursor=None)
        raise
