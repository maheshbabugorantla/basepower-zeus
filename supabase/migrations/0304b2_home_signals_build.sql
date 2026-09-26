set local statement_timeout = 0;
set local work_mem = '64MB';
set local maintenance_work_mem = '256MB';
set local max_parallel_workers_per_gather = 0;
-- 0304b2: build core.mv_home_signals_v2 beside the live one (split out of 0304b so peak disk stays under 8 GB).
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
-- NOT MATERIALIZED: raw is read 5 times (4 anchors + the final select). Materialized, Postgres
-- spools every wide row (source_ids arrays included) to temp files, several GB at 1.2M homes,
-- which filled the 8 GB disk. Inlined, each anchor reads only the columns it needs.
raw as not materialized (
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
