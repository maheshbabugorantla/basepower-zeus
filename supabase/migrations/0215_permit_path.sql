-- M2-P9 (data half, P9a): permit timelines + permit-path risk stats per
-- jurisdiction, from the ALREADY-manifested Austin permits raw file
-- (data/raw/austin_permits/austin_permits_<date>.jsonl -- no new
-- download; pipelines/sources/permit_timelines.py reuses austin_permits'
-- existing ops.source_manifest row as source_id on every row here), plus
-- core.permit_rules, a small hand-curated cited source (SB 1252, Austin
-- Energy's ESS permit requirement, unincorporated Travis fire code),
-- loaded like core.retail_market from data/manual/permit_rules.csv.
--
-- This migration does NOT touch core.mv_home_signals, any scoring
-- function, or api.home_score_breakdown -- another agent (M2-P9b) wires
-- permit_risk into scoring and the per-home permit_path in a later pass.

-- ---------------------------------------------------------------------------
-- core.permit_timelines -- one row per permit that core.permit_labels
-- (labeller='rules') has classified battery/generator/solar/panel/ev.
-- ---------------------------------------------------------------------------

create table if not exists core.permit_timelines (
    permit_number           text primary key references core.permits (permit_number),
    tcad_id                 text,
    label                   text not null check (label in ('battery', 'generator', 'solar', 'panel', 'ev')),
    applied_date            date,
    issued_date             date,
    days_to_issue           integer,
    issue_method            text,
    status_current          text,
    jurisdiction            text,
    contractor_company_name text,
    is_base_power           boolean not null default false,
    source_id               uuid not null references ops.source_manifest (id),
    created_at              timestamptz not null default now()
);

create index if not exists permit_timelines_tcad_id_idx on core.permit_timelines (tcad_id);
create index if not exists permit_timelines_jurisdiction_idx on core.permit_timelines (jurisdiction);
create index if not exists permit_timelines_label_idx on core.permit_timelines (label);
create index if not exists permit_timelines_is_base_power_idx on core.permit_timelines (is_base_power) where is_base_power;

comment on table core.permit_timelines is
    'One row per Austin permit rules-labelled battery/generator/solar/panel/ev '
    '(core.permit_labels, labeller=''rules''), kept regardless of applied/'
    'issue date -- never date-filtered: tcad_id (indexed, joins '
    'core.parcels.geo_id -- the key a later ticket uses to match a permit '
    'to the home it was pulled for), applied/issued dates, days_to_issue, '
    'issue_method, status_current, the raw file''s own jurisdiction field, '
    'contractor_company_name, and is_base_power (an EXACT match on '
    'contractor_company_name = ''Base Power'', trimmed and '
    'case-insensitive -- ''Solid Base Electric, LLC'' is a different '
    'company and never matches). label is one representative label per '
    'permit (priority battery > generator > solar > panel > ev) -- a '
    'permit matching more than one label counts under every matching '
    'label in core.permit_path_stats, not just this one. Filled by '
    'pipelines/sources/permit_timelines.py (M2-P9), which reads the '
    'already-manifested austin_permits raw file directly (no new '
    'download) -- see source_id.';

-- ---------------------------------------------------------------------------
-- core.permit_path_stats -- median/p90 days-to-issue, share never finished
-- (Expired/Withdrawn/VOID), share issued online, and n, per
-- (jurisdiction, label, is_base_power, period_type, period). See the
-- pipelines/sources/permit_timelines.py module docstring for exactly
-- which combinations are filled and why.
-- ---------------------------------------------------------------------------

create table if not exists core.permit_path_stats (
    id                    uuid primary key default gen_random_uuid(),
    jurisdiction          text not null,
    label                 text not null,
    is_base_power         boolean not null default false,
    period_type           text not null check (period_type in ('sb1252', 'quarter')),
    period                text not null,
    n                     integer not null,
    median_days           numeric,
    p90_days              numeric,
    share_never_finished  numeric,
    share_issued_online   numeric,
    source_id             uuid not null references ops.source_manifest (id),
    updated_at            timestamptz not null default now(),
    unique (jurisdiction, label, is_base_power, period_type, period)
);

create index if not exists permit_path_stats_lookup_idx
    on core.permit_path_stats (jurisdiction, label, is_base_power, period_type);

comment on table core.permit_path_stats is
    'Permit-path risk stats per (jurisdiction, label, is_base_power, '
    'period_type, period). jurisdiction is the raw austin_permits file''s '
    'own jurisdiction value (e.g. ''AUSTIN FULL PURPOSE'') or ''ALL'' (every '
    'jurisdiction combined -- the citywide number product copy quotes). '
    'label is battery/generator/solar/panel/ev, or ''ALL'' (every one of '
    'Base Power''s own permits regardless of label, is_base_power=true '
    'rows only). period_type=''sb1252'': period in (''overall'', '
    '''before_sb1252'', ''after_sb1252'') by issue_date vs 2025-09-01. '
    'period_type=''quarter'': period=''YYYY-Qn'' by issue_date, '
    'jurisdiction=''ALL'' only. Filled by '
    'pipelines/sources/permit_timelines.py (M2-P9); refresh with '
    'core.refresh_permit_stats() after a new austin_permits backfill.';

-- ---------------------------------------------------------------------------
-- core.permit_rules -- small, hand-curated, cited rows: SB 1252, Austin
-- Energy's ESS auxiliary power electrical permit requirement, and
-- unincorporated Travis County's fire-code ESS standard. Loaded like
-- core.retail_market (0206_retail_market.sql) from
-- data/manual/permit_rules.csv: the CSV's own bytes are the raw file,
-- uploaded unchanged to Storage and recorded in ops.source_manifest.
-- ---------------------------------------------------------------------------

create table if not exists core.permit_rules (
    id            uuid primary key default gen_random_uuid(),
    authority     text not null,
    rule          text not null,
    value         text not null,
    source_url    text not null,
    quote         text not null,
    retrieved_at  timestamptz not null,
    source_id     uuid not null references ops.source_manifest (id),
    created_at    timestamptz not null default now(),
    unique (authority, rule)
);

create index if not exists permit_rules_authority_idx on core.permit_rules (authority);

comment on table core.permit_rules is
    'Hand-curated, cited permit/regulatory rules (Texas SB 1252, Austin '
    'Energy''s ESS auxiliary power electrical permit requirement, '
    'unincorporated Travis County fire code) from '
    'data/manual/permit_rules.csv, loaded like core.retail_market. Filled '
    'by pipelines/sources/permit_rules.py (M2-P9).';

-- ---------------------------------------------------------------------------
-- RLS + zeus_web_ro grants (pattern in 0210_web_readonly_role.sql /
-- 0206_retail_market.sql -- these tables didn't exist when 0210 ran, so
-- each needs its own copy of the policy; the CREATE/DROP POLICY calls are
-- guarded so a from-scratch replay in file order never errors).
-- ---------------------------------------------------------------------------

alter table core.permit_timelines  enable row level security;
alter table core.permit_path_stats enable row level security;
alter table core.permit_rules      enable row level security;

revoke all on core.permit_timelines  from public, anon, authenticated;
revoke all on core.permit_path_stats from public, anon, authenticated;
revoke all on core.permit_rules      from public, anon, authenticated;

do $$
begin
    if exists (select 1 from pg_roles where rolname = 'zeus_web_ro') then
        execute 'drop policy if exists web_ro_select on core.permit_timelines';
        execute 'create policy web_ro_select on core.permit_timelines for select to zeus_web_ro using (true)';
        execute 'drop policy if exists web_ro_select on core.permit_path_stats';
        execute 'create policy web_ro_select on core.permit_path_stats for select to zeus_web_ro using (true)';
        execute 'drop policy if exists web_ro_select on core.permit_rules';
        execute 'create policy web_ro_select on core.permit_rules for select to zeus_web_ro using (true)';
    end if;
end $$;

-- ---------------------------------------------------------------------------
-- api.permit_path_stats / api.permit_rules -- plain SELECTs over small,
-- indexed tables (no core.parcels scan, no request-time aggregation).
-- ---------------------------------------------------------------------------

create or replace view api.permit_path_stats as
select
    jurisdiction, label, is_base_power, period_type, period,
    n, median_days, p90_days, share_never_finished, share_issued_online,
    source_id
from core.permit_path_stats;

revoke all on api.permit_path_stats from public, anon, authenticated;
grant select on api.permit_path_stats to service_role;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'zeus_web_ro') then
        execute 'grant select on api.permit_path_stats to zeus_web_ro';
    end if;
end $$;

comment on view api.permit_path_stats is
    'core.permit_path_stats: median/p90 days-to-issue, share never '
    'finished, share issued online and n, per (jurisdiction, label, '
    'is_base_power, period_type, period). Look up by (jurisdiction, '
    'label, is_base_power, period_type, period) -- the table''s own '
    'unique index, well under 50 ms.';

create or replace view api.permit_rules as
select authority, rule, value, source_url, quote, retrieved_at, source_id
from core.permit_rules;

revoke all on api.permit_rules from public, anon, authenticated;
grant select on api.permit_rules to service_role;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'zeus_web_ro') then
        execute 'grant select on api.permit_rules to zeus_web_ro';
    end if;
end $$;

comment on view api.permit_rules is
    'core.permit_rules: SB 1252, Austin Energy''s ESS permit requirement, '
    'and unincorporated Travis fire code, each with its cited source_url '
    'and verbatim quote. Look up by authority -- a small table, full scan '
    'well under 50 ms.';

-- ---------------------------------------------------------------------------
-- core.refresh_permit_stats() -- NOT wired into core.refresh_all_scores();
-- call manually after a new austin_permits backfill or a
-- permit_timelines re-run. core.permit_path_stats is loaded directly by
-- pipelines/sources/permit_timelines.py (a plain table, not a materialized
-- view), so this function's only job is to report that -- it does no
-- work itself, since re-running the pipeline source is what actually
-- refreshes the data. Kept as a named hook so the orchestrator/refresh
-- policy has a single, documented entry point to call or schedule.
-- ---------------------------------------------------------------------------

create or replace function core.refresh_permit_stats() returns void
language plpgsql
as $$
begin
    -- core.permit_timelines / core.permit_path_stats are loaded directly
    -- by pipelines/sources/permit_timelines.py (python -m pipelines.run
    -- permit_timelines), not by a materialized view refresh -- this
    -- function is a documented no-op hook, not a real refresh path.
    raise notice 'core.refresh_permit_stats(): re-run `python -m pipelines.run permit_timelines` after a new austin_permits backfill to refresh core.permit_timelines / core.permit_path_stats.';
end;
$$;

comment on function core.refresh_permit_stats() is
    'Documented no-op: core.permit_timelines/core.permit_path_stats are '
    'loaded by re-running pipelines/sources/permit_timelines.py, not by a '
    'materialized view refresh. NOT wired into core.refresh_all_scores() '
    '-- the orchestrator owns that wiring (M2-P9).';

-- ---------------------------------------------------------------------------
-- ops.refresh_policy -- backfill/cron cadence, same convention as
-- retail_market and utility_crosswalk.
-- ---------------------------------------------------------------------------

-- no-mock-check: config-seed refresh cycle is the team's freshness policy from the spec, not source data
insert into ops.refresh_policy (source, refresh_cycle_days, note) values
    ('permit_timelines', null, 'core.permit_timelines / core.permit_path_stats (M2-P9) -- backfill/CLI only: RAW_DIR is a local absolute path, unreachable from a Vercel cron function; re-run manually after each austin_permits backfill'),
    ('permit_rules', null, 'data/manual/permit_rules.csv (M2-P9) -- backfill only, hand-curated and cited (SB 1252, Austin Energy, Travis County)')
on conflict (source) do update
    set refresh_cycle_days = excluded.refresh_cycle_days,
        note                = excluded.note;
