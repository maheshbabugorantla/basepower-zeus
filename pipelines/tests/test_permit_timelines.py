"""Real tests for pipelines/sources/permit_timelines.py.

No synthetic rows. Two kinds of real data are used:

1. Small fixtures under fixtures/permit_timelines/ -- single-line byte
   slices of the real austin_permits raw file (each with a sidecar
   recording its exact byte range, per the fixture-sidecar contract) --
   for narrow, fast checks of field parsing, the is_base_power EXACT
   match (a real 'Base Power' permit and a real 'Solid Base Electric,
   LLC' permit -- a different company that must never match), never-
   finished/period classification.

2. The FULL real austin_permits raw file (not a fixture -- the whole
   manifested source itself, so no sidecar applies) for the acceptance
   criterion "Austin battery median/p90 days by quarter match a direct
   recount of the raw file": this test independently recomputes the
   battery label with austin_permits.classify_text (the same reviewed
   RULES table austin_permits.py's own classifier uses, and the same one
   that already filled core.permit_labels) rather than trusting this
   module's own stats code, then asserts the exact figures quoted in
   tickets/M2/M2-P9.md.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from sources import austin_permits, permit_timelines

FIXTURES = Path(__file__).parent / "fixtures" / "permit_timelines"
RAW_FILE = Path(
    "/Users/maheshbabugorantla/Code/Hackathons/BasePower_Deep_Tech_Hackathon_Sep_25_2026_Mavericks"
    "/data/raw/austin_permits/austin_permits_20260926.jsonl"
)


def _load_fixture_record(name: str) -> dict:
    path = FIXTURES / f"{name}.jsonl"
    with open(path, "r", encoding="utf-8") as f:
        line = f.readline().strip()
    return json.loads(line)


# ---------------------------------------------------------------------------
# Fixture-level checks: field parsing, is_base_power exact match, never-
# finished / SB 1252 period classification.
# ---------------------------------------------------------------------------


def test_record_fields_before_sb1252():
    rec = _load_fixture_record("battery_before_sb1252")
    fields = permit_timelines.record_fields(rec)
    assert fields["permit_number"] == "2023-043728 EP"
    assert fields["applied_date"].isoformat() == "2023-04-11"
    assert fields["issued_date"].isoformat() == "2023-11-21"
    assert fields["days_to_issue"] == (fields["issued_date"] - fields["applied_date"]).days
    assert permit_timelines.sb1252_period(fields["issued_date"]) == "before_sb1252"
    assert fields["status_current"] == "Final"
    assert not permit_timelines.is_never_finished(fields["status_current"])


def test_record_fields_after_sb1252():
    rec = _load_fixture_record("battery_after_sb1252")
    fields = permit_timelines.record_fields(rec)
    assert fields["issued_date"].isoformat() == "2025-11-24"
    assert permit_timelines.sb1252_period(fields["issued_date"]) == "after_sb1252"


def test_never_finished_status():
    rec = _load_fixture_record("battery_never_finished")
    fields = permit_timelines.record_fields(rec)
    assert fields["status_current"] == "Expired"
    assert permit_timelines.is_never_finished(fields["status_current"])


def test_is_base_power_is_an_exact_match_not_a_substring():
    base_power_rec = _load_fixture_record("base_power_permit")
    assert base_power_rec["contractor_company_name"] == "Base Power"
    assert permit_timelines.is_base_power(base_power_rec["contractor_company_name"]) is True

    # A real permit from "Solid Base Electric, LLC" -- a different
    # company whose name merely contains the substring "Base" -- must
    # NEVER be classified as a Base Power permit.
    solid_base_rec = _load_fixture_record("solid_base_electric_permit")
    assert solid_base_rec["contractor_company_name"] == "Solid Base Electric, LLC"
    assert permit_timelines.is_base_power(solid_base_rec["contractor_company_name"]) is False


def test_quarter_of():
    rec = _load_fixture_record("battery_after_sb1252")
    fields = permit_timelines.record_fields(rec)
    assert permit_timelines.quarter_of(fields["issued_date"]) == "2025Q4"


def test_issue_method_is_never_online_in_this_dataset():
    # The real raw file's issue_method is 100% "Permit Center" (in
    # person) for every fixture record here -- share_issued_online must
    # come out as a real 0.0, never an invented nonzero value.
    for name in ("battery_before_sb1252", "battery_after_sb1252", "battery_never_finished"):
        rec = _load_fixture_record(name)
        fields = permit_timelines.record_fields(rec)
        assert fields["issue_method"] == "Permit Center"
        assert permit_timelines.is_issued_online(fields["issue_method"]) is False


def test_primary_label_priority_battery_over_generator():
    assert permit_timelines.primary_label(["generator", "battery"]) == "battery"
    assert permit_timelines.primary_label(["panel", "ev"]) == "panel"
    assert permit_timelines.primary_label([]) is None


# ---------------------------------------------------------------------------
# Full-raw-file recount: matches tickets/M2/M2-P9.md's expected numbers,
# using an INDEPENDENT recomputation of the battery label (the reviewed
# RULES table austin_permits.py's classifier already uses) rather than
# this module's own stats code trusting itself.
# ---------------------------------------------------------------------------

pytestmark_skip_no_raw = pytest.mark.skipif(
    not RAW_FILE.is_file(), reason=f"real austin_permits raw file not found at {RAW_FILE}"
)


def _independent_battery_permit_numbers() -> set[str]:
    """Recompute which permits are battery-labelled directly from the raw
    file's own description/work_class/permit_type_desc text, using
    austin_permits.classify_text (the same RULES table, not this
    module's own label-fetching code path)."""
    battery: set[str] = set()
    for record in permit_timelines.iter_jsonl(RAW_FILE):
        row = austin_permits.record_to_permit_row(record)
        if row is None:
            continue
        text = " ".join(
            part for part in (row["description"], row["work_class"], row["permit_type_desc"]) if part
        )
        labels = {label for label, _kw in austin_permits.classify_text(text)}
        if "battery" in labels:
            battery.add(row["permit_number"])
    return battery


@pytestmark_skip_no_raw
def test_austin_battery_permit_days_to_issue_recount_matches_ticket():
    battery_permits = _independent_battery_permit_numbers()
    assert len(battery_permits) > 0

    labelled_records = []
    base_power_records = []
    for record in permit_timelines.iter_jsonl(RAW_FILE):
        fields = permit_timelines.record_fields(record)
        if fields["permit_number"] in battery_permits:
            labelled_records.append(fields)
        if permit_timelines.is_base_power(fields["contractor_company_name"]):
            base_power_records.append(fields)

    labels_by_permit = {pn: ["battery"] for pn in battery_permits}
    stats = permit_timelines.compute_stat_rows(labelled_records, labels_by_permit, base_power_records)
    by_key = {(s["jurisdiction"], s["label"], s["is_base_power"], s["period_type"], s["period"]): s for s in stats}

    before = by_key[("ALL", "battery", False, "sb1252", "before_sb1252")]
    assert before["n"] == 783
    assert before["median_days"] == 7
    assert before["p90_days"] == 36.0

    after = by_key[("ALL", "battery", False, "sb1252", "after_sb1252")]
    assert after["n"] == 669
    assert after["median_days"] == 12
    assert after["p90_days"] == 34.0

    overall = by_key[("ALL", "battery", False, "sb1252", "overall")]
    assert overall["n"] == 1452
    # ~9% never finish: 6.2% expired + 2.8% withdrawn (ticket's own figure)
    assert 0.08 < overall["share_never_finished"] < 0.10
    assert overall["share_issued_online"] == 0.0

    base_power_all = by_key[("ALL", "ALL", True, "sb1252", "overall")]
    assert base_power_all["n"] == 327

    base_power_q3 = by_key[("ALL", "ALL", True, "quarter", "2026Q3")]
    assert base_power_q3["n"] == 315
    assert base_power_q3["median_days"] == 14
    assert base_power_q3["p90_days"] == 20.0

    # Quarter breakdown for ALL installers, not just Base Power (the
    # Overview panel's "by quarter" line): 2026Q3 is the most recent full
    # quarter in this raw file.
    all_installers_q3 = by_key[("ALL", "battery", False, "quarter", "2026Q3")]
    assert all_installers_q3["n"] == 363
    assert all_installers_q3["median_days"] == 14
    assert all_installers_q3["p90_days"] == 22.0


# ---------------------------------------------------------------------------
# Live-DB check (skipped without POSTGRES_URL_NON_POOLING): the real
# backfill loaded core.permit_timelines / core.permit_path_stats, every
# row resolves to a real ops.source_manifest row, and is_base_power never
# matches "Solid Base Electric, LLC".
# ---------------------------------------------------------------------------


@pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) to check the live backfill",
)
def test_live_db_permit_timelines_and_stats_loaded():
    from pipelines.core import db

    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute("select count(*) from core.permit_timelines")
            timelines_count = cur.fetchone()[0]
            assert timelines_count > 0, "core.permit_timelines has no rows after backfill"

            cur.execute("select count(*) from core.permit_path_stats")
            stats_count = cur.fetchone()[0]
            assert stats_count > 0, "core.permit_path_stats has no rows after backfill"

            cur.execute(
                """
                select count(*) from core.permit_timelines pt
                join ops.source_manifest sm on sm.id = pt.source_id
                where sm.source = 'austin_permits'
                """
            )
            assert cur.fetchone()[0] == timelines_count, (
                "some core.permit_timelines rows don't resolve to an austin_permits manifest row"
            )

            cur.execute(
                "select count(*) from core.permit_timelines "
                "where contractor_company_name = 'Solid Base Electric, LLC' and is_base_power"
            )
            assert cur.fetchone()[0] == 0, "'Solid Base Electric, LLC' must never be flagged is_base_power"

            cur.execute(
                "select n, median_days, p90_days from api.permit_path_stats "
                "where jurisdiction = 'ALL' and label = 'battery' and not is_base_power "
                "and period_type = 'sb1252' and period = 'before_sb1252'"
            )
            row = cur.fetchone()
            assert row is not None
            assert row[0] == 783
            assert row[1] == 7
            assert row[2] == 36

            cur.execute(
                "select n, median_days, p90_days from api.permit_path_stats "
                "where jurisdiction = 'ALL' and label = 'ALL' and is_base_power "
                "and period_type = 'quarter' and period = '2026Q3'"
            )
            row = cur.fetchone()
            assert row is not None
            assert row[0] == 315
            assert row[1] == 14
            assert row[2] == 20
