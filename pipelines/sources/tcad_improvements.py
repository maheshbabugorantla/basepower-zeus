"""TCAD 2026 Certified Appraisal Export "File #8: Improvement Detail"
(APPRAISAL_IMPROVEMENT_DETAIL.TXT, short name IMP_DET.TXT) -> core.parcel_
improvements (yr_built, living_area per prop_id).

Same raw zip as pipelines/sources/parcels.py (already downloaded and
manifested by that module under source 'tcad_export' -- this module reuses
that existing ops.source_manifest row by sha256, never re-uploads or
re-manifests the zip). IMP_DET.TXT is streamed straight out of the zip via
zipfile's ZipExtFile (never extracted to disk): confirmed against the real
member (2,065,539,840 bytes) that 2,065,539,840 / 624 == 3,310,160 exactly,
so plain readline() always lands on a record boundary (622 data bytes +
"\\r\\n").

Field positions (1-based, inclusive) are read from the layout XLSX's
'ImprovementDetail' sheet (Legacy8.0.33-AppraisalExportLayout.xlsx, the
same zip pipelines/sources/tcad_layout.py's PROP.TXT positions come from,
confirmed 2026-09-26 for this ticket, M2-P8). tcad_layout.py's own FIELDS
dict only covers PROP.TXT ("File #2: Property") and is not touched here
(out of this ticket's owns) -- this module keeps its own IMP_DET FIELDS
dict below instead, reusing tcad_layout.py's extract-by-slice approach.

    Field Name           Datatype       Start  End   Length
    prop_id               int(12)          1    12     12
    prop_val_yr           numeric(4)      13    16      4
    imprv_id              int(12)         17    28     12
    imprv_det_id          int(12)         29    40     12
    imprv_det_type_cd     varchar(10)     41    50     10
    imprv_det_type_desc   varchar(25)     51    75     25
    imprv_det_class_cd    varchar(10)     76    85     10
    yr_built              numeric(4)      86    89      4
    depreciation_yr       numeric(4)      90    93      4
    imprv_det_area        numeric(15)     94   108     15
    imprv_det_val         numeric(14)    109   122     14
    sketch_cmds           varchar(500)   123   622    500  (NOT USED)

Main living-area rule (documented here since it is this module's one
material judgment call, not from memory): IMP_DET.TXT carries one row per
structural "detail" of an improvement (porches, garages, decks, HVAC,
fixtures, etc., identified by imprv_det_type_cd) as well as one row per
finished floor -- confirmed by sampling the real file's imprv_det_type_cd
-> imprv_det_type_desc pairs, which include the literal floor codes '1ST'
("1st Floor"), '2ND' ("2nd Floor"), '3RD', '4TH', '5TH', '1/2' ("Half
Floor"), 'ADDL' ("Additional Floor"), 'ATTIC' ("Attic"), 'FBSMT'
("Finished Basement"), 'MEZZ' ("Mezzanine") -- as distinct from
non-living details like '011' ("PORCH OPEN 1ST F"), '031'/'041'
("GARAGE..."), '501' ("CANOPY"), '604' ("POOL RES CONC"), etc. This
module's FLOOR_TYPE_CODES set is exactly those floor-detail codes.

For a given prop_id, a home can have more than one imprv_id (e.g. a house
plus a detached garage counted as its own improvement) and more than one
floor detail per imprv_id (multi-story). The "main" improvement is the
imprv_id with the largest summed floor-code area (imprv_det_area over
FLOOR_TYPE_CODES rows) -- the primary residence, not a garage/shed logged
as its own improvement. living_area for that prop_id is the sum of that
main improvement's floor areas. yr_built is that main improvement's '1ST'
floor detail's yr_built (the ground floor, i.e. original construction
year) when present; if no '1ST' detail exists for that improvement (e.g.
some condo/townhome records), yr_built falls back to the yr_built of
whichever floor detail on that improvement has the largest area. A
yr_built of 0 or blank is treated as not loaded (null), never a literal
year 0.

Filter: only prop_id values already present in core.mv_home_signals
(Travis gated homes -- the current, pre-M2-P8 view, itself built only from
core.parcels rows this same zip already loaded) are aggregated; every
other IMP_DET.TXT row is skipped as soon as its prop_id is read, before
any further per-record work, since ~3.3M records must be scanned to
produce ~150k rows.

Lean mode (per this ticket's binding rules): the whole file is aggregated
in memory (per-prop_id dict of at most a few floor rows each; ~150k target
prop_ids) and written with a single COPY + upsert at the end, rather than
parcels.py's incremental-batch/resumable-cursor machinery -- this module's
target row count is far smaller and a full pass over the compressed
member is itself only tens of seconds, so no chunked resume is needed.
Too big for a 300 s Vercel call regardless: only the CLI path
(`python -m pipelines.run tcad_improvements --backfill`) is exercised.
"""
from __future__ import annotations

import os
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pipelines.core import db, runs

SOURCE = "tcad_improvements"
TCAD_EXPORT_SOURCE = "tcad_export"  # pipelines/sources/parcels.py's manifest source
EXPORT_SHA256 = "62d0d1cd22b03f31db8d3986160eb181c5d00044df98a303fce9e17a44e9aa02"
IMP_DET_MEMBER = "IMP_DET.TXT"
RECORD_DATA_LEN = 622  # data bytes only; +2 bytes "\r\n" terminator per record

TCAD_RAW_DIR_ENV = "TCAD_RAW_DIR"
EXPORT_LOCAL_FILE_ENV = "TCAD_EXPORT_LOCAL_FILE"
DEFAULT_RAW_DIR = (
    "/Users/maheshbabugorantla/Code/Hackathons/"
    "BasePower_Deep_Tech_Hackathon_Sep_25_2026_Mavericks/data/raw/tcad"
)
EXPORT_FILENAME = "2026_Certified_Appraisal_Export_Supp0_07182026.zip"

Runner = Literal["cron", "cli"]

# field name -> (start, end), 1-based inclusive, from the layout XLSX's
# 'ImprovementDetail' sheet (see module docstring table above).
FIELDS: dict[str, tuple[int, int]] = {
    "prop_id": (1, 12),
    "prop_val_yr": (13, 16),
    "imprv_id": (17, 28),
    "imprv_det_type_cd": (41, 50),
    "yr_built": (86, 89),
    "imprv_det_area": (94, 108),
}

FLOOR_TYPE_CODES = frozenset(
    {"1ST", "2ND", "3RD", "4TH", "5TH", "1/2", "ADDL", "ATTIC", "FBSMT", "MEZZ"}
)


def extract_stripped(record: str, field: str) -> str | None:
    start, end = FIELDS[field]
    value = record[start - 1 : end].strip()
    return value or None


def _raw_dir() -> str:
    return os.environ.get(TCAD_RAW_DIR_ENV, DEFAULT_RAW_DIR)


def _export_path() -> str:
    return os.environ.get(EXPORT_LOCAL_FILE_ENV) or os.path.join(_raw_dir(), EXPORT_FILENAME)


def _normalize_prop_id(raw: str | None) -> str | None:
    if not raw:
        return None
    try:
        return str(int(raw))
    except ValueError:
        return None


def _existing_manifest_id(sha256: str) -> str:
    """Reuse the tcad_export zip's own ops.source_manifest row (already
    inserted by pipelines/sources/parcels.py) -- this module never
    re-uploads or re-manifests the export zip, per the real-data rule
    (one raw file, one manifest row, referenced everywhere it's used)."""
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select id from ops.source_manifest "
                "where source = %s and sha256 = %s order by retrieved_at desc limit 1",
                (TCAD_EXPORT_SOURCE, sha256),
            )
            row = cur.fetchone()
    if row is None:
        raise RuntimeError(
            f"no ops.source_manifest row for source={TCAD_EXPORT_SOURCE!r} sha256={sha256!r} -- "
            f"run `python -m pipelines.run parcels --backfill` first (real-data rule: this "
            f"module never uploads/manifests the export zip itself)"
        )
    return str(row[0])


def _target_prop_ids() -> set[str]:
    """prop_ids of Travis gated homes, from the current core.mv_home_signals
    -- the population this ticket needs year-built/living-area for."""
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute("select prop_id from core.mv_home_signals where gate_reason is null")
            return {row[0] for row in cur.fetchall()}


def _process_with_fallback(f, *, target_prop_ids: set[str]) -> tuple[dict[str, dict[str, Any]], dict[str, int]]:
    """Like _process, but also tracks, per (prop_id, imprv_id), the
    yr_built of the single largest floor detail -- used as yr_built when
    that improvement has no '1ST' detail at all."""
    filter_drops = {"prop_id_not_targeted": 0, "not_floor_detail": 0, "non_numeric_prop_id": 0}
    by_prop: dict[str, dict[str, dict[str, Any]]] = {}

    while True:
        line = f.readline()
        if not line:
            break
        text = line.decode("latin-1").rstrip("\r\n")
        if not text:
            continue

        prop_id = _normalize_prop_id(extract_stripped(text, "prop_id"))
        if prop_id is None:
            filter_drops["non_numeric_prop_id"] += 1
            continue
        if prop_id not in target_prop_ids:
            filter_drops["prop_id_not_targeted"] += 1
            continue

        type_cd = extract_stripped(text, "imprv_det_type_cd")
        if type_cd not in FLOOR_TYPE_CODES:
            filter_drops["not_floor_detail"] += 1
            continue

        imprv_id = extract_stripped(text, "imprv_id") or ""
        area_raw = extract_stripped(text, "imprv_det_area")
        area = float(area_raw) if area_raw else 0.0
        yr_built_raw = extract_stripped(text, "yr_built")
        yr_built = int(yr_built_raw) if yr_built_raw and yr_built_raw != "0" else None

        imp = by_prop.setdefault(prop_id, {}).setdefault(
            imprv_id, {"total_area": 0.0, "first_floor_yr_built": None, "largest_area": -1.0, "largest_area_yr_built": None}
        )
        imp["total_area"] += area
        if type_cd == "1ST" and yr_built is not None:
            imp["first_floor_yr_built"] = yr_built
        if area > imp["largest_area"]:
            imp["largest_area"] = area
            imp["largest_area_yr_built"] = yr_built

    result: dict[str, dict[str, Any]] = {}
    for prop_id, imprv_map in by_prop.items():
        winner_id = max(imprv_map, key=lambda k: imprv_map[k]["total_area"])
        winner = imprv_map[winner_id]
        yr_built = winner["first_floor_yr_built"] or winner["largest_area_yr_built"]
        result[prop_id] = {
            "yr_built": yr_built,
            "living_area": winner["total_area"] if winner["total_area"] > 0 else None,
        }
    return result, filter_drops


_STAGE_COLUMNS = ("prop_id", "yr_built", "living_area", "source_id")


def _load_all(conn, rows: dict[str, dict[str, Any]], manifest_id: str) -> int:
    with conn.cursor() as cur:
        cur.execute(
            """
            create temporary table if not exists parcel_improvements_stage (
                prop_id text, yr_built int, living_area numeric, source_id uuid
            ) on commit preserve rows
            """
        )
        cur.execute("truncate parcel_improvements_stage")
        with cur.copy(
            f"copy parcel_improvements_stage ({', '.join(_STAGE_COLUMNS)}) from stdin"
        ) as copy:
            for prop_id, vals in rows.items():
                copy.write_row((prop_id, vals["yr_built"], vals["living_area"], manifest_id))
        cur.execute(
            """
            insert into core.parcel_improvements (prop_id, yr_built, living_area, source_id)
            select prop_id, yr_built, living_area, source_id from parcel_improvements_stage
            on conflict (prop_id) do update set
                yr_built = excluded.yr_built,
                living_area = excluded.living_area,
                source_id = excluded.source_id
            """
        )
    conn.commit()
    return len(rows)


def run(*, runner: Runner, backfill: bool = False, cursor: dict[str, Any] | None = None) -> None:
    export_path = _export_path()
    if not os.path.isfile(export_path):
        raise RuntimeError(
            f"raw file not found: {export_path} -- real-data rule forbids substituting a "
            f"different file; stop and report this instead"
        )
    manifest_id = _existing_manifest_id(EXPORT_SHA256)
    target_prop_ids = _target_prop_ids()

    with db.connect(pooled=False) as conn:
        run_id = runs.start(conn, source=SOURCE, runner=runner, cursor={"target_homes": len(target_prop_ids)})
        conn.commit()
        try:
            with zipfile.ZipFile(export_path) as zf, zf.open(IMP_DET_MEMBER) as f:
                rows, filter_drops = _process_with_fallback(f, target_prop_ids=target_prop_ids)
            loaded = _load_all(conn, rows, manifest_id)
            rows_in = loaded + sum(filter_drops.values())
            runs.finish(
                conn, run_id, status="success",
                rows_in=rows_in, rows_loaded=loaded, filter_drops=filter_drops,
                cursor={"target_homes": len(target_prop_ids), "loaded": loaded},
            )
        except Exception as exc:
            runs.finish(conn, run_id, status="failed", error=str(exc))
            raise
