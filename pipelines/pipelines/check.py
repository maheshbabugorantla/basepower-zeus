"""python -m pipelines.check — the acceptance-check CLI every ticket's
Acceptance block calls, per tickets/M0/M0-P2.md.

Subcommands:

    manifest --source X
        Every Storage object recorded for source X in ops.source_manifest
        is re-downloaded (streamed, never held whole in memory — objects
        run up to 2 GiB) and its SHA-256 recomputed and compared to the
        manifest row (check 1). Zero manifest rows for X passes vacuously
        (there is nothing to contradict), and says so.

    rows --table SCHEMA.TABLE --min N
        select count(*) from SCHEMA.TABLE, fail if < N. An empty table
        with --min 1 fails; this is the one subcommand that must NOT pass
        vacuously, since "at least N rows" is the whole claim.

    provenance
        Every api.* view (discovered from information_schema, so a view
        added by a later ticket is automatically covered) must carry
        exactly one source_id column (source_id, source_ids, or
        latest_source_id). Every non-null value column must then resolve
        to a source_id in that column that is a real row in
        ops.source_manifest (check 2). Columns that are static
        configuration or derived labels rather than sourced data (see
        PROVENANCE_EXEMPT below) are explicitly exempted, never silently
        skipped. A view with zero rows passes vacuously and says so.

        A row whose null-reason column (any column named like
        `*null_reason*`, or exactly `reason`) is non-null is an explicit
        "not loaded" state (e.g. api.classifier_precision before M1-H1
        labels exist: a non-null zero/summary column plus a non-null
        `precision_null_reason`, no source_id yet) and the WHOLE row is
        exempt from the per-row check — printed explicitly, never a
        silent skip. Once data is loaded, that column's null-reason goes
        null and the row is checked normally like any other.

    reconcile --source X
        For every ops.pipeline_runs row with status='success' for source
        X: rows loaded = raw rows - sum(filter drops) (check 5). A source
        with no runs yet, or none successful yet, passes vacuously and
        says so — there is no run to contradict the invariant.

    untouched --except T1,T2 [--save PATH | --compare PATH]
        Guards parallel pipeline tickets: every ops/core base table not
        named in --except must have the same row count now as at
        --save time. --save writes a snapshot json; --compare reads one
        back and fails on any drift, naming the table and both counts.

Every subcommand prints what it checked and exits non-zero on failure,
printing exactly what failed.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Iterable

import httpx
import psycopg

from .core import config, db

# ---------------------------------------------------------------------------
# provenance
#
# api.* views are discovered dynamically from information_schema, so a
# view added by a later ticket is automatically covered without editing
# this file (M0-P2 owns only this file; other tickets own their views).
# Every discovered view must carry exactly one source_id column, matched
# by _ID_COL_RE ("source_id", "source_ids", or "latest_source_id"). Every
# OTHER column on the view is a "value column": if any is non-null on a
# row, that row's source_id column must resolve to ops.source_manifest.
#
# PROVENANCE_EXEMPT lists the only columns excluded from that rule, each
# with the reason spelled out — never a silent skip:
# ---------------------------------------------------------------------------

PROVENANCE_EXEMPT: dict[str, str] = {
    # Static configuration seeded into ops.refresh_policy (refresh cadence
    # per publisher) — not observed source data, has no source_id and is
    # not supposed to.
    "api.source_freshness.refresh_cycle_days": (
        "static config from ops.refresh_policy, not sourced data"
    ),
    # A derived label about a source's pipeline activity, not a value
    # drawn from a raw file's content. It is legitimately non-null
    # ('not_loaded') even when nothing has ever been loaded for the
    # source, so it can never carry a source_id in that state.
    "api.source_freshness.status": "derived label, non-null even when not_loaded",
    # The grouping key (source name) the row is about, not sourced data.
    "api.source_freshness.source": "grouping key (source name), not a value",
    # Run metadata from ops.pipeline_runs (when a step last succeeded and
    # whether that is past its cycle), not a value read from a raw file.
    # Derived steps such as refresh_scores have no manifest by design.
    "api.source_freshness.last_success_at": "run metadata from ops.pipeline_runs, not sourced data",
    "api.source_freshness.is_stale": "derived from run metadata and refresh policy, not sourced data",
}

# Views intentionally exempted from the whole per-row check (none yet —
# every api.* view as of M0 carries a source_id column). Add a view here
# only with a comment explaining why it has no per-row provenance.
PROVENANCE_EXEMPT_VIEWS: set[str] = set()

# Row-level exemption (not a column exemption): M1-S1's summary views
# (api.join_rate, api.classifier_precision, ...) are always present with
# exactly one row (or one row per label), and while their underlying data
# hasn't loaded yet they carry a non-null "0" or "no_x_yet" value column
# plus a non-null `*_null_reason` column explaining why — e.g.
# api.classifier_precision.precision_null_reason = 'no_claude_labels_yet'
# with claude_labelled_count still null but precision_null_reason itself
# non-null. That is an explicit "not loaded" state, not an unsourced
# value: a row whose null-reason column (matched by _NULL_REASON_COL_RE,
# any column named like `*null_reason*`, or exactly `reason`) is non-null
# is exempt from the per-row check in its ENTIRETY (every column on that
# row, not just the null-reason column). Once the source loads, that
# column goes null and the row is checked like any other — carrying a
# real source_id, same as api.join_rate does today.
_NULL_REASON_COL_RE = re.compile(r"null_reason|^reason$", re.IGNORECASE)

_ID_COL_RE = re.compile(r"^(latest_)?source_ids?$")
_IDENT_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")
_ALLOWED_SCHEMAS = {"ops", "core", "api"}


def _validate_table_name(qualified: str) -> tuple[str, str]:
    parts = qualified.split(".")
    if len(parts) != 2:
        raise ValueError(f"--table must be SCHEMA.TABLE, got {qualified!r}")
    schema, table = parts
    if schema not in _ALLOWED_SCHEMAS:
        raise ValueError(f"unknown schema {schema!r} (expected one of {sorted(_ALLOWED_SCHEMAS)})")
    if not _IDENT_RE.match(table):
        raise ValueError(f"invalid table identifier {table!r}")
    return schema, table


def _fail(msg: str) -> int:
    print(f"FAIL: {msg}", file=sys.stderr)
    return 1


def _ok(msg: str) -> int:
    print(f"OK: {msg}")
    return 0


# ---------------------------------------------------------------------------
# manifest
# ---------------------------------------------------------------------------

def _stream_sha256(url: str, headers: dict[str, str], *, chunk_size: int = 8 * 1024 * 1024) -> tuple[str, int]:
    """Stream `url`'s body and return (sha256_hex, total_bytes) without ever
    holding the whole object in memory — objects can be up to 2 GiB."""
    import hashlib

    digest = hashlib.sha256()
    total = 0
    with httpx.stream("GET", url, headers=headers, timeout=300.0) as response:
        response.raise_for_status()
        for chunk in response.iter_bytes(chunk_size):
            digest.update(chunk)
            total += len(chunk)
    return digest.hexdigest(), total


def cmd_manifest(source: str) -> int:
    with db.connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select id, sha256, bytes, storage_key
                from ops.source_manifest
                where source = %s
                order by retrieved_at
                """,
                (source,),
            )
            manifest_rows = cur.fetchall()
        with conn.cursor() as cur:
            # The reverse direction of check 1: every Storage object under
            # this source's prefix must have exactly one manifest row, not
            # just every manifest row having a downloadable object.
            cur.execute(
                "select name from storage.objects where bucket_id = %s and name like %s",
                (config.RAW_BUCKET, f"{source}/%"),
            )
            storage_object_names = {r[0] for r in cur.fetchall()}

    if not manifest_rows and not storage_object_names:
        return _ok(
            f"manifest: 0 ops.source_manifest rows and 0 Storage objects for "
            f"source={source!r} (vacuous pass)"
        )

    failures: list[str] = []

    manifest_keys = {storage_key for _, _, _, storage_key in manifest_rows}
    orphan_objects = storage_object_names - manifest_keys
    for name in sorted(orphan_objects):
        failures.append(f"Storage object {name!r} (bucket 'raw') has no ops.source_manifest row")

    if manifest_rows:
        supabase_url = config.supabase_url().rstrip("/")
        # supabase-py sends both apikey and Authorization: Bearer for the
        # service-role (sb_secret_*) key, since it is not itself a JWT that
        # the storage API would otherwise accept as a bearer alone.
        headers = {
            "apikey": config.supabase_secret_key(),
            "Authorization": f"Bearer {config.supabase_secret_key()}",
        }
        for manifest_id, sha256, bytes_expected, storage_key in manifest_rows:
            object_url = f"{supabase_url}/storage/v1/object/{config.RAW_BUCKET}/{storage_key}"
            try:
                actual_sha256, actual_bytes = _stream_sha256(object_url, headers)
            except httpx.HTTPError as exc:
                failures.append(f"manifest {manifest_id}: download of {storage_key!r} failed: {exc}")
                continue
            if actual_sha256 != sha256:
                failures.append(
                    f"manifest {manifest_id} ({storage_key!r}): sha256 mismatch "
                    f"(manifest={sha256}, recomputed={actual_sha256})"
                )
            if bytes_expected is not None and actual_bytes != bytes_expected:
                failures.append(
                    f"manifest {manifest_id} ({storage_key!r}): byte count mismatch "
                    f"(manifest={bytes_expected}, downloaded={actual_bytes})"
                )

    if failures:
        for f in failures:
            print(f"FAIL: {f}", file=sys.stderr)
        return 1
    return _ok(
        f"manifest: {len(manifest_rows)} manifest row(s) and {len(storage_object_names)} "
        f"Storage object(s) for source={source!r} verified against each other"
    )


# ---------------------------------------------------------------------------
# rows
# ---------------------------------------------------------------------------

def cmd_rows(table: str, minimum: int) -> int:
    try:
        schema, name = _validate_table_name(table)
    except ValueError as exc:
        return _fail(f"rows: {exc}")
    with db.connect() as conn:
        with conn.cursor() as cur:
            cur.execute(f"select count(*) from {schema}.{name}")
            row = cur.fetchone()
            assert row is not None
            count = row[0]
    if count < minimum:
        return _fail(f"rows: {schema}.{name} has {count} row(s), need >= {minimum}")
    return _ok(f"rows: {schema}.{name} has {count} row(s) (>= {minimum})")


# ---------------------------------------------------------------------------
# provenance
# ---------------------------------------------------------------------------

def _api_views(conn: psycopg.Connection) -> list[str]:
    with conn.cursor() as cur:
        cur.execute(
            "select table_name from information_schema.views where table_schema = 'api' order by table_name"
        )
        return [f"api.{row[0]}" for row in cur.fetchall()]


def _view_columns(conn: psycopg.Connection, view: str) -> list[tuple[str, str]]:
    schema, name = view.split(".")
    with conn.cursor() as cur:
        cur.execute(
            """
            select column_name, data_type
            from information_schema.columns
            where table_schema = %s and table_name = %s
            order by ordinal_position
            """,
            (schema, name),
        )
        return cur.fetchall()


def cmd_provenance() -> int:
    failures: list[str] = []
    checked_any_rows = False

    with db.connect() as conn:
        views = _api_views(conn)
        if not views:
            return _ok("provenance: no api.* views exist yet (vacuous pass)")

        for view in views:
            if view in PROVENANCE_EXEMPT_VIEWS:
                print(f"OK: provenance: {view} is exempt from the per-row check (PROVENANCE_EXEMPT_VIEWS)")
                continue

            columns = _view_columns(conn, view)
            id_cols = [(name, dtype) for name, dtype in columns if _ID_COL_RE.match(name)]
            if len(id_cols) != 1:
                failures.append(
                    f"{view}: expected exactly one source_id column matching "
                    f"{_ID_COL_RE.pattern!r}, found {[c for c, _ in id_cols]!r} — give it a "
                    f"provenance column (source_id / source_ids / latest_source_id), or add it "
                    f"to PROVENANCE_EXEMPT_VIEWS with a comment explaining why not"
                )
                continue
            id_col, id_dtype = id_cols[0]

            value_cols = [
                name for name, _ in columns
                if name != id_col and f"{view}.{name}" not in PROVENANCE_EXEMPT
            ]
            if not value_cols:
                print(f"OK: provenance: {view} has no checkable value columns (all exempt or id-only)")
                continue

            # Row-level "not loaded" exemption — see _NULL_REASON_COL_RE
            # above. A row is exempt in its entirety (all its columns,
            # including the null-reason column itself) when any
            # null-reason column on it is non-null.
            null_reason_cols = [name for name, _ in columns if _NULL_REASON_COL_RE.search(name)]
            row_exempt_expr = (
                " or ".join(f"{c} is not null" for c in null_reason_cols) if null_reason_cols else "false"
            )

            value_expr = " or ".join(f"{c} is not null" for c in value_cols)
            ids_expr = (
                id_col if id_dtype == "ARRAY"
                else f"case when {id_col} is not null then array[{id_col}] else null end"
            )

            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    with v as (
                        select ({value_expr}) as _value_present,
                               ({ids_expr}) as _ids,
                               ({row_exempt_expr}) as _row_exempt
                        from {view}
                    )
                    select
                        count(*) filter (
                            where _value_present and not _row_exempt
                              and (_ids is null or array_length(_ids, 1) is null)
                        ) as missing_id_count,
                        count(*) filter (
                            where _value_present and not _row_exempt and _ids is not null
                              and exists (
                                  select 1 from unnest(_ids) as eid(id)
                                  where eid.id not in (select id from ops.source_manifest)
                              )
                        ) as unresolved_count,
                        count(*) filter (where _row_exempt) as exempt_count,
                        count(*) as total_rows
                    from v
                    """
                )
                row = cur.fetchone()
                assert row is not None
                missing_id_count, unresolved_count, exempt_count, total_rows = row

            if total_rows == 0:
                print(f"OK: provenance: {view} has 0 rows (vacuous pass)")
                continue
            checked_any_rows = True

            if exempt_count:
                reason_cols_desc = ", ".join(null_reason_cols)
                print(
                    f"OK: provenance: {view}: {exempt_count} row(s) exempt as explicit "
                    f"not-loaded state (non-null {reason_cols_desc})"
                )

            if missing_id_count or unresolved_count:
                with conn.cursor() as cur:
                    cur.execute(
                        f"""
                        with v as (
                            select t.*,
                                   ({value_expr}) as _value_present,
                                   ({ids_expr}) as _ids,
                                   ({row_exempt_expr}) as _row_exempt
                            from {view} as t
                        )
                        select * from v
                        where _value_present and not _row_exempt and (
                            _ids is null or array_length(_ids, 1) is null
                            or exists (
                                select 1 from unnest(_ids) as eid(id)
                                where eid.id not in (select id from ops.source_manifest)
                            )
                        )
                        limit 5
                        """
                    )
                    sample = cur.fetchall()
                failures.append(
                    f"{view}: {missing_id_count} row(s) with a non-null value column but no "
                    f"source_id, {unresolved_count} row(s) whose source_id does not resolve to "
                    f"ops.source_manifest (sample of up to 5 offending rows: {sample})"
                )

    if failures:
        for f in failures:
            print(f"FAIL: {f}", file=sys.stderr)
        return 1
    if not checked_any_rows:
        return _ok(f"provenance: {len(views)} api.* view(s) checked, all empty (vacuous pass)")
    return _ok(
        f"provenance: {len(views)} api.* view(s) checked; every non-null value column "
        f"resolved to ops.source_manifest"
    )


# ---------------------------------------------------------------------------
# reconcile
# ---------------------------------------------------------------------------

def cmd_reconcile(source: str) -> int:
    with db.connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select id, rows_in, rows_loaded, filter_drops, status, manifest_id
                from ops.pipeline_runs
                where source = %s
                order by started_at
                """,
                (source,),
            )
            runs = cur.fetchall()

    if not runs:
        return _ok(f"reconcile: no ops.pipeline_runs rows for source={source!r} (vacuous pass)")

    success_runs = [r for r in runs if r[4] == "success"]
    if not success_runs:
        return _ok(
            f"reconcile: {len(runs)} run(s) for source={source!r}, none with status='success' "
            f"yet (vacuous pass — nothing to reconcile)"
        )

    # Check EVERY successful run, not just the latest: EAGLE-I is one run
    # per year file (manifest_id), and a stale/failed latest run must not
    # hide an earlier successful run's mismatch.
    failures: list[str] = []
    checked = 0
    for run_id, rows_in, rows_loaded, filter_drops, _status, manifest_id in success_runs:
        if rows_in is None or rows_loaded is None:
            failures.append(
                f"run {run_id} (manifest_id={manifest_id}) is 'success' but missing "
                f"rows_in/rows_loaded (rows_in={rows_in}, rows_loaded={rows_loaded})"
            )
            continue
        drops = filter_drops or {}
        if not isinstance(drops, dict):
            failures.append(f"run {run_id}: filter_drops is not an object: {drops!r}")
            continue
        total_drops = sum(drops.values())
        expected = rows_in - total_drops
        checked += 1
        if rows_loaded != expected:
            failures.append(
                f"run {run_id} (manifest_id={manifest_id}): rows_loaded={rows_loaded} != "
                f"rows_in({rows_in}) - filter_drops({total_drops}) = {expected}"
            )

    if failures:
        for f in failures:
            print(f"FAIL: reconcile: {f}", file=sys.stderr)
        return 1
    return _ok(
        f"reconcile: {checked} successful run(s) for source={source!r} all satisfy "
        f"rows_loaded = rows_in - filter_drops"
    )


# ---------------------------------------------------------------------------
# untouched
# ---------------------------------------------------------------------------

def _base_tables(conn: psycopg.Connection, exclude: set[str]) -> dict[str, int]:
    with conn.cursor() as cur:
        cur.execute(
            """
            select table_schema, table_name
            from information_schema.tables
            where table_schema in ('ops', 'core')
              and table_type = 'BASE TABLE'
            order by table_schema, table_name
            """
        )
        tables = cur.fetchall()

    counts: dict[str, int] = {}
    for schema, name in tables:
        qualified = f"{schema}.{name}"
        if qualified in exclude:
            continue
        with conn.cursor() as cur:
            cur.execute(f"select count(*) from {schema}.{name}")
            row = cur.fetchone()
            assert row is not None
            counts[qualified] = row[0]
    return counts


def cmd_ranking() -> int:
    """M2-P8: run pipelines/pipelines/evaluate_ranking.py's time-split
    evaluation against the live core.mv_home_signals and print the
    typed report (AUC + top-decile lift per single signal, plus equal
    weights and core.default_weights)."""
    from . import evaluate_ranking

    with db.connect(pooled=False) as conn:
        ev = evaluate_ranking.evaluate(conn)
    evaluate_ranking._print_report(ev)
    if ev.population_n == 0:
        print("FAIL: empty as-of-cutoff population -- nothing to evaluate")
        return 1
    print(f"PASS: evaluated {ev.population_n} homes, {ev.adopters_n} adopters")
    return 0


def cmd_untouched(except_tables: Iterable[str], *, save: Path | None, compare: Path | None) -> int:
    exclude = set(except_tables)
    with db.connect() as conn:
        current = _base_tables(conn, exclude)

    if save is not None:
        save.write_text(json.dumps(current, indent=2, sort_keys=True))
        return _ok(f"untouched: snapshot of {len(current)} table(s) saved to {save}")

    if compare is not None:
        if not compare.is_file():
            return _fail(f"untouched: no snapshot at {compare}")
        snapshot = json.loads(compare.read_text())
        failures = []
        all_tables = sorted(set(snapshot) | set(current))
        for table in all_tables:
            before = snapshot.get(table)
            after = current.get(table)
            if before != after:
                failures.append(f"{table}: was {before}, now {after}")
        if failures:
            for f in failures:
                print(f"FAIL: untouched: {f}", file=sys.stderr)
            return 1
        return _ok(f"untouched: {len(all_tables)} table(s) unchanged since snapshot")

    return _fail("untouched: pass --save PATH or --compare PATH")


# ---------------------------------------------------------------------------
# argparse wiring
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python3 -m pipelines.check",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_manifest = sub.add_parser("manifest", help="verify Storage objects against ops.source_manifest")
    p_manifest.add_argument("--source", required=True)

    p_rows = sub.add_parser("rows", help="assert a table has at least N rows")
    p_rows.add_argument("--table", required=True, help="SCHEMA.TABLE")
    p_rows.add_argument("--min", type=int, required=True, dest="minimum")

    sub.add_parser("provenance", help="verify every api.* view's value columns resolve to source_id(s)")

    p_reconcile = sub.add_parser("reconcile", help="verify rows_loaded = rows_in - filter_drops")
    p_reconcile.add_argument("--source", required=True)

    sub.add_parser(
        "ranking",
        help="M2-P8: time-split evaluation of the ranking score against real battery/generator adoption",
    )

    p_untouched = sub.add_parser("untouched", help="verify other tables' row counts are unchanged")
    p_untouched.add_argument("--except", dest="except_tables", required=True, help="comma-separated SCHEMA.TABLE list")
    group = p_untouched.add_mutually_exclusive_group(required=True)
    group.add_argument("--save", type=Path)
    group.add_argument("--compare", type=Path)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "manifest":
        return cmd_manifest(args.source)
    if args.command == "rows":
        return cmd_rows(args.table, args.minimum)
    if args.command == "provenance":
        return cmd_provenance()
    if args.command == "reconcile":
        return cmd_reconcile(args.source)
    if args.command == "ranking":
        return cmd_ranking()
    if args.command == "untouched":
        except_tables = [t.strip() for t in args.except_tables.split(",") if t.strip()]
        return cmd_untouched(except_tables, save=args.save, compare=args.compare)

    parser.error(f"unknown command {args.command!r}")
    return 2  # unreachable


if __name__ == "__main__":
    sys.exit(main())
