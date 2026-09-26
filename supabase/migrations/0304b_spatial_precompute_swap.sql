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
-- refresh time: block group / flood / territory answers come from
-- core.home_spatial, precomputed once per (home, boundary-file version).
-- `base` joins through the just-rebuilt core.mv_home_block_group (not
-- core.home_spatial + core.parcels directly) so the single-family/
-- homestead eligibility filter stays IDENTICAL to the live version's row
-- set — home_spatial itself deliberately covers every parcel (a general
-- spatial cache other future consumers can filter differently), so
-- skipping this join would have silently widened mv_home_signals to
-- include non-single-family/non-homestead parcels. Adds territory_basis
-- (new). Keeps the six legacy *_pctile columns as DEPRECATED-always-null
-- (see the note below) rather than dropping them outright.
-- ---------------------------------------------------------------------------
create materialized view core.mv_home_signals_v2 as
with base as (
    select
        hbg.prop_id,
        hbg.geo_id,
        hs.county_fips,
        hbg.block_group_geoid,
        p.situs_zip,
        p.ov65_exempt,
        p.market_value,
        hbg.parcel_source_id,
        hs.resolved_territory_eia_id as territory_eia_id,
        hs.territory_source_id,
        hs.territory_basis,
        hs.territory_null_reason,
        hs.territory_gate_reason as gate_reason,
        hs.in_sfha as flood_flag,
        hs.flood_source_id,
        hs.flood_null_reason,
        hs.boundary_source_ids
    from core.mv_home_block_group hbg
    join core.home_spatial hs on hs.prop_id = hbg.prop_id
    join core.parcels p on p.prop_id = hbg.prop_id
),
reliability as (
    select
        b.prop_id,
        ur.saidi_incl_major as distributor_saidi,
        ur.year as distributor_saidi_year,
        ur.early_release as distributor_saidi_early_release,
        ur.utility_name as distributor_name,
        ur.source_id as reliability_source_id,
        case
            when b.territory_eia_id is null then coalesce(b.territory_null_reason, 'no_territory_match')
            when ur.saidi_incl_major is not null then null
            when (select count(*) from core.utility_reliability) = 0 then 'eia861_not_loaded'
            else 'no_eia861_figure_for_distributor'
        end as distributor_saidi_null_reason
    from base b
    left join lateral (
        select r.saidi_incl_major, r.year, r.early_release, r.utility_name, r.source_id
        from core.utility_reliability r
        where r.eia_id = b.territory_eia_id and r.saidi_incl_major is not null
        order by r.year desc
        limit 1
    ) ur on true
),
county_proxy as (
    select distinct on (o.county_fips)
        o.county_fips,
        o.year,
        o.customer_hours_out * 60.0 / c.customers as proxy_minutes,
        array(select distinct s.s from unnest(o.source_ids || array[c.source_id]) s(s) where s.s is not null) as source_ids,
        c.customers is null or c.customers = 0 as customers_missing
    from core.outage_county_year o
    left join core.county_customers c on c.county_fips = o.county_fips
    where o.customer_hours_out is not null
    order by o.county_fips, o.year desc
),
outage as (
    select
        b.prop_id,
        case
            when r.distributor_saidi is not null then r.distributor_saidi
            when cp.proxy_minutes is not null then cp.proxy_minutes
            else null
        end as outage_minutes,
        case
            when r.distributor_saidi is not null then r.distributor_saidi_year
            when cp.proxy_minutes is not null then cp.year
            else null
        end as outage_year,
        case
            when r.distributor_saidi is not null then 'distributor_saidi'
            when cp.proxy_minutes is not null then 'county_eaglei_proxy'
            else null
        end as outage_basis,
        case
            when r.distributor_saidi is not null then array[r.reliability_source_id]
            when cp.proxy_minutes is not null then cp.source_ids
            else array[]::uuid[]
        end as outage_source_ids,
        case
            when r.distributor_saidi is not null then null
            when cp.proxy_minutes is not null then null
            when r.distributor_saidi_null_reason <> 'no_eia861_figure_for_distributor' then r.distributor_saidi_null_reason
            when (select count(*) from core.outage_county_year) = 0 then 'eaglei_not_loaded'
            when cp.customers_missing then 'county_customers_not_loaded'
            else 'no_outage_figure_for_county'
        end as outage_null_reason
    from base b
    join reliability r on r.prop_id = b.prop_id
    left join county_proxy cp on cp.county_fips = b.county_fips
),
empower as (
    select
        b.prop_id,
        case
            when ez.zip_code is null then null
            when ez.power_dependent_devices_dme_suppressed then null
            when ez.medicare_benes is null or ez.medicare_benes = 0 then null
            else ez.power_dependent_devices_dme / ez.medicare_benes
        end as empower_rate,
        ez.source_id as empower_source_id,
        case
            when ez.zip_code is not null and not ez.power_dependent_devices_dme_suppressed
                 and ez.medicare_benes > 0 and ez.power_dependent_devices_dme is not null then null
            when (select count(*) from core.empower_zip) = 0 then 'empower_not_loaded'
            when ez.zip_code is null then 'zip_not_in_empower'
            when ez.power_dependent_devices_dme_suppressed then 'suppressed_1_to_10'
            else 'no_empower_figure'
        end as empower_null_reason
    from base b
    left join core.empower_zip ez on ez.zip_code = left(trim(b.situs_zip), 5)
),
acs as (
    select
        b.prop_id,
        case
            when a.geoid is null or a.pop_total is null or a.pop_total = 0 or a.pop_65_plus is null then null
            else a.pop_65_plus / a.pop_total
        end as acs_pct_65_plus,
        case
            when a.geoid is null or a.housing_units_total is null or a.housing_units_total = 0 or a.heating_electric is null then null
            else a.heating_electric / a.housing_units_total
        end as acs_pct_electric_heat,
        a.source_id as acs_source_id,
        case
            when a.geoid is not null and a.pop_total > 0 and a.pop_65_plus is not null then null
            when (select count(*) from core.acs_bg) = 0 then 'acs_not_loaded'
            when a.geoid is null then 'block_group_not_in_acs'
            else coalesce(a.pop_65_plus_null_reason, 'no_acs_figure')
        end as acs_65_null_reason,
        case
            when a.geoid is not null and a.housing_units_total > 0 and a.heating_electric is not null then null
            when (select count(*) from core.acs_bg) = 0 then 'acs_not_loaded'
            when a.geoid is null then 'block_group_not_in_acs'
            else coalesce(a.heating_electric_null_reason, 'no_acs_figure')
        end as acs_heat_null_reason
    from base b
    left join core.acs_bg a on a.geoid = b.block_group_geoid
),
bg_home_counts as (
    select block_group_geoid, count(*) as homes_gated
    from core.home_spatial
    group by block_group_geoid
),
permits_in_window as (
    select pm.permit_number, hs.block_group_geoid, hs.prop_id, pl.label, pm.source_id as permit_source_id
    from core.permits pm
    join core.permit_labels pl on pl.permit_number = pm.permit_number and pl.labeller = 'rules'
    join core.parcels p on p.geo_id = pm.tcad_id
    join core.home_spatial hs on hs.prop_id = p.prop_id
    where pm.issue_date >= current_date - interval '3 years'
),
bg_permit_counts as (
    select
        block_group_geoid,
        count(distinct permit_number) filter (where label = any (array['battery', 'generator'])) as backup_permits_count,
        count(distinct permit_number) as any_permits_count,
        -- Small aggregate (one row per block group, not per home) --
        -- distinct here is cheap and unrelated to the per-home cost this
        -- ticket targets.
        array_agg(distinct permit_source_id) as permit_source_ids
    from permits_in_window
    group by block_group_geoid
),
home_backup_permits as (
    select prop_id, count(distinct permit_number) as own_backup_permits
    from permits_in_window
    where label = any (array['battery', 'generator'])
    group by prop_id
),
permits_loaded as (
    select exists (select 1 from core.permit_labels where labeller = 'rules') as any_rules_labels
),
bg_backup as (
    select
        hc.prop_id,
        hc.block_group_geoid,
        case
            when hc.peer_homes <= 0 then null
            when pc.any_permits_count is null then null
            else greatest(0, pc.backup_permits_count - (case when hbp.own_backup_permits is null then 0 else hbp.own_backup_permits end))::numeric / hc.peer_homes * 1000
        end as backup_intent_rate,
        pc.permit_source_ids,
        case
            when hc.peer_homes <= 0 then 'no_peer_homes_in_block_group'
            when not pl.any_rules_labels then 'permits_not_loaded'
            when pc.any_permits_count is null then 'no_permit_coverage'
            else null
        end as backup_intent_null_reason
    from (
        select hs.prop_id, hs.block_group_geoid, bhc.homes_gated - 1 as peer_homes
        from core.home_spatial hs
        join bg_home_counts bhc on bhc.block_group_geoid = hs.block_group_geoid
    ) hc
    left join bg_permit_counts pc on pc.block_group_geoid = hc.block_group_geoid
    left join home_backup_permits hbp on hbp.prop_id = hc.prop_id
    cross join permits_loaded pl
),
-- Perf fix (coordinator): dropped the per-home `array_agg(distinct
-- pm.source_id) filter (...)` this CTE originally had. It is redundant
-- with `raw`'s own final `array(select distinct ...)` below, which
-- already dedups every source id (static + dynamic) once per home — an
-- inner per-home DISTINCT here just did that work twice, 1.2M times.
-- A real fix (a precomputed per-home permit-source aggregate populated
-- by the permits pipeline itself, not this spatial loader) is a
-- follow-up outside this ticket's owns paths; this keeps the residual
-- cost small (arrays here are un-deduped but tiny, typically 0-1
-- elements since one permits file load shares one source_id).
home_permit_agg as (
    select
        b.prop_id,
        b.block_group_geoid,
        bool_or(pl.label = 'solar') as has_solar,
        bool_or(pl.label = 'ev') as has_ev,
        bool_or(pl.label = 'generator') as has_generator,
        bool_or(pl.label = 'panel') as has_panel,
        bool_or(pl.label = 'battery') as has_battery,
        min(pm.issue_date) filter (where pl.label = 'battery') as battery_permit_date,
        array_agg(pm.source_id) filter (where pl.label is not null) as home_permit_source_ids
    from base b
    left join core.permits pm on pm.tcad_id = b.geo_id
    left join core.permit_labels pl on pl.permit_number = pm.permit_number and pl.labeller = 'rules'
    group by b.prop_id, b.block_group_geoid
),
home_permits as (
    select
        hpa.prop_id,
        case when bpc.any_permits_count is null then null else coalesce(hpa.has_solar, false) end as home_solar,
        case when bpc.any_permits_count is null then null else coalesce(hpa.has_ev, false) end as home_ev,
        case when bpc.any_permits_count is null then null else coalesce(hpa.has_generator, false) end as home_generator,
        case when bpc.any_permits_count is null then null else coalesce(hpa.has_panel, false) end as home_panel_upgrade,
        case when bpc.any_permits_count is null then null else coalesce(hpa.has_battery, false) end as home_battery,
        hpa.battery_permit_date,
        case when bpc.any_permits_count is null then 'no_permit_coverage' else null end as permit_null_reason,
        hpa.home_permit_source_ids
    from home_permit_agg hpa
    left join bg_permit_counts bpc on bpc.block_group_geoid = hpa.block_group_geoid
),
improvements as (
    select
        b.prop_id,
        pi.yr_built,
        pi.living_area,
        pi.source_id as improvements_source_id,
        case
            when pi.prop_id is null then
                case
                    when (select count(*) from core.parcel_improvements) = 0 then 'tcad_improvements_not_loaded'
                    else 'no_living_area_detail'
                end
            else null
        end as yr_built_null_reason
    from base b
    left join core.parcel_improvements pi on pi.prop_id = b.prop_id
),
owner65 as (
    select
        b.prop_id,
        case when b.ov65_exempt is null then null else b.ov65_exempt = 'T' end as owner_65_flag,
        case when b.ov65_exempt is null then 'exemption_data_missing' else null end as owner_65_null_reason
    from base b
),
raw as (
    select
        b.prop_id, b.geo_id, b.block_group_geoid, b.county_fips, b.situs_zip, b.market_value,
        b.gate_reason, b.territory_eia_id, b.territory_null_reason, b.territory_basis,
        r.distributor_saidi, r.distributor_saidi_year, r.distributor_saidi_early_release,
        r.distributor_name, r.distributor_saidi_null_reason,
        o.outage_minutes, o.outage_year, o.outage_basis, o.outage_source_ids, o.outage_null_reason,
        b.flood_flag, b.flood_null_reason,
        e.empower_rate, e.empower_null_reason,
        a.acs_pct_65_plus, a.acs_65_null_reason, a.acs_pct_electric_heat, a.acs_heat_null_reason,
        bb.backup_intent_rate, bb.backup_intent_null_reason,
        ow.owner_65_flag, ow.owner_65_null_reason,
        hp2.home_solar, hp2.home_ev, hp2.home_generator, hp2.home_panel_upgrade, hp2.home_battery,
        hp2.battery_permit_date, hp2.permit_null_reason,
        im.yr_built, im.living_area, im.yr_built_null_reason,
        case
            when hp2.permit_null_reason is not null then null
            else coalesce(hp2.home_solar, false) or coalesce(hp2.home_ev, false) or coalesce(hp2.home_generator, false)
        end as home_permits_flag,
        case
            when coalesce(hp2.home_panel_upgrade, false) then 1
            when im.yr_built is not null then case when im.yr_built >= 2000 then 1 else 0 end
            when hp2.permit_null_reason is null then 0
            else null
        end as installability_term,
        case
            when coalesce(hp2.home_panel_upgrade, false) or im.yr_built is not null then null
            when hp2.permit_null_reason is null then null
            when im.yr_built_null_reason is not null then 'no_permit_coverage_and_' || im.yr_built_null_reason
            else 'no_permit_coverage_and_year_built_not_loaded'
        end as installability_null_reason,
        -- Perf fix (M3-P6): only the genuinely dynamic source ids
        -- (reliability/acs/improvements rows, plus the small permit/
        -- outage arrays) are deduplicated per row here, once. Every
        -- static boundary source id (parcel/geom/bg/territory/
        -- crosswalk/flood) was already deduplicated once by the loader
        -- into home_spatial.boundary_source_ids -- never recomputed here.
        array(
            select distinct s.s
            from unnest(
                b.boundary_source_ids
                || array[r.reliability_source_id, a.acs_source_id, im.improvements_source_id]
                || coalesce(bb.permit_source_ids, array[]::uuid[])
                || coalesce(o.outage_source_ids, array[]::uuid[])
                || coalesce(hp2.home_permit_source_ids, array[]::uuid[])
            ) s(s)
            where s.s is not null
        ) as source_ids
    from base b
    left join reliability r on r.prop_id = b.prop_id
    left join outage o on o.prop_id = b.prop_id
    left join empower e on e.prop_id = b.prop_id
    left join acs a on a.prop_id = b.prop_id
    left join bg_backup bb on bb.prop_id = b.prop_id
    left join owner65 ow on ow.prop_id = b.prop_id
    left join home_permits hp2 on hp2.prop_id = b.prop_id
    left join improvements im on im.prop_id = b.prop_id
),
anchors as (
    select
        (select percentile_cont(0.9) within group (order by saidi_incl_major)
         from core.utility_reliability
         where year = (select max(year) from core.utility_reliability where saidi_incl_major is not null)
           and saidi_incl_major is not null) as outage_anchor,
        (select percentile_cont(0.9) within group (order by (power_dependent_devices_dme / medicare_benes))
         from core.empower_zip
         where not power_dependent_devices_dme_suppressed and medicare_benes > 0
           and power_dependent_devices_dme is not null) as empower_anchor,
        (select percentile_cont(0.9) within group (order by acs_pct_65_plus)
         from (select distinct block_group_geoid, acs_pct_65_plus from raw where acs_pct_65_plus is not null) t) as age65_anchor,
        (select percentile_cont(0.9) within group (order by backup_intent_rate)
         from raw where gate_reason is null and backup_intent_rate is not null) as backup_anchor,
        (select percentile_cont(0.1) within group (order by ln(market_value))
         from raw where gate_reason is null and market_value > 0) as home_value_anchor_low,
        (select percentile_cont(0.9) within group (order by ln(market_value))
         from raw where gate_reason is null and market_value > 0) as home_value_anchor_high
)
select
    raw.prop_id, raw.geo_id, raw.block_group_geoid, raw.county_fips, raw.situs_zip,
    raw.gate_reason, raw.territory_eia_id, raw.territory_null_reason, raw.territory_basis,
    raw.distributor_saidi, raw.distributor_saidi_year, raw.distributor_saidi_early_release,
    raw.distributor_name, raw.distributor_saidi_null_reason,
    -- DEPRECATED: percent_rank() removed (perf pass -- six sorts of
    -- ~1.2M rows was one of two remaining >5-min costs). Always null
    -- now; kept only so two live web tests and api.home_score_breakdown
    -- don't hit an unknown-column error. Follow-up ticket: update
    -- web/tests/m2-map/homes-ranked-weighted.test.ts and
    -- web/tests/m2/top-homes-route.test.ts (both assert on real
    -- percentile variance today), then drop the six columns for real.
    -- See checks/M3-P6.md's "Known risk carried forward" section.
    null::double precision as distributor_saidi_pctile,
    raw.outage_minutes, raw.outage_year, raw.outage_basis, raw.outage_source_ids, raw.outage_null_reason,
    case when raw.outage_minutes is not null and anchors.outage_anchor > 0
         then least(1.0, raw.outage_minutes::float8 / anchors.outage_anchor) else null end as outage_term,
    raw.flood_flag, raw.flood_null_reason,
    null::double precision as flood_pctile,
    case when raw.flood_flag is not null then case when raw.flood_flag then 0 else 1 end else null end as flood_term,
    raw.empower_rate, raw.empower_null_reason,
    null::double precision as empower_pctile,
    case when raw.empower_rate is not null and anchors.empower_anchor > 0
         then least(1.0, raw.empower_rate::float8 / anchors.empower_anchor) else null end as empower_term,
    raw.acs_pct_65_plus, raw.acs_65_null_reason,
    null::double precision as acs_65_pctile,
    case when raw.acs_pct_65_plus is not null and anchors.age65_anchor > 0
         then least(1.0, raw.acs_pct_65_plus::float8 / anchors.age65_anchor) else null end as age65_term,
    raw.acs_pct_electric_heat, raw.acs_heat_null_reason,
    null::double precision as acs_heat_pctile,
    raw.acs_pct_electric_heat as electric_heat_term,
    raw.backup_intent_rate, raw.backup_intent_null_reason,
    null::double precision as backup_intent_pctile,
    case when raw.backup_intent_rate is not null and anchors.backup_anchor > 0
         then least(1.0, raw.backup_intent_rate::float8 / anchors.backup_anchor) else null end as backup_intent_term,
    raw.market_value,
    case when raw.market_value > 0
         then least(1.0, greatest(0.0, (ln(raw.market_value)::float8 - anchors.home_value_anchor_low) / (anchors.home_value_anchor_high - anchors.home_value_anchor_low)))
         else null end as home_value_term,
    case when raw.market_value > 0 then null else 'market_value_not_loaded' end as home_value_null_reason,
    raw.owner_65_flag as owner_65, raw.owner_65_null_reason,
    raw.home_solar, raw.home_ev, raw.home_generator, raw.home_panel_upgrade, raw.home_battery,
    raw.battery_permit_date, raw.permit_null_reason, raw.home_permits_flag,
    raw.yr_built, raw.living_area, raw.yr_built_null_reason,
    raw.installability_term, raw.installability_null_reason,
    raw.source_ids
from raw
cross join anchors;

create unique index mv_home_signals_v2_prop_id_idx on core.mv_home_signals_v2 (prop_id);
create index mv_home_signals_v2_gate_reason_idx on core.mv_home_signals_v2 (gate_reason) where gate_reason is null;
create index mv_home_signals_v2_county_fips_idx on core.mv_home_signals_v2 (county_fips);
create index mv_home_signals_v2_bg_geoid_idx on core.mv_home_signals_v2 (block_group_geoid);
create index mv_home_signals_v2_county_gated_idx on core.mv_home_signals_v2 (county_fips, prop_id) where gate_reason is null;
create index mv_home_signals_v2_county_territory_idx on core.mv_home_signals_v2 (county_fips, territory_eia_id);
create index mv_home_signals_v2_territory_idx on core.mv_home_signals_v2 (territory_eia_id);

analyze core.mv_home_signals_v2;

-- ---------------------------------------------------------------------------
-- core.mv_gate_counts_v2 / core.mv_parcel_gate_counts_v2 /
-- core.mv_gate_counts_by_market_v2 — same shape as the live versions,
-- + county_fips (the current live mv_parcel_gate_counts has a
-- `singleton` unique index -- one row total, no per-county split; v2
-- replaces that with one row per county).
-- ---------------------------------------------------------------------------
create materialized view core.mv_gate_counts_v2 as
with homes as (
    select s.prop_id, s.county_fips, s.source_ids,
           coalesce(s.gate_reason, s.territory_null_reason, 'passed') as reason
    from core.mv_home_signals_v2 s
    join core.parcels p on p.prop_id = s.prop_id
    where s.county_fips = p.county_fips
),
counts as (
    select county_fips, reason, count(distinct prop_id) as home_count
    from homes
    group by county_fips, reason
),
srcs as (
    select county_fips, reason, array_agg(distinct src.src) as source_ids
    from homes
    cross join lateral unnest(homes.source_ids) src(src)
    group by county_fips, reason
)
select c.county_fips, c.reason, c.home_count, coalesce(sr.source_ids, array[]::uuid[]) as source_ids
from counts c
left join srcs sr on sr.county_fips = c.county_fips and sr.reason = c.reason;

create unique index mv_gate_counts_v2_county_reason_idx on core.mv_gate_counts_v2 (county_fips, reason);

create materialized view core.mv_parcel_gate_counts_v2 as
select
    county_fips,
    count(*) as total_parcels,
    count(*) filter (where imprv_state_cd like 'A1%' or land_state_cd like 'A1%') as single_family_count,
    count(*) filter (where not (coalesce(imprv_state_cd, '') like 'A1%' or coalesce(land_state_cd, '') like 'A1%')) as not_single_family_count,
    count(*) filter (where hs_exempt = 'T') as homestead_count,
    count(*) filter (where hs_exempt is distinct from 'T') as not_homestead_count,
    array_agg(distinct source_id) filter (where source_id is not null) as source_ids
from core.parcels
group by county_fips
having count(*) > 0;

create unique index mv_parcel_gate_counts_v2_county_idx on core.mv_parcel_gate_counts_v2 (county_fips);

create materialized view core.mv_gate_counts_by_market_v2 as
with homes as (
    select s.prop_id, s.county_fips, s.source_ids,
           coalesce(s.gate_reason, s.territory_null_reason, 'passed') as reason,
           s.territory_eia_id
    from core.mv_home_signals_v2 s
    join core.parcels p on p.prop_id = s.prop_id
    where s.county_fips = p.county_fips
),
joined as (
    select
        h.prop_id, h.county_fips, h.reason, h.source_ids,
        case
            when (select count(*) from core.retail_market) = 0 then 'retail_market_not_loaded'
            when h.territory_eia_id is null then 'no_territory_match'
            when rm.retail_market is null then 'utility_not_in_retail_market_file'
            else rm.retail_market
        end as market
    from homes h
    left join core.retail_market rm on rm.eia_utility_number = h.territory_eia_id
),
counts as (
    select county_fips, market, reason, count(distinct prop_id) as home_count
    from joined
    group by county_fips, market, reason
),
srcs as (
    select county_fips, market, reason, array_agg(distinct src.src) as source_ids
    from joined
    cross join lateral unnest(joined.source_ids) src(src)
    group by county_fips, market, reason
)
select c.county_fips, c.market, c.reason, c.home_count, coalesce(sr.source_ids, array[]::uuid[]) as source_ids
from counts c
left join srcs sr on sr.county_fips = c.county_fips and sr.market = c.market and sr.reason = c.reason;

create unique index mv_gate_counts_by_market_v2_idx on core.mv_gate_counts_by_market_v2 (county_fips, market, reason);

analyze core.mv_gate_counts_v2;
analyze core.mv_parcel_gate_counts_v2;
analyze core.mv_gate_counts_by_market_v2;

-- ---------------------------------------------------------------------------
-- core.mv_home_terms (new) — one row per gated home with every anchored
-- term the four weighted scoring functions need, so scoring a large
-- county doesn't redo the acs_income_age_bg/home_coverage/
-- permit_path_stats/signal_anchors joins on every request.
-- ---------------------------------------------------------------------------
create materialized view core.mv_home_terms as
with anc_one as materialized (
    select max(anchor_value) filter (where signal_key = 'income_100k') as inc_anchor,
           max(anchor_value) filter (where signal_key = 'age_35_64')  as age_anchor
    from core.signal_anchors
),
stats as materialized (
    select st.median_days, st.p90_days, st.share_never_finished
    from (values (1)) one(x)
    left join lateral (
        select median_days, p90_days, share_never_finished
        from core.permit_path_stats
        where jurisdiction = 'ALL' and label = 'battery' and period_type = 'quarter'
        order by period desc limit 1
    ) st on true
)
select
    s.prop_id,
    s.county_fips,
    s.block_group_geoid,
    p.situs_city,
    s.situs_zip,
    s.backup_intent_rate,
    s.outage_term::float8 as outage_term,
    s.flood_term::float8 as flood_term,
    s.empower_term::float8 as empower_term,
    s.age65_term::float8 as age65_term,
    s.electric_heat_term::float8 as electric_heat_term,
    s.backup_intent_term::float8 as backup_intent_term,
    s.owner_65::int::float8 as owner65_term,
    s.home_permits_flag::int::float8 as permits_term,
    s.installability_term::float8 as installability_term,
    s.home_value_term::float8 as home_value_term,
    least(1, ia.income_100k_share / nullif(anc_one.inc_anchor, 0))::float8 as income100k_term,
    least(1, ia.age_35_64_share / nullif(anc_one.age_anchor, 0))::float8 as age3564_term,
    (case
        when s.territory_eia_id = '1015' then 'city_battery_permit'
        when s.territory_eia_id is not null then 'state_rules_only'
        else null
    end) as permit_path,
    (case
        when s.territory_eia_id = '1015' and stats.median_days is not null then
            1 - least(1, greatest(0,
                0.5 * least(1, stats.median_days::float8 / greatest(stats.p90_days, 1)::float8)
                + 0.5 * stats.share_never_finished::float8
            ))
        when s.territory_eia_id is not null and s.territory_eia_id != '1015' then 1.0
        else null
    end) as permitrisk_term,
    coalesce(hc.bucket, 'prospect') as coverage_bucket
from core.mv_home_signals_v2 s
join core.parcels p on p.prop_id = s.prop_id
left join core.acs_income_age_bg ia on ia.geoid = s.block_group_geoid
cross join anc_one
cross join stats
left join core.home_coverage hc on hc.prop_id = s.prop_id
where s.gate_reason is null;

create unique index mv_home_terms_prop_id_idx on core.mv_home_terms (prop_id);
create index mv_home_terms_county_prop_idx on core.mv_home_terms (county_fips, prop_id);
create index mv_home_terms_county_bg_idx on core.mv_home_terms (county_fips, block_group_geoid);

analyze core.mv_home_terms;

-- ---------------------------------------------------------------------------
-- core.mv_home_geo_rollup (new) — drill-down rollup for predicted mode.
-- ---------------------------------------------------------------------------
create materialized view core.mv_home_geo_rollup as
select
    s.county_fips,
    p.situs_city,
    p.situs_zip,
    s.block_group_geoid,
    count(*) as home_count,
    avg(hp.p_install_12m) as avg_p,
    max(hp.p_install_12m) as max_p,
    count(*) filter (where hp.decile = 1) as top10_count
from core.mv_home_signals_v2 s
join core.parcels p on p.prop_id = s.prop_id
left join core.home_propensity hp on hp.prop_id = s.prop_id
where s.gate_reason is null
group by s.county_fips, p.situs_city, p.situs_zip, s.block_group_geoid;

create unique index mv_home_geo_rollup_tuple_idx
    on core.mv_home_geo_rollup (county_fips, situs_city, situs_zip, block_group_geoid);

analyze core.mv_home_geo_rollup;

-- ---------------------------------------------------------------------------
-- core.home_propensity.county_fips — new column, backfilled here (once,
-- against mv_home_signals_v2, before the swap so it's ready the moment
-- api.home_propensity repoints to read it directly instead of joining
-- core.mv_home_signals just for the county filter).
-- ---------------------------------------------------------------------------
alter table core.home_propensity add column if not exists county_fips text;

update core.home_propensity hp
set county_fips = s.county_fips
from core.mv_home_signals_v2 s
where s.prop_id = hp.prop_id
  and hp.county_fips is distinct from s.county_fips;

create index if not exists home_propensity_county_p_idx
    on core.home_propensity (county_fips, p_install_12m desc, prop_id);

-- ---------------------------------------------------------------------------
-- Swap. Lesson 6: any matview built with `... from core.mv_home_signals`
-- stays bound to the OLD object after a rename-swap, so every matview
-- that reads it is dropped and recreated here (not just renamed), then
-- the api views on top of THOSE are dropped and recreated too.
-- ---------------------------------------------------------------------------
drop view if exists api.gate_counts;
drop view if exists api.parcel_gate_counts;
drop view if exists api.gate_counts_by_market;
drop view if exists api.home_propensity;

alter materialized view core.mv_home_signals rename to mv_home_signals_pre_m3p6;
alter materialized view core.mv_home_signals_v2 rename to mv_home_signals;

alter index core.mv_home_signals_v2_prop_id_idx rename to mv_home_signals_prop_id_idx_m3p6;
alter index core.mv_home_signals_v2_gate_reason_idx rename to mv_home_signals_gate_reason_idx_m3p6;
alter index core.mv_home_signals_v2_county_fips_idx rename to mv_home_signals_county_fips_idx_m3p6;
alter index core.mv_home_signals_v2_bg_geoid_idx rename to mv_home_signals_bg_geoid_idx_m3p6;
alter index core.mv_home_signals_v2_county_gated_idx rename to mv_home_signals_county_gated_idx_m3p6;
alter index core.mv_home_signals_v2_county_territory_idx rename to mv_home_signals_county_territory_idx_m3p6;
alter index core.mv_home_signals_v2_territory_idx rename to mv_home_signals_territory_idx_m3p6;

drop materialized view if exists core.mv_gate_counts;
drop materialized view if exists core.mv_parcel_gate_counts;
drop materialized view if exists core.mv_gate_counts_by_market;

alter materialized view core.mv_gate_counts_v2 rename to mv_gate_counts;
alter index core.mv_gate_counts_v2_county_reason_idx rename to mv_gate_counts_county_reason_idx_m3p6;

alter materialized view core.mv_parcel_gate_counts_v2 rename to mv_parcel_gate_counts;
alter index core.mv_parcel_gate_counts_v2_county_idx rename to mv_parcel_gate_counts_county_idx_m3p6;

alter materialized view core.mv_gate_counts_by_market_v2 rename to mv_gate_counts_by_market;
alter index core.mv_gate_counts_by_market_v2_idx rename to mv_gate_counts_by_market_idx_m3p6;

create materialized view core.mv_county_territories as
select county_fips, territory_eia_id, count(*) as homes
from core.mv_home_signals
where territory_eia_id is not null
group by county_fips, territory_eia_id;

create unique index mv_county_territories_idx on core.mv_county_territories (county_fips, territory_eia_id);

analyze core.mv_home_signals;
analyze core.mv_gate_counts;
analyze core.mv_parcel_gate_counts;
analyze core.mv_gate_counts_by_market;
analyze core.mv_county_territories;

grant select on
    core.mv_home_signals, core.mv_gate_counts, core.mv_parcel_gate_counts,
    core.mv_gate_counts_by_market, core.mv_home_terms, core.mv_home_geo_rollup,
    core.mv_county_territories
to zeus_web_ro;

-- ---------------------------------------------------------------------------
-- api.* views. county_fips appended as a new trailing column on the
-- three gate-count views so every existing consumer
-- (select reason, home_count, source_ids ...) keeps working unchanged.
-- ---------------------------------------------------------------------------
create view api.gate_counts as
    select reason, home_count, source_ids, county_fips from core.mv_gate_counts;

create view api.parcel_gate_counts as
    select total_parcels, single_family_count, not_single_family_count,
           homestead_count, not_homestead_count, source_ids, county_fips
    from core.mv_parcel_gate_counts;

create view api.gate_counts_by_market as
    select market, reason, home_count, source_ids, county_fips from core.mv_gate_counts_by_market;

-- api.home_propensity — same column list/order/types; now reads
-- core.home_propensity.county_fips directly (backfilled above), no join.
create view api.home_propensity as
    select hp.prop_id, hp.county_fips, hp.p_install_12m, hp.relative_to_county, hp.decile,
           hp.reasons, hp.extrapolated_from, hp.model_version, hp.trained_through, hp.source_ids
    from core.home_propensity hp;

create view api.home_geo_rollup as
    select county_fips, situs_city, situs_zip, block_group_geoid, home_count, avg_p, max_p, top10_count
    from core.mv_home_geo_rollup;

create view api.county_territories as
    select county_fips, territory_eia_id, homes from core.mv_county_territories;

-- Williamson homes are never 'passed' (utility withheld, not confirmed)
-- but ARE ranked/predicted, so the county switcher must still see them.
create view api.loaded_counties as
    select county_fips, sum(home_count) as homes_scored
    from core.mv_gate_counts
    where reason in ('passed', 'utility_not_confirmed')
    group by county_fips;

grant select on
    api.gate_counts, api.parcel_gate_counts, api.gate_counts_by_market,
    api.home_propensity, api.home_geo_rollup, api.county_territories, api.loaded_counties
to zeus_web_ro;

-- ---------------------------------------------------------------------------
-- Repoint the four weighted-scoring functions at core.mv_home_terms (the
-- term computation now happens once per refresh, not once per request).
-- Lesson 7: CREATE OR REPLACE with a different argument list makes an
-- overload, it doesn't replace -- drop each function's CURRENT LIVE
-- signature (verified via pg_catalog against the real DB this session)
-- before creating the extended one. api.top_homes_weighted and
-- api.home_score_breakdown keep their current signatures unchanged, so
-- plain CREATE OR REPLACE is safe for those two.
-- ---------------------------------------------------------------------------
drop function if exists api.homes_ranked_weighted(jsonb, text, text, numeric, text, integer, boolean);
drop function if exists api.homes_ranked_weighted_count(jsonb, text, text, boolean);
drop function if exists api.blockgroup_scores_weighted(jsonb, text, boolean);

create or replace function api.top_homes_weighted(weights jsonb, p_county_fips text default null, p_exclude_backup boolean default true)
returns table(prop_id text, geo_id text, situs_num text, situs_street text, situs_city text, situs_zip text, market_value numeric, block_group_geoid text, county_fips text, score numeric, reasons text[], territory_eia_id text, distributor_name text, distributor_saidi numeric, distributor_saidi_year integer, distributor_saidi_early_release boolean, flood_flag boolean, empower_rate numeric, acs_pct_65_plus numeric, acs_pct_electric_heat numeric, backup_intent_rate numeric, source_ids uuid[], owner_65 boolean, home_solar boolean, home_ev boolean, home_generator boolean, home_panel_upgrade boolean, home_battery boolean, home_battery_permit_date date, permit_null_reason text, yr_built integer, living_area numeric, outage_minutes numeric, outage_year integer, outage_basis text, outage_source_ids uuid[], home_value_term numeric, installability_term numeric, income_100k_share numeric, age_35_64_share numeric, permit_path text, permit_risk_term numeric)
language sql
stable parallel safe
as $function$
    with w as materialized (
        select
            (case when weights ? 'outage'        then (weights ->> 'outage')::float8        else 0 end) as w_outage,
            (case when weights ? 'flood'          then (weights ->> 'flood')::float8          else 0 end) as w_flood,
            (case when weights ? 'empower'        then (weights ->> 'empower')::float8          else 0 end) as w_empower,
            (case when weights ? 'age65'          then (weights ->> 'age65')::float8          else 0 end) as w_age65,
            (case when weights ? 'electric_heat'  then (weights ->> 'electric_heat')::float8  else 0 end) as w_heat,
            (case when weights ? 'backup_intent'  then (weights ->> 'backup_intent')::float8  else 0 end) as w_backup,
            (case when weights ? 'owner_65'       then (weights ->> 'owner_65')::float8       else 0 end) as w_owner65,
            (case when weights ? 'home_permits'   then (weights ->> 'home_permits')::float8   else 0 end) as w_permits,
            (case when weights ? 'installability' then (weights ->> 'installability')::float8 else 0 end) as w_install,
            (case when weights ? 'home_value'     then (weights ->> 'home_value')::float8     else 0 end) as w_homevalue,
            (case when weights ? 'income_100k'    then (weights ->> 'income_100k')::float8    else 0 end) as w_income100k,
            (case when weights ? 'age_35_64'      then (weights ->> 'age_35_64')::float8      else 0 end) as w_age3564,
            (case when weights ? 'permit_risk'    then (weights ->> 'permit_risk')::float8    else 0 end) as w_permitrisk
    ),
    medians as (
        select county_fips, jsonb_object_agg(signal_key, median) as med from core.signal_medians group by county_fips
    ),
    narrow as (
        select
            t.prop_id, t.backup_intent_rate,
            t.outage_term, t.flood_term, t.empower_term, t.age65_term, t.electric_heat_term,
            t.backup_intent_term, t.owner65_term, t.permits_term, t.installability_term, t.home_value_term,
            t.income100k_term, t.age3564_term, t.permitrisk_term
        from core.mv_home_terms t
        where t.county_fips = coalesce(p_county_fips, '48453')
          and (not p_exclude_backup or t.coverage_bucket not in ('base_customer', 'other_backup'))
    ),
    scored as materialized (
        select
            n.prop_id,
            n.backup_intent_rate,
            (
                case when n.outage_term is not null then w.w_outage * n.outage_term else 0 end
                + case when n.flood_term is not null then w.w_flood * n.flood_term else 0 end
                + case when n.empower_term is not null then w.w_empower * n.empower_term else 0 end
                + case when n.age65_term is not null then w.w_age65 * n.age65_term else 0 end
                + case when n.electric_heat_term is not null then w.w_heat * n.electric_heat_term else 0 end
                + case when n.backup_intent_term is not null then w.w_backup * n.backup_intent_term else 0 end
                + case when n.owner65_term is not null then w.w_owner65 * n.owner65_term else 0 end
                + case when n.permits_term is not null then w.w_permits * n.permits_term else 0 end
                + case when n.installability_term is not null then w.w_install * n.installability_term else 0 end
                + case when n.home_value_term is not null then w.w_homevalue * n.home_value_term else 0 end
                + case when n.income100k_term is not null then w.w_income100k * n.income100k_term else 0 end
                + case when n.age3564_term is not null then w.w_age3564 * n.age3564_term else 0 end
                + case when n.permitrisk_term is not null then w.w_permitrisk * n.permitrisk_term else 0 end
            ) as weighted_sum,
            (
                (case when n.outage_term is not null then w.w_outage else 0 end)
                + (case when n.flood_term is not null then w.w_flood else 0 end)
                + (case when n.empower_term is not null then w.w_empower else 0 end)
                + (case when n.age65_term is not null then w.w_age65 else 0 end)
                + (case when n.electric_heat_term is not null then w.w_heat else 0 end)
                + (case when n.backup_intent_term is not null then w.w_backup else 0 end)
                + (case when n.owner65_term is not null then w.w_owner65 else 0 end)
                + (case when n.permits_term is not null then w.w_permits else 0 end)
                + (case when n.installability_term is not null then w.w_install else 0 end)
                + (case when n.home_value_term is not null then w.w_homevalue else 0 end)
                + (case when n.income100k_term is not null then w.w_income100k else 0 end)
                + (case when n.age3564_term is not null then w.w_age3564 else 0 end)
                + (case when n.permitrisk_term is not null then w.w_permitrisk else 0 end)
            ) as weight_sum
        from narrow n
        cross join w
    ),
    ranked as materialized (
        select scored.prop_id, scored.backup_intent_rate, (scored.weighted_sum / scored.weight_sum)::numeric as final_score
        from scored
        where scored.weight_sum > 0
        order by final_score desc, scored.backup_intent_rate desc nulls last, scored.prop_id
        limit 50
    )
    select
        r.prop_id, p.geo_id, p.situs_num, p.situs_street, p.situs_city, p.situs_zip, p.market_value,
        s.block_group_geoid, s.county_fips, r.final_score as score,
        (
            select array_agg(c.label order by c.contrib desc, c.home_level desc)
            from (
                select label, contrib, home_level
                from (values
                    ('outage',        case when s.outage_term is not null
                                          then (select w_outage from w) * (s.outage_term - (case when (md.med->>'outage') is null then 0 else (md.med->>'outage')::numeric end)) end, true),
                    ('empower',       case when s.empower_term is not null
                                          then (select w_empower from w) * (s.empower_term - (case when (md.med->>'empower') is null then 0 else (md.med->>'empower')::numeric end)) end, false),
                    ('age65',         case when s.age65_term is not null
                                          then (select w_age65 from w) * (s.age65_term - (case when (md.med->>'age65') is null then 0 else (md.med->>'age65')::numeric end)) end, false),
                    ('electric_heat', case when s.electric_heat_term is not null
                                          then (select w_heat from w) * (s.electric_heat_term - (case when (md.med->>'electric_heat') is null then 0 else (md.med->>'electric_heat')::numeric end)) end, false),
                    ('backup_intent', case when s.backup_intent_term is not null
                                          then (select w_backup from w) * (s.backup_intent_term - (case when (md.med->>'backup_intent') is null then 0 else (md.med->>'backup_intent')::numeric end)) end, true),
                    ('owner_65',      case when s.owner_65 is not null
                                          then (select w_owner65 from w) * (s.owner_65::int::numeric - (case when (md.med->>'owner_65') is null then 0 else (md.med->>'owner_65')::numeric end)) end, true),
                    ('home_permits',  case when s.home_permits_flag is not null
                                          then (select w_permits from w) * (s.home_permits_flag::int::numeric - (case when (md.med->>'home_permits') is null then 0 else (md.med->>'home_permits')::numeric end)) end, true),
                    ('installability', case when s.installability_term is not null
                                          then (select w_install from w) * (s.installability_term - (case when (md.med->>'installability') is null then 0 else (md.med->>'installability')::numeric end)) end, true),
                    ('home_value',    case when s.home_value_term is not null
                                          then (select w_homevalue from w) * (s.home_value_term - (case when (md.med->>'home_value') is null then 0 else (md.med->>'home_value')::numeric end)) end, true)
                ) as t(label, contrib, home_level)
                where contrib is not null and contrib > 0
                order by contrib desc, home_level desc
                limit 3
            ) c
        ) as reasons,
        s.territory_eia_id, s.distributor_name, s.distributor_saidi, s.distributor_saidi_year, s.distributor_saidi_early_release,
        s.flood_flag, s.empower_rate, s.acs_pct_65_plus, s.acs_pct_electric_heat, s.backup_intent_rate, s.source_ids,
        s.owner_65, s.home_solar, s.home_ev, s.home_generator, s.home_panel_upgrade, s.home_battery,
        s.battery_permit_date, s.permit_null_reason, s.yr_built, s.living_area,
        s.outage_minutes, s.outage_year, s.outage_basis, s.outage_source_ids,
        s.home_value_term, s.installability_term,
        ia.income_100k_share, ia.age_35_64_share,
        t.permit_path, t.permitrisk_term as permit_risk_term
    from ranked r
    join core.mv_home_terms t on t.prop_id = r.prop_id
    join core.mv_home_signals s on s.prop_id = r.prop_id
    join core.parcels p on p.prop_id = r.prop_id
    left join core.acs_income_age_bg ia on ia.geoid = s.block_group_geoid
    left join medians md on md.county_fips = s.county_fips
    cross join w
    order by r.final_score desc, r.backup_intent_rate desc nulls last, r.prop_id;
$function$;

create or replace function api.homes_ranked_weighted(weights jsonb, p_county_fips text default null, p_block_group_geoid text default null, after_score numeric default null, after_prop_id text default null, page_size integer default 50, p_exclude_backup boolean default true, p_situs_city text default null, p_situs_zip text default null)
returns table(prop_id text, geo_id text, situs_num text, situs_street text, situs_city text, situs_zip text, market_value numeric, block_group_geoid text, county_fips text, score numeric, reasons text[], territory_eia_id text, distributor_name text, distributor_saidi numeric, distributor_saidi_year integer, distributor_saidi_early_release boolean, flood_flag boolean, empower_rate numeric, acs_pct_65_plus numeric, acs_pct_electric_heat numeric, backup_intent_rate numeric, source_ids uuid[], lon double precision, lat double precision, owner_65 boolean, home_solar boolean, home_ev boolean, home_generator boolean, home_panel_upgrade boolean, home_battery boolean, home_battery_permit_date date, permit_null_reason text, yr_built integer, living_area numeric, outage_minutes numeric, outage_year integer, outage_basis text, outage_source_ids uuid[], home_value_term numeric, installability_term numeric, income_100k_share numeric, age_35_64_share numeric, permit_path text, permit_risk_term numeric)
language sql
stable parallel safe
as $function$
    with w as materialized (
        select
            (case when weights ? 'outage'        then (weights ->> 'outage')::float8        else 0 end) as w_outage,
            (case when weights ? 'flood'          then (weights ->> 'flood')::float8          else 0 end) as w_flood,
            (case when weights ? 'empower'        then (weights ->> 'empower')::float8          else 0 end) as w_empower,
            (case when weights ? 'age65'          then (weights ->> 'age65')::float8          else 0 end) as w_age65,
            (case when weights ? 'electric_heat'  then (weights ->> 'electric_heat')::float8  else 0 end) as w_heat,
            (case when weights ? 'backup_intent'  then (weights ->> 'backup_intent')::float8  else 0 end) as w_backup,
            (case when weights ? 'owner_65'       then (weights ->> 'owner_65')::float8       else 0 end) as w_owner65,
            (case when weights ? 'home_permits'   then (weights ->> 'home_permits')::float8   else 0 end) as w_permits,
            (case when weights ? 'installability' then (weights ->> 'installability')::float8 else 0 end) as w_install,
            (case when weights ? 'home_value'     then (weights ->> 'home_value')::float8     else 0 end) as w_homevalue,
            (case when weights ? 'income_100k'    then (weights ->> 'income_100k')::float8    else 0 end) as w_income100k,
            (case when weights ? 'age_35_64'      then (weights ->> 'age_35_64')::float8      else 0 end) as w_age3564,
            (case when weights ? 'permit_risk'    then (weights ->> 'permit_risk')::float8    else 0 end) as w_permitrisk
    ),
    medians as (
        select county_fips, jsonb_object_agg(signal_key, median) as med from core.signal_medians group by county_fips
    ),
    narrow as (
        select
            t.prop_id, t.backup_intent_rate,
            t.outage_term, t.flood_term, t.empower_term, t.age65_term, t.electric_heat_term,
            t.backup_intent_term, t.owner65_term, t.permits_term, t.installability_term, t.home_value_term,
            t.income100k_term, t.age3564_term, t.permitrisk_term
        from core.mv_home_terms t
        where t.county_fips = coalesce(p_county_fips, '48453')
          and (p_block_group_geoid is null or t.block_group_geoid = p_block_group_geoid)
          -- Lesson 8 applies to t.county_fips above (the indexed
          -- leading column: `= coalesce(p_county_fips, '48453')`, never
          -- `param is null or col = param`). situs_city/situs_zip are
          -- not index columns here, so the plain
          -- `coalesce(col, '') = param` form (same as the live 0218
          -- functions) is kept as-is.
          and (p_situs_city is null or coalesce(t.situs_city, '') = p_situs_city)
          and (p_situs_zip is null or coalesce(t.situs_zip, '') = p_situs_zip)
          and (not p_exclude_backup or t.coverage_bucket not in ('base_customer', 'other_backup'))
    ),
    scored as materialized (
        select
            n.prop_id,
            n.backup_intent_rate,
            (
                case when n.outage_term is not null then w.w_outage * n.outage_term else 0 end
                + case when n.flood_term is not null then w.w_flood * n.flood_term else 0 end
                + case when n.empower_term is not null then w.w_empower * n.empower_term else 0 end
                + case when n.age65_term is not null then w.w_age65 * n.age65_term else 0 end
                + case when n.electric_heat_term is not null then w.w_heat * n.electric_heat_term else 0 end
                + case when n.backup_intent_term is not null then w.w_backup * n.backup_intent_term else 0 end
                + case when n.owner65_term is not null then w.w_owner65 * n.owner65_term else 0 end
                + case when n.permits_term is not null then w.w_permits * n.permits_term else 0 end
                + case when n.installability_term is not null then w.w_install * n.installability_term else 0 end
                + case when n.home_value_term is not null then w.w_homevalue * n.home_value_term else 0 end
                + case when n.income100k_term is not null then w.w_income100k * n.income100k_term else 0 end
                + case when n.age3564_term is not null then w.w_age3564 * n.age3564_term else 0 end
                + case when n.permitrisk_term is not null then w.w_permitrisk * n.permitrisk_term else 0 end
            ) as weighted_sum,
            (
                (case when n.outage_term is not null then w.w_outage else 0 end)
                + (case when n.flood_term is not null then w.w_flood else 0 end)
                + (case when n.empower_term is not null then w.w_empower else 0 end)
                + (case when n.age65_term is not null then w.w_age65 else 0 end)
                + (case when n.electric_heat_term is not null then w.w_heat else 0 end)
                + (case when n.backup_intent_term is not null then w.w_backup else 0 end)
                + (case when n.owner65_term is not null then w.w_owner65 else 0 end)
                + (case when n.permits_term is not null then w.w_permits else 0 end)
                + (case when n.installability_term is not null then w.w_install else 0 end)
                + (case when n.home_value_term is not null then w.w_homevalue else 0 end)
                + (case when n.income100k_term is not null then w.w_income100k else 0 end)
                + (case when n.age3564_term is not null then w.w_age3564 else 0 end)
                + (case when n.permitrisk_term is not null then w.w_permitrisk else 0 end)
            ) as weight_sum
        from narrow n
        cross join w
    ),
    ranked as materialized (
        select scored.prop_id, scored.backup_intent_rate, (scored.weighted_sum / scored.weight_sum)::numeric as final_score
        from scored
        where scored.weight_sum > 0
    ),
    page as (
        select r.prop_id, r.backup_intent_rate, r.final_score
        from ranked r
        where after_score is null
           or r.final_score < after_score
           or (r.final_score = after_score and r.prop_id > after_prop_id)
        order by r.final_score desc, r.prop_id
        limit page_size
    )
    select
        p.prop_id, pc.geo_id, pc.situs_num, pc.situs_street, pc.situs_city, pc.situs_zip, pc.market_value,
        s.block_group_geoid, s.county_fips, p.final_score as score,
        (
            select array_agg(c.label order by c.contrib desc, c.home_level desc)
            from (
                select label, contrib, home_level
                from (values
                    ('outage',        case when s.outage_term is not null
                                          then (select w_outage from w) * (s.outage_term - (case when (md.med->>'outage') is null then 0 else (md.med->>'outage')::numeric end)) end, true),
                    ('empower',       case when s.empower_term is not null
                                          then (select w_empower from w) * (s.empower_term - (case when (md.med->>'empower') is null then 0 else (md.med->>'empower')::numeric end)) end, false),
                    ('age65',         case when s.age65_term is not null
                                          then (select w_age65 from w) * (s.age65_term - (case when (md.med->>'age65') is null then 0 else (md.med->>'age65')::numeric end)) end, false),
                    ('electric_heat', case when s.electric_heat_term is not null
                                          then (select w_heat from w) * (s.electric_heat_term - (case when (md.med->>'electric_heat') is null then 0 else (md.med->>'electric_heat')::numeric end)) end, false),
                    ('backup_intent', case when s.backup_intent_term is not null
                                          then (select w_backup from w) * (s.backup_intent_term - (case when (md.med->>'backup_intent') is null then 0 else (md.med->>'backup_intent')::numeric end)) end, true),
                    ('owner_65',      case when s.owner_65 is not null
                                          then (select w_owner65 from w) * (s.owner_65::int::numeric - (case when (md.med->>'owner_65') is null then 0 else (md.med->>'owner_65')::numeric end)) end, true),
                    ('home_permits',  case when s.home_permits_flag is not null
                                          then (select w_permits from w) * (s.home_permits_flag::int::numeric - (case when (md.med->>'home_permits') is null then 0 else (md.med->>'home_permits')::numeric end)) end, true),
                    ('installability', case when s.installability_term is not null
                                          then (select w_install from w) * (s.installability_term - (case when (md.med->>'installability') is null then 0 else (md.med->>'installability')::numeric end)) end, true),
                    ('home_value',    case when s.home_value_term is not null
                                          then (select w_homevalue from w) * (s.home_value_term - (case when (md.med->>'home_value') is null then 0 else (md.med->>'home_value')::numeric end)) end, true)
                ) as t(label, contrib, home_level)
                where contrib is not null and contrib > 0
                order by contrib desc, home_level desc
                limit 3
            ) c
        ) as reasons,
        s.territory_eia_id, s.distributor_name, s.distributor_saidi, s.distributor_saidi_year, s.distributor_saidi_early_release,
        s.flood_flag, s.empower_rate, s.acs_pct_65_plus, s.acs_pct_electric_heat, s.backup_intent_rate, s.source_ids,
        extensions.ST_X(pg.centroid) as lon, extensions.ST_Y(pg.centroid) as lat,
        s.owner_65, s.home_solar, s.home_ev, s.home_generator, s.home_panel_upgrade, s.home_battery,
        s.battery_permit_date, s.permit_null_reason, s.yr_built, s.living_area,
        s.outage_minutes, s.outage_year, s.outage_basis, s.outage_source_ids,
        s.home_value_term, s.installability_term,
        ia.income_100k_share, ia.age_35_64_share,
        t.permit_path, t.permitrisk_term as permit_risk_term
    from page p
    join core.mv_home_terms t on t.prop_id = p.prop_id
    join core.mv_home_signals s on s.prop_id = p.prop_id
    join core.parcels pc on pc.prop_id = p.prop_id
    left join core.parcel_geoms pg on pg.prop_id = p.prop_id
    left join core.acs_income_age_bg ia on ia.geoid = s.block_group_geoid
    left join medians md on md.county_fips = s.county_fips
    cross join w
    order by p.final_score desc, p.prop_id;
$function$;

create or replace function api.homes_ranked_weighted_count(weights jsonb, p_county_fips text default null, p_block_group_geoid text default null, p_exclude_backup boolean default true, p_situs_city text default null, p_situs_zip text default null)
returns bigint
language sql
stable parallel safe
as $function$
    with w as materialized (
        select
            (case when weights ? 'outage'        then (weights ->> 'outage')::float8        else 0 end) as w_outage,
            (case when weights ? 'flood'          then (weights ->> 'flood')::float8          else 0 end) as w_flood,
            (case when weights ? 'empower'        then (weights ->> 'empower')::float8          else 0 end) as w_empower,
            (case when weights ? 'age65'          then (weights ->> 'age65')::float8          else 0 end) as w_age65,
            (case when weights ? 'electric_heat'  then (weights ->> 'electric_heat')::float8  else 0 end) as w_heat,
            (case when weights ? 'backup_intent'  then (weights ->> 'backup_intent')::float8  else 0 end) as w_backup,
            (case when weights ? 'owner_65'       then (weights ->> 'owner_65')::float8       else 0 end) as w_owner65,
            (case when weights ? 'home_permits'   then (weights ->> 'home_permits')::float8   else 0 end) as w_permits,
            (case when weights ? 'installability' then (weights ->> 'installability')::float8 else 0 end) as w_install,
            (case when weights ? 'home_value'     then (weights ->> 'home_value')::float8     else 0 end) as w_homevalue,
            (case when weights ? 'income_100k'    then (weights ->> 'income_100k')::float8    else 0 end) as w_income100k,
            (case when weights ? 'age_35_64'      then (weights ->> 'age_35_64')::float8      else 0 end) as w_age3564,
            (case when weights ? 'permit_risk'    then (weights ->> 'permit_risk')::float8    else 0 end) as w_permitrisk
    ),
    narrow as (
        select
            t.outage_term, t.flood_term, t.empower_term, t.age65_term, t.electric_heat_term,
            t.backup_intent_term, t.owner65_term, t.permits_term, t.installability_term, t.home_value_term,
            t.income100k_term, t.age3564_term, t.permitrisk_term
        from core.mv_home_terms t
        where t.county_fips = coalesce(p_county_fips, '48453')
          and (p_block_group_geoid is null or t.block_group_geoid = p_block_group_geoid)
          and (p_situs_city is null or coalesce(t.situs_city, '') = p_situs_city)
          and (p_situs_zip is null or coalesce(t.situs_zip, '') = p_situs_zip)
          and (not p_exclude_backup or t.coverage_bucket not in ('base_customer', 'other_backup'))
    ),
    weight_sums as materialized (
        select
            (
                (case when n.outage_term is not null then w.w_outage else 0 end)
                + (case when n.flood_term is not null then w.w_flood else 0 end)
                + (case when n.empower_term is not null then w.w_empower else 0 end)
                + (case when n.age65_term is not null then w.w_age65 else 0 end)
                + (case when n.electric_heat_term is not null then w.w_heat else 0 end)
                + (case when n.backup_intent_term is not null then w.w_backup else 0 end)
                + (case when n.owner65_term is not null then w.w_owner65 else 0 end)
                + (case when n.permits_term is not null then w.w_permits else 0 end)
                + (case when n.installability_term is not null then w.w_install else 0 end)
                + (case when n.home_value_term is not null then w.w_homevalue else 0 end)
                + (case when n.income100k_term is not null then w.w_income100k else 0 end)
                + (case when n.age3564_term is not null then w.w_age3564 else 0 end)
                + (case when n.permitrisk_term is not null then w.w_permitrisk else 0 end)
            ) as weight_sum
        from narrow n
        cross join w
    )
    select count(*) from weight_sums where weight_sum > 0;
$function$;

create or replace function api.blockgroup_scores_weighted(weights jsonb, p_county_fips text default null, p_exclude_backup boolean default true, p_situs_city text default null, p_situs_zip text default null)
returns table(block_group_geoid text, score numeric, homes_scored bigint)
language sql
stable parallel safe
as $function$
    with w as materialized (
        select
            (case when weights ? 'outage'        then (weights ->> 'outage')::float8        else 0 end) as w_outage,
            (case when weights ? 'flood'          then (weights ->> 'flood')::float8          else 0 end) as w_flood,
            (case when weights ? 'empower'        then (weights ->> 'empower')::float8          else 0 end) as w_empower,
            (case when weights ? 'age65'          then (weights ->> 'age65')::float8          else 0 end) as w_age65,
            (case when weights ? 'electric_heat'  then (weights ->> 'electric_heat')::float8  else 0 end) as w_heat,
            (case when weights ? 'backup_intent'  then (weights ->> 'backup_intent')::float8  else 0 end) as w_backup,
            (case when weights ? 'owner_65'       then (weights ->> 'owner_65')::float8       else 0 end) as w_owner65,
            (case when weights ? 'home_permits'   then (weights ->> 'home_permits')::float8   else 0 end) as w_permits,
            (case when weights ? 'installability' then (weights ->> 'installability')::float8 else 0 end) as w_install,
            (case when weights ? 'home_value'     then (weights ->> 'home_value')::float8     else 0 end) as w_homevalue,
            (case when weights ? 'income_100k'    then (weights ->> 'income_100k')::float8    else 0 end) as w_income100k,
            (case when weights ? 'age_35_64'      then (weights ->> 'age_35_64')::float8      else 0 end) as w_age3564,
            (case when weights ? 'permit_risk'    then (weights ->> 'permit_risk')::float8    else 0 end) as w_permitrisk
    ),
    narrow as (
        select
            t.block_group_geoid,
            t.outage_term, t.flood_term, t.empower_term, t.age65_term, t.electric_heat_term,
            t.backup_intent_term, t.owner65_term, t.permits_term, t.installability_term, t.home_value_term,
            t.income100k_term, t.age3564_term, t.permitrisk_term
        from core.mv_home_terms t
        where t.county_fips = coalesce(p_county_fips, '48453')
          and (p_situs_city is null or coalesce(t.situs_city, '') = p_situs_city)
          and (p_situs_zip is null or coalesce(t.situs_zip, '') = p_situs_zip)
          and (not p_exclude_backup or t.coverage_bucket not in ('base_customer', 'other_backup'))
    ),
    scored as materialized (
        select
            n.block_group_geoid,
            (
                case when n.outage_term is not null then w.w_outage * n.outage_term else 0 end
                + case when n.flood_term is not null then w.w_flood * n.flood_term else 0 end
                + case when n.empower_term is not null then w.w_empower * n.empower_term else 0 end
                + case when n.age65_term is not null then w.w_age65 * n.age65_term else 0 end
                + case when n.electric_heat_term is not null then w.w_heat * n.electric_heat_term else 0 end
                + case when n.backup_intent_term is not null then w.w_backup * n.backup_intent_term else 0 end
                + case when n.owner65_term is not null then w.w_owner65 * n.owner65_term else 0 end
                + case when n.permits_term is not null then w.w_permits * n.permits_term else 0 end
                + case when n.installability_term is not null then w.w_install * n.installability_term else 0 end
                + case when n.home_value_term is not null then w.w_homevalue * n.home_value_term else 0 end
                + case when n.income100k_term is not null then w.w_income100k * n.income100k_term else 0 end
                + case when n.age3564_term is not null then w.w_age3564 * n.age3564_term else 0 end
                + case when n.permitrisk_term is not null then w.w_permitrisk * n.permitrisk_term else 0 end
            ) as weighted_sum,
            (
                (case when n.outage_term is not null then w.w_outage else 0 end)
                + (case when n.flood_term is not null then w.w_flood else 0 end)
                + (case when n.empower_term is not null then w.w_empower else 0 end)
                + (case when n.age65_term is not null then w.w_age65 else 0 end)
                + (case when n.electric_heat_term is not null then w.w_heat else 0 end)
                + (case when n.backup_intent_term is not null then w.w_backup else 0 end)
                + (case when n.owner65_term is not null then w.w_owner65 else 0 end)
                + (case when n.permits_term is not null then w.w_permits else 0 end)
                + (case when n.installability_term is not null then w.w_install else 0 end)
                + (case when n.home_value_term is not null then w.w_homevalue else 0 end)
                + (case when n.income100k_term is not null then w.w_income100k else 0 end)
                + (case when n.age3564_term is not null then w.w_age3564 else 0 end)
                + (case when n.permitrisk_term is not null then w.w_permitrisk else 0 end)
            ) as weight_sum
        from narrow n
        cross join w
    ),
    home_scored as materialized (
        select scored.block_group_geoid, (scored.weighted_sum / scored.weight_sum)::numeric as final_score
        from scored
        where scored.weight_sum > 0
    ),
    bg_mean as (
        select block_group_geoid, avg(final_score) as mean_score, count(*) as homes_scored
        from home_scored
        where block_group_geoid is not null
        group by block_group_geoid
    )
    -- Course correction (coordinator): the live version ranked block
    -- groups with percent_rank() over mean_score -- a relative rank that
    -- changes whenever a county/weight/homeset changes, which is exactly
    -- what the project's "score terms = real value / anchor, never
    -- percentile" rule forbids. final_score (each home's weighted
    -- average of terms already anchored to a real value, each bounded to
    -- [0,1]) stays bounded to [0,1] under averaging, so bg_mean.mean_score
    -- is returned directly as `score` -- an anchored-absolute value, not
    -- a rank. Checked web/ first (grep -rn blockgroup_scores_weighted
    -- web/): BlockGroupMap.tsx's scoreRampColor/SCORE_RAMP clamp+bucket
    -- any score in [0,1] into 5 color buckets, so the map keeps working
    -- unchanged -- it only ever needed a bounded [0,1] number, not
    -- specifically a rank. BlockGroupMap.tsx's own comment ("score is
    -- api.blockgroup_scores_weighted's percent_rank (0..1)") is now
    -- stale, and web/tests/m2-map/blockgroup-scores-route.test.ts's
    -- "top1 -> top color bucket" assertion is no longer guaranteed by
    -- construction (an absolute average isn't guaranteed >= 0.8 the way
    -- rank 1.0 was) -- both flagged in checks/M3-P6.md as follow-up
    -- (web/ is out of this ticket's owns paths).
    select bg_mean.block_group_geoid, bg_mean.mean_score as score, bg_mean.homes_scored
    from bg_mean;
$function$;

create or replace function api.home_score_breakdown(p_prop_id text, weights jsonb)
returns table(key text, label text, raw_value numeric, raw_unit text, percentile numeric, weight numeric, contribution numeric, available boolean, null_reason text, term numeric, anchor_value numeric, anchor_basis text)
language sql
stable parallel safe
as $function$
    with w as materialized (
        select
            (case when weights ? 'outage'        then (weights ->> 'outage')::numeric        else 0 end) as w_outage,
            (case when weights ? 'flood'          then (weights ->> 'flood')::numeric          else 0 end) as w_flood,
            (case when weights ? 'empower'        then (weights ->> 'empower')::numeric          else 0 end) as w_empower,
            (case when weights ? 'age65'          then (weights ->> 'age65')::numeric          else 0 end) as w_age65,
            (case when weights ? 'electric_heat'  then (weights ->> 'electric_heat')::numeric  else 0 end) as w_heat,
            (case when weights ? 'backup_intent'  then (weights ->> 'backup_intent')::numeric  else 0 end) as w_backup,
            (case when weights ? 'owner_65'       then (weights ->> 'owner_65')::numeric       else 0 end) as w_owner65,
            (case when weights ? 'home_permits'   then (weights ->> 'home_permits')::numeric   else 0 end) as w_permits,
            (case when weights ? 'installability' then (weights ->> 'installability')::numeric else 0 end) as w_install,
            (case when weights ? 'home_value'     then (weights ->> 'home_value')::numeric     else 0 end) as w_homevalue,
            (case when weights ? 'income_100k'    then (weights ->> 'income_100k')::numeric    else 0 end) as w_income100k,
            (case when weights ? 'age_35_64'      then (weights ->> 'age_35_64')::numeric      else 0 end) as w_age3564,
            (case when weights ? 'permit_risk'    then (weights ->> 'permit_risk')::numeric    else 0 end) as w_permitrisk
    ),
    s as (
        select * from core.mv_home_signals where prop_id = p_prop_id
    ),
    d as (
        select t.* from (values (1)) one(x)
        left join lateral (select * from core.mv_home_terms where prop_id = p_prop_id) t on true
    ),
    ia as (
        select ia_t.* from (values (1)) one(x)
        left join lateral (
            select * from core.acs_income_age_bg where geoid = (select block_group_geoid from s)
        ) ia_t on true
    ),
    stats as (
        select st.median_days, st.p90_days, st.share_never_finished
        from (values (1)) one(x)
        left join lateral (
            select median_days, p90_days, share_never_finished
            from core.permit_path_stats
            where jurisdiction = 'ALL' and label = 'battery' and period_type = 'quarter'
            order by period desc limit 1
        ) st on true
    ),
    anc as (
        select signal_key, anchor_value, anchor_value_low, basis from core.signal_anchors
    ),
    weight_total as (
        select
            (
                case when s.outage_term            is not null then w.w_outage  else 0 end
                + case when s.flood_term            is not null then w.w_flood   else 0 end
                + case when s.empower_term          is not null then w.w_empower else 0 end
                + case when s.age65_term            is not null then w.w_age65   else 0 end
                + case when s.electric_heat_term    is not null then w.w_heat    else 0 end
                + case when s.backup_intent_term    is not null then w.w_backup  else 0 end
                + case when s.owner_65              is not null then w.w_owner65 else 0 end
                + case when s.home_permits_flag     is not null then w.w_permits else 0 end
                + case when s.installability_term   is not null then w.w_install else 0 end
                + case when s.home_value_term       is not null then w.w_homevalue else 0 end
                + case when d.income100k_term       is not null then w.w_income100k else 0 end
                + case when d.age3564_term          is not null then w.w_age3564 else 0 end
                + case when d.permitrisk_term       is not null then w.w_permitrisk else 0 end
            ) as weight_sum
        from s cross join w cross join d
    )
    select
        v.key, v.label, v.raw_value, v.raw_unit, v.percentile, v.weight,
        case when v.available and wt.weight_sum > 0 then (v.weight * v.term) / wt.weight_sum else null end as contribution,
        v.available, v.null_reason, v.term, v.anchor_value, v.anchor_basis
    from s
    cross join w
    cross join ia
    cross join stats
    cross join d
    cross join weight_total wt
    cross join lateral (
        values
            (
                'outage', 'Outage exposure',
                s.distributor_saidi, 'minutes without power/customer/year (SAIDI, incl. major events, or the EAGLE-I county proxy when the distributor reports none)',
                -- DEPRECATED: s.distributor_saidi_pctile is always null
                -- now (M3-P6 perf pass, six percent_rank sorts removed).
                s.distributor_saidi_pctile, w.w_outage,
                s.outage_term is not null, s.outage_null_reason,
                s.outage_term,
                (select anchor_value from anc where signal_key = 'outage'),
                (select basis from anc where signal_key = 'outage')
            ),
            (
                'flood', 'Outside flood zone (penalty only, never a top signal)',
                case when s.flood_flag is null then null else (case when s.flood_flag then 1 else 0 end)::numeric end,
                'flag (1 = inside a FEMA Special Flood Hazard Area)',
                case when s.flood_pctile is null then null else 1 - s.flood_pctile end,
                w.w_flood,
                s.flood_term is not null, s.flood_null_reason,
                s.flood_term,
                null::numeric,
                'no anchor -- 1 outside a FEMA Special Flood Hazard Area, 0 inside (penalty only)'
            ),
            (
                'empower', 'Medical need (emPOWER)',
                case when s.empower_rate is null then null else s.empower_rate * 1000 end,
                'power-dependent Medicare devices per 1,000 Medicare beneficiaries in this ZIP',
                s.empower_pctile, w.w_empower,
                s.empower_term is not null, s.empower_null_reason,
                s.empower_term,
                (select anchor_value from anc where signal_key = 'empower'),
                (select basis from anc where signal_key = 'empower')
            ),
            (
                'age65', 'Age 65+ (block group, ACS)',
                case when s.acs_pct_65_plus is null then null else s.acs_pct_65_plus * 100 end,
                '% of this block group''s population age 65+ (same for every home in the block group)',
                s.acs_65_pctile, w.w_age65,
                s.age65_term is not null, s.acs_65_null_reason,
                s.age65_term,
                (select anchor_value from anc where signal_key = 'age65'),
                (select basis from anc where signal_key = 'age65')
            ),
            (
                'electric_heat', 'Electric heat (block group, ACS)',
                case when s.acs_pct_electric_heat is null then null else s.acs_pct_electric_heat * 100 end,
                '% of this block group''s housing units heating with electricity (same for every home in the block group)',
                s.acs_heat_pctile, w.w_heat,
                s.electric_heat_term is not null, s.acs_heat_null_reason,
                s.electric_heat_term,
                null::numeric,
                'no anchor -- used directly as a 0-1 share'
            ),
            (
                'backup_intent', 'Neighbours adopting backup (peer rate, this home''s own permits excluded)',
                s.backup_intent_rate,
                'battery/generator permits per 1,000 OTHER gated homes in this block group (36 months, self excluded)',
                s.backup_intent_pctile, w.w_backup,
                s.backup_intent_term is not null, s.backup_intent_null_reason,
                s.backup_intent_term,
                (select anchor_value from anc where signal_key = 'backup_intent'),
                (select basis from anc where signal_key = 'backup_intent')
            ),
            (
                'owner_65', 'Homeowner is 65+ (TCAD over-65 exemption)',
                case when s.owner_65 is null then null else s.owner_65::int::numeric end,
                'flag (1 = has the TCAD over-65 homestead exemption)',
                null::numeric, w.w_owner65,
                s.owner_65 is not null, s.owner_65_null_reason,
                case when s.owner_65 is null then null else s.owner_65::int::numeric end,
                null::numeric,
                'no anchor -- 1/0 flag'
            ),
            (
                'home_permits', 'Home has its own solar/EV/generator permit',
                case when s.home_permits_flag is null then null else s.home_permits_flag::int::numeric end,
                'flag (1 = this home''s own Austin permits include solar, EV, or generator)',
                null::numeric, w.w_permits,
                s.home_permits_flag is not null, s.permit_null_reason,
                case when s.home_permits_flag is null then null else s.home_permits_flag::int::numeric end,
                null::numeric,
                'no anchor -- 1/0 flag'
            ),
            (
                'installability', 'Installability (newer home or own panel-upgrade permit)',
                case when s.yr_built is null then null else s.yr_built::numeric end,
                'flag (1 = built 2000 or later, or has its own panel-upgrade permit)',
                null::numeric, w.w_install,
                s.installability_term is not null, s.installability_null_reason,
                s.installability_term,
                null::numeric,
                'no anchor -- 1/0 flag (yr_built >= 2000, a team-chosen cutoff, or a panel-upgrade permit)'
            ),
            (
                'home_value', 'Home value (county appraisal export market value)',
                s.market_value,
                'dollars, county appraisal district market value',
                null::numeric, w.w_homevalue,
                s.home_value_term is not null, s.home_value_null_reason,
                s.home_value_term,
                (select anchor_value from anc where signal_key = 'home_value'),
                (select basis from anc where signal_key = 'home_value')
            ),
            (
                'income_100k', 'Household income $100k+ (block group, ACS, neighborhood figure)',
                case when ia.income_100k_share is null then null else ia.income_100k_share * 100 end,
                '% of this block group''s households earning $100k+ (ACS 2024 5-year; same for every home in the block group)',
                null::numeric, w.w_income100k,
                d.income100k_term is not null, ia.income_100k_share_null_reason,
                d.income100k_term,
                (select anchor_value from anc where signal_key = 'income_100k'),
                (select basis from anc where signal_key = 'income_100k')
            ),
            (
                'age_35_64', 'Prime working age 35-64 (block group, ACS, neighborhood figure)',
                case when ia.age_35_64_share is null then null else ia.age_35_64_share * 100 end,
                '% of this block group''s population aged 35-64 (ACS 2024 5-year; same for every home in the block group)',
                null::numeric, w.w_age3564,
                d.age3564_term is not null, ia.age_35_64_share_null_reason,
                d.age3564_term,
                (select anchor_value from anc where signal_key = 'age_35_64'),
                (select basis from anc where signal_key = 'age_35_64')
            ),
            (
                'permit_risk', 'Permit risk (Austin permit timelines, low = fast/easy)',
                stats.median_days,
                'days (this quarter''s median days-to-issue for a battery permit, citywide)',
                null::numeric, w.w_permitrisk,
                d.permitrisk_term is not null,
                (case when d.permit_path is null then coalesce(s.territory_null_reason, 'no_territory_match') end),
                d.permitrisk_term,
                null::numeric,
                'no anchor -- half days-to-issue (this quarter''s median vs its own p90), half share never finished, both already 0-1; state_rules_only homes score 1 (no city ESS permit process to measure, per SB 1252)'
            )
    ) as v(key, label, raw_value, raw_unit, percentile, weight, available, null_reason, term, anchor_value, anchor_basis);
$function$;

grant execute on function
    api.homes_ranked_weighted(jsonb, text, text, numeric, text, integer, boolean, text, text),
    api.homes_ranked_weighted_count(jsonb, text, text, boolean, text, text),
    api.blockgroup_scores_weighted(jsonb, text, boolean, text, text)
to zeus_web_ro;

-- ---------------------------------------------------------------------------
-- core.refresh_all_scores() — same overall shape as the current live
-- function (mv_home_block_group / mv_join_rate / mv_blockgroup_scores /
-- mv_top_homes / mv_gate_counts / mv_parcel_gate_counts /
-- mv_blockgroup_geojson / refresh_market / mv_gate_counts_by_market, in
-- that order, then signal_anchors/signal_medians), plus the new
-- mv_home_terms / mv_home_geo_rollup / mv_county_territories refreshes
-- and the home_propensity.county_fips backfill. core.home_spatial,
-- core.flood_zones_sub and core.territories_sub are NOT refreshed here:
-- they change only when a boundary file or the parcel roll changes, and
-- are kept current by pipelines/sources/home_spatial.py on its own
-- schedule (per county, its own committed step) -- never inside this
-- transaction. That is the entire point of this ticket: this function's
-- wall-clock is now dominated by ID joins onto an already-computed
-- table, not by ST_Within/ST_Intersects/percent_rank.
--
-- Fixed (coordinator follow-up): core.mv_home_block_group's own refresh
-- no longer does live ST_Within either -- it's rebuilt above as a plain
-- filtered select from core.home_spatial, so this whole function is now
-- zero-geometry end to end. mv_join_rate/mv_blockgroup_scores/
-- mv_top_homes/mv_blockgroup_geojson (legacy v0 objects, kept refreshed
-- only because api.top_homes/api.blockgroup_scores still read them) are
-- correspondingly cheap now too, since they read the rebuilt
-- mv_home_block_group.
-- ---------------------------------------------------------------------------
create or replace function core.refresh_all_scores()
returns void
language plpgsql
as $function$
begin
    refresh materialized view concurrently core.mv_home_block_group;
    refresh materialized view concurrently core.mv_home_signals;
    refresh materialized view concurrently core.mv_join_rate;
    refresh materialized view concurrently core.mv_blockgroup_scores;
    refresh materialized view concurrently core.mv_top_homes;
    refresh materialized view concurrently core.mv_gate_counts;
    refresh materialized view concurrently core.mv_parcel_gate_counts;
    refresh materialized view concurrently core.mv_blockgroup_geojson;
    perform core.refresh_market();
    refresh materialized view concurrently core.mv_gate_counts_by_market;

    insert into core.signal_anchors (signal_key, anchor_value, anchor_value_low, basis, year, source_ids)
    select
        'outage',
        (select percentile_cont(0.9) within group (order by saidi_incl_major)
         from core.utility_reliability
         where year = (select max(year) from core.utility_reliability where saidi_incl_major is not null)
           and saidi_incl_major is not null),
        null::numeric,
        'Texas utilities'' 90th-percentile outage minutes per customer per year, EIA-861',
        (select max(year) from core.utility_reliability where saidi_incl_major is not null),
        (select array_agg(distinct source_id) from core.utility_reliability
         where year = (select max(year) from core.utility_reliability where saidi_incl_major is not null))
    union all
    select
        'empower',
        (select percentile_cont(0.9) within group (order by (power_dependent_devices_dme::numeric / medicare_benes))
         from core.empower_zip
         where not power_dependent_devices_dme_suppressed and medicare_benes > 0
           and power_dependent_devices_dme is not null),
        null::numeric,
        '90th-percentile rate of power-dependent Medicare devices per Medicare beneficiary, across every Texas ZIP, HHS emPOWER',
        null::int,
        (select array_agg(distinct source_id) from core.empower_zip)
    union all
    select
        'age65',
        (select percentile_cont(0.9) within group (order by acs_pct_65_plus)
         from (select distinct block_group_geoid, acs_pct_65_plus from core.mv_home_signals where acs_pct_65_plus is not null) t),
        null::numeric,
        '90th-percentile share of population age 65+, across every block group with a gated home, Census ACS',
        null::int,
        (select array_agg(distinct source_id) from core.acs_bg)
    union all
    select
        'backup_intent',
        (select percentile_cont(0.9) within group (order by backup_intent_rate)
         from core.mv_home_signals where gate_reason is null and backup_intent_rate is not null),
        null::numeric,
        '90th-percentile rate of battery/generator permits per 1,000 OTHER gated homes (peer rate, self excluded, 36 months), Austin permits',
        null::int,
        (select array_agg(distinct source_id) from core.permits)
    union all
    select
        'home_value',
        (select percentile_cont(0.9) within group (order by ln(market_value))
         from core.mv_home_signals where gate_reason is null and market_value > 0),
        (select percentile_cont(0.1) within group (order by ln(market_value))
         from core.mv_home_signals where gate_reason is null and market_value > 0),
        '10th-to-90th-percentile range of ln(market value) across gated homes, county appraisal exports',
        2026,
        (select array_agg(distinct source_id) from core.parcels)
    on conflict (signal_key) do update set
        anchor_value     = excluded.anchor_value,
        anchor_value_low = excluded.anchor_value_low,
        basis            = excluded.basis,
        year             = excluded.year,
        source_ids       = excluded.source_ids,
        created_at       = now();

    delete from core.signal_medians;
    insert into core.signal_medians (county_fips, signal_key, median)
    select county_fips, 'outage', percentile_cont(0.5) within group (order by outage_term)
    from core.mv_home_signals where gate_reason is null and outage_term is not null group by county_fips
    union all
    select county_fips, 'home_value', percentile_cont(0.5) within group (order by home_value_term)
    from core.mv_home_signals where gate_reason is null and home_value_term is not null group by county_fips
    union all
    select county_fips, 'empower', percentile_cont(0.5) within group (order by empower_term)
    from core.mv_home_signals where gate_reason is null and empower_term is not null group by county_fips
    union all
    select county_fips, 'age65', percentile_cont(0.5) within group (order by age65_term)
    from core.mv_home_signals where gate_reason is null and age65_term is not null group by county_fips
    union all
    select county_fips, 'electric_heat', percentile_cont(0.5) within group (order by electric_heat_term)
    from core.mv_home_signals where gate_reason is null and electric_heat_term is not null group by county_fips
    union all
    select county_fips, 'backup_intent', percentile_cont(0.5) within group (order by backup_intent_term)
    from core.mv_home_signals where gate_reason is null and backup_intent_term is not null group by county_fips
    union all
    select county_fips, 'owner_65', percentile_cont(0.5) within group (order by owner_65::int)
    from core.mv_home_signals where gate_reason is null and owner_65 is not null group by county_fips
    union all
    select county_fips, 'home_permits', percentile_cont(0.5) within group (order by home_permits_flag::int)
    from core.mv_home_signals where gate_reason is null and home_permits_flag is not null group by county_fips
    union all
    select county_fips, 'installability', percentile_cont(0.5) within group (order by installability_term)
    from core.mv_home_signals where gate_reason is null and installability_term is not null group by county_fips;

    update core.home_propensity hp
    set county_fips = s.county_fips
    from core.mv_home_signals s
    where s.prop_id = hp.prop_id
      and hp.county_fips is distinct from s.county_fips;

    refresh materialized view concurrently core.mv_home_terms;
    refresh materialized view concurrently core.mv_home_geo_rollup;
    refresh materialized view concurrently core.mv_county_territories;
end;
$function$;

-- ---------------------------------------------------------------------------
-- vacuum (analyze) everything this cutover just rebuilt/renamed. Run
-- outside this transaction (vacuum cannot run inside one) -- the caller
-- runs these as separate autocommit statements right after this file
-- commits (lesson 11):
--   vacuum (analyze) core.mv_home_signals_pre_m3p6;
--   vacuum (analyze) core.home_spatial;
--   vacuum (analyze) core.home_propensity;
-- ---------------------------------------------------------------------------
