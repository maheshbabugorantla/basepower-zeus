-- 0203_perf_precompute.sql — M2 perf: precompute the three remaining
-- request-time heavy queries measured by the incident's EXPLAIN ANALYZE
-- pass (per-request costs on a Supabase Micro instance):
--
--   api.gate_counts          2,228 ms — seq scan of core.mv_home_signals
--                                       (~250k rows) then a LEFT JOIN
--                                       LATERAL unnest(source_ids), fanning
--                                       every row out to ~1.74M rows before
--                                       count(distinct prop_id)/array_agg.
--   api.parcel_gate_counts     513 ms — two full seq scans of core.parcels
--                                       (441,961 rows): once for the FILTER
--                                       aggregates, once more for the
--                                       correlated `array(select distinct
--                                       source_id from core.parcels ...)`.
--   blockgroups GeoJSON route  451 ms — live ST_SimplifyPreserveTopology
--                                       over 766 Travis polygons, on every
--                                       request.
--
-- Fix: three small materialized views (core.mv_gate_counts,
-- core.mv_parcel_gate_counts, core.mv_blockgroup_geojson), each with a
-- unique index so REFRESH ... CONCURRENTLY works, refreshed by
-- core.refresh_all_scores() alongside core.mv_home_signals /
-- core.mv_blockgroup_scores. api.gate_counts and api.parcel_gate_counts
-- are redefined as thin `select * from core.mv_...`, with IDENTICAL
-- column names/order/types to before — no caller needs to change. A new
-- api.blockgroup_geojson replaces the route's two live queries
-- (core.block_groups + api.blockgroup_scores) with one read of the
-- precomputed mv; web/app/ranking/blockgroups/route.ts is updated in the
-- same ticket to read it.
--
-- core.mv_gate_counts avoids the 1.74M-row fan-out at REQUEST time by
-- moving it into the mv's own refresh (a rare, pipeline-triggered event,
-- not a per-request cost) and, within that refresh, computing home_count
-- and source_ids as two SEPARATE small aggregates (one plain group-by
-- count, one small group-by over the unnest) rather than one combined
-- query that forces Postgres to carry the inflated row set through both
-- a JOIN and a count(distinct) in the same plan.
--
-- Idempotent-safe: DROP MATERIALIZED VIEW IF EXISTS immediately before
-- each CREATE (matching 0102_m1_materialize.sql/0201_m2.sql's pattern),
-- CREATE OR REPLACE VIEW/FUNCTION elsewhere. Whole file in one
-- transaction — a mid-apply restart (e.g. a Supabase compute resize)
-- leaves either the old or the new schema in place, never a half-applied
-- one. Real-data rule: no data rows are created or altered by this
-- migration; every mv is a precomputed rollup of already-manifested
-- core tables, and each carries its own source_ids column forward for
-- provenance exactly as its live-view predecessor did.

begin;

-- ---------------------------------------------------------------------------
-- core.mv_gate_counts — same columns/semantics as api.gate_counts
-- (0201_m2.sql). `counts` aggregates home_count directly off
-- core.mv_home_signals (no fan-out: one row in, one row counted). `srcs`
-- is the only place that unnests source_ids, and only to build the
-- small per-reason array_agg — a handful of groups, not a per-request
-- cost. The two are joined on the (few, group-by) `reason` value, not on
-- prop_id, so there is no row-multiplying join at output time either.
-- ---------------------------------------------------------------------------

drop materialized view if exists core.mv_gate_counts cascade;

create materialized view core.mv_gate_counts as
with counts as (
    select
        coalesce(s.gate_reason, s.territory_null_reason, 'passed') as reason,
        count(distinct s.prop_id)                                     as home_count
    from core.mv_home_signals s
    group by 1
),
srcs as (
    select
        coalesce(s.gate_reason, s.territory_null_reason, 'passed') as reason,
        array_agg(distinct src)                                       as source_ids
    from core.mv_home_signals s
    cross join lateral unnest(s.source_ids) as src
    group by 1
)
select
    c.reason,
    c.home_count,
    coalesce(sr.source_ids, array[]::uuid[]) as source_ids
from counts c
left join srcs sr on sr.reason = c.reason;

create unique index mv_gate_counts_reason_idx on core.mv_gate_counts (reason);

comment on materialized view core.mv_gate_counts is
    'Precomputed api.gate_counts (was a live ~2.2 s recompute on every '
    'request in 0201_m2.sql: a seq scan of core.mv_home_signals fanned '
    'out ~1.74M rows via unnest(source_ids) before count(distinct)). '
    'home_count and source_ids are computed as two separate small '
    'aggregates so the fan-out (still real work, but now only during '
    'refresh, not per request) never touches the join that drives '
    'home_count. Refreshed by core.refresh_all_scores().';

revoke all on core.mv_gate_counts from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- api.gate_counts — same columns/order/types as 0201_m2.sql: reason,
-- home_count, source_ids. Empty until core.mv_home_signals has rows —
-- unchanged, since a GROUP BY over zero source rows already yields zero
-- groups (the previous HAVING count(distinct s.prop_id) > 0 was
-- redundant with that and is dropped here as dead weight, not a
-- semantic change).
-- ---------------------------------------------------------------------------

create or replace view api.gate_counts as
select reason, home_count, source_ids
from core.mv_gate_counts;

comment on view api.gate_counts is
    'Gate funnel: home count per reason, from core.mv_gate_counts '
    '(precomputed; 0203_perf_precompute.sql). reason is one of: '
    'territory_not_base_served (a real exclusion), '
    'territories_not_loaded / crosswalk_not_loaded (gate not yet '
    'resolvable), or passed. Empty until core.mv_home_signals has rows. '
    'The upstream single-family/homestead parcel gate is counted '
    'separately by api.parcel_gate_counts.';

-- ---------------------------------------------------------------------------
-- core.mv_parcel_gate_counts — same columns/semantics as
-- api.parcel_gate_counts (0101_m1.sql). One pass over core.parcels
-- computes both the FILTER counts and source_ids (array_agg distinct
-- FILTER, not a second correlated subquery re-scanning the table), so
-- this mv's own refresh is a single seq scan of core.parcels, not two.
-- Single-row result: `true as singleton` + a unique index on it, same
-- pattern as core.mv_join_rate (0201_m2.sql). HAVING keeps the mv at
-- zero rows (not a zeroed-out row) while core.parcels is empty, matching
-- the live view's HAVING-driven "zero rows until loaded" behavior.
-- ---------------------------------------------------------------------------

drop materialized view if exists core.mv_parcel_gate_counts cascade;

create materialized view core.mv_parcel_gate_counts as
select
    true as singleton,
    count(*) as total_parcels,
    count(*) filter (
        where imprv_state_cd like 'A1%' or land_state_cd like 'A1%'
    ) as single_family_count,
    count(*) filter (
        where not (coalesce(imprv_state_cd, '') like 'A1%' or coalesce(land_state_cd, '') like 'A1%')
    ) as not_single_family_count,
    count(*) filter (where hs_exempt = 'T') as homestead_count,
    count(*) filter (where hs_exempt is distinct from 'T') as not_homestead_count,
    array_agg(distinct source_id) filter (where source_id is not null) as source_ids
from core.parcels
having count(*) > 0;

-- REFRESH ... CONCURRENTLY needs a unique index on real column(s), not
-- an expression and not partial — `singleton` is always `true` (exactly
-- one row) but is a plain boolean column, which qualifies (same pattern
-- as core.mv_join_rate_singleton_idx, 0201_m2.sql).
create unique index mv_parcel_gate_counts_singleton_idx
    on core.mv_parcel_gate_counts (singleton);

comment on materialized view core.mv_parcel_gate_counts is
    'Precomputed api.parcel_gate_counts (was a live ~513 ms recompute on '
    'every request in 0101_m1.sql: two full seq scans of core.parcels — '
    'one for the FILTER aggregates, one more for a correlated subquery '
    'rebuilding source_ids). Now a single seq scan; source_ids is an '
    'array_agg FILTER in the same aggregate pass. Always exactly one '
    'row (while core.parcels is non-empty). Refreshed by '
    'core.refresh_all_scores().';

revoke all on core.mv_parcel_gate_counts from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- api.parcel_gate_counts — same columns/order/types as 0101_m1.sql:
-- total_parcels, single_family_count, not_single_family_count,
-- homestead_count, not_homestead_count, source_ids.
-- ---------------------------------------------------------------------------

create or replace view api.parcel_gate_counts as
select
    total_parcels,
    single_family_count,
    not_single_family_count,
    homestead_count,
    not_homestead_count,
    source_ids
from core.mv_parcel_gate_counts;

comment on view api.parcel_gate_counts is
    'Parcel gate funnel: single-family (imprv_state_cd/land_state_cd '
    'starts A1) and homestead (hs_exempt = T) counts, from '
    'core.mv_parcel_gate_counts (precomputed; 0203_perf_precompute.sql). '
    'Returns zero rows until core.parcels has at least one row, not an '
    'error.';

-- ---------------------------------------------------------------------------
-- core.mv_blockgroup_geojson — precomputed GeoJSON for
-- web/app/ranking/blockgroups/route.ts, which previously ran
-- ST_SimplifyPreserveTopology live on every request (~451 ms for 766
-- Travis polygons). Same simplification tolerance the route used
-- (0.0001 degrees, ~11m at Travis's latitude — SIMPLIFY_TOLERANCE_DEGREES
-- in route.ts). Joins in the block-group score (same columns the route
-- read from api.blockgroup_scores: score, score_null_reason,
-- rate_per_1000, homes_gated) and carries score's source_ids forward for
-- provenance. Restricted to counties that have parcels loaded (today:
-- Travis, 48453 only) — core.block_groups alone is a statewide TIGER
-- load (18,638 rows across every TX county), almost all of which have no
-- parcel/score data at all and would just be dead weight in this mv and
-- its GeoJSON payload.
-- ---------------------------------------------------------------------------

drop materialized view if exists core.mv_blockgroup_geojson cascade;

create materialized view core.mv_blockgroup_geojson as
select
    bg.geoid,
    bg.county_fips,
    extensions.ST_AsGeoJSON(
        extensions.ST_SimplifyPreserveTopology(bg.geom, 0.0001)
    ) as geometry,
    s.score,
    case
        when s.block_group_geoid is null then 'block_group_not_in_score_view'
        else s.score_null_reason
    end as score_null_reason,
    s.rate_per_1000,
    s.homes_gated,
    coalesce(s.source_ids, array[]::uuid[]) as source_ids
from core.block_groups bg
left join core.mv_blockgroup_scores s on s.block_group_geoid = bg.geoid
where bg.county_fips in (
    select distinct county_fips from core.parcels where county_fips is not null
);

create unique index mv_blockgroup_geojson_geoid_idx
    on core.mv_blockgroup_geojson (geoid);
create index mv_blockgroup_geojson_county_fips_idx
    on core.mv_blockgroup_geojson (county_fips);

comment on materialized view core.mv_blockgroup_geojson is
    'Precomputed simplified GeoJSON + score per block group, for counties '
    'that have parcels loaded (was a live ST_SimplifyPreserveTopology '
    'recompute on every request in web/app/ranking/blockgroups/'
    'route.ts, ~451 ms for 766 Travis polygons). Same simplification '
    'tolerance (0.0001 degrees) the route used. Reads '
    'core.mv_blockgroup_scores, so it must be refreshed AFTER it in '
    'core.refresh_all_scores() — if that mv_blockgroup_scores refresh '
    'line is ever dropped (0201_m2.sql''s comment says to drop it once '
    'M2-W1 lands), this mv''s score/rate_per_1000/homes_gated columns '
    'would silently freeze; move it to read core.mv_top_homes-era data '
    'or whatever v1-score mv replaces it at that point, in the same '
    'change.';

revoke all on core.mv_blockgroup_geojson from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- api.blockgroup_geojson — geoid, county_fips, geometry (GeoJSON text),
-- score, score_null_reason, rate_per_1000, homes_gated, source_ids. Read
-- by web/app/ranking/blockgroups/route.ts instead of the two live
-- queries (core.block_groups + api.blockgroup_scores) it previously ran
-- — same properties the route emitted before (geoid, county_fips, score,
-- score_null_reason, rate_per_1000, homes_gated).
-- ---------------------------------------------------------------------------

create or replace view api.blockgroup_geojson as
select
    geoid,
    county_fips,
    geometry,
    score,
    score_null_reason,
    rate_per_1000,
    homes_gated,
    source_ids
from core.mv_blockgroup_geojson;

comment on view api.blockgroup_geojson is
    'Simplified block-group GeoJSON + score, from '
    'core.mv_blockgroup_geojson (precomputed; 0203_perf_precompute.sql), '
    'for counties that have parcels loaded. Read by '
    'web/app/ranking/blockgroups/route.ts.';

-- ---------------------------------------------------------------------------
-- core.refresh_all_scores() — extended to also refresh the three new
-- mvs, after mv_home_signals / mv_blockgroup_scores (both of which they
-- read). Does NOT change the refresh order of mv_home_signals or the
-- 0102-era mv_blockgroup_scores/mv_top_homes — same as before.
-- ---------------------------------------------------------------------------

create or replace function core.refresh_all_scores() returns void
language plpgsql
as $$
begin
    refresh materialized view concurrently core.mv_home_block_group;
    refresh materialized view concurrently core.mv_home_signals;
    refresh materialized view concurrently core.mv_join_rate;
    -- core.mv_blockgroup_scores / core.mv_top_homes (0102) are retired
    -- by 0201_m2.sql (core.mv_home_signals + api.top_homes_weighted
    -- replace their per-home semantics) but are kept refreshed for now,
    -- since the pre-existing api.top_homes view still reads
    -- core.mv_top_homes and the web app has not switched off it yet
    -- (M2-W1). Drop these two lines once M2-W1 lands.
    refresh materialized view concurrently core.mv_blockgroup_scores;
    refresh materialized view concurrently core.mv_top_homes;
    -- 0203_perf_precompute.sql: precomputed request-time rollups. Must
    -- come after mv_home_signals (mv_gate_counts reads it) and after
    -- mv_blockgroup_scores (mv_blockgroup_geojson reads it).
    refresh materialized view concurrently core.mv_gate_counts;
    refresh materialized view concurrently core.mv_parcel_gate_counts;
    refresh materialized view concurrently core.mv_blockgroup_geojson;
end;
$$;

comment on function core.refresh_all_scores() is
    'Refreshes every score-pipeline materialized view in dependency '
    'order: core.mv_home_block_group, then core.mv_home_signals, then '
    'core.mv_join_rate, then (temporarily, for api.top_homes backward '
    'compatibility until M2-W1 lands) core.mv_blockgroup_scores and '
    'core.mv_top_homes, then (0203_perf_precompute.sql) '
    'core.mv_gate_counts, core.mv_parcel_gate_counts and '
    'core.mv_blockgroup_geojson. Must run outside an already-open '
    'transaction (REFRESH ... CONCURRENTLY cannot run inside one) — '
    'call it as its own statement, e.g. from an autocommit connection.';

revoke all on all tables in schema api from public, anon, authenticated;
grant select on all tables in schema api to service_role;

commit;
