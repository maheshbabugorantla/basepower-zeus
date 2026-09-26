"""Real tests for pipelines/sources/base_service_areas.py.

No synthetic rows: the fixture is a byte slice of the real
data/raw/base_service_areas/pricing.md snapshot (see
fixtures/base_service_areas/pricing_outline_slice0.md.source.json for
its exact byte range in that staged file). The parser is exercised only
against this real slice — no fabricated markdown.

The live-DB test requires a real backfill to have already loaded
core.base_service_areas (via
`python -m pipelines.run base_service_areas --backfill`) and is skipped
if POSTGRES_URL_NON_POOLING isn't configured.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from sources import base_service_areas

FIXTURE = Path(__file__).parent / "fixtures" / "base_service_areas" / "pricing_outline_slice0.md"


def _load_fixture_text() -> str:
    return FIXTURE.read_text(encoding="utf-8")


def test_parse_utilities_on_real_fixture_stops_before_non_utility_bullet():
    text = _load_fixture_text()
    names = base_service_areas.parse_utilities(text)

    # Real names, in page order, exactly as they appear in the fixture
    # slice — never a hard-coded list compared out of context: this
    # asserts the module's own parse against the real bytes.
    expected = [
        "CenterPoint Energy",
        "Oncor",
        "AEP Texas Central",
        "AEP Texas North",
        "Texas–New Mexico Power",
        "ComEd",
        "Guadalupe Valley EC",
        "CoServ",
        "Farmers EC",
        "Austin Energy",
        "El Paso Electric",
    ]
    assert names == expected

    # The first non-utility bullet in the real fixture must never be
    # included (this is the actual behavior under test, not the fixture
    # data): every parsed name must literally appear as its own child
    # bullet line in the fixture, and the very next bullet after the
    # last parsed name must be the "See your exact rate..." sentence.
    lines = text.splitlines()
    bullet_lines = [l.strip("- ").strip() for l in lines if l.startswith("  - ")]
    assert bullet_lines[: len(names)] == names
    assert bullet_lines[len(names)] == "See your exact rate in two minutes"


def test_looks_like_utility_name():
    for name in ["CenterPoint Energy", "AEP Texas Central", "ComEd", "Texas–New Mexico Power"]:
        assert base_service_areas._looks_like_utility_name(name), name
    for sentence in ["See your exact rate in two minutes", "How it works"]:
        assert not base_service_areas._looks_like_utility_name(sentence), sentence


@pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL_NON_POOLING"),
    reason="requires POSTGRES_URL_NON_POOLING (real Supabase pooler) to check the live backfill",
)
def test_live_db_base_service_areas_loaded():
    from pipelines.core import db

    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute("select count(*) from core.base_service_areas")
            count = cur.fetchone()[0]
            assert count > 0, "core.base_service_areas has no rows after backfill"

            cur.execute(
                "select utility_name from core.base_service_areas "
                "where utility_name = 'ComEd'"
            )
            assert cur.fetchone() is not None, "ComEd should be loaded (it is on the real pricing.md page)"
