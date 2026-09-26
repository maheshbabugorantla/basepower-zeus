-- 0201_m2.sql — M2-S1: territories, gate, need signals, score v1 with weights
--
-- Idempotent-safe: every DDL statement uses IF NOT EXISTS / CREATE OR REPLACE /
-- drop-if-exists-then-create so this file can be re-applied to the same
-- database without error or duplication. The whole file runs inside one
-- transaction (BEGIN/COMMIT below) so a partial failure never leaves a
-- half-applied schema.
--
-- Real-data rule: this migration creates no data rows for territories,
-- ACS, emPOWER, flood, reliability, or crosswalk data. The only rows it
-- seeds are `ops.refresh_policy` additions, which are static
-- configuration, not observed data.
--
-- Performance split (M1 lesson — live spatial joins timed out in
-- production, see 0102_m1_materialize.sql): everything input-independent
-- (home -> territory/flood/ZIP/block-group joins, distributor SAIDI,
-- ACS shares, backup-intent rate, percentile ranks) is PRECOMPUTED into
-- core.mv_home_signals, built on top of core.mv_home_block_group (0102 —
-- not redone here). Only the weights-dependent weighted mean is computed
-- at request time, inside api.top_homes_weighted(weights, county_fips),
-- a SQL function (never materialized).
--
-- core.mv_blockgroup_scores / core.mv_top_homes (0102_m1_materialize.sql)
-- are retired: core.refresh_all_scores() below no longer refreshes them,
-- so they go stale as of this migration. They are deliberately left in
-- place (not dropped) because api.top_homes (the plain view from
-- 0101_m1.sql / 0102_m1_materialize.sql) still reads
-- core.mv_top_homes and we do not want to break that existing view name
-- — see the api.top_homes_weighted comment below for why the new
-- function has a different name instead of replacing it.

begin;

-- ---------------------------------------------------------------------------
-- core.territories — HIFLD electric retail service territory polygons.
-- eia_id is the polygon's `ID` field, which IS the EIA utility number
-- (Austin Energy 1015, Pedernales 14626, Bluebonnet 1892, CenterPoint
-- 8901, Oncor 44372) — the same key that joins core.utility_reliability
-- and core.utility_crosswalk.eia_utility_number. Filled by M2-P1.
-- ---------------------------------------------------------------------------

create table if not exists core.territories (
    eia_id      text primary key,
    name        text,
    state       text,
    geom        extensions.geometry(MultiPolygon, 4326),
    source_id   uuid not null references ops.source_manifest (id),
    created_at  timestamptz not null default now()
);

create index if not exists territories_geom_gix on core.territories using gist (geom);

comment on table core.territories is
    'HIFLD Electric Retail Service Territories polygons. eia_id (the '
    'polygon ID field) is the EIA-861 utility number. Filled by M2-P1.';

-- ---------------------------------------------------------------------------
-- core.base_service_areas — utility names parsed from Base's
-- pricing.md snapshot. Filled by M2-P2.
-- ---------------------------------------------------------------------------

create table if not exists core.base_service_areas (
    utility_name text primary key,
    source_id    uuid not null references ops.source_manifest (id),
    created_at   timestamptz not null default now()
);

comment on table core.base_service_areas is
    'Utility names Base lists as served, parsed from a checksummed '
    'snapshot of basepowercompany.com/pricing.md. Filled by M2-P2.';

-- ---------------------------------------------------------------------------
-- core.utility_crosswalk — data/manual/utility_crosswalk.csv (M2-H1),
-- loaded like any other source by M2-P6. Maps Base's utility name to a
-- territory polygon name and its EIA-861 utility number; mapped='no'
-- rows are logged-unmapped, not guessed (e.g. AEP Texas Central/North).
-- ---------------------------------------------------------------------------

create table if not exists core.utility_crosswalk (
    id                    uuid primary key default gen_random_uuid(),
    base_name             text not null,
    eia_utility_number    text,
    polygon_name          text,
    state                 text,
    mapped                text not null check (mapped in ('yes', 'no')),
    note                  text,
    base_source_url       text,
    base_retrieved_at     timestamptz,
    polygon_source_url    text,
    polygon_retrieved_at  timestamptz,
    source_id             uuid not null references ops.source_manifest (id),
    created_at            timestamptz not null default now(),
    unique (base_name)
);

create index if not exists utility_crosswalk_eia_number_idx
    on core.utility_crosswalk (eia_utility_number);

comment on table core.utility_crosswalk is
    'Base utility name <-> HIFLD territory polygon name <-> EIA-861 '
    'utility number (data/manual/utility_crosswalk.csv, M2-H1). '
    'eia_utility_number is null when mapped=no (logged-unmapped, per '
    'checks/M2-H1.md — never guessed). Filled by M2-P6.';

-- ---------------------------------------------------------------------------
-- core.acs_bg — Census ACS 5-year, by block group: population 65+ share
-- and electric-heat share. Filled by M2-P3.
-- ---------------------------------------------------------------------------

create table if not exists core.acs_bg (
    geoid                          text primary key,
    county_fips                    text,
    pop_total                      numeric,
    pop_65_plus                    numeric,
    pop_65_plus_null_reason        text,
    housing_units_total            numeric,
    heating_electric               numeric,
    heating_electric_null_reason   text,
    source_id                      uuid not null references ops.source_manifest (id),
    created_at                     timestamptz not null default now()
);

create index if not exists acs_bg_county_fips_idx on core.acs_bg (county_fips);

comment on table core.acs_bg is
    'Census ACS 5-year block-group estimates: total population, '
    'population 65+, total occupied housing units, and units heated by '
    'electricity. Nulls carry a *_null_reason. Filled by M2-P3.';

-- ---------------------------------------------------------------------------
-- core.empower_zip — HHS emPOWER Map ZIP-level Medicare + power-dependent
-- device counts. Value 11 means suppressed 1-10 (never a count) per
-- checks/M2-H3.md. Filled by M2-P4, monthly cron.
-- ---------------------------------------------------------------------------

create table if not exists core.empower_zip (
    zip_code                              text primary key,
    medicare_benes                        numeric,
    power_dependent_devices_dme           numeric,
    power_dependent_devices_dme_suppressed boolean not null default false,
    empower_null_reason                    text,
    source_id                              uuid not null references ops.source_manifest (id),
    created_at                             timestamptz not null default now(),
    updated_at                              timestamptz not null default now()
);

comment on table core.empower_zip is
    'HHS emPOWER Map, by ZIP: Medicare beneficiaries and power-dependent '
    'DME device counts. power_dependent_devices_dme_suppressed is true '
    'when the source value was the literal 11 (suppressed 1-10, not a '
    'count) — the raw 11 is never stored as a count. Filled by M2-P4.';

-- ---------------------------------------------------------------------------
-- core.zcta — Census TIGER ZCTA polygons, for the ZIP -> block group /
-- home join. Filled by M2-P4.
-- ---------------------------------------------------------------------------

create table if not exists core.zcta (
    zcta5       text primary key,
    geom        extensions.geometry(MultiPolygon, 4326),
    source_id   uuid not null references ops.source_manifest (id),
    created_at  timestamptz not null default now()
);

create index if not exists zcta_geom_gix on core.zcta using gist (geom);

comment on table core.zcta is
    'Census TIGER/Line ZCTA5 polygons (EPSG:4326), backing the ZIP -> '
    'block group / home spatial join for emPOWER. Filled by M2-P4.';

-- ---------------------------------------------------------------------------
-- core.flood_zones — FEMA National Flood Hazard Layer polygons for
-- Travis. Filled by M2-P5.
-- ---------------------------------------------------------------------------

create table if not exists core.flood_zones (
    id          uuid primary key default gen_random_uuid(),
    county_fips text,
    fld_zone    text,
    geom        extensions.geometry(MultiPolygon, 4326),
    source_id   uuid not null references ops.source_manifest (id),
    created_at  timestamptz not null default now()
);

create index if not exists flood_zones_geom_gix on core.flood_zones using gist (geom);
create index if not exists flood_zones_county_fips_idx on core.flood_zones (county_fips);

comment on table core.flood_zones is
    'FEMA NFHL flood zone polygons (EPSG:4326), Travis. Filled by M2-P5.';

-- ---------------------------------------------------------------------------
-- core.utility_reliability — EIA-861 SAIDI/SAIFI/CAIDI, with and without
-- major event days, per distributor per data year. EIA's "." means not
-- reported: loaded null with reason, never 0. early_release flags the
-- 2025 early-release file (not fully edited). Filled by M2-P7.
-- ---------------------------------------------------------------------------

create table if not exists core.utility_reliability (
    eia_id                       text not null,
    year                         int not null,
    utility_name                 text,
    saidi_incl_major             numeric,
    saidi_incl_major_null_reason text,
    saidi_excl_major             numeric,
    saidi_excl_major_null_reason text,
    saifi_incl_major             numeric,
    saifi_incl_major_null_reason text,
    saifi_excl_major             numeric,
    saifi_excl_major_null_reason text,
    caidi_incl_major             numeric,
    caidi_incl_major_null_reason text,
    caidi_excl_major             numeric,
    caidi_excl_major_null_reason text,
    early_release                boolean not null default false,
    source_id                    uuid not null references ops.source_manifest (id),
    created_at                   timestamptz not null default now(),
    primary key (eia_id, year)
);

comment on table core.utility_reliability is
    'EIA-861 Reliability: SAIDI/SAIFI/CAIDI with/without major event '
    'days, per EIA utility number (= core.territories.eia_id) per data '
    'year. EIA''s literal "." is loaded as null with a *_null_reason, '
    'never 0 (e.g. Oncor 44372, both years). early_release marks the '
    '2025 early-release file (values not fully edited per EIA). Filled '
    'by M2-P7.';

-- ---------------------------------------------------------------------------
-- core.county_customers — EAGLE-I MCC.csv customer counts per county.
-- Filled by M2-P7.
-- ---------------------------------------------------------------------------

create table if not exists core.county_customers (
    county_fips text primary key,
    customers   numeric,
    source_id   uuid not null references ops.source_manifest (id),
    created_at  timestamptz not null default now()
);

comment on table core.county_customers is
    'EAGLE-I MCC.csv customer counts per Texas county (e.g. Travis '
    '48453 = 641,926). Backs api.county_outage.hours_per_customer. '
    'Filled by M2-P7.';

-- ---------------------------------------------------------------------------
-- Row-level security: enabled on every new table, no policies — only
-- service_role (bypasses RLS) can read/write, matching M0/M1 convention.
-- ---------------------------------------------------------------------------

alter table core.territories        enable row level security;
alter table core.base_service_areas  enable row level security;
alter table core.utility_crosswalk   enable row level security;
alter table core.acs_bg              enable row level security;
alter table core.empower_zip         enable row level security;
alter table core.zcta                enable row level security;
alter table core.flood_zones         enable row level security;
alter table core.utility_reliability enable row level security;
alter table core.county_customers    enable row level security;

revoke all on core.territories        from public, anon, authenticated;
revoke all on core.base_service_areas  from public, anon, authenticated;
revoke all on core.utility_crosswalk   from public, anon, authenticated;
revoke all on core.acs_bg              from public, anon, authenticated;
revoke all on core.empower_zip         from public, anon, authenticated;
revoke all on core.zcta                from public, anon, authenticated;
revoke all on core.flood_zones         from public, anon, authenticated;
revoke all on core.utility_reliability from public, anon, authenticated;
revoke all on core.county_customers    from public, anon, authenticated;

revoke all on schema ops  from public, anon, authenticated;
revoke all on schema core from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- ops.refresh_policy — new M2 source keys (backfill-only except crosswalk,
-- which tracks whatever cadence M2-P1/P2 use — both backfill-only, so
-- crosswalk is backfill-only too). Static config, not observed data.
-- ---------------------------------------------------------------------------

-- no-mock-check: config-seed refresh cycles are the team's freshness policy from the spec, not source data
insert into ops.refresh_policy (source, refresh_cycle_days, note) values
    ('utility_crosswalk',    null, 'data/manual/utility_crosswalk.csv (M2-H1) — backfill only, hand-curated'),
    ('eia861_reliability',   null, 'EIA-861 Reliability_2025_Data_Early_Release + Reliability_2024 — backfill only, annual upstream'),
    ('eaglei_mcc',           null, 'EAGLE-I MCC.csv customer counts — backfill only, one-time file')
on conflict (source) do update
    set refresh_cycle_days = excluded.refresh_cycle_days,
        note                = excluded.note;

-- ---------------------------------------------------------------------------
-- core.mv_home_signals — per-home gate + need signals + percentile ranks,
-- built ON TOP OF core.mv_home_block_group (0102_m1_materialize.sql — the
-- home -> block-group spatial join, not redone here). Input-independent:
-- no weights here. Refreshed by core.refresh_all_scores() below (called
-- by pipelines/sources/refresh_scores.py after every load).
--
-- Every join to an M2 source table (territories, crosswalk, reliability,
-- flood_zones, empower_zip, acs_bg) is a LEFT JOIN, so with those tables
-- still empty (M2-S1 applied ahead of the M2-P* pipelines), every home
-- still gets a row here: gate_reason stays null (fail-open — an unknown
-- gate never excludes a home) and every M2 signal is null with an
-- explicit *_null_reason of "<x>_not_loaded". The one M1-era signal
-- (backup_intent, recomputed here from core.permits/permit_labels, the
-- same logic 0102_m1_materialize.sql's core.mv_blockgroup_scores used)
-- is already populated, so ranking still works before any M2 pipeline
-- runs.
-- ---------------------------------------------------------------------------

drop materialized view if exists core.mv_home_signals cascade;

create materialized view core.mv_home_signals as
with base as (
    select
        hb.prop_id,
        hb.geo_id,
        hb.block_group_geoid,
        bg.county_fips,
        pg.centroid,
        p.situs_zip,
        p.source_id  as parcel_source_id,
        hb.geom_source_id,
        hb.bg_source_id
    from core.mv_home_block_group hb
    join core.parcels p on p.prop_id = hb.prop_id
    left join core.parcel_geoms pg on pg.prop_id = hb.prop_id
    left join core.block_groups bg on bg.geoid = hb.block_group_geoid
),
-- Best territory match per home, preferring a Base-served (mapped='yes')
-- polygon on overlap (HIFLD polygons overlap in practice) — this choice
-- also decides which distributor's SAIDI the home is assigned below.
territory_match as (
    select distinct on (b.prop_id)
        b.prop_id,
        t.eia_id,
        t.source_id as territory_source_id,
        cw.mapped,
        cw.source_id as crosswalk_source_id
    from base b
    join core.territories t
        on b.centroid is not null and extensions.ST_Within(b.centroid, t.geom)
    left join core.utility_crosswalk cw on cw.eia_utility_number = t.eia_id
    order by b.prop_id, (cw.mapped = 'yes') desc nulls last, t.eia_id
),
-- Gate is fail-OPEN (never excludes) until BOTH territories and the
-- crosswalk are loaded — an unresolved gate is not an exclusion. Once
-- both are loaded it is fail-CLOSED: outside every territory, or inside
-- a territory the crosswalk does not mark mapped='yes', is excluded
-- (M2-P6: "gate homes whose parcel centroid is outside a Base-served
-- polygon").
gate as (
    select
        b.prop_id,
        tm.eia_id as territory_eia_id,
        tm.territory_source_id,
        tm.mapped,
        tm.crosswalk_source_id,
        case
            when (select count(*) from core.territories) = 0 then null
            when (select count(*) from core.utility_crosswalk) = 0 then null
            when tm.eia_id is null then 'territory_not_base_served'
            when tm.mapped is distinct from 'yes' then 'territory_not_base_served'
            else null
        end as gate_reason,
        case
            when (select count(*) from core.territories) = 0 then 'territories_not_loaded'
            when (select count(*) from core.utility_crosswalk) = 0 then 'crosswalk_not_loaded'
            else null
        end as territory_null_reason
    from base b
    left join territory_match tm on tm.prop_id = b.prop_id
),
reliability as (
    select
        g.prop_id,
        ur.saidi_incl_major       as distributor_saidi,
        ur.year                    as distributor_saidi_year,
        ur.early_release           as distributor_saidi_early_release,
        ur.utility_name             as distributor_name,
        ur.source_id               as reliability_source_id,
        case
            when g.territory_eia_id is null then coalesce(g.territory_null_reason, 'no_territory_match')
            when ur.saidi_incl_major is not null then null
            when (select count(*) from core.utility_reliability) = 0 then 'eia861_not_loaded'
            else 'no_eia861_figure_for_distributor'
        end as distributor_saidi_null_reason
    from gate g
    left join lateral (
        select r.saidi_incl_major, r.year, r.early_release, r.utility_name, r.source_id
        from core.utility_reliability r
        where r.eia_id = g.territory_eia_id and r.saidi_incl_major is not null
        order by r.year desc
        limit 1
    ) ur on true
),
-- Flood flag is null (not false) while core.flood_zones is empty — a
-- zero-fill would make an unloaded signal look like a real "no flood
-- risk" reading. Once loaded, only Special Flood Hazard Area zones (A*
-- or V*) count; NFHL also carries zone X (minimal risk) polygons, which
-- must not flag a home as "in a flood zone".
flood as (
    select
        b.prop_id,
        case when (select count(*) from core.flood_zones) = 0 then null
             else (fz.id is not null) end as flood_flag,
        fz.source_id as flood_source_id,
        case when (select count(*) from core.flood_zones) = 0 then 'flood_zones_not_loaded'
             else null end as flood_null_reason
    from base b
    left join lateral (
        select f.id, f.source_id
        from core.flood_zones f
        where b.centroid is not null
          and f.fld_zone ~ '^(A|V)'
          and extensions.ST_Within(b.centroid, f.geom)
        limit 1
    ) fz on true
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
            when a.geoid is null or a.pop_total is null or a.pop_total = 0
                or a.pop_65_plus is null then null
            else a.pop_65_plus / a.pop_total
        end as acs_pct_65_plus,
        case
            when a.geoid is null or a.housing_units_total is null or a.housing_units_total = 0
                or a.heating_electric is null then null
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
-- Backup-intent rate: generator+battery rules-labelled permits per 1,000
-- gated homes in the block group, last 36 months — identical semantics
-- to core.mv_blockgroup_scores (0102_m1_materialize.sql), recomputed here
-- (not read from that mv, which is being retired) since it must live
-- alongside the other per-home signals in one refreshable table.
bg_home_counts as (
    select block_group_geoid, count(*) as homes_gated
    from core.mv_home_block_group
    group by block_group_geoid
),
permits_in_window as (
    select
        pm.permit_number,
        hb.block_group_geoid,
        pl.label,
        pm.source_id as permit_source_id
    from core.permits pm
    join core.permit_labels pl
        on pl.permit_number = pm.permit_number and pl.labeller = 'rules'
    join core.parcels p on p.geo_id = pm.tcad_id
    join core.mv_home_block_group hb on hb.prop_id = p.prop_id
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
bg_backup as (
    select
        hc.block_group_geoid,
        case
            when hc.homes_gated = 0 then null
            when pc.any_permits_count is null then null
            else (pc.backup_permits_count::numeric / hc.homes_gated) * 1000
        end as backup_intent_rate,
        pc.permit_source_ids,
        case
            when hc.homes_gated = 0 then 'no_gated_homes_in_block_group'
            when not pl.any_rules_labels then 'permits_not_loaded'
            when pc.any_permits_count is null then 'no_permit_coverage'
            else null
        end as backup_intent_null_reason
    from bg_home_counts hc
    left join bg_permit_counts pc on pc.block_group_geoid = hc.block_group_geoid
    cross join permits_loaded pl
),
raw as (
    select
        b.prop_id,
        b.geo_id,
        b.block_group_geoid,
        b.county_fips,
        b.situs_zip,
        g.gate_reason,
        g.territory_eia_id,
        g.territory_null_reason,
        r.distributor_saidi,
        r.distributor_saidi_year,
        r.distributor_saidi_early_release,
        r.distributor_name,
        r.distributor_saidi_null_reason,
        f.flood_flag,
        f.flood_null_reason,
        e.empower_rate,
        e.empower_null_reason,
        a.acs_pct_65_plus,
        a.acs_65_null_reason,
        a.acs_pct_electric_heat,
        a.acs_heat_null_reason,
        bb.backup_intent_rate,
        bb.backup_intent_null_reason,
        array(
            select distinct s from unnest(
                array[
                    b.parcel_source_id, b.geom_source_id, b.bg_source_id,
                    g.territory_source_id, g.crosswalk_source_id,
                    r.reliability_source_id, f.flood_source_id,
                    e.empower_source_id, a.acs_source_id
                ] || coalesce(bb.permit_source_ids, array[]::uuid[])
            ) s where s is not null
        ) as source_ids
    from base b
    join gate g on g.prop_id = b.prop_id
    left join reliability r on r.prop_id = b.prop_id
    left join flood f on f.prop_id = b.prop_id
    left join empower e on e.prop_id = b.prop_id
    left join acs a on a.prop_id = b.prop_id
    left join bg_backup bb on bb.block_group_geoid = b.block_group_geoid
),
-- percent_rank() over (order by x) sorts NULLs last and counts them in
-- N, which would compress the real (non-null) values into a sub-range
-- of 0..1 instead of spanning it. Partitioning by "is x null" first
-- ranks the non-null and null values separately; only the non-null
-- partition's rank is ever selected below (raw.x is not null guards
-- every use), so the null partition's (unused) rank value doesn't matter.
gated as (
    select
        prop_id,
        percent_rank() over (partition by (distributor_saidi is null) order by distributor_saidi)      as pr_saidi,
        percent_rank() over (partition by (flood_flag is null) order by flood_flag::int)                as pr_flood,
        percent_rank() over (partition by (empower_rate is null) order by empower_rate)                 as pr_empower,
        percent_rank() over (partition by (acs_pct_65_plus is null) order by acs_pct_65_plus)            as pr_acs65,
        percent_rank() over (partition by (acs_pct_electric_heat is null) order by acs_pct_electric_heat) as pr_acsheat,
        percent_rank() over (partition by (backup_intent_rate is null) order by backup_intent_rate)      as pr_backup
    from raw
    where gate_reason is null
)
select
    raw.prop_id,
    raw.geo_id,
    raw.block_group_geoid,
    raw.county_fips,
    raw.situs_zip,
    raw.gate_reason,
    raw.territory_eia_id,
    raw.territory_null_reason,
    raw.distributor_saidi,
    raw.distributor_saidi_year,
    raw.distributor_saidi_early_release,
    raw.distributor_name,
    raw.distributor_saidi_null_reason,
    (case when raw.distributor_saidi is not null then gated.pr_saidi end) as distributor_saidi_pctile,
    raw.flood_flag,
    raw.flood_null_reason,
    (case when raw.flood_flag is not null then gated.pr_flood end) as flood_pctile,
    raw.empower_rate,
    raw.empower_null_reason,
    (case when raw.empower_rate is not null then gated.pr_empower end) as empower_pctile,
    raw.acs_pct_65_plus,
    raw.acs_65_null_reason,
    (case when raw.acs_pct_65_plus is not null then gated.pr_acs65 end) as acs_65_pctile,
    raw.acs_pct_electric_heat,
    raw.acs_heat_null_reason,
    (case when raw.acs_pct_electric_heat is not null then gated.pr_acsheat end) as acs_heat_pctile,
    raw.backup_intent_rate,
    raw.backup_intent_null_reason,
    (case when raw.backup_intent_rate is not null then gated.pr_backup end) as backup_intent_pctile,
    raw.source_ids
from raw
left join gated on gated.prop_id = raw.prop_id;

create unique index mv_home_signals_prop_id_idx on core.mv_home_signals (prop_id);
create index mv_home_signals_gate_reason_idx on core.mv_home_signals (gate_reason) where gate_reason is null;
create index mv_home_signals_county_fips_idx on core.mv_home_signals (county_fips);
create index mv_home_signals_bg_geoid_idx on core.mv_home_signals (block_group_geoid);

comment on materialized view core.mv_home_signals is
    'Per-home gate flag/reason + need signals + percentile ranks (among '
    'gated homes only), built on core.mv_home_block_group. Every M2 '
    'source join is a LEFT JOIN, so this builds and is fully populated '
    'even before any M2-P* pipeline has loaded data — signals are null '
    'with an explicit *_null_reason instead. Never materializes a '
    'weighted score (see api.top_homes_weighted). Refreshed by '
    'core.refresh_all_scores(), called by pipelines/sources/'
    'refresh_scores.py after every load.';

revoke all on core.mv_home_signals from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- core.refresh_all_scores() — SQL-callable refresh, dependency order:
-- mv_home_block_group (0102) first, then mv_home_signals. Does NOT
-- refresh core.mv_blockgroup_scores/core.mv_top_homes (0102) — those are
-- retired as of this migration (left in place, un-refreshed, so
-- api.top_homes — the pre-existing view — keeps returning whatever it
-- last held rather than erroring). pipelines/sources/refresh_scores.py
-- should call `select core.refresh_all_scores()` instead of looping its
-- own MATERIALIZED_VIEWS list (a pipeline-side change outside this
-- migration's owned path).
-- ---------------------------------------------------------------------------

create or replace function core.refresh_all_scores() returns void
language plpgsql
as $$
begin
    refresh materialized view concurrently core.mv_home_block_group;
    refresh materialized view concurrently core.mv_home_signals;
    refresh materialized view concurrently core.mv_join_rate;
    -- core.mv_blockgroup_scores / core.mv_top_homes (0102) are retired
    -- by this ticket (core.mv_home_signals + api.top_homes_weighted
    -- replace their per-home semantics) but are kept refreshed for now,
    -- since the pre-existing api.top_homes view still reads
    -- core.mv_top_homes and the web app has not switched off it yet
    -- (M2-W1). Drop these two lines once M2-W1 lands.
    refresh materialized view concurrently core.mv_blockgroup_scores;
    refresh materialized view concurrently core.mv_top_homes;
end;
$$;

comment on function core.refresh_all_scores() is
    'Refreshes every score-pipeline materialized view in dependency '
    'order: core.mv_home_block_group, then core.mv_home_signals, then '
    'core.mv_join_rate, then (temporarily, for api.top_homes backward '
    'compatibility until M2-W1 lands) core.mv_blockgroup_scores and '
    'core.mv_top_homes. Must run outside an already-open transaction '
    '(REFRESH ... CONCURRENTLY cannot run inside one) — call it as its '
    'own statement, e.g. from an autocommit connection.';

-- ---------------------------------------------------------------------------
-- api.gate_counts — funnel counts per gate reason. Distinguishes a real
-- exclusion (gate_reason, e.g. territory_not_base_served) from an
-- unresolved gate (territory_null_reason, e.g. territories_not_loaded —
-- what M2-W1's "not loaded" render state keys off) from a home that
-- clears every gate ('passed'). Carries the source_ids of the
-- contributing homes for provenance. Zero rows (via HAVING) until
-- core.mv_home_signals has at least one row.
-- ---------------------------------------------------------------------------

create or replace view api.gate_counts as
select
    coalesce(s.gate_reason, s.territory_null_reason, 'passed') as reason,
    count(distinct s.prop_id)                                     as home_count,
    array_agg(distinct src)                                       as source_ids
from core.mv_home_signals s
left join lateral unnest(s.source_ids) as src on true
group by coalesce(s.gate_reason, s.territory_null_reason, 'passed')
having count(distinct s.prop_id) > 0;

comment on view api.gate_counts is
    'Gate funnel: home count per reason, from core.mv_home_signals. '
    'reason is one of: territory_not_base_served (a real exclusion — '
    'outside every territory, or inside one the crosswalk does not mark '
    'mapped=yes), territories_not_loaded / crosswalk_not_loaded (gate '
    'not yet resolvable — M2-W1''s "not loaded" state), or passed. Empty '
    'until core.mv_home_signals has rows; returns zero rows, not an '
    'error. The upstream single-family/homestead parcel gate (applied '
    'before a home ever reaches core.mv_home_block_group) is counted '
    'separately by api.parcel_gate_counts (0101_m1.sql).';

-- ---------------------------------------------------------------------------
-- api.top_homes_weighted(weights, county_fips) — score v1: weighted mean
-- of percentile ranks over each home's AVAILABLE signals (never
-- materialized — see core.mv_home_signals comment). Only gated homes
-- (gate_reason is null) are candidates.
--
-- Named top_homes_weighted, not top_homes: api.top_homes already exists
-- as a plain view (0101_m1.sql, redefined in 0102_m1_materialize.sql)
-- reading core.mv_top_homes, which this migration deliberately leaves
-- untouched for backward compatibility (see file header). Postgres
-- keeps relation names (views/tables) and function names in separate
-- namespaces, so `api.top_homes` (no args, a view) and
-- `api.top_homes_weighted(jsonb, text)` (a function) could in principle
-- coexist without a name collision — but the ticket calls for the
-- distinct name explicitly, so M2-W1 (the slider UI) calls
-- api.top_homes_weighted, not api.top_homes.
--
-- weights keys (all optional; a home's score = sum(w_i * p_i) /
-- sum(w_i) over signals with a non-null percentile only):
--   outage         -> distributor_saidi_pctile
--   flood          -> flood_pctile
--   empower        -> empower_pctile
--   age65          -> acs_65_pctile
--   electric_heat  -> acs_heat_pctile
--   backup_intent  -> backup_intent_pctile
-- ---------------------------------------------------------------------------

create or replace function api.top_homes_weighted(weights jsonb, p_county_fips text default null)
returns table (
    prop_id                       text,
    geo_id                        text,
    situs_num                     text,
    situs_street                  text,
    situs_city                    text,
    situs_zip                     text,
    market_value                  numeric,
    block_group_geoid             text,
    county_fips                   text,
    score                         numeric,
    reasons                       text[],
    territory_eia_id              text,
    distributor_name              text,
    distributor_saidi             numeric,
    distributor_saidi_year        int,
    distributor_saidi_early_release boolean,
    flood_flag                    boolean,
    empower_rate                  numeric,
    acs_pct_65_plus                numeric,
    acs_pct_electric_heat          numeric,
    backup_intent_rate             numeric,
    source_ids                     uuid[]
)
language sql
stable
as $$
    -- Weight per signal, read from the jsonb argument exactly once
    -- (no COALESCE-to-0, per scripts/no_mock_check.py check 6 — a
    -- missing key just means the CASE below falls through to 0).
    with w as (
        select
            (case when weights ? 'outage'        then (weights ->> 'outage')::numeric        else 0 end) as w_outage,
            (case when weights ? 'flood'          then (weights ->> 'flood')::numeric          else 0 end) as w_flood,
            (case when weights ? 'empower'        then (weights ->> 'empower')::numeric        else 0 end) as w_empower,
            (case when weights ? 'age65'          then (weights ->> 'age65')::numeric          else 0 end) as w_age65,
            (case when weights ? 'electric_heat'  then (weights ->> 'electric_heat')::numeric  else 0 end) as w_heat,
            (case when weights ? 'backup_intent'  then (weights ->> 'backup_intent')::numeric  else 0 end) as w_backup
    ),
    scored as (
        select
            s.*,
            (
                case when s.distributor_saidi_pctile is not null then w.w_outage * s.distributor_saidi_pctile else 0 end
                + case when s.flood_pctile is not null then w.w_flood * s.flood_pctile else 0 end
                + case when s.empower_pctile is not null then w.w_empower * s.empower_pctile else 0 end
                + case when s.acs_65_pctile is not null then w.w_age65 * s.acs_65_pctile else 0 end
                + case when s.acs_heat_pctile is not null then w.w_heat * s.acs_heat_pctile else 0 end
                + case when s.backup_intent_pctile is not null then w.w_backup * s.backup_intent_pctile else 0 end
            ) as weighted_sum,
            (
                case when s.distributor_saidi_pctile is not null then w.w_outage else 0 end
                + case when s.flood_pctile is not null then w.w_flood else 0 end
                + case when s.empower_pctile is not null then w.w_empower else 0 end
                + case when s.acs_65_pctile is not null then w.w_age65 else 0 end
                + case when s.acs_heat_pctile is not null then w.w_heat else 0 end
                + case when s.backup_intent_pctile is not null then w.w_backup else 0 end
            ) as weight_sum
        from core.mv_home_signals s
        cross join w
        where s.gate_reason is null
          and (p_county_fips is null or s.county_fips = p_county_fips)
    ),
    ranked as (
        select
            scored.*,
            (weighted_sum / weight_sum)::numeric as final_score
        from scored
        where weight_sum > 0
        order by final_score desc, backup_intent_rate desc nulls last, prop_id
        limit 50
    )
    select
        r.prop_id,
        p.geo_id,
        p.situs_num,
        p.situs_street,
        p.situs_city,
        p.situs_zip,
        p.market_value,
        r.block_group_geoid,
        r.county_fips,
        r.final_score as score,
        (
            select array_agg(c.label order by c.contrib desc)
            from (
                select label, contrib
                from (values
                    ('outage',        case when r.distributor_saidi_pctile is not null and r.weight_sum > 0
                                          then (select w_outage from w) * r.distributor_saidi_pctile end),
                    ('flood',          case when r.flood_pctile is not null
                                          then (select w_flood from w) * r.flood_pctile end),
                    ('empower',        case when r.empower_pctile is not null
                                          then (select w_empower from w) * r.empower_pctile end),
                    ('age65',          case when r.acs_65_pctile is not null
                                          then (select w_age65 from w) * r.acs_65_pctile end),
                    ('electric_heat',  case when r.acs_heat_pctile is not null
                                          then (select w_heat from w) * r.acs_heat_pctile end),
                    ('backup_intent',  case when r.backup_intent_pctile is not null
                                          then (select w_backup from w) * r.backup_intent_pctile end)
                ) as t(label, contrib)
                where contrib is not null and contrib > 0
                order by contrib desc
                limit 3
            ) c
        ) as reasons,
        r.territory_eia_id,
        r.distributor_name,
        r.distributor_saidi,
        r.distributor_saidi_year,
        r.distributor_saidi_early_release,
        r.flood_flag,
        r.empower_rate,
        r.acs_pct_65_plus,
        r.acs_pct_electric_heat,
        r.backup_intent_rate,
        r.source_ids
    from ranked r
    join core.parcels p on p.prop_id = r.prop_id
    order by r.final_score desc, r.backup_intent_rate desc nulls last, r.prop_id;
$$;

comment on function api.top_homes_weighted(jsonb, text) is
    'Score v1: score = sum(w_i * p_i) / sum(w_i) over each home''s '
    'AVAILABLE percentile signals (from core.mv_home_signals, never '
    'materialized weighted), top-3 contributing (nonzero) signals as '
    'reasons, gated homes only, ordered deterministically (score, then '
    'backup_intent_rate, then prop_id — needed for M2-W1''s rank-change '
    'indicator to be meaningful when most signals are still unloaded '
    'and many homes tie), limit 50. Returns the raw signal values '
    '(distributor name/SAIDI/year, flood flag, emPOWER rate, ACS '
    'shares, backup-intent rate) alongside score so M2-W1 can label '
    'outage exposure as "this distributor''s SAIDI in this year", never '
    'a county total. Named _weighted (not api.top_homes) because '
    'api.top_homes already names a pre-existing view — see the '
    'function-definition comment above. With only backup_intent '
    'currently populated (M2-P* pipelines not yet run), score equals '
    'backup_intent''s own percentile whenever w_backup > 0 and every '
    'other weight is 0 or its signal is null; different weight sets '
    'cannot change the order until a second signal loads, and an '
    'all-zero-weight call returns zero rows (weight_sum > 0 required).';

revoke all on function api.top_homes_weighted(jsonb, text) from public, anon, authenticated;
grant execute on function api.top_homes_weighted(jsonb, text) to service_role;

-- ---------------------------------------------------------------------------
-- core.mv_join_rate — api.join_rate (0101_m1.sql) recomputed the
-- tcad_id -> parcels.geo_id match rate live on every request (~6.5 s
-- over the full permits/parcels tables). Precomputed here into a
-- single-row materialized view, refreshed by core.refresh_all_scores().
-- A unique index on a constant expression is enough for
-- REFRESH CONCURRENTLY to work on a always-exactly-one-row mv.
-- ---------------------------------------------------------------------------

drop materialized view if exists core.mv_join_rate cascade;

create materialized view core.mv_join_rate as
with permits_with_tcad as (
    select pm.permit_number, pm.tcad_id, pm.source_id
    from core.permits pm
    where pm.tcad_id is not null
),
matched as (
    select pwt.permit_number, pwt.source_id
    from permits_with_tcad pwt
    where exists (select 1 from core.parcels p where p.geo_id = pwt.tcad_id)
)
select
    true as singleton,
    (select count(*) from permits_with_tcad) as permits_with_tcad_id,
    (select count(*) from matched) as matched_to_parcels,
    case
        when (select count(*) from permits_with_tcad) = 0 then null
        else (select count(*) from matched)::numeric / (select count(*) from permits_with_tcad)
    end as join_rate,
    case
        when (select count(*) from permits_with_tcad) = 0 then 'no_permits_loaded_yet'
        else null
    end as join_rate_null_reason,
    array(select distinct source_id from permits_with_tcad where source_id is not null) as source_ids;

-- REFRESH ... CONCURRENTLY needs a unique index on real column(s), not
-- an expression and not partial — `singleton` is always `true` (exactly
-- one row) but is a plain boolean column, which qualifies.
create unique index mv_join_rate_singleton_idx on core.mv_join_rate (singleton);

comment on materialized view core.mv_join_rate is
    'Precomputed api.join_rate (was a live ~6.5 s recompute on every '
    'request in 0101_m1.sql). Always exactly one row. Refreshed by '
    'core.refresh_all_scores().';

revoke all on core.mv_join_rate from public, anon, authenticated;

create or replace view api.join_rate as
select
    permits_with_tcad_id,
    matched_to_parcels,
    join_rate,
    join_rate_null_reason,
    source_ids
from core.mv_join_rate;

comment on view api.join_rate is
    'Permits with a tcad_id that match a core.parcels.geo_id, over all '
    'permits carrying a tcad_id — served from core.mv_join_rate '
    '(materialized, refreshed by core.refresh_all_scores(); was a live '
    '~6.5 s recompute). Always one row; join_rate is null with a reason '
    'until permits are loaded.';

-- ---------------------------------------------------------------------------
-- api.county_outage gains hours_per_customer = customer_hours_out /
-- core.county_customers.customers (new table, filled by M2-P7). Existing
-- columns/order preserved (CREATE OR REPLACE VIEW requires this); the
-- two new columns are appended.
-- ---------------------------------------------------------------------------

create or replace view api.county_outage as
select
    o.county_fips,
    o.year,
    o.customer_hours_out,
    array(
        select distinct s from unnest(o.source_ids || coalesce(array[c.source_id], array[]::uuid[])) s
        where s is not null
    ) as source_ids,
    o.customer_hours_out_null_reason,
    case
        when o.customer_hours_out is null then null
        when c.customers is null or c.customers = 0 then null
        else o.customer_hours_out / c.customers
    end as hours_per_customer,
    case
        when o.customer_hours_out is null then o.customer_hours_out_null_reason
        when c.customers is not null and c.customers > 0 then null
        when (select count(*) from core.county_customers) = 0 then 'county_customers_not_loaded'
        else 'no_customer_count_for_county'
    end as hours_per_customer_null_reason
from core.outage_county_year o
left join core.county_customers c on c.county_fips = o.county_fips;

comment on view api.county_outage is
    'County-year outage figure with explicit source_ids for provenance, '
    'plus hours_per_customer = customer_hours_out / '
    'core.county_customers.customers (EAGLE-I MCC.csv, M2-P7). Never a '
    'home''s value — a county total (per the real-data rule, a home''s '
    'outage exposure is its distributor''s SAIDI, core.mv_home_signals.'
    'distributor_saidi). Empty until M0-P1 loads EAGLE-I; queries return '
    'zero rows, not an error.';

-- ---------------------------------------------------------------------------
-- Grants: service_role only. Re-assert (idempotent) so every new/changed
-- api object is covered.
-- ---------------------------------------------------------------------------

revoke all on all tables in schema api from public, anon, authenticated;
grant select on all tables in schema api to service_role;

commit;
