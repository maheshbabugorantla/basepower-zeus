"""Permit timelines and permit-path risk stats -> core.permit_timelines /
core.permit_path_stats.

Reads the ALREADY-manifested Austin Issued Construction Permits raw file
(data/raw/austin_permits/austin_permits_<YYYYMMDD>.jsonl, fetched by
pipelines/sources/austin_permits.py) directly for fields core.permits
does not carry (applieddate, issue_method, jurisdiction,
contractor_company_name) -- no new download. This module locates the
current raw file by matching its SHA-256 against the newest
ops.source_manifest row for source='austin_permits', and reuses that
row's id as source_id on every row it writes (per the real-data rule:
"only load data that comes from a raw file with an ops.source_manifest
row" -- this is the SAME manifest row austin_permits.py already
recorded, not a new one).

core.permit_timelines: one row per permit that core.permit_labels
(labeller='rules', from austin_permits.py's keyword classifier) has
already tagged battery/generator/solar/panel/ev. A permit can carry more
than one label (e.g. "battery" and "generator" both matched); this table
stores one representative label per permit_number (its primary key),
chosen by priority battery > generator > solar > panel > ev -- the
per-label AGGREGATE stats below use every matching label, not just the
representative one.

core.permit_path_stats: median/p90 days-to-issue, share never finished
(status Expired/Withdrawn/VOID) and share issued online (issue_method
other than the in-person "Permit Center") -- grouped two ways:
  - period_type='sb1252': period in ('overall', 'before_sb1252',
    'after_sb1252') -- before/after Texas SB 1252's 2025-09-01 effective
    date, bucketed by issue_date (permits never issued have no
    before/after bucket but still count in 'overall'). jurisdiction is
    every distinct raw `jurisdiction` value with >=1 labelled permit,
    PLUS an 'ALL' row (every jurisdiction combined -- the citywide
    number product copy quotes, e.g. "battery permits median 7 days
    before SB 1252").
  - period_type='quarter': period = 'YYYY-Qn' by issue_date's calendar
    quarter, jurisdiction='ALL' only (the Overview panel is citywide).
is_base_power rows (contractor_company_name EXACTLY 'Base Power' -- NOT
a substring match: 'Solid Base Electric, LLC' is a different company
and must never match) always use jurisdiction='ALL'.
"""
from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pipelines.core import db, runs

SOURCE = "permit_timelines"
AUSTIN_PERMITS_SOURCE = "austin_permits"

RAW_DIR = Path(
    "/Users/maheshbabugorantla/Code/Hackathons/BasePower_Deep_Tech_Hackathon_Sep_25_2026_Mavericks"
    "/data/raw/austin_permits"
)

SB1252_EFFECTIVE = date(2025, 9, 1)
NEVER_FINISHED_STATUSES = {"Expired", "Withdrawn", "VOID"}
IN_PERSON_ISSUE_METHODS = {"Permit Center"}  # the only value ever observed in this dataset
LABELS = ("battery", "generator", "solar", "panel", "ev")
LABEL_PRIORITY = LABELS  # battery > generator > solar > panel > ev
BASE_POWER_CONTRACTOR = "Base Power"

Runner = Literal["cron", "cli"]


# ---------------------------------------------------------------------------
# Field parsing (raw JSON -> plain python values, never re-derived/invented)
# ---------------------------------------------------------------------------


def _clean_str(value: Any) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    return s or None


def _parse_date(value: Any) -> date | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).date()
    except ValueError:
        return None


def days_to_issue(applied: date | None, issued: date | None) -> int | None:
    if applied is None or issued is None:
        return None
    return (issued - applied).days


def is_base_power(contractor_company_name: str | None) -> bool:
    """Exact match only: 'Solid Base Electric, LLC' is a different company."""
    return (contractor_company_name or "").strip() == BASE_POWER_CONTRACTOR


def is_never_finished(status_current: str | None) -> bool:
    return status_current in NEVER_FINISHED_STATUSES


def is_issued_online(issue_method: str | None) -> bool:
    return issue_method is not None and issue_method not in IN_PERSON_ISSUE_METHODS


def sb1252_period(issue_date: date | None) -> str | None:
    """None if never issued (no before/after bucket -- see module docstring)."""
    if issue_date is None:
        return None
    return "before_sb1252" if issue_date < SB1252_EFFECTIVE else "after_sb1252"


def quarter_of(d: date | None) -> str | None:
    if d is None:
        return None
    return f"{d.year}Q{(d.month - 1) // 3 + 1}"


def record_fields(record: dict[str, Any]) -> dict[str, Any]:
    """Parse the raw-file fields this module needs from one JSON record."""
    applied = _parse_date(record.get("applieddate"))
    issued = _parse_date(record.get("issue_date"))
    return {
        "permit_number": _clean_str(record.get("permit_number")),
        "applied_date": applied,
        "issued_date": issued,
        "days_to_issue": days_to_issue(applied, issued),
        "issue_method": _clean_str(record.get("issue_method")),
        "status_current": _clean_str(record.get("status_current")),
        "jurisdiction": _clean_str(record.get("jurisdiction")),
        "contractor_company_name": _clean_str(record.get("contractor_company_name")),
    }


def primary_label(labels: list[str]) -> str | None:
    label_set = set(labels)
    for label in LABEL_PRIORITY:
        if label in label_set:
            return label
    return None


# ---------------------------------------------------------------------------
# Locate the already-manifested raw file (no new download, no new manifest row)
# ---------------------------------------------------------------------------


def _sha256_of_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def find_manifest_and_raw_file(conn) -> tuple[str, Path]:
    """Return (source_id, raw_file_path) for the newest austin_permits
    manifest row whose sha256 matches a real file under RAW_DIR. Raises
    if no such file exists -- per the real-data rule, this module never
    substitutes a different file or invents a source_id."""
    with conn.cursor() as cur:
        cur.execute(
            "select id, sha256 from ops.source_manifest "
            "where source = %s order by retrieved_at desc",
            (AUSTIN_PERMITS_SOURCE,),
        )
        manifest_rows = cur.fetchall()
    if not manifest_rows:
        raise RuntimeError(
            f"no ops.source_manifest row for source={AUSTIN_PERMITS_SOURCE!r} -- "
            "run `python -m pipelines.run austin_permits` first"
        )

    candidates = sorted(RAW_DIR.glob("austin_permits_*.jsonl"))
    if not candidates:
        raise RuntimeError(f"no austin_permits_*.jsonl raw file found under {RAW_DIR}")

    file_sha256 = {path: _sha256_of_file(path) for path in candidates}
    for manifest_id, sha256 in manifest_rows:
        for path, actual_sha256 in file_sha256.items():
            if actual_sha256 == sha256:
                return str(manifest_id), path

    raise RuntimeError(
        f"no local file under {RAW_DIR} matches any austin_permits ops.source_manifest sha256 "
        "-- stopping rather than substituting a different file"
    )


def iter_jsonl(path: Path):
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)


# ---------------------------------------------------------------------------
# One pass over the raw file: collect labelled-permit records + Base Power
# records (everything else is derived from these two small collections).
# ---------------------------------------------------------------------------


def read_relevant_records(path: Path, labelled_permit_numbers: set[str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    labelled: list[dict[str, Any]] = []
    base_power: list[dict[str, Any]] = []
    for record in iter_jsonl(path):
        fields = record_fields(record)
        pn = fields["permit_number"]
        if pn is None:
            continue
        if is_base_power(fields["contractor_company_name"]):
            base_power.append(fields)
        if pn in labelled_permit_numbers:
            labelled.append(fields)
    return labelled, base_power


def fetch_rules_labels(conn) -> dict[str, list[str]]:
    """permit_number -> list of rules labels among LABELS."""
    with conn.cursor() as cur:
        cur.execute(
            "select permit_number, label from core.permit_labels "
            "where labeller = 'rules' and label = any(%s)",
            (list(LABELS),),
        )
        by_permit: dict[str, list[str]] = defaultdict(list)
        for permit_number, label in cur.fetchall():
            by_permit[permit_number].append(label)
    return dict(by_permit)


# ---------------------------------------------------------------------------
# core.permit_timelines rows
# ---------------------------------------------------------------------------


def build_timeline_rows(
    labelled_records: list[dict[str, Any]], labels_by_permit: dict[str, list[str]]
) -> list[dict[str, Any]]:
    rows = []
    for fields in labelled_records:
        pn = fields["permit_number"]
        labels = labels_by_permit.get(pn, [])
        label = primary_label(labels)
        if label is None:
            continue
        rows.append({**fields, "label": label})
    return rows


def load_timelines(conn, source_id: str, rows: list[dict[str, Any]]) -> int:
    if not rows:
        return 0
    with conn.cursor() as cur:
        cur.executemany(
            """
            insert into core.permit_timelines (
                permit_number, label, applied_date, issued_date, days_to_issue,
                issue_method, status_current, jurisdiction, contractor_company_name,
                is_base_power, source_id
            ) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            on conflict (permit_number) do update set
                label = excluded.label,
                applied_date = excluded.applied_date,
                issued_date = excluded.issued_date,
                days_to_issue = excluded.days_to_issue,
                issue_method = excluded.issue_method,
                status_current = excluded.status_current,
                jurisdiction = excluded.jurisdiction,
                contractor_company_name = excluded.contractor_company_name,
                is_base_power = excluded.is_base_power,
                source_id = excluded.source_id
            """,
            [
                (
                    r["permit_number"], r["label"], r["applied_date"], r["issued_date"],
                    r["days_to_issue"], r["issue_method"], r["status_current"],
                    r["jurisdiction"], r["contractor_company_name"],
                    is_base_power(r["contractor_company_name"]), source_id,
                )
                for r in rows
            ],
        )
    return len(rows)


# ---------------------------------------------------------------------------
# core.permit_path_stats
# ---------------------------------------------------------------------------


def _percentile(values: list[int], p: float) -> float | None:
    if not values:
        return None
    vals = sorted(values)
    k = (len(vals) - 1) * (p / 100)
    f = int(k)
    c = min(f + 1, len(vals) - 1)
    if f == c:
        return float(vals[f])
    d0 = vals[f] * (c - k)
    d1 = vals[c] * (k - f)
    return d0 + d1


def _median(values: list[int]) -> float | None:
    return _percentile(values, 50)


def _stat_row(fields_list: list[dict[str, Any]]) -> dict[str, Any]:
    n = len(fields_list)
    days = [f["days_to_issue"] for f in fields_list if f["days_to_issue"] is not None]
    never_finished = sum(1 for f in fields_list if is_never_finished(f["status_current"]))
    online = sum(1 for f in fields_list if is_issued_online(f["issue_method"]))
    return {
        "n": n,
        "median_days": _median(days),
        "p90_days": _percentile(days, 90),
        "share_never_finished": (never_finished / n) if n else None,
        "share_issued_online": (online / n) if n else None,
    }


def compute_stat_rows(
    labelled_records: list[dict[str, Any]],
    labels_by_permit: dict[str, list[str]],
    base_power_records: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Every (jurisdiction, label, is_base_power, period_type, period) bucket
    this module fills, each with its own real n/median/p90/shares."""
    stats: list[dict[str, Any]] = []

    # --- non-Base-Power buckets: one entry per (label, jurisdiction) among
    # labelled permits, using every label a permit matched (not just its
    # primary one) so a battery+generator permit counts in both buckets.
    by_label_jur: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    by_label_all: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for fields in labelled_records:
        pn = fields["permit_number"]
        jur = fields["jurisdiction"]
        for label in labels_by_permit.get(pn, []):
            # A permit with no real jurisdiction value only counts in the
            # 'ALL' aggregate below -- never invent an "UNKNOWN" jurisdiction
            # bucket for it.
            if jur is not None:
                by_label_jur[(label, jur)].append(fields)
            by_label_all[label].append(fields)

    def emit_sb1252(jurisdiction: str, label: str, records: list[dict[str, Any]], is_bp: bool) -> None:
        stats.append({
            "jurisdiction": jurisdiction, "label": label, "is_base_power": is_bp,
            "period_type": "sb1252", "period": "overall", **_stat_row(records),
        })
        for period_name in ("before_sb1252", "after_sb1252"):
            subset = [f for f in records if sb1252_period(f["issued_date"]) == period_name]
            stats.append({
                "jurisdiction": jurisdiction, "label": label, "is_base_power": is_bp,
                "period_type": "sb1252", "period": period_name, **_stat_row(subset),
            })

    def emit_quarters(jurisdiction: str, label: str, records: list[dict[str, Any]], is_bp: bool) -> None:
        by_quarter: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for f in records:
            q = quarter_of(f["issued_date"])
            if q is not None:
                by_quarter[q].append(f)
        for q, subset in by_quarter.items():
            stats.append({
                "jurisdiction": jurisdiction, "label": label, "is_base_power": is_bp,
                "period_type": "quarter", "period": q, **_stat_row(subset),
            })

    for (label, jur), records in by_label_jur.items():
        emit_sb1252(jur, label, records, is_bp=False)
    for label, records in by_label_all.items():
        emit_sb1252("ALL", label, records, is_bp=False)
        emit_quarters("ALL", label, records, is_bp=False)

    # --- Base Power's own permits: jurisdiction='ALL' only. label='ALL'
    # covers every one of Base Power's permits regardless of classification
    # (327 total, only some of which are battery-labelled); label='battery'
    # restricts to Base Power's battery-labelled permits specifically.
    emit_sb1252("ALL", "ALL", base_power_records, is_bp=True)
    emit_quarters("ALL", "ALL", base_power_records, is_bp=True)
    base_power_battery = [
        f for f in base_power_records
        if "battery" in labels_by_permit.get(f["permit_number"], [])
    ]
    emit_sb1252("ALL", "battery", base_power_battery, is_bp=True)
    emit_quarters("ALL", "battery", base_power_battery, is_bp=True)

    return stats


def load_stats(conn, source_id: str, stats: list[dict[str, Any]]) -> int:
    if not stats:
        return 0
    with conn.cursor() as cur:
        cur.executemany(
            """
            insert into core.permit_path_stats (
                jurisdiction, label, is_base_power, period_type, period,
                n, median_days, p90_days, share_never_finished, share_issued_online,
                source_id
            ) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            on conflict (jurisdiction, label, is_base_power, period_type, period) do update set
                n = excluded.n,
                median_days = excluded.median_days,
                p90_days = excluded.p90_days,
                share_never_finished = excluded.share_never_finished,
                share_issued_online = excluded.share_issued_online,
                source_id = excluded.source_id,
                updated_at = now()
            """,
            [
                (
                    s["jurisdiction"], s["label"], s["is_base_power"], s["period_type"], s["period"],
                    s["n"], s["median_days"], s["p90_days"], s["share_never_finished"], s["share_issued_online"],
                    source_id,
                )
                for s in stats
            ],
        )
    return len(stats)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def run(*, runner: Runner, backfill: bool = False, cursor: dict[str, Any] | None = None) -> None:
    with db.connect(pooled=False) as conn:
        source_id, raw_path = find_manifest_and_raw_file(conn)
        run_id = runs.start(conn, source=SOURCE, runner=runner)
        with conn.cursor() as cur:
            cur.execute("update ops.pipeline_runs set manifest_id = %s where id = %s", (source_id, run_id))

    try:
        with db.connect(pooled=False) as conn:
            labels_by_permit = fetch_rules_labels(conn)
        labelled_records, base_power_records = read_relevant_records(raw_path, set(labels_by_permit.keys()))
        timeline_rows = build_timeline_rows(labelled_records, labels_by_permit)
        stat_rows = compute_stat_rows(labelled_records, labels_by_permit, base_power_records)

        with db.connect(pooled=False) as conn:
            rows_loaded = load_timelines(conn, source_id, timeline_rows)
            stats_loaded = load_stats(conn, source_id, stat_rows)

        with db.connect(pooled=False) as conn:
            runs.finish(
                conn, run_id, status="success",
                rows_in=len(labelled_records), rows_loaded=rows_loaded,
                filter_drops={}, cursor={"stats_rows_loaded": stats_loaded},
            )
    except Exception as exc:
        with db.connect(pooled=False) as conn:
            runs.finish(conn, run_id, status="failed", error=str(exc))
        raise
