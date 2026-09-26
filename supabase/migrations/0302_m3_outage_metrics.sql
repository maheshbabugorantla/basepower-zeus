-- M3-P3 — core.outage_metrics_county: per-county EAGLE-I outage metrics
-- computed by pipelines/sources/eaglei_metrics.py, streamed directly from
-- the raw EAGLE-I CSVs (not derived from core.outage_county_year, which
-- only holds annual customer-hours totals with no event/peak detail).
--
-- One row per (county_fips, metric). metric values currently written by
-- eaglei_metrics.py, one set per county:
--   longest_event_hours            -- longest run of consecutive 15-min
--                                      snapshots with customers_out > 0,
--                                      in the latest year (2025)
--   longest_event_peak_customers   -- peak customers_out within that run
--   longest_event_start_epoch      -- run's first snapshot, unix seconds UTC
--   longest_event_end_epoch        -- run's last snapshot, unix seconds UTC
--   beryl_2024_07_peak_customers   -- peak customers_out in July 2024
--                                      (Hurricane Beryl), from the 2024 file
--   beryl_2024_07_peak_share       -- that peak / the file's own
--                                      total_customers for the same row
--                                      (can exceed 1.0 for Harris in the
--                                      real EAGLE-I 2024 file during Beryl
--                                      -- a genuine data anomaly, not
--                                      clamped or corrected here)
--
-- value is null (never zero) with value_null_reason set when a metric
-- could not be computed (e.g. a county absent from a file). unit and
-- period are plain-words labels, not enums, since new metrics may be
-- added without a migration. source_ids traces to the exact
-- ops.source_manifest row(s) (the 2025 file for longest_event_*, the 2024
-- file for beryl_2024_07_*).

create table if not exists core.outage_metrics_county (
    county_fips       text not null,
    metric            text not null,
    value             numeric,
    value_null_reason text,
    unit              text not null,
    period            text not null,
    source_ids        uuid[] not null,
    created_at        timestamptz not null default now(),
    primary key (county_fips, metric)
);

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'outage_metrics_county_value_or_reason'
    ) then
        alter table core.outage_metrics_county
            add constraint outage_metrics_county_value_or_reason
            check (value is not null or value_null_reason is not null);
    end if;
end $$;

comment on table core.outage_metrics_county is
    'Per-county EAGLE-I outage metrics (longest continuous outage event in '
    'the latest year, July 2024 Hurricane Beryl peak) computed directly '
    'from streamed raw EAGLE-I CSV rows by pipelines/sources/eaglei_metrics.py. '
    'value is null with value_null_reason when not computed for that county; '
    'never zero-filled. source_ids references ops.source_manifest.id.';

alter table core.outage_metrics_county enable row level security;
revoke all on core.outage_metrics_county from public, anon, authenticated;
grant select on core.outage_metrics_county to zeus_web_ro;
drop policy if exists web_ro_select on core.outage_metrics_county;
create policy web_ro_select on core.outage_metrics_county for select to zeus_web_ro using (true);

-- ---------------------------------------------------------------------------
-- api.outage_metrics_county — passthrough view, the only one the web app
-- reads for these figures (same convention as api.county_outage).
-- ---------------------------------------------------------------------------

create or replace view api.outage_metrics_county as
select
    county_fips,
    metric,
    value,
    value_null_reason,
    unit,
    period,
    source_ids
from core.outage_metrics_county;

comment on view api.outage_metrics_county is
    'Per-county EAGLE-I outage metrics (longest continuous event, Beryl '
    'peak) with explicit source_ids for provenance. Empty until '
    'M3-P3''s eaglei_metrics pipeline runs.';

revoke all on api.outage_metrics_county from public, anon, authenticated;
grant select on api.outage_metrics_county to service_role;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'zeus_web_ro') then
        execute 'grant select on api.outage_metrics_county to zeus_web_ro';
    end if;
end $$;

-- ---------------------------------------------------------------------------
-- ops.refresh_policy — register eaglei_metrics (pipelines/sources/
-- eaglei_metrics.py), same convention as 0201_m2.sql's eaglei_mcc row:
-- backfill-only, since its inputs (the 2025 and 2024 EAGLE-I files) are
-- themselves backfill-only/annual.
-- ---------------------------------------------------------------------------

-- no-mock-check: config-seed refresh cycle is the team's freshness policy, not source data
insert into ops.refresh_policy (source, refresh_cycle_days, note) values
    ('eaglei_metrics', null, 'Per-county longest-event + Beryl-peak metrics from the 2025/2024 EAGLE-I files — backfill only')
on conflict (source) do update
    set refresh_cycle_days = excluded.refresh_cycle_days,
        note                = excluded.note;
