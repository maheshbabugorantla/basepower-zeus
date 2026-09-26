"""Field byte positions for the TCAD Legacy 8.0.33 Appraisal Export record
layout, "File #2: Property" (short file name PROP.TXT), sheet 'Property'
of the layout workbook shipped alongside the export
(`AppraisalExportLayout_06182026.zip` -> Legacy8.0.33-AppraisalExportLayout.xlsx,
manifested by pipelines/sources/parcels.py under source 'tcad_export').

Positions below are 1-based, inclusive, copied straight from the sheet's
Start/End columns (confirmed 2026-09-26 — see checks/T0-H3.md and
tickets/M1/M1-P1.md, which state the same numbers). Do not change any of
these from memory: re-open the XLSX's 'Property' sheet and re-check
Start/End for whichever field you touch.

RECORD_DATA_LEN is the record's data length (the layout's own last field,
lgcc_prorate_end, ends at column 9922). PROP.TXT itself separates records
with a trailing "\r\n" (2 bytes) after those 9922 data characters — this
module only knows about the 9922 data characters; parcels.py's readline()
based streaming handles the line terminator.
"""
from __future__ import annotations

RECORD_DATA_LEN = 9922

# field name -> (start, end), 1-based inclusive, exactly as the layout's
# Start/End columns give them.
FIELDS: dict[str, tuple[int, int]] = {
    "prop_id": (1, 12),
    "prop_type_cd": (13, 17),
    "geo_id": (547, 596),
    "situs_street": (1050, 1099),
    "situs_city": (1110, 1139),
    "situs_zip": (1140, 1149),
    "hs_exempt": (2609, 2609),
    "ov65_exempt": (2610, 2610),
    "imprv_state_cd": (2732, 2741),
    "land_state_cd": (2742, 2751),
    "market_value": (4214, 4227),
    "situs_num": (4460, 4474),
}


def extract(record: str, field: str) -> str:
    """Return the raw (not yet stripped) slice for `field` out of a decoded
    PROP.TXT record string (a single line, terminator already removed)."""
    start, end = FIELDS[field]
    return record[start - 1 : end]


def extract_stripped(record: str, field: str) -> str | None:
    """Like extract(), but stripped of padding spaces, with an
    all-blank field returned as None rather than ''."""
    value = extract(record, field).strip()
    return value or None
