-- 0102_m1_materialize.sql — M1 outage fix: materialize the live spatial
-- join (parcel centroid -> block group) and the score/top-homes rollups
-- that 0101_m1.sql defined as plain views, which forces a fresh ~217K-row
-- ST_Within spatial join plus permit aggregation on every request and
-- blows the Supabase 120s statement_timeout on /ranking.
--
-- Idempotent-safe: every DDL statement uses IF NOT EXISTS / CREATE OR
-- REPLACE / drop-if-exists-then-create so this file can be re-applied to
-- the same database without error. `CREATE MATERIALIZED VIEW` has no
-- `OR REPLACE` in Postgres, so re-applying this file drops and recreates
-- each mv only if its defining query text changed is NOT checked here —
-- instead we DROP ... IF EXISTS immediately before each CREATE, inside the
-- same transaction, so this file is safely re-runnable.
--
-- api.blockgroup_scores / api.top_homes are redefined as thin
-- `select * from core.mv_...` with identical column names/order, so the
-- web app (web/lib/db.ts queries) needs no change. api.home_detail and
-- api.parcel_gate_counts do NOT perform the spatial join (home_detail is
-- keyed to one prop_id; parcel_gate_counts aggregates core.parcels alone,
-- no core.block_groups join) so they are left as-is from 0101_m1.sql.
--
-- Refresh: pipelines/sources/refresh_scores.py runs
-- REFRESH MATERIALIZED VIEW CONCURRENTLY for these three, in dependency
-- order, after every parcel/geometry/block-group/permit load. Each mv
-- below therefore needs a unique index so CONCURRENTLY works.

begin;

-- ---------------------------------------------------------------------------
-- core.mv_home_block_group — gated (single-family + homestead) home ->
-- block group, via ST_Within(parcel centroid, block group geom), GIST-
-- index-assisted on both sides (parcel_geoms_centroid_gix,
-- block_groups_geom_gix from 0101_m1.sql).
--
-- NOTE: an earlier draft of this migration additionally restricted
-- candidate block groups to `bg.county_fips in (select distinct
-- county_fips from core.parcels)`, matching on the *parcel's own*
-- county_fips attribute rather than geography. That is wrong: a real
-- Travis-county parcel (prop_id 177324, county_fips='48453') sits, by
-- centroid, inside a Williamson-county (48491) block group polygon near
-- the county line — a real ST_Within match the live 0101_m1.sql view
-- includes. Filtering on the parcel's own attribute silently dropped
-- that (and every other near-the-line) match and changed the top-50
-- ranking measurably. The GIST indexes already make the unrestricted
-- join fast (full 3-mv refresh completes in ~1 min live), so there is no
-- county restriction here at all — correctness over a speedup that
-- isn't needed.
-- ---------------------------------------------------------------------------

drop materialized view if exists core.mv_home_block_group cascade;

create materialized view core.mv_home_block_group as
with gated_homes as (
    select
        p.prop_id,
        p.geo_id,
        pg.centroid,
        p.source_id  as parcel_source_id,
        pg.source_id as geom_source_id
    from core.parcels p
    join core.parcel_geoms pg on pg.prop_id = p.prop_id
    where (p.imprv_state_cd like 'A1%' or p.land_state_cd like 'A1%')
      and p.hs_exempt = 'T'
      and pg.centroid is not null
)
select
    gh.prop_id,
    gh.geo_id,
    bg.geoid as block_group_geoid,
    gh.parcel_source_id,
    gh.geom_source_id,
    bg.source_id as bg_source_id
from gated_homes gh
join core.block_groups bg
    on extensions.ST_Within(gh.centroid, bg.geom);

create unique index mv_home_block_group_prop_id_idx
    on core.mv_home_block_group (prop_id);
create index mv_home_block_group_bg_geoid_idx
    on core.mv_home_block_group (block_group_geoid);

comment on materialized view core.mv_home_block_group is
    'Materialized spatial join (ST_Within, parcel centroid in block group '
    'polygon) for gated homes, GIST-index-assisted, unrestricted by '
    'county (a parcel''s own county_fips attribute does not always match '
    'the county of the block group its centroid geographically falls '
    'in, near a county line). Refreshed by pipelines/sources/'
    'refresh_scores.py (first in dependency order — mv_blockgroup_scores '
    'and mv_top_homes both read this).';

-- ---------------------------------------------------------------------------
-- core.mv_blockgroup_scores — same columns/semantics as api.blockgroup_scores
-- in 0101_m1.sql, but reading the precomputed core.mv_home_block_group
-- instead of recomputing the spatial join, so refresh cost is dominated by
-- the (indexed, non-spatial) permit aggregation, not ST_Within.
-- ---------------------------------------------------------------------------

drop materialized view if exists core.mv_blockgroup_scores cascade;

create materialized view core.mv_blockgroup_scores as
with home_bg as (
    select prop_id, geo_id, block_group_geoid, parcel_source_id, geom_source_id, bg_source_id
    from core.mv_home_block_group
),
bg_home_counts as (
    select
        block_group_geoid,
        count(*) as homes_gated,
        array_agg(distinct parcel_source_id) as parcel_source_ids,
        array_agg(distinct geom_source_id) as geom_source_ids,
        array_agg(distinct bg_source_id) as bg_source_ids
    from home_bg
    group by block_group_geoid
),
permits_in_window as (
    select
        pm.permit_number,
        hb.prop_id,
        hb.block_group_geoid,
        pl.label,
        pm.source_id as permit_source_id
    from core.permits pm
    join core.permit_labels pl
        on pl.permit_number = pm.permit_number
       and pl.labeller = 'rules'
    join core.parcels p on p.geo_id = pm.tcad_id
    join home_bg hb on hb.prop_id = p.prop_id
    where pm.issue_date >= (current_date - interval '36 months')
),
bg_permit_counts as (
    select
        block_group_geoid,
        count(distinct permit_number) filter (where label in ('battery', 'generator')) as backup_permits_count,
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
        bg.geoid as block_group_geoid,
        bg.county_fips,
        hc.homes_gated,
        pc.backup_permits_count,
        case
            when hc.homes_gated is null or hc.homes_gated = 0 then null
            when pc.any_permits_count is null then null
            else (pc.backup_permits_count::numeric / hc.homes_gated) * 1000
        end as rate_per_1000,
        case
            when hc.homes_gated is null or hc.homes_gated = 0 then 'no_gated_homes_in_block_group'
            when not pl2.any_rules_labels then 'permits_not_loaded'
            when pc.any_permits_count is null then 'no_permit_coverage'
            else null
        end as rate_null_reason,
        array(
            select distinct s from unnest(
                array[bg.source_id]
                || coalesce(hc.parcel_source_ids, array[]::uuid[])
                || coalesce(hc.geom_source_ids, array[]::uuid[])
                || coalesce(hc.bg_source_ids, array[]::uuid[])
                || coalesce(pc.permit_source_ids, array[]::uuid[])
            ) s where s is not null
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
    r.block_group_geoid,
    r.county_fips,
    r.homes_gated,
    r.backup_permits_count,
    r.rate_per_1000,
    s.score,
    case when s.score is null then r.rate_null_reason else null end as score_null_reason,
    r.source_ids
from bg_rates r
left join scored s on s.block_group_geoid = r.block_group_geoid;

create unique index mv_blockgroup_scores_bg_geoid_idx
    on core.mv_blockgroup_scores (block_group_geoid);

comment on materialized view core.mv_blockgroup_scores is
    'Materialized score v0 (see api.blockgroup_scores comment in '
    '0101_m1.sql for full semantics). Reads core.mv_home_block_group '
    'instead of recomputing the spatial join. Refreshed by '
    'pipelines/sources/refresh_scores.py after mv_home_block_group.';

-- ---------------------------------------------------------------------------
-- core.mv_top_homes — same columns/semantics as api.top_homes in
-- 0101_m1.sql, reading the two mvs above instead of recomputing.
-- ---------------------------------------------------------------------------

drop materialized view if exists core.mv_top_homes cascade;

create materialized view core.mv_top_homes as
with gated_homes as (
    select
        p.prop_id,
        p.geo_id,
        p.situs_num,
        p.situs_street,
        p.situs_city,
        p.situs_zip,
        p.market_value,
        p.source_id as parcel_source_id
    from core.parcels p
    where (p.imprv_state_cd like 'A1%' or p.land_state_cd like 'A1%')
      and p.hs_exempt = 'T'
),
home_bg as (
    select prop_id, block_group_geoid, geom_source_id
    from core.mv_home_block_group
)
select
    gh.prop_id,
    gh.geo_id,
    gh.situs_num,
    gh.situs_street,
    gh.situs_city,
    gh.situs_zip,
    gh.market_value,
    hb.block_group_geoid,
    bs.score,
    bs.rate_per_1000,
    array['gated single-family/homestead home in block group ' || hb.block_group_geoid ||
          ' (score ' || coalesce(bs.score::text, 'not loaded') || ')'] as reasons,
    array(
        select distinct s from unnest(
            array[gh.parcel_source_id, hb.geom_source_id] || coalesce(bs.source_ids, array[]::uuid[])
        ) s where s is not null
    ) as source_ids
from gated_homes gh
join home_bg hb on hb.prop_id = gh.prop_id
join core.mv_blockgroup_scores bs on bs.block_group_geoid = hb.block_group_geoid
where bs.score is not null
order by bs.score desc, gh.market_value desc nulls last
limit 50;

create unique index mv_top_homes_prop_id_idx
    on core.mv_top_homes (prop_id);

comment on materialized view core.mv_top_homes is
    'Materialized top 50 (see api.top_homes comment in 0101_m1.sql for '
    'full semantics). Refreshed by pipelines/sources/refresh_scores.py '
    'last (depends on both mvs above).';

-- ---------------------------------------------------------------------------
-- Access control on the new core materialized views. Row-level security
-- cannot be enabled on a materialized view in Postgres (ALTER MATERIALIZED
-- VIEW ... ENABLE ROW LEVEL SECURITY is not supported), so — matching the
-- core-schema convention from 0101_m1.sql — we instead revoke all grants
-- from public/anon/authenticated directly. Nothing outside the api schema
-- reads these mvs; api.blockgroup_scores/api.top_homes read them as the
-- view owner (Postgres views run with definer, not invoker, rights by
-- default), same as every other api.* view reads core tables today.
-- ---------------------------------------------------------------------------

revoke all on core.mv_home_block_group   from public, anon, authenticated;
revoke all on core.mv_blockgroup_scores  from public, anon, authenticated;
revoke all on core.mv_top_homes          from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- api.blockgroup_scores / api.top_homes — thin wrappers over the mvs above.
-- Identical column names/order to 0101_m1.sql, so the web app needs no
-- change.
-- ---------------------------------------------------------------------------

create or replace view api.blockgroup_scores as
select * from core.mv_blockgroup_scores;

comment on view api.blockgroup_scores is
    'Score v0 (backup intent only), served from core.mv_blockgroup_scores '
    '(materialized — see 0101_m1.sql for full score semantics and null-'
    'reason meanings). Refreshed by pipelines/sources/refresh_scores.py; '
    'this view itself is always instant.';

create or replace view api.top_homes as
select * from core.mv_top_homes;

comment on view api.top_homes is
    'Top 50 gated homes in the highest-scoring block groups, served from '
    'core.mv_top_homes (materialized — see 0101_m1.sql for full '
    'semantics). Refreshed by pipelines/sources/refresh_scores.py; this '
    'view itself is always instant.';

-- ---------------------------------------------------------------------------
-- Grants: service_role only (re-assert, idempotent, matching 0101_m1.sql).
-- ---------------------------------------------------------------------------

revoke all on all tables in schema api from public, anon, authenticated;
grant select on all tables in schema api to service_role;

commit;
