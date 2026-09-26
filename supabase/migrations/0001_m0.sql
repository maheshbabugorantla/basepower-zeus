-- 0001_m0.sql — M0-S1: ops/core/api schemas, source manifest, outage-by-county contract
--
-- Idempotent-safe: every DDL statement uses IF NOT EXISTS / CREATE OR REPLACE /
-- ON CONFLICT so this file can be re-applied to the same database without error
-- or duplication. The whole file is intended to run inside one transaction
-- (BEGIN/COMMIT below) so a partial failure never leaves a half-applied schema.
--
-- Real-data rule: this migration creates no data rows for outages, permits, or
-- any other signal. The only rows it seeds are `ops.refresh_policy`, which is
-- static configuration (refresh-cycle policy per publisher), not observed data.

begin;

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

create extension if not exists postgis with schema extensions;

-- ---------------------------------------------------------------------------
-- Schemas
-- ---------------------------------------------------------------------------

create schema if not exists ops;
create schema if not exists core;
create schema if not exists api;

-- ---------------------------------------------------------------------------
-- ops.source_manifest — one row per raw file retrieved from a public source.
-- Every row in Storage bucket `raw` must have exactly one row here (check 1).
-- ---------------------------------------------------------------------------

create table if not exists ops.source_manifest (
    id           uuid primary key default gen_random_uuid(),
    source       text not null,
    url          text not null,
    retrieved_at timestamptz not null,
    sha256       text not null,
    bytes        bigint not null,
    rows         bigint,
    runner       text not null check (runner in ('cron', 'cli')),
    storage_key  text not null,
    created_at   timestamptz not null default now()
);

create index if not exists source_manifest_source_idx
    on ops.source_manifest (source, retrieved_at desc);

comment on table ops.source_manifest is
    'One row per raw file downloaded from a public source and stored unchanged '
    'in the private Storage bucket `raw`. storage_key is the bucket object path.';

-- ---------------------------------------------------------------------------
-- ops.pipeline_runs — one row per pipeline invocation (cron call or CLI
-- backfill chunk). Holds a resumable cursor for chunked backfills.
-- ---------------------------------------------------------------------------

create table if not exists ops.pipeline_runs (
    id             uuid primary key default gen_random_uuid(),
    source         text not null,
    status         text not null check (status in ('running', 'success', 'failed')),
    cursor         jsonb,
    rows_in        bigint,
    rows_loaded    bigint,
    filter_drops   jsonb,
    runner         text not null check (runner in ('cron', 'cli')),
    started_at     timestamptz not null default now(),
    finished_at    timestamptz,
    error          text,
    created_at     timestamptz not null default now()
);

-- Re-apply-safe: add columns that were not present in an already-applied
-- earlier version of this table (CREATE TABLE IF NOT EXISTS above is a no-op
-- once the table exists, so new columns must be added explicitly).
alter table ops.pipeline_runs
    add column if not exists manifest_id uuid references ops.source_manifest (id);

comment on column ops.pipeline_runs.manifest_id is
    'The specific ops.source_manifest row this run loaded from, when a source '
    'is split across multiple raw files (e.g. one EAGLE-I file per year). '
    'Nullable: a run may cover a source as a whole rather than one file.';

create index if not exists pipeline_runs_source_idx
    on ops.pipeline_runs (source, started_at desc);

comment on table ops.pipeline_runs is
    'One row per pipeline invocation. cursor is the resumable position for a '
    'chunked backfill; filter_drops records per-filter dropped-row counts as '
    'jsonb ({"filter_name": count, ...}) so reconcile can check rows_loaded = '
    'rows_in - sum(filter_drops).';

-- ---------------------------------------------------------------------------
-- ops.refresh_policy — configuration, not data: the refresh cycle (in days)
-- each publisher's source is expected to be re-pulled at. Seeded here per the
-- spec: permits 7 d, ERCOT 1 d, emPOWER monthly, everything else is a
-- backfill-only source with no expected refresh cycle (null).
-- ---------------------------------------------------------------------------

create table if not exists ops.refresh_policy (
    source             text primary key,
    refresh_cycle_days numeric,
    note               text
);

comment on table ops.refresh_policy is
    'Static configuration: expected refresh cycle per source, in days. Null '
    'means backfill-only (no recurring refresh expected). Seeded by this '
    'migration; not observed data.';

-- Source keys match the --source values used by `pipelines.check` across the
-- ticket graph (grepped from tickets/M0 … M4) so this table stays a working
-- lookup, not just documentation.
-- no-mock-check: config-seed refresh cycles are the team's freshness policy from the spec, not source data
insert into ops.refresh_policy (source, refresh_cycle_days, note) values
    ('austin_permits',      7,    'Austin Issued Construction Permits — daily cron, 7 d policy per spec'),
    ('ercot_spp',           1,    'ERCOT settlement point prices — daily cron, 1 d policy per spec'),
    ('empower',             30,   'HHS emPOWER Map — monthly cron'),
    ('zcta',                30,   'Census ZCTA boundaries backing emPOWER — monthly, tracks empower'),
    ('eaglei',              null, 'EAGLE-I outages 2014-2024 — backfill only, one file per year'),
    ('parcels',             null, 'TxGIO StratMap land parcels — backfill only, refreshed ~yearly upstream'),
    ('tiger_bg',            null, 'Census TIGER/Line block groups — backfill only'),
    ('territories',         null, 'Electric retail service territories (HIFLD) — backfill only'),
    ('base_service_areas',  null, 'Base service areas markdown snapshot — backfill only'),
    ('acs',                 null, 'Census ACS 5-year — backfill only'),
    ('fema_flood',          null, 'FEMA National Flood Hazard Layer — backfill only'),
    ('county_loadzone',     null, 'County-to-ERCOT-loadzone crosswalk — backfill only, derived'),
    ('ahj_facts',           null, 'AHJ (permitting authority) facts — backfill only, derived'),
    ('nrel_euld',           null, 'NREL End-Use Load Profiles — backfill only, stretch')
on conflict (source) do update
    set refresh_cycle_days = excluded.refresh_cycle_days,
        note                = excluded.note;

-- Converge to exactly this key set on re-apply: drop any source key that was
-- seeded by an earlier version of this migration and later renamed (config,
-- not data — safe to delete and re-seed).
delete from ops.refresh_policy
where source not in (
    'austin_permits', 'ercot_spp', 'empower', 'zcta', 'eaglei', 'parcels',
    'tiger_bg', 'territories', 'base_service_areas', 'acs', 'fema_flood',
    'county_loadzone', 'ahj_facts', 'nrel_euld'
);

-- ---------------------------------------------------------------------------
-- core.outage_county_year — EAGLE-I 15-minute customer-outage records
-- aggregated to customer-hours-without-power per Texas county per year.
-- ---------------------------------------------------------------------------

create table if not exists core.outage_county_year (
    county_fips         text not null,
    year                 int not null,
    customer_hours_out   numeric,
    source_ids           uuid[] not null,
    created_at           timestamptz not null default now(),
    primary key (county_fips, year)
);

-- Re-apply-safe column addition (see note on ops.pipeline_runs above).
alter table core.outage_county_year
    add column if not exists customer_hours_out_null_reason text;

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'outage_county_year_value_or_reason'
    ) then
        alter table core.outage_county_year
            add constraint outage_county_year_value_or_reason
            check (customer_hours_out is not null or customer_hours_out_null_reason is not null);
    end if;
end $$;

comment on table core.outage_county_year is
    'Customer-hours without power per Texas county per year, aggregated from '
    'EAGLE-I 15-minute records. customer_hours_out is null (never zero-filled) '
    'when a county-year was not loaded; customer_hours_out_null_reason then '
    'records why. source_ids references ops.source_manifest.id (array, since '
    'a year may span multiple raw files).';

-- ---------------------------------------------------------------------------
-- Row-level security: enabled on every ops/core table, with NO policies —
-- i.e. no anon or authenticated access at all. service_role (which bypasses
-- RLS in Supabase) is the only role that can read or write these tables.
-- ---------------------------------------------------------------------------

alter table ops.source_manifest    enable row level security;
alter table ops.pipeline_runs      enable row level security;
alter table ops.refresh_policy     enable row level security;
alter table core.outage_county_year enable row level security;

revoke all on ops.source_manifest     from public, anon, authenticated;
revoke all on ops.pipeline_runs       from public, anon, authenticated;
revoke all on ops.refresh_policy      from public, anon, authenticated;
revoke all on core.outage_county_year from public, anon, authenticated;

revoke all on schema ops  from public, anon, authenticated;
revoke all on schema core from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- api.county_outage — every row carries its source_id(s); this is the only
-- view the web app reads for county outage figures.
-- ---------------------------------------------------------------------------

create or replace view api.county_outage as
select
    county_fips,
    year,
    customer_hours_out,
    source_ids,
    customer_hours_out_null_reason
from core.outage_county_year;

comment on view api.county_outage is
    'County-year outage figure with explicit source_ids for provenance. '
    'Empty until M0-P1 loads EAGLE-I; queries return zero rows, not an error.';

-- ---------------------------------------------------------------------------
-- api.source_freshness — last successful run per source + its refresh cycle,
-- for the top-bar freshness summary. Driven off ops.refresh_policy so every
-- known source appears even before it has ever run.
-- ---------------------------------------------------------------------------

create or replace view api.source_freshness as
with all_sources as (
    select source from ops.refresh_policy
    union
    select source from ops.pipeline_runs
    union
    select source from ops.source_manifest
),
last_success as (
    select
        source,
        max(finished_at) as last_success_at
    from ops.pipeline_runs
    where status = 'success'
    group by source
),
latest_manifest as (
    select distinct on (source)
        source,
        id as source_id
    from ops.source_manifest
    order by source, retrieved_at desc
)
select
    a.source,
    p.refresh_cycle_days,
    ls.last_success_at,
    case
        when ls.last_success_at is null then null
        when p.refresh_cycle_days is null then false
        else ls.last_success_at < now() - (p.refresh_cycle_days || ' days')::interval
    end as is_stale,
    lm.source_id as latest_source_id,
    case
        when ls.last_success_at is null then 'not_loaded'
        when p.refresh_cycle_days is null then 'no_cycle'
        when ls.last_success_at < now() - (p.refresh_cycle_days || ' days')::interval then 'stale'
        else 'fresh'
    end as status
from all_sources a
left join ops.refresh_policy p on p.source = a.source
left join last_success ls on ls.source = a.source
left join latest_manifest lm on lm.source = a.source;

comment on view api.source_freshness is
    'One row per known source (union of ops.refresh_policy, ops.pipeline_runs, '
    'ops.source_manifest, so a source-name mismatch is visible instead of '
    'silently dropped): last successful run, its refresh cycle, and a status '
    'of not_loaded / no_cycle / stale / fresh. is_stale is null (not false) '
    'until the source has a successful run, per the never-zero-fill rule. '
    'latest_source_id is the newest ops.source_manifest row for the source, '
    'for provenance; refresh_cycle_days itself is static configuration with '
    'no manifest row and is exempt from the provenance check.';

-- ---------------------------------------------------------------------------
-- api.sources — every manifest row with its latest pipeline run, for the
-- Sources page (dataset, url, retrieved_at, sha256, rows, runner, latest run).
-- ---------------------------------------------------------------------------

create or replace view api.sources as
with latest_run as (
    select distinct on (source)
        source,
        id          as run_id,
        status,
        started_at,
        finished_at,
        rows_in,
        rows_loaded
    from ops.pipeline_runs
    order by source, started_at desc
)
select
    sm.id           as source_id,
    sm.source,
    sm.url,
    sm.retrieved_at,
    sm.sha256,
    sm.bytes,
    sm.rows,
    sm.runner,
    sm.storage_key,
    lr.run_id       as latest_run_id,
    lr.status       as latest_run_status,
    lr.started_at   as latest_run_started_at,
    lr.finished_at  as latest_run_finished_at,
    lr.rows_in      as latest_run_rows_in,
    lr.rows_loaded  as latest_run_rows_loaded
from ops.source_manifest sm
left join latest_run lr on lr.source = sm.source;

comment on view api.sources is
    'Every ops.source_manifest row joined to its latest ops.pipeline_runs row. '
    'Empty until a pipeline runs; queries return zero rows, not an error.';

-- ---------------------------------------------------------------------------
-- Grants: service_role only. No anon or authenticated access to schema api.
-- ---------------------------------------------------------------------------

revoke all on schema api from public, anon, authenticated;
grant usage on schema api to service_role;

revoke all on all tables in schema api from public, anon, authenticated;
grant select on all tables in schema api to service_role;

alter default privileges in schema api grant select on tables to service_role;

-- ---------------------------------------------------------------------------
-- Storage: private bucket `raw`, 2 GiB per-object limit (EAGLE-I 2024 file is
-- 1.44 GB). No public access, no anon/authenticated policies are created.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit)
values ('raw', 'raw', false, 2147483648)
on conflict (id) do update
    set public          = excluded.public,
        file_size_limit = excluded.file_size_limit;

commit;
