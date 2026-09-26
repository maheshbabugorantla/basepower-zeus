"""EIA-861 Reliability (2025 early release + 2024 final) -> core.utility_reliability.

Source files: staged unchanged in the MAIN checkout at
data/raw/eia861/f8612025er.zip and f8612024.zip (read-only; this module
never downloads them — see agent_preamble.md's raw-data convention). Each
zip's SOURCE_URL.txt/retrieved_at.txt/SHA256SUMS sidecars are the source
of truth for each file's real URL, retrieval time, and expected sha256
(cross-checked against the bytes actually read, never trusted blindly):

    f8612025er.zip -> https://www.eia.gov/electricity/data/eia861/zip/f8612025er.zip
    f8612024.zip   -> https://www.eia.gov/electricity/data/eia861/zip/f8612024.zip

Each zip holds many EIA-861 workbooks; only `Reliability_*.xlsx` is read.
Its `Reliability_States` sheet (one row per utility per state it reports
for) has the per-state SAIDI/SAIFI/CAIDI figures the ticket's verification
values come from (the `Reliability_Territories` sheet has different,
smaller utility numbers and does not contain e.g. Austin Energy 1015 —
confirmed by inspection, not assumed).

Column layout (never hardcoded by position — see `_metric_columns`):
each workbook has three header rows stacked above the data (a "Standard"
row: IEEE Standard vs Other Standard; a "group" row: All Events (With
Major Event Days) / Without Major Event Days / Loss of Supply Removed
(With Major Event Days); and a metric row: SAIDI/SAIFI/CAIDI/...). Group
headers merge across their span (only the first cell in the run holds
the label, the rest are None) and the SAME group label ("All Events
(With Major Event Days)") repeats twice — once under "IEEE Standard"
(the columns this ticket wants) and again under "Other Standard" (a
duplicate SAIDI-only column using a different reliability standard,
which is NOT what the verification values below come from — confirmed:
Oncor's IEEE-standard columns are all "." but its Other-Standard SAIDI
column has a real number). `_metric_columns` forward-fills both the
Standard and group header rows across their merged span and keys columns
by the (standard, group, metric) triple, taking IEEE Standard only, so a
missing or duplicated header can never silently resolve to the wrong
column.

Schema note: core.utility_reliability (supabase/migrations/0201_m2.sql,
contract_in, read-only) has *_incl_major / *_excl_major columns only —
there is no column for the "Loss of Supply Removed (With Major Event
Days)" group. That group IS present and parsed out of every workbook
(so the code that would load it is a matter of adding a destination
column, not new parsing) but is never written anywhere, since the
schema this ticket must write to has nowhere to put it. This is a
deliberate deviation from the M2-P7 ticket text, which describes three
groups, dictated entirely by the migration this ticket may not edit.

Null handling: EIA's literal "." string means not reported. Loaded as
NULL with a *_null_reason of 'not_reported' — never 0, per the real-data
rule. Verified case: Oncor Electric Delivery (44372) is "." across every
IEEE-standard column in both 2025 and 2024.

Not runnable on Vercel Hobby today: `openpyxl` is not in
pipelines/requirements.txt (owned by M0-D1, outside this ticket's `owns`
paths — same posture tiger_bg.py documents for `pyshp`). Only the CLI
path (`python -m pipelines.run eia861_reliability --backfill`) is
exercised; run pytest and the CLI with `uv run --with openpyxl ...`
until requirements.txt is updated.

Two ops.source_manifest rows are created (one per zip, its own URL/
sha256/retrieved_at) and two ops.pipeline_runs rows (one per zip,
carrying that zip's manifest_id) — the same "one run per year file"
posture eaglei.py documents for its own per-year files.
"""
from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Literal

from pipelines.core import db, manifest, runs, storage

# openpyxl is imported lazily inside read_texas_rows(), not at module level:
# it is not in pipelines/requirements.txt (owned by M0-D1, outside this
# ticket's `owns` paths — same posture tiger_bg.py documents for `pyshp`,
# though that module imports pyshp at top level since it has no test that
# imports it under the plain `--with pytest` command). A top-level import
# here would break pytest collection for every test file whenever the
# standard `uv run ... --with pytest pytest` command (no `--with openpyxl`)
# is used, since pytest aborts the whole run on a collection-time
# ImportError, not just this module's own tests.

SOURCE = "eia861_reliability"

RAW_DIR = (
    "/Users/maheshbabugorantla/Code/Hackathons/BasePower_Deep_Tech_Hackathon_Sep_25_2026_Mavericks"
    "/data/raw/eia861"
)

STATE = "TX"
SHEET_NAME = "Reliability_States"

STANDARD_IEEE = "IEEE Standard"
GROUP_INCL_MAJOR = "All Events (With Major Event Days)"
GROUP_EXCL_MAJOR = "Without Major Event Days"

METRIC_SAIDI = "SAIDI (minutes per year)"
METRIC_SAIFI = "SAIFI (times per year)"
METRIC_CAIDI = "CAIDI (minutes per interruption)"

# (group constant) -> core.utility_reliability column prefix
GROUP_TO_PREFIX = {
    GROUP_INCL_MAJOR: "incl_major",
    GROUP_EXCL_MAJOR: "excl_major",
}
METRIC_TO_NAME = {
    METRIC_SAIDI: "saidi",
    METRIC_SAIFI: "saifi",
    METRIC_CAIDI: "caidi",
}

Runner = Literal["cron", "cli"]


@dataclass(frozen=True)
class FileSpec:
    filename: str
    url: str
    early_release: bool
    year: int


FILES: tuple[FileSpec, ...] = (
    FileSpec(
        filename="f8612025er.zip",
        url="https://www.eia.gov/electricity/data/eia861/zip/f8612025er.zip",
        early_release=True,
        year=2025,
    ),
    FileSpec(
        filename="f8612024.zip",
        url="https://www.eia.gov/electricity/data/eia861/zip/f8612024.zip",
        early_release=False,
        year=2024,
    ),
)


# --------------------------------------------------------------------------
# Sidecars (retrieved_at.txt, SHA256SUMS) — cross-checked, never trusted blindly
# --------------------------------------------------------------------------


def _read_retrieved_at() -> datetime:
    with open(f"{RAW_DIR}/retrieved_at.txt", "r", encoding="utf-8") as f:
        text = f.read().strip()
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def _read_sha256sums() -> dict[str, str]:
    out: dict[str, str] = {}
    with open(f"{RAW_DIR}/SHA256SUMS", "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            sha, name = line.split(maxsplit=1)
            out[name.strip()] = sha.strip()
    return out


def _obtain_zip_bytes(filename: str) -> bytes:
    with open(f"{RAW_DIR}/{filename}", "rb") as f:
        return f.read()


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


def _ensure_manifest(spec: FileSpec, runner: Runner) -> dict[str, Any]:
    from pipelines.core import fetch as fetch_mod

    data = _obtain_zip_bytes(spec.filename)
    sha256 = fetch_mod.sha256_of(data)

    expected = _read_sha256sums().get(spec.filename)
    if expected is not None and expected != sha256:
        raise RuntimeError(
            f"{spec.filename}: sha256 mismatch against SHA256SUMS "
            f"(sidecar={expected}, computed={sha256})"
        )

    existing = _existing_manifest(sha256)
    if existing is not None:
        return {"id": existing["id"], "storage_key": existing["storage_key"], "data": data}

    retrieved_at = _read_retrieved_at()
    key = storage.storage_key(SOURCE, sha256, when=retrieved_at, ext=f"_{spec.filename}")
    storage.upload_raw(data, key, content_type="application/zip")

    with db.connect(pooled=False) as conn:
        manifest_id = manifest.insert(
            conn,
            source=SOURCE,
            url=spec.url,
            retrieved_at=retrieved_at,
            sha256=sha256,
            bytes_=len(data),
            rows=None,
            runner=runner,
            storage_key=key,
        )
    return {"id": manifest_id, "storage_key": key, "data": data}


def _set_manifest_rows(manifest_id: str, rows: int) -> None:
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute("update ops.source_manifest set rows = %s where id = %s", (rows, manifest_id))


# --------------------------------------------------------------------------
# Zip -> Reliability_*.xlsx bytes
# --------------------------------------------------------------------------


def extract_reliability_xlsx(zip_bytes: bytes) -> bytes:
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        names = [n for n in zf.namelist() if n.startswith("Reliability_") and n.endswith(".xlsx")]
        if len(names) != 1:
            raise RuntimeError(f"expected exactly one Reliability_*.xlsx member, found {names!r}")
        return zf.read(names[0])


# --------------------------------------------------------------------------
# Header parsing: forward-fill the "standard" and "group" header rows and
# key every (metric) column by the (standard, group, metric) triple it
# actually carries — never a hardcoded column letter/position.
# --------------------------------------------------------------------------


def _forward_fill(values: list[Any]) -> list[Any]:
    out: list[Any] = []
    last: Any = None
    for v in values:
        if v is not None and str(v).strip() != "":
            last = v
        out.append(last)
    return out


def _find_metric_row(ws, max_scan_rows: int = 10) -> int:
    for r in range(1, max_scan_rows + 1):
        for c in range(1, ws.max_column + 1):
            if ws.cell(row=r, column=c).value == "Utility Number":
                return r
    raise RuntimeError("could not find the metric header row (no 'Utility Number' cell in first 10 rows)")


@dataclass(frozen=True)
class Layout:
    metric_row: int
    utility_number_col: int
    utility_name_col: int
    state_col: int
    year_col: int
    # (prefix like "incl_major"/"excl_major") -> {"saidi": col, "saifi": col, "caidi": col}
    metric_columns: dict[str, dict[str, int]]


def parse_layout(ws) -> Layout:
    metric_row = _find_metric_row(ws)
    group_row = metric_row - 1
    standard_row = metric_row - 2

    max_col = ws.max_column
    standard_vals = _forward_fill([ws.cell(row=standard_row, column=c).value for c in range(1, max_col + 1)])
    group_vals = _forward_fill([ws.cell(row=group_row, column=c).value for c in range(1, max_col + 1)])
    metric_vals = [ws.cell(row=metric_row, column=c).value for c in range(1, max_col + 1)]

    utility_number_col = utility_name_col = state_col = year_col = None
    metric_columns: dict[str, dict[str, int]] = {prefix: {} for prefix in GROUP_TO_PREFIX.values()}

    for idx in range(max_col):
        col = idx + 1
        metric = metric_vals[idx]
        if metric == "Utility Number":
            utility_number_col = col
        elif metric == "Utility Name":
            utility_name_col = col
        elif metric == "State":
            state_col = col
        elif metric == "Data Year":
            year_col = col

        if standard_vals[idx] == STANDARD_IEEE and group_vals[idx] in GROUP_TO_PREFIX and metric in METRIC_TO_NAME:
            prefix = GROUP_TO_PREFIX[group_vals[idx]]
            name = METRIC_TO_NAME[metric]
            metric_columns[prefix][name] = col

    missing = [f"{prefix}.{name}" for prefix in metric_columns for name in ("saidi", "saifi", "caidi") if name not in metric_columns[prefix]]
    if missing or utility_number_col is None or utility_name_col is None or state_col is None or year_col is None:
        raise RuntimeError(
            f"could not resolve required columns from the workbook's own headers "
            f"(missing metric columns: {missing}, utility_number_col={utility_number_col}, "
            f"utility_name_col={utility_name_col}, state_col={state_col}, year_col={year_col})"
        )

    return Layout(
        metric_row=metric_row,
        utility_number_col=utility_number_col,
        utility_name_col=utility_name_col,
        state_col=state_col,
        year_col=year_col,
        metric_columns=metric_columns,
    )


# --------------------------------------------------------------------------
# Row parsing: "." (or blank) -> (None, 'not_reported'); a real number ->
# (Decimal(str(value)), None) so 181.98 stays exact, never a binary-float
# round-trip.
# --------------------------------------------------------------------------


def _parse_value(raw: Any) -> tuple[Decimal | None, str | None]:
    if raw is None or (isinstance(raw, str) and raw.strip() in ("", ".")):
        return None, "not_reported"
    if isinstance(raw, (int, float)):
        return Decimal(str(raw)), None
    if isinstance(raw, Decimal):
        return raw, None
    raise ValueError(f"unexpected reliability cell value {raw!r} (expected a number or '.')")


@dataclass(frozen=True)
class ReliabilityRow:
    eia_id: str
    year: int
    utility_name: str | None
    values: dict[str, tuple[Decimal | None, str | None]]  # "incl_major.saidi" -> (value, null_reason)


def read_texas_rows(xlsx_bytes: bytes) -> tuple[list[ReliabilityRow], int, int]:
    """Returns (texas_rows, rows_in, non_texas_count). rows_in counts every
    data row scanned (any state); non_texas_count is rows_in - len(texas_rows)."""
    import openpyxl

    wb = openpyxl.load_workbook(io.BytesIO(xlsx_bytes), data_only=True)
    ws = wb[SHEET_NAME]
    layout = parse_layout(ws)

    rows_in = 0
    non_texas = 0
    texas_rows: list[ReliabilityRow] = []

    for r in range(layout.metric_row + 1, ws.max_row + 1):
        utility_number = ws.cell(row=r, column=layout.utility_number_col).value
        if utility_number is None or utility_number == "":
            continue
        rows_in += 1

        state = ws.cell(row=r, column=layout.state_col).value
        if state != STATE:
            non_texas += 1
            continue

        eia_id = str(int(utility_number))
        year = int(ws.cell(row=r, column=layout.year_col).value)
        utility_name = ws.cell(row=r, column=layout.utility_name_col).value

        values: dict[str, tuple[Decimal | None, str | None]] = {}
        for prefix, cols in layout.metric_columns.items():
            for name, col in cols.items():
                values[f"{prefix}.{name}"] = _parse_value(ws.cell(row=r, column=col).value)

        texas_rows.append(
            ReliabilityRow(eia_id=eia_id, year=year, utility_name=utility_name, values=values)
        )

    return texas_rows, rows_in, non_texas


# --------------------------------------------------------------------------
# Load core.utility_reliability
# --------------------------------------------------------------------------


def load_core(conn, manifest_id: str, texas_rows: list[ReliabilityRow], *, early_release: bool) -> int:
    loaded = 0
    with conn.cursor() as cur:
        for row in texas_rows:
            saidi_incl, saidi_incl_reason = row.values["incl_major.saidi"]
            saifi_incl, saifi_incl_reason = row.values["incl_major.saifi"]
            caidi_incl, caidi_incl_reason = row.values["incl_major.caidi"]
            saidi_excl, saidi_excl_reason = row.values["excl_major.saidi"]
            saifi_excl, saifi_excl_reason = row.values["excl_major.saifi"]
            caidi_excl, caidi_excl_reason = row.values["excl_major.caidi"]

            cur.execute(
                """
                insert into core.utility_reliability (
                    eia_id, year, utility_name,
                    saidi_incl_major, saidi_incl_major_null_reason,
                    saidi_excl_major, saidi_excl_major_null_reason,
                    saifi_incl_major, saifi_incl_major_null_reason,
                    saifi_excl_major, saifi_excl_major_null_reason,
                    caidi_incl_major, caidi_incl_major_null_reason,
                    caidi_excl_major, caidi_excl_major_null_reason,
                    early_release, source_id
                ) values (
                    %s, %s, %s,
                    %s, %s,
                    %s, %s,
                    %s, %s,
                    %s, %s,
                    %s, %s,
                    %s, %s,
                    %s, %s
                )
                on conflict (eia_id, year) do update set
                    utility_name = excluded.utility_name,
                    saidi_incl_major = excluded.saidi_incl_major,
                    saidi_incl_major_null_reason = excluded.saidi_incl_major_null_reason,
                    saidi_excl_major = excluded.saidi_excl_major,
                    saidi_excl_major_null_reason = excluded.saidi_excl_major_null_reason,
                    saifi_incl_major = excluded.saifi_incl_major,
                    saifi_incl_major_null_reason = excluded.saifi_incl_major_null_reason,
                    saifi_excl_major = excluded.saifi_excl_major,
                    saifi_excl_major_null_reason = excluded.saifi_excl_major_null_reason,
                    caidi_incl_major = excluded.caidi_incl_major,
                    caidi_incl_major_null_reason = excluded.caidi_incl_major_null_reason,
                    caidi_excl_major = excluded.caidi_excl_major,
                    caidi_excl_major_null_reason = excluded.caidi_excl_major_null_reason,
                    early_release = excluded.early_release,
                    source_id = excluded.source_id
                """,
                (
                    row.eia_id, row.year, row.utility_name,
                    saidi_incl, saidi_incl_reason,
                    saidi_excl, saidi_excl_reason,
                    saifi_incl, saifi_incl_reason,
                    saifi_excl, saifi_excl_reason,
                    caidi_incl, caidi_incl_reason,
                    caidi_excl, caidi_excl_reason,
                    early_release, manifest_id,
                ),
            )
            loaded += 1
    return loaded


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------


def run(*, runner: Runner, backfill: bool = False, cursor: dict[str, Any] | None = None) -> None:
    for spec in FILES:
        manifest_row = _ensure_manifest(spec, runner)
        manifest_id = manifest_row["id"]

        with db.connect(pooled=False) as conn:
            run_id = runs.start(conn, source=SOURCE, runner=runner, cursor=None)
            with conn.cursor() as cur:
                cur.execute("update ops.pipeline_runs set manifest_id = %s where id = %s", (manifest_id, run_id))

        try:
            xlsx_bytes = extract_reliability_xlsx(manifest_row["data"])
            texas_rows, rows_in, non_texas = read_texas_rows(xlsx_bytes)

            with db.connect(pooled=False) as conn:
                loaded = load_core(conn, manifest_id, texas_rows, early_release=spec.early_release)

            _set_manifest_rows(manifest_id, rows_in)
            filter_drops = {"non_texas": non_texas}
            with db.connect(pooled=False) as conn:
                runs.finish(
                    conn, run_id, status="success",
                    rows_in=rows_in, rows_loaded=loaded, filter_drops=filter_drops, cursor=None,
                )
        except Exception as exc:
            with db.connect(pooled=False) as conn:
                runs.finish(conn, run_id, status="failed", error=str(exc), cursor=None)
            raise
