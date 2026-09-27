set local statement_timeout = 0;
set local work_mem = '64MB';
set local maintenance_work_mem = '256MB';
set local max_parallel_workers_per_gather = 0;

-- 0306_eligibility_fix.sql
--
-- Data-correctness investigation (2026-09-26), two issues:
--
-- Issue 1 (Harris/HCAD over-inclusion, Williamson/WCAD 100% pass rate):
-- INVESTIGATED, NOT A BUG. core.mv_home_block_group's single-family/
-- homestead eligibility filter --
--     (p.imprv_state_cd like 'A1%' or p.land_state_cd like 'A1%')
--     and p.hs_exempt = 'T'
-- -- is verified honest against the real raw files for every county:
--   * Harris: recomputing state_class='A1' (verified against HCAD's own
--     Code_description_real.zip -> desc_r_01_state_class.txt: 'A1' =
--     "Real, Residential, Single-Family") AND acct-in-homestead-set
--     (Real_jur_exempt.zip's per-acct exempt_cat token list containing
--     'RES') directly from data/raw/hcad/Real_acct_owner.zip +
--     Real_jur_exempt.zip gives EXACTLY 836,310 rows -- the exact count
--     already in core.parcels for county_fips='48201'. HCAD's own loader
--     (pipelines/sources/hcad_parcels.py) pre-filters to this same
--     criterion BEFORE loading (Vercel/disk-IO budget, its own module
--     docstring), so every Harris row in core.parcels already satisfies
--     the eligibility gate by construction -- the live 819,421-of-836,310
--     "pass rate" is the geometry/block-group join rate (819,421 have a
--     matched block_group_geoid), not an eligibility shortfall. Same
--     shape for Williamson: recomputing land StateCode='A1' AND an
--     Exemptions.csv row with ExemptionTypeDescription='Homestead' AND
--     ExemptionStatusCode='A' directly from data/raw/wcad/ gives 158,597
--     candidates, 158,584 with geometry, matching (within the documented
--     ~109-row TCAD-in-Williamson overlap dedup) the 158,475 already in
--     core.parcels for county_fips='48491' -- WCAD's loader
--     (pipelines/sources/wcad_parcels.py) pre-filters identically. Travis
--     (TCAD, parcels.py) is the odd one out only because ITS loader loads
--     every parcel unfiltered and lets this same view do the single-
--     family/homestead filtering at query time -- an architectural
--     difference (documented, per-county disk-IO budgets), not a data
--     error. No change to the eligibility predicate itself is made here.
--
-- Issue 2 (cross-county block_group_geoid, e.g. Williamson/Travis homes
-- carrying a 48453-prefixed GEOID): REAL BUG, fixed at its source in
-- pipelines/sources/home_spatial.py's bg_match lateral join (this
-- migration's session was read-only; the loader fix is not yet applied
-- to core.home_spatial -- see the ticket report for the exact rerun
-- steps). This migration adds the SAME county-scoped predicate directly
-- to core.mv_home_block_group's own filter as a defensive belt-and-
-- suspenders measure, so the view is correct immediately on apply even
-- before pipelines/sources/home_spatial.py is rerun for every county:
-- verified live (read-only) that 409 core.home_spatial rows currently
-- carry an unverified cross-county block_group_geoid (110 Harris, 253
-- Travis, 46 Williamson) -- none of which have any alternate same-county
-- block group also containing their stored point. The ONE documented,
-- verified exception is kept: TCAD (Travis, 48453) parcels whose real
-- geometry sits inside Williamson (48491) -- see
-- pipelines/sources/wcad_parcels.py's module docstring (the
-- 137-TCAD-rolled-parcels-in-Williamson note, sourced from
-- 0102_m1_materialize.sql's original geometry-based county assignment
-- decision) and that module's own TCAD-in-Williamson overlap dedup
-- logic, which this filter must not contradict.
--
-- Follow-up (coordinator, same session): the first draft of this
-- migration EXCLUDED the 409 rows from core.mv_home_block_group entirely
-- (via `block_group_geoid is not null`), which silently dropped those
-- homes out of core.mv_home_signals / ranking too (mv_home_signals'
-- `base` CTE inner-joins core.mv_home_block_group). Fixed here: every
-- eligible home now stays a row in core.mv_home_block_group regardless
-- of whether a block group resolved -- block_group_geoid is null (never
-- a force-assigned neighboring-county GEOID) with a
-- block_group_null_reason explaining why, and the home keeps ranking on
-- every OTHER signal. Verified this does not break any consumer:
--   * mv_blockgroup_scores' bg_home_counts/bg_permit_counts group by
--     block_group_geoid, producing one extra NULL-keyed aggregate row --
--     that row can never equi-join to a real core.block_groups.geoid
--     (never null) in bg_rates' `left join ... on hc.block_group_geoid =
--     bg.geoid`, so it is silently and correctly excluded, same as
--     before.
--   * mv_top_homes joins home_bg to mv_blockgroup_scores ON
--     block_group_geoid and filters `where bs.score is not null` -- a
--     null-block-group home can't equi-join a score row either, so it's
--     excluded from this legacy top-50-by-block-group-score leaderboard
--     only (correct: it has no block-group score to rank by there); the
--     real ranking path (core.mv_home_signals / api.homes_ranked_weighted,
--     0304b2, not touched by this migration) reads core.mv_home_block_group
--     by prop_id and keeps the home with block_group_geoid null.
--   * core.mv_home_signals_v2's own `acs` CTE already left-joins
--     core.acs_bg on block_group_geoid and already has an
--     `a.geoid is null` branch producing 'block_group_not_in_acs' -- a
--     real, non-invented reason -- so ACS-derived signals for these
--     homes come out null with that existing reason, unchanged.
--
-- Same build-beside + rename-swap + rebind-dependents pattern as
-- 0304b1_block_group_swap.sql (mv_home_block_group_pre_m3p6 was already
-- dropped by 0304b5, so this swap starts clean). Peak disk kept small:
-- one extra copy of mv_home_block_group only, dropped at the end.
-- ---------------------------------------------------------------------------

-- Additive, nullable, no rewrite of existing rows: carries the specific
-- reason pipelines/sources/home_spatial.py's bg_match now computes
-- ('no_block_group_in_county', 'point_outside_loaded_block_groups',
-- 'no_parcel_point') once that loader is rerun. Existing rows read back
-- null here until then -- mv_home_block_group_v2 below falls back to an
-- honest generic reason for those, never inventing the specific one.
alter table core.home_spatial add column if not exists block_group_null_reason text;

create materialized view core.mv_home_block_group_v2 as
with eligible as (
    select
        hs.prop_id, hs.county_fips, hs.block_group_geoid, hs.bg_source_id,
        hs.block_group_null_reason, hs.parcel_source_id, hs.geom_source_id,
        p.geo_id, p.county_fips as parcel_county_fips
    from core.home_spatial hs
    join core.parcels p on p.prop_id = hs.prop_id
    where (p.imprv_state_cd like 'A1%' or p.land_state_cd like 'A1%')
      and p.hs_exempt = 'T'
),
scoped as (
    select
        e.*,
        (
            e.block_group_geoid is not null
            and (
                left(e.block_group_geoid, 5) = e.parcel_county_fips
                or (e.parcel_county_fips = '48453' and left(e.block_group_geoid, 5) = '48491')
            )
        ) as bg_in_scope
    from eligible e
)
select
    s.prop_id,
    s.geo_id,
    case when s.bg_in_scope then s.block_group_geoid else null end as block_group_geoid,
    s.parcel_source_id,
    s.geom_source_id,
    case when s.bg_in_scope then s.bg_source_id else null end as bg_source_id,
    case
        when s.bg_in_scope then null
        -- home_spatial not yet rerun with the fix: the stored GEOID is a
        -- real cross-county match this view must not surface.
        when s.block_group_geoid is not null then 'no_block_group_in_county'
        else coalesce(s.block_group_null_reason, 'block_group_not_available')
    end as block_group_null_reason
from scoped s;

create unique index mv_home_block_group_v2_prop_id_idx on core.mv_home_block_group_v2 (prop_id);
create index mv_home_block_group_v2_bg_geoid_idx on core.mv_home_block_group_v2 (block_group_geoid);

analyze core.mv_home_block_group_v2;

drop view if exists api.blockgroup_geojson;
drop view if exists api.blockgroup_scores;
drop view if exists api.top_homes;
drop materialized view if exists core.mv_blockgroup_geojson;
drop materialized view if exists core.mv_top_homes;
drop materialized view if exists core.mv_blockgroup_scores;

alter materialized view core.mv_home_block_group rename to mv_home_block_group_pre_0306;
alter materialized view core.mv_home_block_group_v2 rename to mv_home_block_group;
alter index core.mv_home_block_group_v2_prop_id_idx rename to mv_home_block_group_prop_id_idx_0306;
alter index core.mv_home_block_group_v2_bg_geoid_idx rename to mv_home_block_group_bg_geoid_idx_0306;

-- Recreated verbatim from 0304b1_block_group_swap.sql (no logic change
-- in this section -- only rebinding to the new core.mv_home_block_group).
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

-- Drop the pre-swap copy as soon as nothing reads it (disk on Supabase
-- Small is 8 GB) -- same lesson as 0304b5_drop_pre_m3p6.sql.
drop materialized view core.mv_home_block_group_pre_0306;
