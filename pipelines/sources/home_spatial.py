"""M3-P6 spatial precompute: core.home_spatial loader.

Not a new raw source — no ops.source_manifest row is created here. This
module derives block-group / flood-zone / utility-territory answers for
every parcel from tables that are already loaded and already carry their
own source_id (core.parcels, core.parcel_geoms, core.block_groups,
core.flood_zones_sub, core.territories_sub, core.utility_crosswalk). Real
data in, real data out: every home_spatial row's boundary_source_ids
traces straight back to those tables' own source_ids (real-data rule 1 —
nothing invented, no new provenance is fabricated, only threaded through).

Why this exists (tickets/M3/M3-P6.md, measured on Supabase Small):
raw-polygon flood point-in-polygon over 1.2M homes projects to ~15 min;
after ST_Subdivide(geom, 256) (core.flood_zones_sub / core.territories_sub,
supabase/migrations/0304_spatial_precompute.sql), ~1.5 min. Recomputing
that on every scoring refresh is wasted work: a home's spatial answer
depends only on (parcel geometry, boundary-file version), both far more
stable than a scoring refresh's cadence. This loader computes each
answer ONCE per (home, boundary-file version) into core.home_spatial;
core.mv_home_signals (0304b) then joins onto it by prop_id, doing zero
geometry work per refresh.

Territory resolution mirrors 0303_utility_gate_counts.sql's `gate` CTE
exactly (same Harris-pin / Williamson-withhold user decision), just
computed once per home here instead of on every mv_home_signals refresh:
  * Harris (48201): pinned to CenterPoint (eia_id '8901'),
    territory_basis='most_likely_county_utility', if 8901 exists in both
    core.territories and core.utility_crosswalk (fail-open: falls back to
    the real ST_Within match otherwise — never fabricates a match).
  * Williamson (48491): territory withheld — resolved_territory_eia_id
    NULL, territory_null_reason='utility_not_confirmed',
    territory_gate_reason NULL (still gated in).
  * Every other county: the real ST_Within match against
    core.territories_sub, tie-broken toward a Base-mapped utility
    (core.utility_crosswalk.mapped='yes'), territory_basis=
    'service_area_polygon'.

Incremental (lesson 3 / acceptance "Incremental"): each row's
input_hash is md5() of every source_id that fed it (parcel geometry,
block-group boundary, flood boundary, territory boundary, crosswalk),
in a fixed order. A batch's upsert only writes rows whose input_hash
changed — a re-run with no upstream source change writes zero rows.

Bulk load (lesson 9): COPY into a session-temp staging table, one
upsert per batch, per-county, each batch its own commit (lesson 4 — a
one-transaction build multiplies retry cost on failure).

Session tuning for the one-time, per-county heavy build (spec's
"Session settings for heavy steps"): work_mem 64MB, maintenance_work_mem
256MB, max_parallel_workers_per_gather 0, statement_timeout 0. Set once
per connection, never globally.

CLI-only: `python -m pipelines.run home_spatial --county 48201`. Too
large for a single Vercel Function call; the caller chunks by prop_id
range (BATCH_SIZE below) and this module resumes via ops.pipeline_runs's
cursor exactly like pipelines/sources/parcels.py.
"""
from __future__ import annotations

from typing import Any, Literal

import psycopg

from pipelines.core import db, runs

SOURCE = "home_spatial"
BATCH_SIZE = 20_000
HARRIS_FIPS = "48201"
WILLIAMSON_FIPS = "48491"
TRAVIS_FIPS = "48453"
HARRIS_PIN_EIA_ID = "8901"

Runner = Literal["cron", "cli"]

# ---------------------------------------------------------------------------
# The one big per-batch query. Parameters: %(county_fips)s, %(after_prop_id)s
# (keyset pagination — prop_id is core.parcels' primary key), %(limit)s.
#
# pt: ST_PointOnSurface of the parcel polygon when core.parcel_geoms has
# one, else the stored centroid — ST_PointOnSurface is guaranteed to lie
# inside a (possibly concave) polygon, centroid is not; either is a real
# geometry derived from the real parcel boundary file, never invented.
# ---------------------------------------------------------------------------
_BATCH_SQL = """
with batch as (
    select p.prop_id, p.county_fips, p.source_id as parcel_source_id
    from core.parcels p
    where p.county_fips = %(county_fips)s
      and p.prop_id > coalesce(%(after_prop_id)s::text, '')
    order by p.prop_id
    limit %(limit)s
),
geo as (
    select
        b.prop_id, b.county_fips, b.parcel_source_id,
        coalesce(extensions.ST_PointOnSurface(pg.geom), pg.centroid) as pt,
        pg.source_id as geom_source_id
    from batch b
    left join core.parcel_geoms pg on pg.prop_id = b.prop_id
),
bg_match as (
    -- Data-correctness fix (2026-09-26, cross-county block-group bug):
    -- the live version of this lateral join matched g.pt against EVERY
    -- county's block groups with no county scoping at all, so a parcel
    -- near a county line could silently pick up a NEIGHBORING county's
    -- GEOID via ST_Within (verified live: 42 Williamson/WCAD parcels
    -- matched a Travis 48453-prefixed block group, 110 Harris/HCAD
    -- parcels matched Fort Bend/Montgomery/Waller block groups, plus
    -- unverified Travis/TCAD crossings into Bastrop/Hays/Comal). HCAD
    -- and WCAD each appraise only their own county (pipelines/sources/
    -- hcad_parcels.py, wcad_parcels.py -- no documented cross-county
    -- roll for either), so any match outside g.county_fips for those
    -- counties is a real bug, not a real home -- fixed here by scoping
    -- the match to g.county_fips.
    --
    -- The ONE exception, kept exactly as-is: TCAD (Travis, 48453) is
    -- separately verified and DOCUMENTED to appraise some parcels whose
    -- real geometry sits inside Williamson (48491) -- see
    -- pipelines/sources/wcad_parcels.py's module docstring ("The 137
    -- TCAD-rolled parcels already sitting in Williamson... county
    -- assignment is geometry-based, not the parcel's own county_fips
    -- attribute", per 0102_m1_materialize.sql) and that module's own
    -- overlap-dedup logic built specifically around this fact. Every
    -- OTHER cross-county match this fix drops was never documented or
    -- verified anywhere in this repo, so per the real-data rule
    -- ("nothing invented") it is not assumed real -- those rows get a
    -- null block_group_geoid instead (missing means empty, never a
    -- force-assigned neighboring-county GEOID).
    select
        g.prop_id,
        bg.geoid as block_group_geoid,
        bg.source_id as bg_source_id,
        -- Follow-up fix (coordinator, same 2026-09-26 session): a home
        -- whose point only matches a NEIGHBORING county's block group
        -- (rejected by the scoping above) must still get an honest
        -- reason, not just a bare null -- distinguished here from a
        -- point that matches no block group at all in ANY county
        -- (a real coverage gap, e.g. core.block_groups missing rows).
        case
            when bg.geoid is not null then null
            when g.pt is null then 'no_parcel_point'
            when any_bg.geoid is not null then 'no_block_group_in_county'
            else 'point_outside_loaded_block_groups'
        end as block_group_null_reason
    from geo g
    left join lateral (
        select bg.geoid, bg.source_id
        from core.block_groups bg
        where g.pt is not null
          and extensions.ST_Within(g.pt, bg.geom)
          and (
              bg.county_fips = g.county_fips
              or (g.county_fips = %(travis_fips)s and bg.county_fips = %(williamson_fips)s)
          )
        limit 1
    ) bg on true
    left join lateral (
        select bg2.geoid
        from core.block_groups bg2
        where g.pt is not null and extensions.ST_Within(g.pt, bg2.geom)
        limit 1
    ) any_bg on true
),
county_flood_loaded as (
    select distinct bg.county_fips
    from core.block_groups bg
    where exists (
        select 1 from core.flood_zones_sub fz
        where fz.fld_zone ~ '^(A|V)' and extensions.ST_Intersects(fz.geom, bg.geom)
    )
),
flood_match as (
    select
        g.prop_id,
        case
            when (select count(*) from core.flood_zones) = 0 then null
            when not exists (select 1 from county_flood_loaded cfl where cfl.county_fips = g.county_fips) then null
            else fz.id is not null
        end as in_sfha,
        fz.source_id as flood_source_id,
        case
            when (select count(*) from core.flood_zones) = 0 then 'flood_zones_not_loaded'
            when not exists (select 1 from county_flood_loaded cfl where cfl.county_fips = g.county_fips) then 'flood_zones_not_loaded'
            else null
        end as flood_null_reason
    from geo g
    left join lateral (
        select f.id, f.source_id
        from core.flood_zones_sub f
        where g.pt is not null and f.fld_zone ~ '^(A|V)' and extensions.ST_Within(g.pt, f.geom)
        limit 1
    ) fz on true
),
territory_candidates as (
    select
        g.prop_id,
        array_agg(distinct t.eia_id) as candidates
    from geo g
    join core.territories_sub t on g.pt is not null and extensions.ST_Within(g.pt, t.geom)
    group by g.prop_id
),
territory_match as (
    select distinct on (g.prop_id)
        g.prop_id,
        t.eia_id,
        t.source_id as territory_source_id,
        cw.mapped,
        cw.source_id as crosswalk_source_id
    from geo g
    join core.territories_sub t on g.pt is not null and extensions.ST_Within(g.pt, t.geom)
    left join core.utility_crosswalk cw on cw.eia_utility_number = t.eia_id
    order by g.prop_id, (cw.mapped = 'yes') desc nulls last, t.eia_id
),
harris_pin as (
    select t.eia_id, t.source_id as territory_source_id, cw.mapped, cw.source_id as crosswalk_source_id
    from core.territories t
    join core.utility_crosswalk cw on cw.eia_utility_number = t.eia_id
    where t.eia_id = %(harris_pin_eia_id)s
    limit 1
),
resolved as (
    select
        g.prop_id, g.county_fips, g.parcel_source_id, g.geom_source_id, g.pt,
        case
            when (select count(*) from core.territories) = 0 then tm.eia_id
            when (select count(*) from core.utility_crosswalk) = 0 then tm.eia_id
            when g.county_fips = %(williamson_fips)s then null
            when g.county_fips = %(harris_fips)s and hp.eia_id is not null then hp.eia_id
            else tm.eia_id
        end as resolved_territory_eia_id,
        case
            when (select count(*) from core.territories) = 0 then tm.territory_source_id
            when (select count(*) from core.utility_crosswalk) = 0 then tm.territory_source_id
            when g.county_fips = %(williamson_fips)s then null
            when g.county_fips = %(harris_fips)s and hp.eia_id is not null then hp.territory_source_id
            else tm.territory_source_id
        end as territory_source_id,
        case
            when (select count(*) from core.territories) = 0 then null
            when (select count(*) from core.utility_crosswalk) = 0 then null
            when g.county_fips = %(williamson_fips)s then null
            when g.county_fips = %(harris_fips)s and hp.eia_id is not null then 'most_likely_county_utility'
            when tm.eia_id is not null then 'service_area_polygon'
            else null
        end as territory_basis,
        case
            when (select count(*) from core.territories) = 0 then 'territories_not_loaded'
            when (select count(*) from core.utility_crosswalk) = 0 then 'crosswalk_not_loaded'
            when g.county_fips = %(williamson_fips)s then 'utility_not_confirmed'
            else null
        end as territory_null_reason,
        case
            when (select count(*) from core.territories) = 0 then null
            when (select count(*) from core.utility_crosswalk) = 0 then null
            when g.county_fips = %(williamson_fips)s then null
            when g.county_fips = %(harris_fips)s and hp.eia_id is not null then null
            when tm.eia_id is null then 'territory_not_base_served'
            when tm.mapped is distinct from 'yes' then 'territory_not_base_served'
            else null
        end as territory_gate_reason,
        case
            when (select count(*) from core.territories) = 0 then tm.crosswalk_source_id
            when (select count(*) from core.utility_crosswalk) = 0 then tm.crosswalk_source_id
            when g.county_fips = %(williamson_fips)s then null
            when g.county_fips = %(harris_fips)s and hp.eia_id is not null then hp.crosswalk_source_id
            else tm.crosswalk_source_id
        end as crosswalk_source_id
    from geo g
    left join territory_match tm on tm.prop_id = g.prop_id
    left join harris_pin hp on g.county_fips = %(harris_fips)s
)
select
    r.prop_id,
    r.county_fips,
    r.pt,
    bm.block_group_geoid,
    bm.bg_source_id,
    bm.block_group_null_reason,
    fm.in_sfha,
    fm.flood_source_id,
    fm.flood_null_reason,
    coalesce(tc.candidates, array[]::text[]) as territory_candidates,
    r.resolved_territory_eia_id,
    r.territory_source_id,
    r.territory_basis,
    r.territory_null_reason,
    r.territory_gate_reason,
    r.crosswalk_source_id,
    r.parcel_source_id,
    r.geom_source_id,
    array(
        select distinct s.s
        from unnest(array[
            r.parcel_source_id, r.geom_source_id, bm.bg_source_id,
            r.territory_source_id, r.crosswalk_source_id, fm.flood_source_id
        ]) s(s)
        where s.s is not null
    ) as boundary_source_ids,
    md5(
        coalesce(r.parcel_source_id::text, '') || '|' ||
        coalesce(r.geom_source_id::text, '') || '|' ||
        coalesce(bm.bg_source_id::text, '') || '|' ||
        coalesce(r.territory_source_id::text, '') || '|' ||
        coalesce(r.crosswalk_source_id::text, '') || '|' ||
        coalesce(fm.flood_source_id::text, '') || '|' ||
        coalesce(r.resolved_territory_eia_id, '') || '|' ||
        coalesce(r.territory_basis, '') || '|' ||
        coalesce(bm.block_group_null_reason, '')
    ) as input_hash
from resolved r
left join bg_match bm on bm.prop_id = r.prop_id
left join flood_match fm on fm.prop_id = r.prop_id
left join territory_candidates tc on tc.prop_id = r.prop_id
order by r.prop_id
"""

_STAGE_COLUMNS = (
    "prop_id", "county_fips", "pt", "block_group_geoid", "bg_source_id",
    "block_group_null_reason",
    "in_sfha", "flood_source_id", "flood_null_reason", "territory_candidates",
    "resolved_territory_eia_id", "territory_source_id", "territory_basis",
    "territory_null_reason", "territory_gate_reason", "crosswalk_source_id",
    "parcel_source_id", "geom_source_id", "boundary_source_ids", "input_hash",
)


def _ensure_staging_table(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            create temporary table if not exists home_spatial_stage (
                prop_id text, county_fips text, pt extensions.geometry(point, 4326),
                block_group_geoid text, bg_source_id uuid, block_group_null_reason text,
                in_sfha boolean, flood_source_id uuid, flood_null_reason text,
                territory_candidates text[], resolved_territory_eia_id text,
                territory_source_id uuid, territory_basis text,
                territory_null_reason text, territory_gate_reason text,
                crosswalk_source_id uuid, parcel_source_id uuid,
                geom_source_id uuid, boundary_source_ids uuid[], input_hash text
            ) on commit preserve rows
            """
        )
    conn.commit()


def _set_session_tuning(conn: psycopg.Connection) -> None:
    """Per-connection only (never a global ALTER ROLE/DATABASE) — lesson
    10: work_mem decides whether the batch's sorts/hashes stay in memory
    instead of spilling to the same disk data lives on."""
    with conn.cursor() as cur:
        cur.execute("set work_mem = '64MB'")
        cur.execute("set maintenance_work_mem = '256MB'")
        cur.execute("set max_parallel_workers_per_gather = 0")
        cur.execute("set statement_timeout = 0")
    conn.commit()


def new_state(county_fips: str) -> dict[str, Any]:
    return {"county_fips": county_fips, "after_prop_id": None, "rows_seen": 0, "rows_written": 0}


def _run_batch(conn: psycopg.Connection, *, county_fips: str, after_prop_id: str | None, limit: int) -> tuple[int, int, str | None]:
    """Compute one batch into the staging table, then upsert into
    core.home_spatial WHERE input_hash differs (lesson 3: a rerun with no
    upstream change writes zero rows). Returns
    (rows_computed, rows_written, last_prop_id_in_batch)."""
    with conn.cursor() as cur:
        cur.execute("truncate home_spatial_stage")
        cur.execute(
            f"insert into home_spatial_stage ({', '.join(_STAGE_COLUMNS)}) {_BATCH_SQL}",
            {
                "county_fips": county_fips,
                "after_prop_id": after_prop_id,
                "limit": limit,
                "harris_fips": HARRIS_FIPS,
                "williamson_fips": WILLIAMSON_FIPS,
                "travis_fips": TRAVIS_FIPS,
                "harris_pin_eia_id": HARRIS_PIN_EIA_ID,
            },
        )
        rows_computed = cur.rowcount

        cur.execute("select max(prop_id) from home_spatial_stage")
        last_prop_id = cur.fetchone()[0]
        if last_prop_id is None:
            return 0, 0, None

        cur.execute(
            f"""
            insert into core.home_spatial ({', '.join(_STAGE_COLUMNS)}, computed_at)
            select {', '.join(_STAGE_COLUMNS)}, now() from home_spatial_stage
            on conflict (prop_id) do update set
                county_fips = excluded.county_fips,
                pt = excluded.pt,
                block_group_geoid = excluded.block_group_geoid,
                bg_source_id = excluded.bg_source_id,
                block_group_null_reason = excluded.block_group_null_reason,
                in_sfha = excluded.in_sfha,
                flood_source_id = excluded.flood_source_id,
                flood_null_reason = excluded.flood_null_reason,
                territory_candidates = excluded.territory_candidates,
                resolved_territory_eia_id = excluded.resolved_territory_eia_id,
                territory_source_id = excluded.territory_source_id,
                territory_basis = excluded.territory_basis,
                territory_null_reason = excluded.territory_null_reason,
                territory_gate_reason = excluded.territory_gate_reason,
                crosswalk_source_id = excluded.crosswalk_source_id,
                parcel_source_id = excluded.parcel_source_id,
                geom_source_id = excluded.geom_source_id,
                boundary_source_ids = excluded.boundary_source_ids,
                input_hash = excluded.input_hash,
                computed_at = excluded.computed_at
            where core.home_spatial.input_hash is distinct from excluded.input_hash
            """
        )
        rows_written = cur.rowcount
    conn.commit()
    return rows_computed, rows_written, last_prop_id


def _loaded_counties() -> list[str]:
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute("select distinct county_fips from core.parcels order by county_fips")
            return [row[0] for row in cur.fetchall()]


def run(*, runner: Runner, backfill: bool = False, cursor: dict[str, Any] | None = None) -> dict[str, Any]:
    """Registry contract entrypoint (pipelines/pipelines/core/registry.py):
    `python -m pipelines.run home_spatial [--backfill]` and the cron route
    both call this exact signature, with no county argument. Runs every
    county already present in core.parcels, one at a time, each its own
    committed batch sequence (lesson 4) — so a failure partway through
    only redoes the county in flight, and a bare re-run with no upstream
    change (any county) touches zero rows. Use `run_county()` directly
    for a single-county CLI/test invocation."""
    counties = cursor.get("counties") if cursor else None
    if counties is None:
        counties = _loaded_counties()
    results: dict[str, Any] = {"counties": {}}
    start_index = 0
    if cursor and cursor.get("county_index") is not None:
        start_index = cursor["county_index"]
    for i, county_fips in enumerate(counties):
        if i < start_index:
            continue
        county_cursor = cursor.get("county_cursor") if (cursor and i == start_index) else None
        results["counties"][county_fips] = run_county(
            county_fips=county_fips, runner=runner, backfill=backfill, cursor=county_cursor,
        )
    return results


def run_county(*, county_fips: str, runner: Runner, backfill: bool = False, cursor: dict[str, Any] | None = None) -> dict[str, Any]:
    """Populate/refresh core.home_spatial for one county, one committed
    batch at a time (lesson 4). `backfill=True` resumes the latest
    non-success run for this county's cursor, matching
    pipelines/sources/parcels.py's pattern."""
    state = cursor
    if state is None and backfill:
        state = _find_resumable_cursor(county_fips)
    if state is None:
        state = new_state(county_fips)

    with db.connect(pooled=False) as conn:
        _set_session_tuning(conn)
        _ensure_staging_table(conn)
        run_id = runs.start(conn, source=SOURCE, runner=runner, cursor=state)

        def checkpoint() -> None:
            runs.finish(
                conn, run_id, status="running",
                rows_in=state["rows_seen"], rows_loaded=state["rows_written"],
                filter_drops={}, cursor=state,
            )
            conn.commit()

        try:
            while True:
                rows_computed, rows_written, last_prop_id = _run_batch(
                    conn, county_fips=state["county_fips"],
                    after_prop_id=state["after_prop_id"], limit=BATCH_SIZE,
                )
                state["rows_seen"] += rows_computed
                state["rows_written"] += rows_written
                if last_prop_id is not None:
                    state["after_prop_id"] = last_prop_id
                checkpoint()
                if rows_computed < BATCH_SIZE:
                    break
            runs.finish(
                conn, run_id, status="success",
                rows_in=state["rows_seen"], rows_loaded=state["rows_written"],
                filter_drops={}, cursor=state,
            )
        except Exception as exc:
            conn.rollback()
            runs.finish(conn, run_id, status="failed", error=str(exc), cursor=state)
            raise
    return state


def _find_resumable_cursor(county_fips: str) -> dict[str, Any] | None:
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select cursor from ops.pipeline_runs
                where source = %s and status != 'success'
                  and cursor ->> 'county_fips' = %s
                order by started_at desc
                limit 1
                """,
                (SOURCE, county_fips),
            )
            row = cur.fetchone()
    return row[0] if row else None
