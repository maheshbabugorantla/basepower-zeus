set local statement_timeout = 0;
set local work_mem = '64MB';
set local maintenance_work_mem = '256MB';
set local max_parallel_workers_per_gather = 0;

-- 0304b_spatial_precompute_swap.sql — M3-P6, SWAP half.
--
-- Course correction (coordinator): this file no longer assumes
-- 0303_utility_gate_counts.sql / 0303b_utility_gate_counts_swap.sql were
-- ever applied — the apply path never runs 0303's live-geometry
-- mv_home_signals_v2 build (the 25-35+ minute step that already hit
-- OOM/disk-full on 2026-09-26). This migration builds directly against
-- the CURRENT live schema (verified via pg_catalog against the real DB
-- during this session, read-only, 2026-09-26): core.mv_home_signals has
-- no territory_basis column yet and still carries the six *_pctile
-- columns from 0212; core.mv_gate_counts/core.mv_parcel_gate_counts/
-- core.mv_gate_counts_by_market have no county_fips column;
-- core.mv_home_terms/core.mv_home_geo_rollup/core.mv_county_territories/
-- api.loaded_counties/api.home_geo_rollup/api.county_territories don't
-- exist; api.homes_ranked_weighted/_count/blockgroup_scores_weighted
-- have their pre-situs-filter signatures; core.home_propensity has no
-- county_fips column.
--
-- This ONE swap carries every semantic 0303+0303b intended
-- (territory_basis, county-aware gate counts, mv_home_terms,
-- mv_home_geo_rollup, api.loaded_counties, mv_county_territories,
-- overload drops before the extended function signatures, coalesce
-- city/zip filters, view rebinding, restated indexes) while replacing
-- the expensive geometry build with pure ID joins onto core.home_spatial
-- (0304). If 0303/0303b are ever applied to some other environment
-- before this file, this file's `create table core.flood_zones_sub`-
-- style DDL in 0304 will conflict (that pairing is retired — do not
-- apply 0303/0303b at all on this path; see checks/M3-P6.md).
--
-- Second course correction (coordinator, after the first swap draft):
-- core.mv_home_block_group's own refresh still did live ST_Within
-- (block-group point-in-polygon, ~2 min projected at 1.2M homes) even
-- after mv_home_signals stopped needing it. Fixed here too: it is now a
-- plain filtered select from core.home_spatial, and every matview/view
-- that reads it (mv_blockgroup_scores, mv_top_homes,
-- mv_blockgroup_geojson, api.blockgroup_scores, api.top_homes,
-- api.blockgroup_geojson — all legacy v0 objects kept refreshed only
-- because the web app hasn't switched off them yet) is rebound. Also
-- fixed: api.blockgroup_scores_weighted returned percent_rank() over
-- block groups' mean score — a relative rank, which is exactly what the
-- project's anchored-absolute (never percentile) scoring rule forbids.
-- It now returns the mean anchored score directly (see that function's
-- own comment for the web-compatibility check).
--
-- Requires: 0304_spatial_precompute.sql applied AND
-- pipelines/sources/home_spatial.py run to completion for every loaded
-- county (core.home_spatial fully populated) — see checks/M3-P6.md.
--
-- One-time cutover: not meant to be re-run after it has already
-- succeeded once.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- core.mv_home_block_group — course correction (coordinator): the live
-- version's `gated_homes` CTE does live ST_Within(centroid, block
-- group) on every refresh (~2 min projected at 1.2M homes, per the
-- ticket's own benchmark table — "already small polygons"). It is
-- rebuilt here as a plain filtered select from core.home_spatial (which
-- already carries every parcel's block_group_geoid, computed once by
-- pipelines/sources/home_spatial.py) — zero geometry at refresh time.
-- Same output columns, same single-family/homestead eligibility filter
-- as the live version's `gated_homes` CTE, same "row only exists when a
-- block group actually matched" semantics (inner join equivalent: the
-- `where hs.block_group_geoid is not null` below). Build-beside +
-- rename-swap (lesson 4), then every matview/view that reads it is
-- dropped and recreated (lesson 6) — mv_blockgroup_scores and
-- mv_top_homes (legacy v0 objects core.refresh_all_scores() keeps
-- refreshed only because api.top_homes/api.blockgroup_scores still read
-- them — see that function's comment) plus mv_blockgroup_geojson and the
-- three api views on top. core.mv_home_signals below then joins through
-- this rebuilt mv_home_block_group, exactly like the live version does,
-- so the single-family/homestead eligibility filter stays identical.
-- ---------------------------------------------------------------------------
create materialized view core.mv_home_block_group_v2 as
select
    hs.prop_id,
    p.geo_id,
    hs.block_group_geoid,
    hs.parcel_source_id,
    hs.geom_source_id,
    hs.bg_source_id
from core.home_spatial hs
join core.parcels p on p.prop_id = hs.prop_id
where (p.imprv_state_cd like 'A1%' or p.land_state_cd like 'A1%')
  and p.hs_exempt = 'T'
  and hs.block_group_geoid is not null;

create unique index mv_home_block_group_v2_prop_id_idx on core.mv_home_block_group_v2 (prop_id);
create index mv_home_block_group_v2_bg_geoid_idx on core.mv_home_block_group_v2 (block_group_geoid);

analyze core.mv_home_block_group_v2;

drop view if exists api.blockgroup_geojson;
drop view if exists api.blockgroup_scores;
drop view if exists api.top_homes;
drop materialized view if exists core.mv_blockgroup_geojson;
drop materialized view if exists core.mv_top_homes;
drop materialized view if exists core.mv_blockgroup_scores;

alter materialized view core.mv_home_block_group rename to mv_home_block_group_pre_m3p6;
alter materialized view core.mv_home_block_group_v2 rename to mv_home_block_group;
alter index core.mv_home_block_group_v2_prop_id_idx rename to mv_home_block_group_prop_id_idx_m3p6;
alter index core.mv_home_block_group_v2_bg_geoid_idx rename to mv_home_block_group_bg_geoid_idx_m3p6;

-- Recreated verbatim (same SQL the live objects had — this section only
-- rebinds them to the new core.mv_home_block_group; none of their own
-- logic changes here, including mv_blockgroup_scores's own separate,
-- legacy v0 percent_rank() -- out of this ticket's scope, unlike
-- api.blockgroup_scores_weighted below).
create materialized view core.mv_blockgroup_scores as
with home_bg as (
    select prop_id, geo_id, block_group_geoid, parcel_source_id, geom_source_id, bg_source_id
    from core.mv_home_block_group
),
bg_home_counts as (
    select block_group_geoid, count(*) as homes_gated,
           array_agg(distinct parcel_source_id) as parcel_source_ids,
           array_agg(distinct geom_source_id) as geom_source_ids,
           array_agg(distinct bg_source_id) as bg_source_ids
    from home_bg
    group by block_group_geoid
),
permits_in_window as (
    select pm.permit_number, hb.prop_id, hb.block_group_geoid, pl.label, pm.source_id as permit_source_id
    from core.permits pm
    join core.permit_labels pl on pl.permit_number = pm.permit_number and pl.labeller = 'rules'
    join core.parcels p on p.geo_id = pm.tcad_id
    join home_bg hb on hb.prop_id = p.prop_id
    where pm.issue_date >= current_date - interval '3 years'
),
bg_permit_counts as (
    select block_group_geoid,
           count(distinct permit_number) filter (where label = any (array['battery', 'generator'])) as backup_permits_count,
           count(distinct permit_number) as any_permits_count,
           array_agg(distinct permit_source_id) as permit_source_ids
    from permits_in_window
    group by block_group_geoid
),
permits_loaded as (
    select exists (select 1 from core.permit_labels where labeller = 'rules') as any_rules_labels
),
bg_rates as (
    select
        bg.geoid as block_group_geoid, bg.county_fips,
        hc.homes_gated, pc.backup_permits_count,
        case
            when hc.homes_gated is null or hc.homes_gated = 0 then null::numeric
            when pc.any_permits_count is null then null::numeric
            else pc.backup_permits_count::numeric / hc.homes_gated::numeric * 1000::numeric
        end as rate_per_1000,
        case
            when hc.homes_gated is null or hc.homes_gated = 0 then 'no_gated_homes_in_block_group'
            when not pl2.any_rules_labels then 'permits_not_loaded'
            when pc.any_permits_count is null then 'no_permit_coverage'
            else null
        end as rate_null_reason,
        array(
            select distinct s_1.s
            from unnest(array[bg.source_id] || coalesce(hc.parcel_source_ids, array[]::uuid[])
                         || coalesce(hc.geom_source_ids, array[]::uuid[]) || coalesce(hc.bg_source_ids, array[]::uuid[])
                         || coalesce(pc.permit_source_ids, array[]::uuid[])) s_1(s)
            where s_1.s is not null
        ) as source_ids
    from core.block_groups bg
    left join bg_home_counts hc on hc.block_group_geoid = bg.geoid
    left join bg_permit_counts pc on pc.block_group_geoid = bg.geoid
    cross join permits_loaded pl2
),
scored as (
    select block_group_geoid, percent_rank() over (order by rate_per_1000) as score
    from bg_rates
    where rate_per_1000 is not null
)
select
    r.block_group_geoid, r.county_fips, r.homes_gated, r.backup_permits_count, r.rate_per_1000,
    s.score,
    case when s.score is null then r.rate_null_reason else null end as score_null_reason,
    r.source_ids
from bg_rates r
left join scored s on s.block_group_geoid = r.block_group_geoid;

create unique index mv_blockgroup_scores_bg_geoid_idx on core.mv_blockgroup_scores (block_group_geoid);
analyze core.mv_blockgroup_scores;

create materialized view core.mv_top_homes as
with gated_homes as (
    select p.prop_id, p.geo_id, p.situs_num, p.situs_street, p.situs_city, p.situs_zip, p.market_value, p.source_id as parcel_source_id
    from core.parcels p
    where (p.imprv_state_cd like 'A1%' or p.land_state_cd like 'A1%') and p.hs_exempt = 'T'
),
home_bg as (
    select prop_id, block_group_geoid, geom_source_id from core.mv_home_block_group
)
select
    gh.prop_id, gh.geo_id, gh.situs_num, gh.situs_street, gh.situs_city, gh.situs_zip, gh.market_value,
    hb.block_group_geoid, bs.score, bs.rate_per_1000,
    array[('gated single-family/homestead home in block group ' || hb.block_group_geoid
           || ' (score ' || coalesce(bs.score::text, 'not loaded') || ')')] as reasons,
    array(select distinct s.s from unnest(array[gh.parcel_source_id, hb.geom_source_id] || coalesce(bs.source_ids, array[]::uuid[])) s(s) where s.s is not null) as source_ids
from gated_homes gh
join home_bg hb on hb.prop_id = gh.prop_id
join core.mv_blockgroup_scores bs on bs.block_group_geoid = hb.block_group_geoid
where bs.score is not null
order by bs.score desc, gh.market_value desc nulls last
limit 50;

create unique index mv_top_homes_prop_id_idx on core.mv_top_homes (prop_id);
analyze core.mv_top_homes;

create materialized view core.mv_blockgroup_geojson as
select
    bg.geoid, bg.county_fips,
    extensions.ST_AsGeoJSON(extensions.ST_SimplifyPreserveTopology(bg.geom, 0.0001)) as geometry,
    s.score,
    case when s.block_group_geoid is null then 'block_group_not_in_score_view' else s.score_null_reason end as score_null_reason,
    s.rate_per_1000, s.homes_gated,
    coalesce(s.source_ids, array[]::uuid[]) as source_ids
from core.block_groups bg
left join core.mv_blockgroup_scores s on s.block_group_geoid = bg.geoid
where bg.county_fips in (select distinct county_fips from core.parcels where county_fips is not null);

create unique index mv_blockgroup_geojson_geoid_idx on core.mv_blockgroup_geojson (geoid);
create index mv_blockgroup_geojson_county_fips_idx on core.mv_blockgroup_geojson (county_fips);
analyze core.mv_blockgroup_geojson;

create view api.blockgroup_scores as
    select block_group_geoid, county_fips, homes_gated, backup_permits_count, rate_per_1000, score, score_null_reason, source_ids
    from core.mv_blockgroup_scores;

create view api.top_homes as
    select prop_id, geo_id, situs_num, situs_street, situs_city, situs_zip, market_value, block_group_geoid, score, rate_per_1000, reasons, source_ids
    from core.mv_top_homes;

create view api.blockgroup_geojson as
    select geoid, county_fips, geometry, score, score_null_reason, rate_per_1000, homes_gated, source_ids
    from core.mv_blockgroup_geojson;

grant select on core.mv_home_block_group, core.mv_blockgroup_scores, core.mv_top_homes, core.mv_blockgroup_geojson to zeus_web_ro;
grant select on api.blockgroup_scores, api.top_homes, api.blockgroup_geojson to zeus_web_ro;

-- ---------------------------------------------------------------------------
-- core.mv_home_signals_v2 — build-beside (lesson 4). Zero geometry at
