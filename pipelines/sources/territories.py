"""HIFLD Electric Retail Service Territories (source.coop GeoParquet mirror)
-> core.territories.

Source file: already staged, read-only, in the MAIN checkout (per
scratchpad/m2_pipeline_brief.md — "Raw files already staged in the MAIN
checkout; upload them unchanged, manifest url = the SOURCE_URL.txt
value"):

    data/raw/territories/retail_service_territories.parquet
    data/raw/territories/SOURCE_URL.txt      -> manifest `url`
    data/raw/territories/retrieved_at.txt    -> manifest `retrieved_at`
    data/raw/territories/SHA256SUMS          -> expected sha256 (verified,
                                                 never trusted blindly)

`run()` reads this local path by default; TERRITORIES_LOCAL_FILE overrides
it (e.g. for a re-run against a copy), same override convention as
sources/tiger_bg.py's TIGER_BG_LOCAL_FILE. Either way the bytes are
hashed and that hash is checked against SHA256SUMS before anything is
uploaded or inserted — a mismatch stops the run (real-data rule: never
substitute or silently proceed on a changed file).

Geometry encoding: the parquet's `geo` key (GeoParquet 1.1.0 metadata)
declares `"encoding":"WKB"` for the `geometry` column and `"crs":null`.
Per the GeoParquet 1.1 spec, an explicit `crs: null` (distinct from the
key being *absent*, which would default to OGC:CRS84) means the CRS is
unknown/unspecified. Two facts settle it here without guessing: (1) the
file's own bbox ([-179.23, -14.60, 179.86, 71.39]) is in decimal degrees
with x=longitude, y=latitude in [-180,180]x[-90,90] range, matching every
other HIFLD/NASA public mirror of this exact dataset, which HIFLD
publishes in WGS84 (EPSG:4326, "GIS-order" x=lon,y=lat, the same axis
order WKB always uses); and (2) this ticket's own acceptance check
(Austin Energy 1015's polygon must contain TCAD parcel 101325's real
centroid, both loaded with no transform) is the actual proof — if the
axis order or datum were wrong, that containment check would fail. So
the WKB bytes are loaded directly as EPSG:4326 with ST_SetSRID (no
ST_Transform, no axis swap): `ST_Multi(ST_SetSRID(ST_GeomFromWKB(%s), 4326))`.
ST_Multi covers the small number of source rows that are single-part
Polygon rather than MultiPolygon, matching core.territories.geom's
declared type. (All 141 Texas rows were independently checked with
shapely's `.is_valid` before writing this module -- zero invalid
geometries -- so no ST_MakeValid step is needed here.)

WKB byte order: this file's `geometry` column is big-endian WKB (byte-
order flag 0x00, confirmed by inspecting the raw bytes: Austin Energy's
row starts `00 00000006 00000007...` = big-endian, MultiPolygon, 7 parts).
ST_GeomFromWKB reads the byte-order flag itself, so no special handling
is needed here -- called out only because it would trip up a naive
struct.unpack("<I", ...) sanity check (see test_territories.py).

Scope: STATE == 'TX' only, per the ticket (141 of 2931 rows). ID is the
polygon's HIFLD `ID` field, which per 0201_m2.sql's core.territories
comment IS the EIA-861 utility number (e.g. Austin Energy 1015,
CenterPoint 8901) -- loaded verbatim as eia_id, no parsing.

Column note: the ticket prose also mentions `type` and `customers`
(null if -999999) columns, but the ACTUAL applied contract
(supabase/migrations/0201_m2.sql's `core.territories`) has only
`eia_id, name, state, geom, source_id, created_at` -- no `type` or
`customers` column. Per the M2 pipeline brief ("Use its exact
table/column names for your contract_out table(s)") and
agent_preamble.md ("Do NOT edit any migration"), this module loads only
the columns the live contract actually has and does not add columns.

Parsing: pyarrow (no GDAL/PROJ). Not in pipelines/requirements.txt
(owned by M0-D1, outside this ticket's `owns` paths) -- same posture as
tiger_bg.py's pyshp: run pytest and the CLI with `uv run --with pyarrow`
until requirements.txt is updated. Only the CLI path is exercised for
now (`python -m pipelines.run territories --backfill`); a Vercel
/cron/territories route would fail to import until pyarrow is added
there, and TIGER-style territory polygons are a backfill-only, rarely
refreshed source anyway (see ops.refresh_policy in 0201_m2.sql).

Never zero-fills: every Texas row in the parquet is loaded (filter_drops
only ever counts non-TX rows dropped by the STATE filter); there is no
other filtering, so `rows_loaded == rows_in - filter_drops['state_not_tx']`
for every run (checked by `python -m pipelines.check reconcile --source
territories`).
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Literal

from pipelines.core import db, fetch, manifest, runs, storage

SOURCE = "territories"

RAW_DIR = Path(
    "/Users/maheshbabugorantla/Code/Hackathons/BasePower_Deep_Tech_Hackathon_Sep_25_2026_Mavericks"
    "/data/raw/territories"
)
DEFAULT_PARQUET = RAW_DIR / "retail_service_territories.parquet"
SOURCE_URL_FILE = RAW_DIR / "SOURCE_URL.txt"
RETRIEVED_AT_FILE = RAW_DIR / "retrieved_at.txt"
SHA256SUMS_FILE = RAW_DIR / "SHA256SUMS"

LOCAL_FILE_ENV = "TERRITORIES_LOCAL_FILE"

DST_SRID = 4326  # WGS84 -- see module docstring for why no transform is needed
INSERT_CHUNK = 10  # large MultiPolygon WKBs (CenterPoint, Oncor); keep batches small

Runner = Literal["cron", "cli"]


# --------------------------------------------------------------------------
# Raw file + its sidecars (already staged in the main checkout)
# --------------------------------------------------------------------------


def _parquet_path() -> Path:
    override = os.environ.get(LOCAL_FILE_ENV)
    return Path(override) if override else DEFAULT_PARQUET


def _expected_sha256() -> str:
    """Parse SHA256SUMS (`<hex>  <filename>` lines) for the parquet's own
    filename and return its expected hash."""
    text = SHA256SUMS_FILE.read_text()
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) == 2 and parts[1].strip() == _parquet_path().name:
            return parts[0]
    raise RuntimeError(f"no SHA256SUMS entry for {_parquet_path().name!r} in {SHA256SUMS_FILE}")


def source_url() -> str:
    return SOURCE_URL_FILE.read_text().strip()


def retrieved_at() -> datetime:
    text = RETRIEVED_AT_FILE.read_text().strip()
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def _obtain_bytes() -> tuple[bytes, str, int]:
    """Read the staged parquet's raw bytes, verify its sha256 against
    SHA256SUMS (stop, never substitute, on a mismatch), and return
    (content, sha256, bytes)."""
    path = _parquet_path()
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
    key = storage.storage_key(SOURCE, sha256, when=when, ext=".parquet")
    storage.upload_raw(data, key, content_type="application/vnd.apache.parquet")

    with db.connect(pooled=False) as conn:
        manifest_id = manifest.insert(
            conn,
            source=SOURCE,
            url=source_url(),
            retrieved_at=when,
            sha256=sha256,
            bytes_=size,
            rows=None,
            runner=runner,
            storage_key=key,
        )
    return {"id": manifest_id, "storage_key": key, "sha256": sha256, "bytes": size}


def _set_manifest_rows(manifest_id: str, rows: int) -> None:
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute("update ops.source_manifest set rows = %s where id = %s", (rows, manifest_id))


# --------------------------------------------------------------------------
# Parquet parsing (pyarrow) -> (eia_id, name, state, wkb_bytes)
# --------------------------------------------------------------------------


def read_records(path: Path | str, *, state: str = "TX") -> tuple[int, list[tuple[str, str, str, bytes]]]:
    """Read the parquet at `path` and return (rows_in, records) where
    records is every row with STATE == `state`, as (eia_id, name, state,
    wkb_bytes). rows_in is the parquet's total row count (every state),
    so callers can report an honest filter_drops count."""
    import pyarrow.parquet as pq
    import pyarrow.compute as pc

    table = pq.read_table(str(path), columns=["ID", "NAME", "STATE", "geometry"])
    rows_in = table.num_rows
    mask = pc.equal(table["STATE"], state)
    subset = table.filter(mask)

    ids = subset.column("ID").to_pylist()
    names = subset.column("NAME").to_pylist()
    states = subset.column("STATE").to_pylist()
    geoms = subset.column("geometry").to_pylist()

    records = [
        (eia_id, name, st, geom)
        for eia_id, name, st, geom in zip(ids, names, states, geoms)
        if eia_id is not None and geom is not None
    ]
    return rows_in, records


# --------------------------------------------------------------------------
# Load core.territories
# --------------------------------------------------------------------------


def _insert_batch(cur, batch: list[tuple[str, str, str, bytes, str]]) -> None:
    """One multi-row INSERT per chunk (not executemany -- see tiger_bg.py's
    _insert_batch docstring for why: psycopg3's executemany enables
    pipeline mode, which has dropped the session-pooler connection on
    large-WKT/WKB chunks before)."""
    row_sql = "(%s, %s, %s, extensions.ST_Multi(extensions.ST_SetSRID(extensions.ST_GeomFromWKB(%s), %s)), %s)"
    values_sql = ", ".join(row_sql for _ in batch)
    params: list[Any] = []
    for eia_id, name, state, wkb_bytes, manifest_id in batch:
        params.extend([eia_id, name, state, wkb_bytes, DST_SRID, manifest_id])
    cur.execute(
        f"""
        insert into core.territories (eia_id, name, state, geom, source_id)
        values {values_sql}
        on conflict (eia_id) do update
            set name      = excluded.name,
                state     = excluded.state,
                geom      = excluded.geom,
                source_id = excluded.source_id
        """,
        params,
    )


def load_core(conn, manifest_id: str, records: Iterator[tuple[str, str, str, bytes]]) -> int:
    loaded = 0
    batch: list[tuple[str, str, str, bytes, str]] = []
    with conn.cursor() as cur:
        for eia_id, name, state, wkb_bytes in records:
            batch.append((eia_id, name, state, wkb_bytes, manifest_id))
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

    try:
        rows_in, records = read_records(_parquet_path(), state="TX")
        filter_drops = {"state_not_tx": rows_in - len(records)}

        with db.connect(pooled=False) as conn:
            loaded = load_core(conn, manifest_id, iter(records))

        _set_manifest_rows(manifest_id, rows_in)
        with db.connect(pooled=False) as conn:
            runs.finish(
                conn, run_id, status="success",
                rows_in=rows_in, rows_loaded=loaded, filter_drops=filter_drops, cursor=None,
            )
    except Exception as exc:
        with db.connect(pooled=False) as conn:
            runs.finish(conn, run_id, status="failed", error=str(exc), cursor=None)
        raise
