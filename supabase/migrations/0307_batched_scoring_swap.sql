set local statement_timeout = 0;
set local work_mem = '64MB';
set local maintenance_work_mem = '256MB';
set local max_parallel_workers_per_gather = 0;

-- 0307_batched_scoring_swap.sql — SWAP half of the perf follow-up to
-- M3-P6. Requires 0307_batched_scoring_build.sql already applied and
-- committed (core.mv_home_signals_v3 / core.mv_home_terms_v3 exist,
-- populated, indexed, analyzed).
--
-- Rebinds core.mv_home_signals and core.mv_home_terms from materialized
-- views to plain tables (same names, same columns/types/rows -- the
-- build half already copied them verbatim, so nothing here recomputes
-- anything). Read-only queries via pg_depend (this session, 2026-09-26)
-- found exactly four matviews with a stored dependency on
-- core.mv_home_signals: core.mv_gate_counts, core.mv_gate_counts_by_market,
-- core.mv_home_geo_rollup, core.mv_county_territories. Lesson 6: those
-- stay bound to the OLD object after a rename-swap, so they're dropped
-- and recreated here verbatim (same SQL 0304b4 gave them -- no logic
-- change) against the new table. core.mv_parcel_gate_counts has NO
-- dependency on mv_home_signals (it reads core.parcels only) and is left
-- untouched. Every SQL/plpgsql function that reads core.mv_home_signals
-- or core.mv_home_terms by name (api.homes_ranked_weighted,
-- api.homes_ranked_weighted_count, api.blockgroup_scores_weighted,
-- api.top_homes_weighted, api.home_score_breakdown, core.refresh_all_scores
-- -- confirmed via pg_get_functiondef, this session) resolves the name at
-- call time and needs no change; none has a `prosqlbody` (BEGIN ATOMIC)
-- body bound to an OID (checked: zero such functions exist in core/api).
--
-- Also retires two costs from core.refresh_all_scores() (read-only
-- pg_stat_statements check, 2026-09-26, on the live 439s run this ticket
-- targets):
--   - `refresh materialized view concurrently core.mv_home_signals` /
--     `...mv_home_terms` -- gone; both are now plain tables kept current
--     by pipelines/sources/scoring_refresh.py's batched upserts, run
--     BEFORE this function (the function's anchors/medians/gate-count
--     steps below read the table assuming it is already current for
--     this refresh cycle).
--   - `update core.home_propensity set county_fips = ... from
--     core.mv_home_signals` -- measured 101.9s for a full first-time
--     backfill (pg_stat_statements). Retired entirely: county_fips is
--     set once by pipelines/models when it writes each home_propensity
--     row, per this ticket's brief; there is no longer a reason to
--     re-derive it from mv_home_signals on every refresh.
--
-- One-time cutover: not meant to be re-run after it has already
-- succeeded once.
-- ---------------------------------------------------------------------------

drop view if exists api.gate_counts;
drop view if exists api.gate_counts_by_market;
drop view if exists api.home_geo_rollup;
drop view if exists api.county_territories;

drop materialized view core.mv_county_territories;
drop materialized view core.mv_gate_counts_by_market;
drop materialized view core.mv_gate_counts;
drop materialized view core.mv_home_geo_rollup;

alter materialized view core.mv_home_signals rename to mv_home_signals_pre_batched;
alter table core.mv_home_signals_v3 rename to mv_home_signals;

alter index core.mv_home_signals_v3_pkey rename to mv_home_signals_prop_id_idx_batched;
alter index core.mv_home_signals_v3_gate_reason_idx rename to mv_home_signals_gate_reason_idx_batched;
alter index core.mv_home_signals_v3_county_fips_idx rename to mv_home_signals_county_fips_idx_batched;
alter index core.mv_home_signals_v3_bg_geoid_idx rename to mv_home_signals_bg_geoid_idx_batched;
alter index core.mv_home_signals_v3_county_gated_idx rename to mv_home_signals_county_gated_idx_batched;
alter index core.mv_home_signals_v3_county_territory_idx rename to mv_home_signals_county_territory_idx_batched;
alter index core.mv_home_signals_v3_territory_idx rename to mv_home_signals_territory_idx_batched;

alter materialized view core.mv_home_terms rename to mv_home_terms_pre_batched;
alter table core.mv_home_terms_v3 rename to mv_home_terms;

alter index core.mv_home_terms_v3_pkey rename to mv_home_terms_prop_id_idx_batched;
alter index core.mv_home_terms_v3_county_prop_idx rename to mv_home_terms_county_prop_idx_batched;
alter index core.mv_home_terms_v3_county_bg_idx rename to mv_home_terms_county_bg_idx_batched;

-- ---------------------------------------------------------------------------
-- Dependents, recreated verbatim (0304b4's own SQL, unchanged) against
-- the new table. No `_v2`/rename dance needed here -- the old matviews
-- were already dropped above, so these are created directly under
-- their final names.
-- ---------------------------------------------------------------------------
create materialized view core.mv_gate_counts as
with homes as (
    select s.prop_id, s.county_fips, s.source_ids,
           coalesce(s.gate_reason, s.territory_null_reason, 'passed') as reason
    from core.mv_home_signals s
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

create unique index mv_gate_counts_county_reason_idx_batched on core.mv_gate_counts (county_fips, reason);

create materialized view core.mv_gate_counts_by_market as
with homes as (
    select s.prop_id, s.county_fips, s.source_ids,
           coalesce(s.gate_reason, s.territory_null_reason, 'passed') as reason,
           s.territory_eia_id
    from core.mv_home_signals s
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

create unique index mv_gate_counts_by_market_idx_batched on core.mv_gate_counts_by_market (county_fips, market, reason);

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
from core.mv_home_signals s
join core.parcels p on p.prop_id = s.prop_id
left join core.home_propensity hp on hp.prop_id = s.prop_id
where s.gate_reason is null
group by s.county_fips, p.situs_city, p.situs_zip, s.block_group_geoid;

create unique index mv_home_geo_rollup_tuple_idx_batched
    on core.mv_home_geo_rollup (county_fips, situs_city, situs_zip, block_group_geoid);

create materialized view core.mv_county_territories as
select county_fips, territory_eia_id, count(*) as homes
from core.mv_home_signals
where territory_eia_id is not null
group by county_fips, territory_eia_id;

create unique index mv_county_territories_idx_batched on core.mv_county_territories (county_fips, territory_eia_id);

analyze core.mv_home_signals;
analyze core.mv_home_terms;
analyze core.mv_gate_counts;
analyze core.mv_gate_counts_by_market;
analyze core.mv_home_geo_rollup;
analyze core.mv_county_territories;

create view api.gate_counts as
    select reason, home_count, source_ids, county_fips from core.mv_gate_counts;

create view api.gate_counts_by_market as
    select market, reason, home_count, source_ids, county_fips from core.mv_gate_counts_by_market;

create view api.home_geo_rollup as
    select county_fips, situs_city, situs_zip, block_group_geoid, home_count, avg_p, max_p, top10_count
    from core.mv_home_geo_rollup;

create view api.county_territories as
    select county_fips, territory_eia_id, homes from core.mv_county_territories;

grant select on
    core.mv_home_signals, core.mv_home_terms, core.mv_gate_counts,
    core.mv_gate_counts_by_market, core.mv_home_geo_rollup, core.mv_county_territories
to zeus_web_ro;

grant select on
    api.gate_counts, api.gate_counts_by_market, api.home_geo_rollup, api.county_territories
to zeus_web_ro;

-- ---------------------------------------------------------------------------
-- core.refresh_all_scores() — slimmed. Same statements as the live
-- function (verified via pg_get_functiondef, this session) MINUS:
--   - `refresh materialized view concurrently core.mv_home_signals`
--   - `refresh materialized view concurrently core.mv_home_terms`
--     (both plain tables now; pipelines/sources/scoring_refresh.py
--     upserts them by prop_id batch, and MUST run before this function
--     in a refresh cycle -- the anchors/medians/gate-count steps below
--     read core.mv_home_signals as-is)
--   - the `update core.home_propensity set county_fips = ...` block
--     (retired; county_fips is set once by pipelines/models)
-- Every other statement, in the same order, unchanged.
-- ---------------------------------------------------------------------------
create or replace function core.refresh_all_scores()
returns void
language plpgsql
as $function$
begin
    refresh materialized view concurrently core.mv_home_block_group;
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

    refresh materialized view concurrently core.mv_home_geo_rollup;
    refresh materialized view concurrently core.mv_county_territories;
end;
$function$;

-- ---------------------------------------------------------------------------
-- vacuum (analyze) outside this transaction (cannot run inside one --
-- lesson 11). Run these as separate autocommit statements right after
-- this file commits:
--   vacuum (analyze) core.mv_home_signals_pre_batched;
--   vacuum (analyze) core.mv_home_terms_pre_batched;
-- ---------------------------------------------------------------------------
