"""PUCT electric CCN (Certificate of Convenience and Necessity) service
area boundaries -> core.electric_ccn.

DRAFT -- written but never run against Supabase (prep task: no DB
writes). Follows the same shape as pipelines/sources/territories.py
(hash-verify staged raw file -> upload unchanged to Storage `raw` ->
one ops.source_manifest row per file -> COPY/insert into a staging
table -> upsert into the contract table), but with THREE raw files
(one per PUCT electric-utility-type layer), each its own source name
and its own ops.source_manifest row -- same convention
pipelines/sources/hcad_parcels.py uses for its multiple input files.

Why this source exists (see checks/ notes for the discovery, or the
sibling scratchpad report from this prep task): core.territories
(HIFLD's national mirror) is a coarse, generalized polygon per utility.
For Williamson County (48491) it overlaps EVERY home with five
different utilities (Oncor, Pedernales, Bluebonnet, Bartlett Electric
Coop, City of Bartlett) and for Travis it also has real Austin
Energy/Pedernales/Bluebonnet boundary disagreement -- see
pipelines/sources/territory_overrides.py's Austin Energy override,
which already documents one such disagreement. Every Williamson home
in core.home_spatial today has resolved_territory_eia_id = NULL,
territory_null_reason = 'utility_not_confirmed' (per 0303_utility_gate_
counts.sql's explicit decision to withhold the county rather than pick
an arbitrary HIFLD tiebreak winner).

PUCT's own ArcGIS Online layers (IOU / MUNI / COOP_DIST -- Investor-
Owned, Municipally-Owned, and Cooperative-Distribution certified
electric service areas, respectively) are a finer-grained, PUCT-edited
proxy for the true CCN boundary (each layer's own `description` field,
fetched live, calls the layer "UNOFFICIAL": the *legally* official
record is a paper mylar map on file at PUCT Central Records, not a
digitized boundary -- see data/raw/puct_ccn/NOTES.md, fetched verbatim
from the live service, not paraphrased). It is still real,
PUCT-published, PUCT-edited data (edited by named PUCT Infrastructure
staff, per the same description field) retrieved from its live public
endpoint, not fabricated -- it satisfies the traceability rule, but its
"UNOFFICIAL" self-label must be surfaced anywhere this table's values
are shown, exactly like territory_null_reason surfaces
'utility_not_confirmed' today.

Raw files: already staged, read-only, in the MAIN checkout --
    data/raw/puct_ccn/puct_ccn_iou_electric.geojson
    data/raw/puct_ccn/puct_ccn_muni_electric.geojson
    data/raw/puct_ccn/puct_ccn_coop_electric.geojson
    data/raw/puct_ccn/SOURCE_URL.txt      -> one query URL per file, per line
    data/raw/puct_ccn/retrieved_at.txt    -> manifest `retrieved_at` (same
                                              instant for all three -- one
                                              retrieval session)
    data/raw/puct_ccn/SHA256SUMS          -> expected sha256 per filename
    data/raw/puct_ccn/NOTES.md            -> provenance + "UNOFFICIAL"
                                              caveat, verbatim from the
                                              live layer descriptions
Each file's bytes are hashed and checked against SHA256SUMS before
anything is uploaded or inserted -- a mismatch stops the run (real-data
rule: never substitute or silently proceed on a changed file).

Geometry: GeoJSON (EPSG:4326, requested with outSR=4326 at fetch time --
see SOURCE_URL.txt), lon/lat. Loaded via ST_GeomFromGeoJSON +
ST_SetSRID(..., 4326), then ST_MakeValid + ST_CollectionExtract(..., 3)
before ST_Multi -- same defensive sequence
pipelines/sources/territory_overrides.py uses for its Austin Energy
polygon, because these Platts-derived co-op/muni polygons DO contain
self-intersections (36 of 148 features across all three layers were
invalid at validation time in this prep task -- see the validation
report). Dropping invalid geometries instead of repairing them would
silently erase real service areas (several of the invalid ones are
Oncor's and AEP's own polygons); this module must never do that.

Load strategy: unlike territories.py (one un-subdivided polygon per
utility, whole-state), this module subdivides at load time --
ST_Subdivide(geom, 256), the same technique and grid size
0304_spatial_precompute.sql already applies to core.flood_zones_sub /
core.territories_sub, for the same reason (tight GiST candidates, not
one sprawling multipolygon per company) -- core.electric_ccn is
declared subdivided from the start rather than needing a companion
`_sub` table.

Company identity: core.electric_ccn.company_name is the layer's own
COMPANY_NAME field verbatim (never normalized/abbreviated), plus
ccn_no (CCN_NO), company_type (COMPANY_TYPE), and ccn_layer_type ('IOU'
| 'MUNI' | 'COOP_DIST', which file it came from -- COMPANY_TYPE on some
rows is blank). Mapping company_name -> an EIA utility number (for
joining core.utility_crosswalk / core.retail_market) is NOT done in
this module -- see supabase/migrations/0305_puct_ccn.sql's
core.electric_ccn_crosswalk seed and its own comment for which holders
are mapped and which are left for a human to confirm. This module never
writes a made-up eia_utility_number onto a row it cannot verify.

Multiply-certificated homes are real and common here (see the
validation report: 5.1% of Williamson+Travis homes fall inside more
than one CCN polygon, up to 86-99% in a few small border towns like
Jarrell and Bartlett where a co-op and a municipal utility legitimately
overlap) -- this module makes no attempt to pick a single "winner" per
home; that is 0305's re-resolution CTE's job, at query time, against
whatever pick rule the user confirms.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Literal

from pipelines.core import db, fetch, manifest, runs, storage

RAW_DIR = Path(
    "/Users/maheshbabugorantla/Code/Hackathons/BasePower_Deep_Tech_Hackathon_Sep_25_2026_Mavericks"
    "/data/raw/puct_ccn"
)
SOURCE_URL_FILE = RAW_DIR / "SOURCE_URL.txt"
RETRIEVED_AT_FILE = RAW_DIR / "retrieved_at.txt"
SHA256SUMS_FILE = RAW_DIR / "SHA256SUMS"

# One (source name, local file, PUCT layer type) triple per raw file --
# same "one manifest row per file" convention as hcad_parcels.py's
# hcad_real_acct / hcad_jur_exempt / hcad_code_description.
FILES: list[tuple[str, str, str]] = [
    ("puct_ccn_iou", "puct_ccn_iou_electric.geojson", "IOU"),
    ("puct_ccn_muni", "puct_ccn_muni_electric.geojson", "MUNI"),
    ("puct_ccn_coop_dist", "puct_ccn_coop_electric.geojson", "COOP_DIST"),
]

LOCAL_FILE_ENV_PREFIX = "PUCT_CCN_LOCAL_FILE_"  # + IOU / MUNI / COOP_DIST

DST_SRID = 4326
INSERT_CHUNK = 20

Runner = Literal["cron", "cli"]


# --------------------------------------------------------------------------
# Raw files + sidecars
# --------------------------------------------------------------------------


def _local_path(fname: str, layer_type: str) -> Path:
    override = os.environ.get(f"{LOCAL_FILE_ENV_PREFIX}{layer_type}")
    return Path(override) if override else RAW_DIR / fname


def _expected_sha256(fname: str) -> str:
    text = SHA256SUMS_FILE.read_text()
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) == 2 and parts[1].strip() == fname:
            return parts[0]
    raise RuntimeError(f"no SHA256SUMS entry for {fname!r} in {SHA256SUMS_FILE}")


def _source_urls() -> list[str]:
    """SOURCE_URL.txt holds one query URL per line, in FILES order."""
    lines = [l.strip() for l in SOURCE_URL_FILE.read_text().splitlines() if l.strip()]
    if len(lines) != len(FILES):
        raise RuntimeError(
            f"SOURCE_URL.txt has {len(lines)} lines, expected {len(FILES)} (one per PUCT layer)"
        )
    return lines


def retrieved_at() -> datetime:
    text = RETRIEVED_AT_FILE.read_text().strip()
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def _obtain_bytes(fname: str, layer_type: str) -> tuple[bytes, str, int]:
    path = _local_path(fname, layer_type)
    with open(path, "rb") as f:
        data = f.read()
    sha256 = fetch.sha256_of(data)
    expected = _expected_sha256(fname)
    if sha256 != expected:
        raise RuntimeError(
            f"{path} sha256 {sha256} does not match SHA256SUMS entry {expected} -- "
            "real-data rule: refusing to load a changed/corrupt file"
        )
    return data, sha256, len(data)


# --------------------------------------------------------------------------
# Manifest: reuse an existing row for the same (source, sha256); else
# upload + insert. One manifest row per file/source name.
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


def _ensure_manifest(source: str, fname: str, layer_type: str, url: str, runner: Runner) -> dict[str, Any]:
    data, sha256, size = _obtain_bytes(fname, layer_type)

    existing = _existing_manifest(source, sha256)
    if existing is not None:
        return {"id": existing["id"], "storage_key": existing["storage_key"], "sha256": sha256, "bytes": size}

    when = retrieved_at()
    key = storage.storage_key(source, sha256, when=when, ext=".geojson")
    storage.upload_raw(data, key, content_type="application/geo+json")

    with db.connect(pooled=False) as conn:
        manifest_id = manifest.insert(
            conn,
            source=source,
            url=url,
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
# GeoJSON parsing -> records
# --------------------------------------------------------------------------


def read_records(path: Path | str, *, layer_type: str) -> tuple[int, list[dict[str, Any]]]:
    """Read one PUCT layer's GeoJSON FeatureCollection and return
    (rows_in, records). rows_in is every feature in the file; a record is
    dropped (and counted, never silently) only when its geometry is null
    -- every other feature is kept, including ones whose geometry later
    turns out to be invalid (those are repaired by ST_MakeValid at
    insert time, never dropped -- see module docstring)."""
    with open(path) as f:
        fc = json.load(f)
    features = fc.get("features", [])
    rows_in = len(features)
    records = []
    for feat in features:
        geom = feat.get("geometry")
        if geom is None:
            continue
        props = feat.get("properties", {})
        records.append(
            {
                "company_name": props.get("COMPANY_NAME"),
                "company_type": props.get("COMPANY_TYPE"),
                "ccn_no": props.get("CCN_NO"),
                "ccn_layer_type": layer_type,
                "geojson": json.dumps(geom),
            }
        )
    return rows_in, records


# --------------------------------------------------------------------------
# Load core.electric_ccn -- COPY into an unlogged staging table (plain
# geometry-free columns, geojson kept as text), THEN one INSERT ... SELECT
# that runs ST_Subdivide/ST_MakeValid/ST_CollectionExtract server-side.
#
# ST_Subdivide is a set-returning function (SRF): Postgres rejects an SRF
# inside a VALUES row (`set-returning functions are not allowed in
# VALUES`), so it CANNOT sit inline in a multi-row INSERT ... VALUES the
# way ST_GeomFromWKB does in territories.py's _insert_batch. It IS legal
# in the SELECT list of an INSERT ... SELECT, which is why this module
# stages first and subdivides in that second statement instead.
#
# Idempotency: this is delete-by-source_id + insert, not upsert-by-key --
# core.electric_ccn has no natural business key across a full reload (a
# subdivided row's identity is a (company, geom-piece) pair with no
# stable id from PUCT), so a re-run for the SAME source_id (same file,
# same sha256, same manifest row) deletes and reinserts that source's
# rows rather than ever appending duplicates.
# --------------------------------------------------------------------------


def _ensure_staging_table(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            create temporary table if not exists puct_ccn_staging (
                company_name text,
                company_type text,
                ccn_no text,
                ccn_layer_type text,
                geojson text,
                source_id uuid
            ) on commit drop
            """
        )


def _copy_records(conn, records: list[dict[str, Any]], manifest_id: str) -> None:
    with conn.cursor() as cur:
        with cur.copy(
            "copy puct_ccn_staging (company_name, company_type, ccn_no, ccn_layer_type, geojson, source_id) "
            "from stdin"
        ) as copy:
            for rec in records:
                copy.write_row(
                    (
                        rec["company_name"],
                        rec["company_type"],
                        rec["ccn_no"],
                        rec["ccn_layer_type"],
                        rec["geojson"],
                        manifest_id,
                    )
                )


def _load_from_staging(conn, manifest_id: str) -> None:
    with conn.cursor() as cur:
        # Delete this source's existing rows first (re-run safety), then
        # insert fresh -- both in the SAME transaction as the COPY above
        # (db.connect's context manager commits once at the end, rolls
        # back on any error, so a failure here never leaves a half
        # deleted-but-not-reinserted state).
        cur.execute("delete from core.electric_ccn where source_id = %s", (manifest_id,))
        cur.execute(
            """
            insert into core.electric_ccn
                (company_name, company_type, ccn_no, ccn_layer_type, geom, source_id)
            select
                company_name, company_type, ccn_no, ccn_layer_type,
                extensions.ST_Subdivide(
                    extensions.ST_CollectionExtract(
                        extensions.ST_MakeValid(
                            extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON(geojson), %s)
                        ), 3
                    ), 256
                ) as geom,
                source_id
            from puct_ccn_staging
            where source_id = %s
            """,
            (DST_SRID, manifest_id),
        )


def run(*, runner: Runner = "cli", backfill: bool = False, cursor: dict[str, Any] | None = None) -> dict[str, Any]:
    """Load all three PUCT layers into core.electric_ccn. NEVER RUN in
    this prep task -- hard rule was no DB writes. Left here as the
    thinnest slice that would fill 0305_puct_ccn.sql's contract_out, for
    whichever ticket picks this up next. Matches the pipelines.core.
    registry source-module contract (runner/backfill/cursor kwargs) so
    `python -m pipelines.run puct_ccn --backfill` can call it -- there
    are only 148 features total across 3 small files, so `backfill` is
    accepted for contract compliance but this module always loads
    everything in one pass; there is no incremental/cursor mode."""
    urls = _source_urls()
    total_rows_in = 0
    total_rows_loaded = 0

    for (source, fname, layer_type), url in zip(FILES, urls):
        man = _ensure_manifest(source, fname, layer_type, url, runner)
        rows_in, records = read_records(_local_path(fname, layer_type), layer_type=layer_type)
        total_rows_in += rows_in

        with db.connect(pooled=False) as conn:
            _ensure_staging_table(conn)
            _copy_records(conn, records, man["id"])
            _load_from_staging(conn, man["id"])
            with conn.cursor() as cur:
                cur.execute("select count(*) from core.electric_ccn where source_id = %s", (man["id"],))
                loaded = cur.fetchone()[0]
            conn.commit()

        _set_manifest_rows(man["id"], loaded)
        total_rows_loaded += loaded

    return {"rows_in": total_rows_in, "rows_loaded": total_rows_loaded}


if __name__ == "__main__":
    import sys

    print(
        "puct_ccn.run() is a DRAFT, never executed against Supabase in this "
        "prep task (hard rule: no DB writes). Refusing to run from __main__.",
        file=sys.stderr,
    )
    raise SystemExit(1)
