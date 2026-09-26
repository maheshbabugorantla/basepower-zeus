-- M2-W4: regulated ("not_deregulated", e.g. Austin Energy municipal — no
-- retail choice) vs deregulated (e.g. Oncor — customers pick a retail
-- provider) electricity market, per EIA-861 utility number.
--
-- Source: data/manual/retail_market.csv — a small, hand-curated, cited
-- file (Base's own basepowercompany.com pages: llms.txt and the
-- Cedar Park rate page), loaded like core.utility_crosswalk (M2-P6,
-- 0201_m2.sql): the CSV's own bytes are the raw file, uploaded unchanged
-- to Storage and recorded in ops.source_manifest, never re-derived.
--
-- core.retail_market is keyed by eia_utility_number, the same EIA-861
-- utility number core.mv_home_signals.territory_eia_id already carries
-- (via core.territories.eia_id) -- so both the home-page lookup and the
-- "Can Base serve this home?" split below are index/PK lookups, never a
-- new spatial join or a core.parcels scan.

create table if not exists core.retail_market (
    id                  uuid primary key default gen_random_uuid(),
    eia_utility_number  text not null,
    utility_name        text,
    retail_market       text not null check (retail_market in ('deregulated', 'not_deregulated')),
    plain_language       text not null,
    source_url          text not null,
    quote               text not null,
    retrieved_at        timestamptz not null,
    source_id           uuid not null references ops.source_manifest (id),
    created_at          timestamptz not null default now(),
    unique (eia_utility_number)
);

create index if not exists retail_market_eia_number_idx
    on core.retail_market (eia_utility_number);

comment on table core.retail_market is
    'Regulated (not_deregulated, e.g. Austin Energy municipal) vs '
    'deregulated (retail choice, e.g. Oncor) electricity market per '
    'EIA-861 utility number, from data/manual/retail_market.csv (Base''s '
    'own basepowercompany.com pages). Filled by M2-W4 '
    '(pipelines/sources/retail_market.py).';

alter table core.retail_market enable row level security;
revoke all on core.retail_market from public, anon, authenticated;

-- Same SELECT-only policy migration 0210 stamped on every RLS-enabled
-- core/ops table at the time it ran -- this table didn't exist yet, so
-- it needs its own copy here (0210's loop is not re-run automatically).
-- Guarded so a from-scratch replay in file order (0206 before 0210
-- creates the role) or a second run of this file never errors.
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'zeus_web_ro') then
        execute 'drop policy if exists web_ro_select on core.retail_market';
        execute 'create policy web_ro_select on core.retail_market for select to zeus_web_ro using (true)';
    end if;
end $$;

-- ---------------------------------------------------------------------------
-- api.retail_market -- single-row-by-eia_utility_number lookup for the
-- home page's market line (a unique-index lookup, well under 50 ms).
-- ---------------------------------------------------------------------------

create or replace view api.retail_market as
select
    eia_utility_number,
    utility_name,
    retail_market,
    plain_language,
    source_url,
    quote,
    retrieved_at,
    source_id
from core.retail_market;

revoke all on api.retail_market from public, anon, authenticated;
grant select on api.retail_market to service_role;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'zeus_web_ro') then
        execute 'grant select on api.retail_market to zeus_web_ro';
    end if;
end $$;

comment on view api.retail_market is
    'One row per EIA-861 utility number: deregulated vs not_deregulated, '
    'plus the plain-language line, Base''s cited quote and source URL '
    '(data/manual/retail_market.csv, M2-W4). Look up by eia_utility_number '
    '(core.mv_home_signals.territory_eia_id) -- a unique-index lookup.';

-- ---------------------------------------------------------------------------
-- core.mv_gate_counts_by_market / api.gate_counts_by_market -- the "Can
-- Base serve this home?" funnel counts (core.mv_gate_counts,
-- 0209_gate_counts_by_located_county.sql), split by market. Built the
-- same way core.mv_gate_counts already is: from core.mv_home_signals,
-- restricted to homes located in their own appraisal-roll county (no
-- cross-county-line lots), grouped -- a small precomputed table, not a
-- request-time join. Refreshed by core.refresh_market() below, NOT by
-- core.refresh_all_scores() (left for the orchestrator to wire in, per
-- the ticket).
-- ---------------------------------------------------------------------------

drop materialized view if exists core.mv_gate_counts_by_market cascade;

create materialized view core.mv_gate_counts_by_market as
with homes as (
    select
        s.prop_id,
        s.source_ids,
        coalesce(s.gate_reason, s.territory_null_reason, 'passed') as reason,
        s.territory_eia_id
    from core.mv_home_signals s
    join core.parcels p on p.prop_id = s.prop_id
    where s.county_fips = p.county_fips
),
joined as (
    select
        h.prop_id,
        h.reason,
        h.source_ids,
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
    select market, reason, count(distinct prop_id) as home_count
    from joined
    group by 1, 2
),
srcs as (
    select market, reason, array_agg(distinct src) as source_ids
    from joined
    cross join lateral unnest(source_ids) as src
    group by 1, 2
)
select
    c.market,
    c.reason,
    c.home_count,
    coalesce(sr.source_ids, array[]::uuid[]) as source_ids
from counts c
left join srcs sr on sr.market = c.market and sr.reason = c.reason;

create unique index mv_gate_counts_by_market_idx
    on core.mv_gate_counts_by_market (market, reason);

revoke all on core.mv_gate_counts_by_market from public, anon, authenticated;

create or replace view api.gate_counts_by_market as
select market, reason, home_count, source_ids
from core.mv_gate_counts_by_market;

revoke all on api.gate_counts_by_market from public, anon, authenticated;
grant select on api.gate_counts_by_market to service_role;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'zeus_web_ro') then
        execute 'grant select on api.gate_counts_by_market to zeus_web_ro';
    end if;
end $$;

comment on view api.gate_counts_by_market is
    'api.gate_counts (core.mv_gate_counts), split by market: '
    'market is one of deregulated, not_deregulated, no_territory_match '
    '(the home has no Base-served territory match at all -- the same '
    'homes api.gate_counts already reports as territory_not_base_served '
    'or an unresolved gate), retail_market_not_loaded (core.retail_market '
    'is empty), or utility_not_in_retail_market_file (a real territory '
    'match whose utility is not yet in data/manual/retail_market.csv). '
    'Refreshed by core.refresh_market(), not core.refresh_all_scores().';

create or replace function core.refresh_market() returns void
language plpgsql
as $$
begin
    refresh materialized view concurrently core.mv_gate_counts_by_market;
end;
$$;

comment on function core.refresh_market() is
    'Refreshes core.mv_gate_counts_by_market (the "Can Base serve this '
    'home?" counts split by regulated/deregulated market, M2-W4). Call '
    'manually after loading/updating core.retail_market or after '
    'core.refresh_all_scores() -- NOT wired into core.refresh_all_scores() '
    'itself; the orchestrator owns that wiring.';

-- ---------------------------------------------------------------------------
-- ops.refresh_policy -- backfill-only, hand-curated manual source, same
-- cadence convention as utility_crosswalk.
-- ---------------------------------------------------------------------------

-- no-mock-check: config-seed refresh cycle is the team's freshness policy from the spec, not source data
insert into ops.refresh_policy (source, refresh_cycle_days, note) values
    ('retail_market', null, 'data/manual/retail_market.csv (M2-W4) — backfill only, hand-curated from Base''s own pages')
on conflict (source) do update
    set refresh_cycle_days = excluded.refresh_cycle_days,
        note                = excluded.note;
