"""Real-DB tests for pipelines/pipelines/check.py (M0-P2).

No synthetic/mock rows are inserted anywhere, per the real-data rule.
Every assertion here is about the *actual* current state of the live
Supabase database (POSTGRES_URL etc., exported into the environment by
whatever invoked pytest — see CLAUDE.md's `set -a; source .env; set +a`
convention). CI has no DB secrets (see .github/workflows/ci.yml), so
every test here is skipped, not failed, when POSTGRES_URL is unset.

As of M0, no pipeline source has loaded anything yet, so every data
table is empty and only ops.refresh_policy (seeded, static config from
0001_m0.sql) has rows. Tests query the live state first and assert
against whatever they find, rather than hard-coding today's row counts
or a specific source name — those would go stale the moment a sibling
pipeline-dev ticket (e.g. M0-P1) loads real data. Where a test needs a
real empty table / real source with no runs and none currently exists,
it skips with an explicit reason instead of fabricating one.
"""
from __future__ import annotations

import json
import os

import pytest

from pipelines import check
from pipelines.core import db

pytestmark = pytest.mark.skipif(
    not os.environ.get("POSTGRES_URL"),
    reason="requires POSTGRES_URL (and Supabase secrets) in the environment; CI has no DB secrets",
)


def _run(argv: list[str]) -> int:
    return check.main(argv)


def _query(sql: str, params: tuple = ()) -> list[tuple]:
    with db.connect() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()


def _base_table_counts() -> dict[str, int]:
    tables = _query(
        """
        select table_schema, table_name
        from information_schema.tables
        where table_schema in ('ops', 'core') and table_type = 'BASE TABLE'
        """
    )
    counts = {}
    for schema, name in tables:
        (count,) = _query(f"select count(*) from {schema}.{name}")[0]
        counts[f"{schema}.{name}"] = count
    return counts


# ---------------------------------------------------------------------------
# rows
# ---------------------------------------------------------------------------

def test_rows_on_a_currently_empty_table_with_min_1_fails(capsys):
    # Find a real ops/core base table that is empty right now (as of M0,
    # every data table is, before any pipeline-dev ticket has loaded
    # anything). --min 1 on an empty table must fail — this is the one
    # subcommand that must NOT pass vacuously.
    empty_tables = [t for t, count in _base_table_counts().items() if count == 0]
    if not empty_tables:
        pytest.skip("no empty ops/core base table exists right now to test the failing case against")

    code = _run(["rows", "--table", empty_tables[0], "--min", "1"])
    out = capsys.readouterr()
    assert code == 1
    assert "FAIL" in out.err


def test_rows_on_seeded_refresh_policy_passes(capsys):
    # ops.refresh_policy is seeded by 0001_m0.sql with static config rows
    # (not observed data) that are always present — a real, already-loaded
    # table to assert the passing case against.
    (actual,) = _query("select count(*) from ops.refresh_policy")[0]
    assert actual > 0, "expected 0001_m0.sql's seeded ops.refresh_policy rows"

    code = _run(["rows", "--table", "ops.refresh_policy", "--min", "1"])
    out = capsys.readouterr()
    assert code == 0
    assert "OK" in out.out


def test_rows_min_higher_than_actual_count_fails(capsys):
    (actual,) = _query("select count(*) from ops.refresh_policy")[0]
    code = _run(["rows", "--table", "ops.refresh_policy", "--min", str(actual + 1)])
    out = capsys.readouterr()
    assert code == 1
    assert "FAIL" in out.err


def test_rows_rejects_unknown_schema(capsys):
    code = _run(["rows", "--table", "public.users", "--min", "0"])
    out = capsys.readouterr()
    assert code == 1
    assert "FAIL" in out.err


def test_rows_rejects_invalid_identifier(capsys):
    code = _run(["rows", "--table", "ops.refresh_policy; drop table x", "--min", "0"])
    out = capsys.readouterr()
    assert code == 1
    assert "FAIL" in out.err


# ---------------------------------------------------------------------------
# manifest
# ---------------------------------------------------------------------------

def _a_source_with_no_manifest_or_storage_rows() -> str | None:
    sources = [row[0] for row in _query("select source from ops.refresh_policy")]
    for source in sources:
        (manifest_count,) = _query(
            "select count(*) from ops.source_manifest where source = %s", (source,)
        )[0]
        (storage_count,) = _query(
            "select count(*) from storage.objects where bucket_id = 'raw' and name like %s",
            (f"{source}/%",),
        )[0]
        if manifest_count == 0 and storage_count == 0:
            return source
    return None


def test_manifest_with_no_sources_is_vacuous_pass(capsys):
    source = _a_source_with_no_manifest_or_storage_rows()
    if source is None:
        pytest.skip("every known source already has manifest or Storage rows")

    code = _run(["manifest", "--source", source])
    out = capsys.readouterr()
    assert code == 0
    assert "vacuous" in out.out.lower()


# ---------------------------------------------------------------------------
# provenance
# ---------------------------------------------------------------------------

def test_provenance_on_currently_empty_api_views_passes(capsys):
    # Every api.* view is empty or has only static-config/derived-label
    # value columns exempted in check.PROVENANCE_EXEMPT as of M0 (no
    # pipeline has loaded anything yet), so provenance must pass overall.
    code = _run(["provenance"])
    out = capsys.readouterr()
    assert code == 0, out.err
    assert "OK" in out.out


def test_provenance_discovers_every_api_view(capsys):
    # Sanity check that discovery actually sees the live api.* views (not
    # an empty schema) so the vacuous-pass test above isn't vacuous for
    # the wrong reason.
    with db.connect() as conn:
        views = check._api_views(conn)
    assert views, "expected at least the M0-S1 api.* views to exist"
    assert "api.county_outage" in views
    assert "api.source_freshness" in views
    assert "api.sources" in views


def test_provenance_source_freshness_rows_with_no_run_have_no_source_id(capsys):
    # With no pipeline runs yet, last_success_at/is_stale must be null
    # (never zero-filled) and status must be 'not_loaded' for those rows,
    # and none of those null-value rows should require a source_id.
    rows = _query("select last_success_at, is_stale, status, latest_source_id from api.source_freshness")
    assert rows, "expected api.source_freshness to have at least the seeded refresh_policy sources"
    for last_success_at, is_stale, status, latest_source_id in rows:
        if last_success_at is None:
            assert is_stale is None
            assert status == "not_loaded"


# ---------------------------------------------------------------------------
# reconcile
# ---------------------------------------------------------------------------

def _a_source_with_no_pipeline_runs() -> str | None:
    sources = [row[0] for row in _query("select source from ops.refresh_policy")]
    for source in sources:
        (run_count,) = _query(
            "select count(*) from ops.pipeline_runs where source = %s", (source,)
        )[0]
        if run_count == 0:
            return source
    return None


def test_reconcile_with_no_runs_reports_clearly(capsys):
    source = _a_source_with_no_pipeline_runs()
    if source is None:
        pytest.skip("every known source already has ops.pipeline_runs rows")

    code = _run(["reconcile", "--source", source])
    out = capsys.readouterr()
    assert code == 0
    assert "vacuous" in out.out.lower()
    assert source in out.out


# ---------------------------------------------------------------------------
# untouched
# ---------------------------------------------------------------------------

def test_untouched_save_then_compare_immediately_passes(tmp_path, capsys):
    snapshot_path = tmp_path / "snapshot.json"

    save_code = _run(
        ["untouched", "--except", "ops.pipeline_runs", "--save", str(snapshot_path)]
    )
    assert save_code == 0
    assert snapshot_path.is_file()

    saved = json.loads(snapshot_path.read_text())
    # ops.pipeline_runs must be excluded per --except; every other real
    # ops/core base table must be present with its actual, live row count.
    assert "ops.pipeline_runs" not in saved
    assert "ops.refresh_policy" in saved
    (actual,) = _query("select count(*) from ops.refresh_policy")[0]
    assert saved["ops.refresh_policy"] == actual

    capsys.readouterr()
    compare_code = _run(
        ["untouched", "--except", "ops.pipeline_runs", "--compare", str(snapshot_path)]
    )
    out = capsys.readouterr()
    assert compare_code == 0, out.err
    assert "unchanged" in out.out.lower()


def test_untouched_compare_missing_snapshot_fails(tmp_path, capsys):
    missing = tmp_path / "does_not_exist.json"
    code = _run(["untouched", "--except", "ops.pipeline_runs", "--compare", str(missing)])
    out = capsys.readouterr()
    assert code == 1
    assert "FAIL" in out.err


def test_untouched_detects_drift_from_a_hand_built_snapshot(tmp_path, capsys):
    # Build a snapshot that intentionally disagrees with the real current
    # count for one real table (no fake rows are inserted into the
    # database itself — only this on-disk snapshot file is fabricated) so
    # the drift-detection branch is exercised without touching live data.
    (actual,) = _query("select count(*) from ops.refresh_policy")[0]

    snapshot_path = tmp_path / "stale_snapshot.json"
    snapshot_path.write_text(json.dumps({"ops.refresh_policy": actual + 1}))

    code = _run(
        [
            "untouched",
            "--except",
            "ops.pipeline_runs,ops.source_manifest,core.outage_county_year",
            "--compare",
            str(snapshot_path),
        ]
    )
    out = capsys.readouterr()
    assert code == 1
    assert "ops.refresh_policy" in out.err


def test_untouched_requires_save_or_compare():
    with pytest.raises(SystemExit) as exc_info:
        _run(["untouched", "--except", "ops.pipeline_runs"])
    # argparse's mutually-exclusive-group(required=True) exits 2 on its own
    # when neither --save nor --compare is given.
    assert exc_info.value.code == 2
