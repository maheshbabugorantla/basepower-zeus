"""Williamson Central Appraisal District (WCAD) public Socrata exports ->
core.parcels, core.parcel_geoms, core.parcel_improvements (county_fips
'48491').

Adapter name (to register in pipelines/config/counties.yaml once that
file's williamson block is added -- NOT done by this ticket, per its
owns list; see checks/M3-P5.md for the exact block to add):
wcad_property_data_export.

WCAD's public data lives on a Socrata portal at data.wcad.org (confirmed
live via https://www.wcad.org/data-downloads/, which links "Certified
Property Data Export" -> data.wcad.org and the field-layout PDF at
https://documents.wcad.org/DataDownloads/PropertyDataExportFileLayout.pdf).
This is NOT the TCAD "Legacy 8.0.x" fixed-width layout, so tcad_layout.py
is not reused -- WCAD publishes five separate CSV tables (Property, Land,
Improvement, Segment, Sales), documented by that PDF, plus a separate
"Exemptions" table and a "Parcels" GIS table (attributes + WKT geometry).
Five of those are downloaded here (Improvement/Sales are not needed):

    Property - PropertyDataExport (attributes: market value, situs)
      https://data.wcad.org/api/views/ij43-xknu/rows.csv?accessType=DOWNLOAD
    Land - PropertyDataExport (StateCode -- the Texas property class code,
      e.g. 'A1' for single-family residential)
      https://data.wcad.org/api/views/2ckt-cqwj/rows.csv?accessType=DOWNLOAD
    Segment - PropertyDataExport (ActYrBuilt, Area, per improvement
      "Type" -- 'MA'/'MA2'/... are the main-area/floor segments)
      https://data.wcad.org/api/views/4kxj-e8c3/rows.csv?accessType=DOWNLOAD
    Exemptions (homestead + Tax Code 11.13(c) exemption rows)
      https://data.wcad.org/api/views/nbn7-h4pp/rows.csv?accessType=DOWNLOAD
    Parcels (WCAD Mapping Dept GIS layer: PropertyID + the_geom WKT
      MultiPolygon -- geometry only; its own attribute columns, e.g.
      CLASSCD/CNTASSDVAL, are unpopulated/stale in this layer and are
      never read)
      https://data.wcad.org/api/views/an3x-cnmw/rows.csv?accessType=DOWNLOAD

All five are Socrata full-table CSV exports (verified live via HEAD: each
returns 200), so each download is one complete, byte-stable file -- one
sha256, one ops.source_manifest row per file, all under SOURCE
'wcad_export' (mirroring parcels.py's two-row-per-source pattern for
TCAD's export+layout zips). Files are downloaded to the MAIN checkout's
data/raw/wcad/ (never committed; see checks/M3-P5.md for paths+sha256)
and uploaded unchanged via pipelines.core.storage.upload_raw (which
already branches on size between a plain PUT and TUS resumable upload --
no bespoke TUS code needed here, unlike parcels.py/tcad_geometry.py which
predate that shared helper).

tax_year is 2026 (WCAD's current certified roll -- confirmed live via the
"Property - Certified" Socrata dataset's own tax_year column, which
returns '2026' for the certified roll) and WCAD_FIPS is '48491'. Both are
module constants rather than read from counties.yaml (that file's
williamson block does not exist yet -- registering it is explicitly out
of this ticket's owns list; do not make run() depend on it).

ID-collision handling: WCAD's PropertyID (e.g. '1014', '62647') is a
short, unprefixed integer -- the same shape as TCAD's prop_id (e.g.
'100008') and, per the M3-P5 ticket brief, may also collide with Harris
HCAD ids. core.parcels.prop_id is a single text primary key shared by
every county's adapter, so a raw WCAD PropertyID is never inserted
as-is: this module's prop_id is always 'W' + PropertyID (e.g. 'W1014'),
applied consistently across core.parcels, core.parcel_geoms and
core.parcel_improvements so all three tables join on the same prefixed
key. geo_id (the TCAD-specific 10-digit Austin-permit join key) has no
WCAD equivalent and is left null for every Williamson row.

Single-family-homestead filter (applied BEFORE loading, per the ticket):
a WCAD PropertyID is loaded only if
  (a) it has at least one Land-PropertyDataExport row whose StateCode
      starts with 'A1' (Texas's single-family-residential class code --
      confirmed live: 'A1'/'Residential' is WCAD's dominant land state
      code, 214,104 of 305,880 land rows), and
  (b) it has an Exemptions row with ExemptionTypeDescription='Homestead'
      and ExemptionStatusCode='A' (active).
This mirrors core.mv_home_block_group's live gate exactly:
    where (p.imprv_state_cd like 'A1%' or p.land_state_cd like 'A1%')
      and p.hs_exempt = 'T'
(0102_m1_materialize.sql) -- confirmed by reading that view's SQL before
writing this module, not from memory. hs_exempt is written as the
literal string 'T' (matching TCAD's encoding, confirmed live:
core.parcels.hs_exempt is 'T'/'F' for existing Travis rows) only when
that homestead condition holds; otherwise left null (never 'F' -- WCAD's
Exemptions table has no "no exemption" row to read a definitive false
from, so absence is encoded as unknown/null, not asserted-false).
land_state_cd is written as the literal 'A1' when that condition holds
(the gate's `like 'A1%'` gate only needs the prefix; the exact WCAD
sub-code, e.g. plain 'A1', is stored as-is with no rounding/invention).

ov65_exempt is intentionally left null for every Williamson row, always
(never 'T' or 'F'): WCAD's Exemptions table conflates the over-65 and
disabled-person population under a single "Tax Code 11.13(c) Exemption"
type (Texas Tax Code Sec. 11.13(c) grants the same additional homestead
exemption to both "65 or older" and "disabled" residents), and a
separate "Disabled Person" exemption type also exists, but nothing in
this data distinguishes an over-65 11.13(c) row from a disabled-but-
under-65 11.13(c) row. Guessing is exactly what the real-data rule
forbids, so ov65_exempt stays null (core.mv_home_signals_v2 already
reports this as owner_65_null_reason='exemption_data_missing' for a null
ov65_exempt -- no code changes needed there).

Improvements (yr_built/living_area): WCAD's Segment-PropertyDataExport
plays the same role as TCAD's IMP_DET.TXT, grouped by (PropertyID,
InstanceID) -- an InstanceID is one physical improvement (house, detached
garage, etc.), and each has one Segment row per structural component
(Type 'OP'=Open Porch, 'G'=Garage, 'FP'=Fireplace, ... and, critically,
'MA'=Main Area/1st floor, 'MA2'=Second Floor, 'MA3'..'MA8', 'MAZ'
=Mezzanine, 'MAB'=Basement -- confirmed live by sampling all distinct
Segment.Type values: every 'MA*' code is a living-area floor). The "main"
improvement for a PropertyID is the InstanceID with the largest total
MA*-type Area (exactly TCAD's floor-type-sum rule); living_area is that
sum; yr_built is that improvement's 'MA' (ground floor) segment's
ActYrBuilt, falling back to whichever MA* segment has the largest area
if no plain 'MA' segment exists -- the same fallback tcad_improvements.py
uses for TCAD's '1ST' code. ActYrBuilt of 0 or blank is null, never a
literal year 0.

The 137 TCAD-rolled parcels already sitting in Williamson (per
core.mv_home_signals, TCAD prop_ids whose real parcel centroid falls
inside a Williamson-county block group -- see
0102_m1_materialize.sql's note on why county assignment is geometry-
based, not the parcel's own county_fips attribute) are NOT WCAD
PropertyIDs at all -- WCAD's roll only contains parcels WCAD itself
appraises, and every one of those 137 homes is appraised by TCAD
instead (visible today as county_fips='48453' in core.parcels, hardcoded
by parcels.py). Spot-checking is not enough to rule out a WCAD parcel
covering the same physical lot as one of those 137 (e.g. a boundary
re-survey), so before loading, every WCAD candidate polygon is checked
against those 137 TCAD centroids with ST_Contains; any WCAD parcel whose
polygon contains one of those centroids is dropped and counted as filter
drop 'on_tcad_roll' (see `_tcad_williamson_overlap_prop_ids`). After
loading, `checks/M3-P5.md` records the same query returning zero rows
against the final core.parcel_geoms as the "no double count" evidence.

Loading is lean-mode (all five CSVs fit comfortably in memory -- the
largest, Segment-PropertyDataExport, is ~140 MB / 1.39M rows), matching
tcad_improvements.py's approach: no resumable cursor, but still batched
COPY + upsert per the repo's binding bulk-loading rule (BATCH_SIZE=5000
rows/batch, one commit per batch). Before every batch, this module polls
pg_stat_activity and pauses while any OTHER backend (pid != our own) is
running `refresh materialized view`, `refresh_all_scores`, or a `copy`
(covers a concurrent Harris HCAD COPY, whose staging-table name this
ticket has no visibility into) -- see `_wait_for_clear_to_write`. This
module never calls core.refresh_all_scores() itself.

Too big for a single 300 s Vercel call (five multi-hundred-MB downloads,
~2M+ CSV rows scanned, plus per-row PostGIS containment checks): only the
CLI path (`python -m pipelines.run wcad_parcels --backfill`) is exercised
for the real backfill; the cron route exists for contract completeness.
"""
from __future__ import annotations

import csv
import hashlib
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import psycopg

from pipelines.core import config, db, manifest, runs, storage

SOURCE = "wcad_export"
ADAPTER_NAME = "wcad_property_data_export"
WCAD_FIPS = "48491"
TAX_YEAR = 2026

WCAD_RAW_DIR_ENV = "WCAD_RAW_DIR"
DEFAULT_RAW_DIR = (
    "/Users/maheshbabugorantla/Code/Hackathons/"
    "BasePower_Deep_Tech_Hackathon_Sep_25_2026_Mavericks/data/raw/wcad"
)

BATCH_SIZE = 5000
PAUSE_POLL_SECONDS = 5.0

Runner = Literal["cron", "cli"]

# (env var to override local path, filename, Socrata dataset id, download URL)
_FILES = {
    "property": ("WCAD_PROPERTY_LOCAL_FILE", "Property_PropertyDataExport.csv", "ij43-xknu"),
    "land": ("WCAD_LAND_LOCAL_FILE", "Land_PropertyDataExport.csv", "2ckt-cqwj"),
    "segment": ("WCAD_SEGMENT_LOCAL_FILE", "Segment_PropertyDataExport.csv", "4kxj-e8c3"),
    "exemptions": ("WCAD_EXEMPTIONS_LOCAL_FILE", "Exemptions.csv", "nbn7-h4pp"),
    "parcels": ("WCAD_PARCELS_LOCAL_FILE", "Parcels.csv", "an3x-cnmw"),
}

FLOOR_TYPE_PREFIX = "MA"  # MA, MA2..MA8, MAZ, MAB — every living-area segment type

FILTER_NAMES = (
    "not_a1_residential",
    "no_active_homestead",
    "no_geometry",
    "on_tcad_roll",
    "duplicate_prop_id",
)

_STAGE_PARCEL_COLUMNS = (
    "prop_id", "geo_id", "county_fips", "prop_type_cd", "imprv_state_cd",
    "land_state_cd", "hs_exempt", "ov65_exempt", "situs_num", "situs_street",
    "situs_city", "situs_zip", "market_value", "tax_year", "source_id",
)
_STAGE_GEOM_COLUMNS = ("prop_id", "geo_id", "wkt", "source_id")
_STAGE_IMPROVEMENT_COLUMNS = ("prop_id", "yr_built", "living_area", "source_id")


def _raw_dir() -> str:
    return os.environ.get(WCAD_RAW_DIR_ENV, DEFAULT_RAW_DIR)


def _local_path(key: str) -> str:
    env_name, filename, _dataset_id = _FILES[key]
    return os.environ.get(env_name) or os.path.join(_raw_dir(), filename)


def _download_url(key: str) -> str:
    _env_name, _filename, dataset_id = _FILES[key]
    return f"https://data.wcad.org/api/views/{dataset_id}/rows.csv?accessType=DOWNLOAD"


def _retrieved_at() -> datetime:
    """Use the real retrieval timestamp recorded alongside the raw files
    (data/raw/wcad/retrieved_at.txt), not "now" -- the files were fetched
    from data.wcad.org once, earlier, not at pipeline-run time."""
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
# Manifest: one row per (source='wcad_export', sha256) -- one per CSV file.
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


def _ensure_manifest_for_file(key: str, *, runner: Runner) -> dict[str, Any]:
    path = _local_path(key)
    if not os.path.isfile(path):
        raise RuntimeError(
            f"raw file not found: {path} -- real-data rule forbids substituting a "
            f"different file; stop and report this instead"
        )
    sha256 = _sha256_of_file(path)
    size = os.path.getsize(path)

    existing = _existing_manifest(sha256)
    if existing is not None:
        return {"id": existing["id"], "storage_key": existing["storage_key"], "path": path, "sha256": sha256}

    retrieved_at = _retrieved_at()
    ext = ".csv"
    storage_key = storage.storage_key(SOURCE, sha256, when=retrieved_at, ext=ext)
    with open(path, "rb") as f:
        content = f.read()
    storage.upload_raw(content, storage_key, content_type="text/csv")

    with db.connect(pooled=False) as conn:
        manifest_id = manifest.insert(
            conn, source=SOURCE, url=_download_url(key), retrieved_at=retrieved_at,
            sha256=sha256, bytes_=size, rows=None, runner=runner, storage_key=storage_key,
        )
    return {"id": manifest_id, "storage_key": storage_key, "path": path, "sha256": sha256}


def _set_manifest_rows(manifest_id: str, rows: int) -> None:
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute("update ops.source_manifest set rows = %s where id = %s", (rows, manifest_id))


# --------------------------------------------------------------------------
# Phase 1: read each CSV into the small per-propertyid lookups this module
# needs (never the owner-name-adjacent columns like OwnerNme1/PrevOwnerName).
# --------------------------------------------------------------------------


def _read_land_state_codes(path: str) -> tuple[dict[str, str], int]:
    """propertyid -> 'A1' if ANY land row's StateCode starts with 'A1',
    else the first non-blank StateCode seen (kept only for completeness;
    never used to pass the single-family filter). Returns (map, rows_in)."""
    result: dict[str, str] = {}
    rows_in = 0
    with open(path, newline="", encoding="utf-8", errors="replace") as f:
        for row in csv.DictReader(f):
            rows_in += 1
            pid = row["PropertyID"]
            code = (row.get("StateCode") or "").strip()
            if not pid or not code:
                continue
            if code.startswith("A1"):
                result[pid] = "A1"
            elif pid not in result:
                result[pid] = code
    return result, rows_in


def _read_active_homesteads(path: str) -> tuple[set[str], int]:
    """propertyid set with an Active (ExemptionStatusCode='A') Homestead
    exemption row. Returns (set, rows_in)."""
    result: set[str] = set()
    rows_in = 0
    with open(path, newline="", encoding="utf-8", errors="replace") as f:
        for row in csv.DictReader(f):
            rows_in += 1
            if (
                (row.get("ExemptionTypeDescription") or "").strip() == "Homestead"
                and (row.get("ExemptionStatusCode") or "").strip() == "A"
            ):
                result.add(row["PropertyID"])
    return result, rows_in


def _num(value: str | None) -> float | None:
    v = (value or "").strip()
    if not v:
        return None
    try:
        return float(v)
    except ValueError:
        return None


def _read_property_rows(path: str, candidate_pids: set[str]) -> tuple[dict[str, dict[str, Any]], int]:
    """propertyid -> {market_value, situs_num, situs_street, situs_city,
    situs_zip}, restricted to `candidate_pids` (already land_state_cd='A1'
    + active-homestead filtered). Returns (map, rows_in)."""
    result: dict[str, dict[str, Any]] = {}
    rows_in = 0
    with open(path, newline="", encoding="utf-8", errors="replace") as f:
        for row in csv.DictReader(f):
            rows_in += 1
            pid = row["PropertyID"]
            if pid not in candidate_pids:
                continue
            market_value = _num(row.get("CurrMarketValue"))
            if not market_value:
                market_value = _num(row.get("MarketValue"))
            result[pid] = {
                "market_value": market_value if market_value else None,
                "situs_num": (row.get("SitusStreetNumber") or "").strip() or None,
                "situs_street": " ".join(
                    p for p in (
                        (row.get("SitusPreDirectional") or "").strip(),
                        (row.get("SitusStreetName") or "").strip(),
                        (row.get("SitusStreetSuffix") or "").strip(),
                        (row.get("SitusPostDirectional") or "").strip(),
                    ) if p
                ) or None,
                "situs_city": (row.get("SitusCity") or "").strip() or None,
                "situs_zip": (row.get("SitusZip") or "").strip() or None,
            }
    return result, rows_in


def _read_improvements(path: str, candidate_pids: set[str]) -> tuple[dict[str, dict[str, Any]], int]:
    """propertyid -> {yr_built, living_area}, restricted to
    `candidate_pids`, via the main-improvement rule described in the
    module docstring. Returns (map, rows_in)."""
    # (propertyid, instanceid) -> {total_area, first_floor_yr_built, largest_area, largest_area_yr_built}
    by_pid: dict[str, dict[str, dict[str, Any]]] = {}
    rows_in = 0
    with open(path, newline="", encoding="utf-8", errors="replace") as f:
        for row in csv.DictReader(f):
            rows_in += 1
            pid = row["PropertyID"]
            if pid not in candidate_pids:
                continue
            type_cd = (row.get("Type") or "").strip()
            if not type_cd.startswith(FLOOR_TYPE_PREFIX):
                continue
            instance_id = (row.get("InstanceID") or "").strip()
            area = _num(row.get("Area")) or 0.0
            yr_built_raw = _num(row.get("ActYrBuilt"))
            yr_built = int(yr_built_raw) if yr_built_raw else None

            imp = by_pid.setdefault(pid, {}).setdefault(
                instance_id,
                {"total_area": 0.0, "first_floor_yr_built": None, "largest_area": -1.0, "largest_area_yr_built": None},
            )
            imp["total_area"] += area
            if type_cd == "MA" and yr_built is not None:
                imp["first_floor_yr_built"] = yr_built
            if area > imp["largest_area"]:
                imp["largest_area"] = area
                imp["largest_area_yr_built"] = yr_built

    result: dict[str, dict[str, Any]] = {}
    for pid, instances in by_pid.items():
        winner_id = max(instances, key=lambda k: instances[k]["total_area"])
        winner = instances[winner_id]
        yr_built = winner["first_floor_yr_built"] or winner["largest_area_yr_built"]
        result[pid] = {
            "yr_built": yr_built,
            "living_area": winner["total_area"] if winner["total_area"] > 0 else None,
        }
    return result, rows_in


def _read_geometries(path: str, candidate_pids: set[str]) -> tuple[dict[str, str], int]:
    """propertyid -> WKT MultiPolygon string (the_geom column), restricted
    to `candidate_pids`. Returns (map, rows_in)."""
    result: dict[str, str] = {}
    rows_in = 0
    with open(path, newline="", encoding="utf-8", errors="replace") as f:
        for row in csv.DictReader(f):
            rows_in += 1
            pid = row.get("PropertyID")
            if not pid or pid not in candidate_pids:
                continue
            geom = (row.get("the_geom") or "").strip()
            if not geom:
                continue
            result[pid] = geom
    return result, rows_in


# --------------------------------------------------------------------------
# Phase 2: exclude WCAD parcels whose polygon contains a centroid of one
# of the 137 TCAD-rolled homes already sitting in Williamson (see module
# docstring). One round trip: stage every candidate's WKT, then ask
# Postgres which prop_ids overlap.
# --------------------------------------------------------------------------


def _tcad_williamson_overlap_prop_ids(conn: psycopg.Connection, candidates: dict[str, str]) -> set[str]:
    """`candidates` is WCAD propertyid -> WKT. Returns the set of WCAD
    propertyids (unprefixed) whose polygon contains the centroid of a
    TCAD-sourced home already gated into Williamson county (core.
    mv_home_signals.county_fips = '48491').

    Candidate polygons are staged into a real `geometry` column (not
    text) with its own GIST index, so the ST_Contains probe below is a
    137-row index-assisted nested loop against tens of thousands of
    candidates, not a per-row WKT-text reparse -- an earlier version of
    this function staged WKT as plain text and called ST_GeomFromText
    inside a correlated EXISTS subquery, which re-parsed every
    candidate's (sometimes large, multi-ring) polygon text once per TCAD
    centroid checked and timed out against the live pooler's statement
    timeout on the first real backfill (see checks/M3-P5.md)."""
    if not candidates:
        return set()
    pids = list(candidates.keys())
    wkts = [candidates[p] for p in pids]
    with conn.cursor() as cur:
        cur.execute(
            """
            create temporary table if not exists wcad_overlap_check (
                prop_id text, geom extensions.geometry
            ) on commit drop
            """
        )
        with cur.copy("copy wcad_overlap_check (prop_id, geom) from stdin") as copy:
            for pid, wkt in zip(pids, wkts):
                copy.write_row((pid, wkt))
        cur.execute("update wcad_overlap_check set geom = extensions.ST_SetSRID(geom, 4326)")
        cur.execute("create index on wcad_overlap_check using gist (geom)")
        cur.execute("analyze wcad_overlap_check")
        cur.execute(
            """
            select distinct c.prop_id
            from core.mv_home_signals hs
            join core.parcel_geoms tpg on tpg.prop_id = hs.prop_id
            join wcad_overlap_check c on extensions.ST_Contains(c.geom, tpg.centroid)
            where hs.county_fips = %s
              and tpg.centroid is not null
            """,
            (WCAD_FIPS,),
        )
        return {row[0] for row in cur.fetchall()}


# --------------------------------------------------------------------------
# Phase 3: pause-before-batch, matching the ticket's "before each batch
# check pg_stat_activity and pause while any refresh materialized view/
# refresh_all_scores or Harris HCAD COPY is running" instruction.
# --------------------------------------------------------------------------


def _busy_with_refresh_or_copy(conn: psycopg.Connection) -> bool:
    with conn.cursor() as cur:
        cur.execute(
            """
            select count(*) from pg_stat_activity
            where pid <> pg_backend_pid()
              and state = 'active'
              and (
                    query ilike '%%refresh materialized view%%'
                 or query ilike '%%refresh_all_scores%%'
                 or query ilike '%%copy %%from stdin%%'
              )
            """
        )
        row = cur.fetchone()
        return bool(row and row[0] > 0)


def _wait_for_clear_to_write(conn: psycopg.Connection) -> None:
    while _busy_with_refresh_or_copy(conn):
        time.sleep(PAUSE_POLL_SECONDS)


# --------------------------------------------------------------------------
# Phase 4: batched COPY + upsert into the three live core tables.
# --------------------------------------------------------------------------


def _ensure_staging_tables(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            create temporary table if not exists wcad_parcels_stage (
                prop_id text, geo_id text, county_fips text, prop_type_cd text,
                imprv_state_cd text, land_state_cd text, hs_exempt text,
                ov65_exempt text, situs_num text, situs_street text,
                situs_city text, situs_zip text, market_value numeric,
                tax_year int, source_id uuid
            ) on commit preserve rows
            """
        )
        cur.execute(
            """
            create temporary table if not exists wcad_parcel_geoms_stage (
                prop_id text, geo_id text, wkt text, source_id uuid
            ) on commit preserve rows
            """
        )
        cur.execute(
            """
            create temporary table if not exists wcad_parcel_improvements_stage (
                prop_id text, yr_built int, living_area numeric, source_id uuid
            ) on commit preserve rows
            """
        )
    conn.commit()


def _load_parcels_batch(conn: psycopg.Connection, batch: list[tuple]) -> None:
    cols = ", ".join(_STAGE_PARCEL_COLUMNS)
    with conn.cursor() as cur:
        cur.execute("truncate wcad_parcels_stage")
        with cur.copy(f"copy wcad_parcels_stage ({cols}) from stdin") as copy:
            for row in batch:
                copy.write_row(row)
        cur.execute(
            f"""
            insert into core.parcels ({cols})
            select {cols} from wcad_parcels_stage
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


def _load_geoms_batch(conn: psycopg.Connection, batch: list[tuple]) -> None:
    cols = ", ".join(_STAGE_GEOM_COLUMNS)
    with conn.cursor() as cur:
        cur.execute("truncate wcad_parcel_geoms_stage")
        with cur.copy(f"copy wcad_parcel_geoms_stage ({cols}) from stdin") as copy:
            for row in batch:
                copy.write_row(row)
        cur.execute(
            """
            insert into core.parcel_geoms (prop_id, geo_id, geom, centroid, source_id)
            select
                prop_id,
                geo_id,
                extensions.ST_Multi(extensions.ST_SetSRID(extensions.ST_GeomFromText(wkt), 4326)),
                extensions.ST_PointOnSurface(extensions.ST_SetSRID(extensions.ST_GeomFromText(wkt), 4326)),
                source_id
            from wcad_parcel_geoms_stage
            on conflict (prop_id) do update set
                geo_id = excluded.geo_id,
                geom = excluded.geom,
                centroid = excluded.centroid,
                source_id = excluded.source_id
            """
        )
    conn.commit()


def _load_improvements_batch(conn: psycopg.Connection, batch: list[tuple]) -> None:
    cols = ", ".join(_STAGE_IMPROVEMENT_COLUMNS)
    with conn.cursor() as cur:
        cur.execute("truncate wcad_parcel_improvements_stage")
        with cur.copy(f"copy wcad_parcel_improvements_stage ({cols}) from stdin") as copy:
            for row in batch:
                copy.write_row(row)
        cur.execute(
            f"""
            insert into core.parcel_improvements ({cols})
            select {cols} from wcad_parcel_improvements_stage
            on conflict (prop_id) do update set
                yr_built = excluded.yr_built,
                living_area = excluded.living_area,
                source_id = excluded.source_id
            """
        )
    conn.commit()


# --------------------------------------------------------------------------
# Row assembly (pure function, unit-testable without a DB connection).
# --------------------------------------------------------------------------


def build_final_rows(
    *,
    land_state_codes: dict[str, str],
    active_homesteads: set[str],
    property_rows: dict[str, dict[str, Any]],
    improvements: dict[str, dict[str, Any]],
    geometries: dict[str, str],
    overlap_pids: set[str],
    source_id: str,
) -> tuple[list[tuple], list[tuple], list[tuple], dict[str, int]]:
    """Combine the per-file lookups into the final rows for the three
    staging tables, applying every filter in order, and return
    (parcel_rows, geom_rows, improvement_rows, filter_drops)."""
    filter_drops = {name: 0 for name in FILTER_NAMES}

    a1_pids = {pid for pid, code in land_state_codes.items() if code == "A1"}
    homestead_a1_pids = a1_pids & active_homesteads
    filter_drops["not_a1_residential"] = len(set(land_state_codes) - a1_pids)
    filter_drops["no_active_homestead"] = len(a1_pids - active_homesteads)

    parcel_rows: list[tuple] = []
    geom_rows: list[tuple] = []
    improvement_rows: list[tuple] = []
    seen: set[str] = set()

    for pid in sorted(homestead_a1_pids):
        if pid not in geometries:
            filter_drops["no_geometry"] += 1
            continue
        if pid in overlap_pids:
            filter_drops["on_tcad_roll"] += 1
            continue

        prop_id = f"W{pid}"
        if prop_id in seen:
            filter_drops["duplicate_prop_id"] += 1
            continue
        seen.add(prop_id)

        prop = property_rows.get(pid, {})
        parcel_rows.append((
            prop_id,
            None,  # geo_id — no WCAD equivalent of TCAD's Austin-permit join key
            WCAD_FIPS,
            "R",
            None,  # imprv_state_cd — not read from WCAD's Improvement export (out of scope)
            "A1",
            "T",
            None,  # ov65_exempt — see module docstring: never guessed
            prop.get("situs_num"),
            prop.get("situs_street"),
            prop.get("situs_city"),
            prop.get("situs_zip"),
            prop.get("market_value"),
            TAX_YEAR,
            source_id,
        ))
        geom_rows.append((prop_id, None, geometries[pid], source_id))

        imp = improvements.get(pid)
        if imp is not None:
            improvement_rows.append((prop_id, imp.get("yr_built"), imp.get("living_area"), source_id))

    return parcel_rows, geom_rows, improvement_rows, filter_drops


def _batched(rows: list[tuple], size: int) -> list[list[tuple]]:
    return [rows[i : i + size] for i in range(0, len(rows), size)]


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------


def run(*, runner: Runner, backfill: bool = False, cursor: dict[str, Any] | None = None) -> None:
    manifests = {key: _ensure_manifest_for_file(key, runner=runner) for key in _FILES}
    # One representative manifest id (the Property file's) is recorded on
    # ops.pipeline_runs; every row's own source_id below is that same id,
    # matching parcels.py's convention of citing the primary export file.
    source_id = manifests["property"]["id"]

    land_state_codes, land_rows_in = _read_land_state_codes(_local_path("land"))
    active_homesteads, exemption_rows_in = _read_active_homesteads(_local_path("exemptions"))

    a1_pids = {pid for pid, code in land_state_codes.items() if code == "A1"}
    candidate_pids = a1_pids & active_homesteads

    property_rows, property_rows_in = _read_property_rows(_local_path("property"), candidate_pids)
    improvements, segment_rows_in = _read_improvements(_local_path("segment"), candidate_pids)
    geometries, parcels_rows_in = _read_geometries(_local_path("parcels"), candidate_pids)

    with db.connect(pooled=False) as conn:
        run_id = runs.start(conn, source=SOURCE, runner=runner, cursor={"candidate_pids": len(candidate_pids)})
        with conn.cursor() as cur:
            cur.execute("update ops.pipeline_runs set manifest_id = %s where id = %s", (source_id, run_id))
        conn.commit()

        try:
            overlap_pids = _tcad_williamson_overlap_prop_ids(conn, geometries)

            parcel_rows, geom_rows, improvement_rows, filter_drops = build_final_rows(
                land_state_codes=land_state_codes,
                active_homesteads=active_homesteads,
                property_rows=property_rows,
                improvements=improvements,
                geometries=geometries,
                overlap_pids=overlap_pids,
                source_id=source_id,
            )

            _ensure_staging_tables(conn)

            for batch in _batched(parcel_rows, BATCH_SIZE):
                _wait_for_clear_to_write(conn)
                _load_parcels_batch(conn, batch)
            for batch in _batched(geom_rows, BATCH_SIZE):
                _wait_for_clear_to_write(conn)
                _load_geoms_batch(conn, batch)
            for batch in _batched(improvement_rows, BATCH_SIZE):
                _wait_for_clear_to_write(conn)
                _load_improvements_batch(conn, batch)

            rows_in = land_rows_in + exemption_rows_in + property_rows_in + segment_rows_in + parcels_rows_in
            rows_loaded = len(parcel_rows)
            for key, manifest_row in manifests.items():
                _set_manifest_rows(manifest_row["id"], {
                    "property": property_rows_in, "land": land_rows_in, "segment": segment_rows_in,
                    "exemptions": exemption_rows_in, "parcels": parcels_rows_in,
                }[key])

            runs.finish(
                conn, run_id, status="success", rows_in=rows_in, rows_loaded=rows_loaded,
                filter_drops=filter_drops,
                cursor={"candidate_pids": len(candidate_pids), "loaded": rows_loaded},
            )
        except Exception as exc:
            # A failure mid-transaction (e.g. a statement-timeout on the
            # overlap query) leaves `conn` aborted; runs.finish's own
            # UPDATE would otherwise raise InFailedSqlTransaction and mask
            # the real error. Roll back first, then record the failure on
            # a fresh connection.
            conn.rollback()
            with db.connect(pooled=False) as finish_conn:
                runs.finish(finish_conn, run_id, status="failed", error=str(exc))
            raise
