"""Real tests for pipelines/sources/austin_permits.py.

No synthetic rows: the fixture is a byte slice of the real Austin permits
JSON-lines raw file fetched by this module (see
fixtures/austin_permits/austin_permits_slice0.jsonl.source.json for its
exact byte range in that file). The classifier check recomputes expected
labels independently in-test (plain `in`/regex checks against the RULES
table, not any of the module's own matching code path beyond the shared
RULES data), on real permit descriptions.

The live-DB test requires a real backfill to have already loaded
core.permits / core.permit_labels / ops.label_queue (via
`python -m pipelines.run austin_permits --backfill`) and is skipped if
POSTGRES_URL_NON_POOLING isn't configured.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

import pytest

from sources import austin_permits

FIXTURE = Path(__file__).parent / "fixtures" / "austin_permits" / "austin_permits_slice0.jsonl"


def _load_fixture_records() -> list[dict]:
    records = []
    with open(FIXTURE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def test_classify_matches_independent_recompute_on_fixture():
    records = _load_fixture_records()
    assert len(records) > 0

    saw_any_positive_label = False
    for record in records:
        row = austin_permits.record_to_permit_row(record)
        if row is None:
            continue
        text = " ".join(
            part for part in (row["description"], row["work_class"], row["permit_type_desc"]) if part
        )
        got = austin_permits.classify_permit_row(row)
        got_labels = {label for label, _keyword in got}

        # Independent recomputation of the same fixture row, using the
        # shared RULES table but not classify_text/classify_permit_row.
        lowered = (text or "").lower()
        expected_labels = set()
        for label, keywords in austin_permits.RULES.items():
            for kw in keywords:
                if re.search(r"\b" + re.escape(kw) + r"\b", lowered):
                    expected_labels.add(label)
                    break

        assert got_labels == expected_labels, f"{row['permit_number']}: got {got_labels}, expected {expected_labels}"

        # Every returned (label, keyword) pair's keyword must actually be a
        # word-bounded case-insensitive substring of the row's text (the
        # rationale must be real, not invented).
        for label, keyword in got:
            assert re.search(r"\b" + re.escape(keyword) + r"\b", lowered)
            assert keyword in austin_permits.RULES[label]

        if got_labels & {"battery", "generator"}:
            saw_any_positive_label = True

    assert saw_any_positive_label, "fixture slice was chosen to contain a battery/generator match"


@pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) to check the live backfill",
)
def test_live_db_permits_labels_and_queue_loaded():
    from pipelines.core import db

    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute("select count(*) from core.permits")
            permits_count = cur.fetchone()[0]
            assert permits_count > 0, "core.permits has no rows after backfill"

            cur.execute("select count(*) from core.permit_labels where labeller = 'rules'")
            labels_count = cur.fetchone()[0]
            assert labels_count > 0, "core.permit_labels has no rules-labelled rows"

            cur.execute("select count(*) from ops.label_queue")
            queue_count = cur.fetchone()[0]
            assert queue_count == 100, f"ops.label_queue has {queue_count} rows, expected 100"

            cur.execute(
                """
                select count(*) from core.permits pm
                join ops.source_manifest sm on sm.id = pm.source_id
                where sm.source = 'austin_permits'
                """
            )
            assert cur.fetchone()[0] == permits_count, "some core.permits rows don't resolve to an austin_permits manifest row"
