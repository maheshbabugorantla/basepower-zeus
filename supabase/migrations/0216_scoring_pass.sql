-- 0216_scoring_pass.sql — M2-P9 (scoring half) + M2-P10 + M2-P11,
-- combined DATA + SCORING pass.
--
-- Design choice (deviation from the literal "build mv_home_signals_v2
-- beside live, swap" instruction, recorded here for the record): the
-- three new per-home signals below (income_100k, age_35_64, permit_risk)
-- are all cheap POINT LOOKUPS against small, indexed tables keyed by
-- block_group_geoid or a single "latest jurisdiction stats row" — not
-- expensive aggregations. Rebuilding core.mv_home_signals as a new
-- materialized view wrapping the current live one and then swapping (the
-- 0212/0212b/0212c pattern) would leave the swapped-in view's definition
-- referencing an object this same transaction drops (0212b's own
-- "drop materialized view core.mv_home_signals_old" step) — permanently
-- breaking REFRESH MATERIALIZED VIEW CONCURRENTLY on it afterwards. So
-- instead: the new signals are computed INLINE, as additional LEFT JOINs
-- inside api.top_homes_weighted / api.homes_ranked_weighted /
-- api.homes_ranked_weighted_count / api.blockgroup_scores_weighted /
-- api.home_score_breakdown — the exact same functions 0212b/0212c
-- already touch for new weight keys — with no change to
-- core.mv_home_signals itself. core.mv_home_signals is refreshed ONCE at
-- the end of this file (core.refresh_all_scores()), not rebuilt.
--
-- ===========================================================================
-- Part A (M2-P10) — household income + prime-age (35-64), block group
-- ===========================================================================

create table if not exists core.acs_income_age_bg (
    geoid                                 text primary key,
    county_fips                           text,
    median_household_income              numeric,
    median_household_income_null_reason  text,
    income_100k_share                    numeric,
    income_100k_share_cv                 numeric,
    income_100k_share_null_reason        text,
    age_35_64_share                      numeric,
    age_35_64_share_cv                   numeric,
    age_35_64_share_null_reason          text,
    source_id                            uuid not null references ops.source_manifest (id),
    created_at                           timestamptz not null default now()
);

create index if not exists acs_income_age_bg_county_fips_idx on core.acs_income_age_bg (county_fips);

comment on table core.acs_income_age_bg is
    'Census ACS 2024 5-year block-group median household income and two '
    'derived shares (household income $100k+, population age 35-64), '
    'each nulled (with a *_null_reason, never clamped to 0) on a Census '
    'sentinel or a coefficient of variation over 40% (see *_cv). Filled '
    'by pipelines/sources/acs.py::run_income_age (M2-P10).';

alter table core.acs_income_age_bg enable row level security;
revoke all on core.acs_income_age_bg from public, anon, authenticated;
grant select on core.acs_income_age_bg to zeus_web_ro;
drop policy if exists web_ro_select on core.acs_income_age_bg;
create policy web_ro_select on core.acs_income_age_bg for select to zeus_web_ro using (true);

create or replace view api.acs_income_age_bg as
    select geoid, county_fips, median_household_income, median_household_income_null_reason,
           income_100k_share, income_100k_share_null_reason,
           age_35_64_share, age_35_64_share_null_reason, source_id
    from core.acs_income_age_bg;

comment on view api.acs_income_age_bg is
    'core.acs_income_age_bg: neighborhood (block-group) median household '
    'income and two shares (income $100k+, age 35-64), with provenance. '
    'Look up by geoid (= core.mv_home_signals.block_group_geoid) -- a '
    'single-row indexed lookup, well under 50 ms.';

revoke all on api.acs_income_age_bg from public, anon, authenticated;
grant select on api.acs_income_age_bg to service_role, zeus_web_ro;

-- Anchors: 90th percentile of each share across every Travis block group
-- with at least one Base-served ("gated") home -- same anchoring method
-- as age65/empower/backup_intent (0212_home_signals_build.sql). Requires
-- pipelines/sources/acs.py::run_income_age to have already loaded
-- core.acs_income_age_bg; a from-scratch replay before that backfill
-- inserts no anchor row (income_100k_term/age_35_64_term stay null with
-- reason 'anchor_not_loaded' below, never a fabricated denominator).
delete from core.signal_anchors where signal_key in ('income_100k', 'age_35_64');

insert into core.signal_anchors (signal_key, anchor_value, anchor_value_low, basis, year, source_ids)
select
    'income_100k',
    percentile_cont(0.9) within group (order by ia.income_100k_share),
    null::numeric,
    'Travis block groups with a Base-served home: 90th percentile of the ACS 2024 5-year share of households earning $100k+',
    2024,
    array_agg(distinct ia.source_id)
from core.acs_income_age_bg ia
where ia.income_100k_share is not null
  and exists (select 1 from core.mv_home_signals s where s.block_group_geoid = ia.geoid and s.gate_reason is null)
having count(*) > 0
union all
select
    'age_35_64',
    percentile_cont(0.9) within group (order by ia.age_35_64_share),
    null::numeric,
    'Travis block groups with a Base-served home: 90th percentile of the ACS 2024 5-year share of population aged 35-64',
    2024,
    array_agg(distinct ia.source_id)
from core.acs_income_age_bg ia
where ia.age_35_64_share is not null
  and exists (select 1 from core.mv_home_signals s where s.block_group_geoid = ia.geoid and s.gate_reason is null)
having count(*) > 0;

-- ===========================================================================
-- Part B (M2-P9 scoring half) — per-home permit_path + permit_risk term
-- ===========================================================================
--
-- permit_path is derived from territory ONLY: '1015' is Austin Energy's
-- eia_id (core.territories, 0201_m2.sql) -> 'city_battery_permit' (SB
-- 1252 keeps Austin Energy's own ESS permit requirement, per
-- core.permit_rules); any OTHER Base-served territory (e.g. Oncor)
-- -> 'state_rules_only' (SB 1252 bars city regulation of a residential
-- energy backup system outside a municipally owned utility's own
-- service area). KNOWN LIMITATION, stated plainly per the real-data rule
-- (never invented): the ticket's third bucket, 'county_fire_code'
-- (unincorporated Travis), needs an incorporated-vs-unincorporated
-- PARCEL BOUNDARY dataset this repo has not loaded (core.parcels.
-- situs_city is a free-text mailing city, not a jurisdiction boundary --
-- checked directly against the live DB before writing this: hundreds of
-- misspellings, and mailing cities like 'DEL VALLE' for unincorporated
-- addresses). permit_path is therefore only ever 'city_battery_permit',
-- 'state_rules_only', or NULL (reason below) -- never
-- 'county_fire_code' until that boundary dataset is loaded.
--
-- permit_risk_term follows the flood_term convention (0212_home_signals_
-- build.sql): stored GOOD-DIRECTION (1 = low risk/fast permit, 0 = high
-- risk), so it plugs into the existing weighted-sum formula unchanged
-- (higher term x weight = higher score for a LOW-risk home). Built from
-- core.permit_path_stats (jurisdiction='ALL', label='battery',
-- period_type='quarter', latest period): half from days-to-issue (this
-- quarter's median vs its own p90 as the risk ceiling) and half from
-- share_never_finished, both already 0-1. 'state_rules_only' homes score
-- 1 (no city ESS permit process exists to measure risk against, per SB
-- 1252 -- the ABSENCE of a municipal permit hurdle is itself the real,
-- cited basis, not a filled-in guess).
-- ===========================================================================

comment on column core.permit_path_stats.median_days is
    'Read at request time by api.*_weighted / api.home_score_breakdown '
    '(M2-P9 scoring pass) for the permit_risk term -- jurisdiction=''ALL'', '
    'label=''battery'', period_type=''quarter'', latest period.';

-- ===========================================================================
-- Part C (M2-P11) — coverage gaps: per-home bucket + block-group rollup
-- ===========================================================================

create table if not exists core.home_coverage (
    prop_id     text primary key references core.parcels (prop_id),
    bucket      text not null check (bucket in ('base_customer', 'other_backup', 'prospect', 'not_observable')),
    source_ids  uuid[] not null default '{}',
    computed_at timestamptz not null default now()
);

create index if not exists home_coverage_bucket_idx on core.home_coverage (bucket);

comment on table core.home_coverage is
    'One row per Base-served ("gated") home: base_customer (this home''s '
    'own Austin permit is Base Power''s, exact contractor_company_name '
    'match), other_backup (its own permit is battery/generator by a '
    'DIFFERENT installer), prospect (Austin Energy territory -- the '
    'austin_permits dataset''s coverage area -- with neither), or '
    'not_observable (outside Austin Energy territory -- the permits '
    'dataset does not cover it, so coverage there is NOT OBSERVABLE, '
    'never shown as "no Base customers"). Drives ranking exclusion only '
    '(api.*_weighted''s p_exclude_backup) -- never joined to an '
    'individually-labelled address in any UI. Plain table, populated by '
    'this migration''s one-time INSERT (M2-P11); re-run the same INSERT '
    'after a new permit_timelines backfill to refresh.';

alter table core.home_coverage enable row level security;
revoke all on core.home_coverage from public, anon, authenticated;
grant select on core.home_coverage to zeus_web_ro;
drop policy if exists web_ro_select on core.home_coverage;
create policy web_ro_select on core.home_coverage for select to zeus_web_ro using (true);

truncate core.home_coverage;

insert into core.home_coverage (prop_id, bucket, source_ids)
with homes as (
    select s.prop_id, s.geo_id, s.territory_eia_id, s.source_ids
    from core.mv_home_signals s
    where s.gate_reason is null
),
permit_flags as (
    select
        h.prop_id,
        bool_or(pt.is_base_power) as has_base,
        bool_or(not pt.is_base_power and pt.label in ('battery', 'generator')) as has_other_backup,
        array_agg(distinct pt.source_id) as permit_source_ids
    from homes h
    join core.permit_timelines pt on pt.tcad_id = h.geo_id
    group by h.prop_id
)
select
    h.prop_id,
    case
        when coalesce(pf.has_base, false) then 'base_customer'
        when coalesce(pf.has_other_backup, false) then 'other_backup'
        when h.territory_eia_id = '1015' then 'prospect'  -- Austin Energy territory = the austin_permits coverage area
        else 'not_observable'
    end as bucket,
    array(
        select distinct x from unnest(h.source_ids || coalesce(pf.permit_source_ids, array[]::uuid[])) x where x is not null
    ) as source_ids
from homes h
left join permit_flags pf on pf.prop_id = h.prop_id;

create or replace view api.coverage_bucket_counts as
    select bucket, count(*) as home_count from core.home_coverage group by bucket;

comment on view api.coverage_bucket_counts is
    'Citywide counts per coverage bucket (base_customer/other_backup/'
    'prospect/not_observable) -- zone-level only, never an individual '
    'address. Full scan of a small table, well under 50 ms.';

revoke all on api.coverage_bucket_counts from public, anon, authenticated;
grant select on api.coverage_bucket_counts to service_role, zeus_web_ro;

-- ---------------------------------------------------------------------------
-- core.mv_home_default_score — helper, INTERNAL only (not exposed via an
-- api view): each Base-served home's score at core.default_weights,
-- generically over every weight key BOTH core.default_weights and
-- core.mv_home_signals'/the inline lookups above carry a term for --
-- used only to compute coverage_gaps_bg's gap_score below. Plain query,
-- not a materialized view (avoids the mv-dependency trap explained at
-- the top of this file) -- cheap enough (one pass over ~150k rows) to
-- recompute inline each time coverage_gaps_bg is populated.
-- ---------------------------------------------------------------------------

create table if not exists core.coverage_gaps_bg (
    block_group_geoid    text primary key,
    homes                integer not null,
    base_customers       integer not null,
    other_backup         integer not null,
    prospects            integer not null,
    base_share_of_backup numeric,
    backup_penetration   numeric,
    mean_prospect_score  numeric,
    gap_score            numeric,
    computed_at          timestamptz not null default now()
);

comment on table core.coverage_gaps_bg is
    'Per Travis block group: homes/base_customers/other_backup/prospects '
    '(core.home_coverage, not_observable homes excluded from these '
    'counts and from gap_score -- a block group with only not_observable '
    'homes has no row here), base_share_of_backup = base_customers / '
    '(base_customers + other_backup) (null if that denominator is 0), '
    'backup_penetration = (base_customers + other_backup) / homes, '
    'mean_prospect_score = mean default-weighted score (core.'
    'default_weights) among this block group''s prospects, and '
    'gap_score = anchored 0-1: (sum of prospect scores) x (1 - '
    'base_share_of_backup), scaled to the 90th percentile of that raw '
    'value across covered block groups (core.signal_anchors, '
    'signal_key=''coverage_gap''). A block group with base_share_of_backup '
    'null (no observed backup at all) gets gap_score = raw_gap scaled '
    'the same way, treating "1 - null" as 1 (no Base presence to net '
    'out). Plain table, populated by this migration''s one-time INSERT '
    '(M2-P11); re-run after a new permit_timelines backfill to refresh.';

alter table core.coverage_gaps_bg enable row level security;
revoke all on core.coverage_gaps_bg from public, anon, authenticated;
grant select on core.coverage_gaps_bg to zeus_web_ro;
drop policy if exists web_ro_select on core.coverage_gaps_bg;
create policy web_ro_select on core.coverage_gaps_bg for select to zeus_web_ro using (true);

truncate core.coverage_gaps_bg;

insert into core.coverage_gaps_bg
    (block_group_geoid, homes, base_customers, other_backup, prospects, base_share_of_backup, backup_penetration, mean_prospect_score, gap_score)
with w as (
    select jsonb_object_agg(signal_key, weight) as weights from core.default_weights
),
default_score as (
    select
        s.prop_id,
        s.block_group_geoid,
        (
            select sum((w.weights ->> k)::float8 * (t ->> k)::float8)
                 / sum(case when t ->> k is not null then (w.weights ->> k)::float8 else 0 end)
            from jsonb_object_keys(w.weights) k
            where t ? k and t ->> k is not null
        ) as score
    from core.mv_home_signals s
    cross join w
    cross join lateral (
        select jsonb_build_object(
            'outage', s.outage_term, 'flood', s.flood_term, 'empower', s.empower_term,
            'age65', s.age65_term, 'electric_heat', s.electric_heat_term,
            'backup_intent', s.backup_intent_term,
            'owner_65', s.owner_65::int::numeric, 'home_permits', s.home_permits_flag::int::numeric,
            'installability', s.installability_term, 'home_value', s.home_value_term
        ) as t
    ) terms
    where s.gate_reason is null
),
bg_counts as (
    select
        s.block_group_geoid,
        count(*) filter (where hc.bucket <> 'not_observable') as homes,
        count(*) filter (where hc.bucket = 'base_customer') as base_customers,
        count(*) filter (where hc.bucket = 'other_backup') as other_backup,
        count(*) filter (where hc.bucket = 'prospect') as prospects
    from core.mv_home_signals s
    join core.home_coverage hc on hc.prop_id = s.prop_id
    where s.gate_reason is null
    group by s.block_group_geoid
),
prospect_scores as (
    select s.block_group_geoid, sum(ds.score) as sum_prospect_score, avg(ds.score) as mean_prospect_score
    from core.mv_home_signals s
    join core.home_coverage hc on hc.prop_id = s.prop_id and hc.bucket = 'prospect'
    join default_score ds on ds.prop_id = s.prop_id
    where s.gate_reason is null
    group by s.block_group_geoid
),
raw as (
    select
        bc.block_group_geoid,
        bc.homes, bc.base_customers, bc.other_backup, bc.prospects,
        case when (bc.base_customers + bc.other_backup) > 0
             then bc.base_customers::numeric / (bc.base_customers + bc.other_backup) else null end as base_share_of_backup,
        case when bc.homes > 0
             then (bc.base_customers + bc.other_backup)::numeric / bc.homes else null end as backup_penetration,
        ps.mean_prospect_score,
        (case when ps.sum_prospect_score is null then 0 else ps.sum_prospect_score end)  -- no scored prospects in the zone = no expected demand
            -- A zone where nobody has installed backup yet is fully untapped
            -- (Base's share of zero installs is not a missing value).
            * (case when (bc.base_customers + bc.other_backup) > 0
                    then 1 - bc.base_customers::numeric / (bc.base_customers + bc.other_backup)
                    else 1 end) as raw_gap
    from bg_counts bc
    left join prospect_scores ps on ps.block_group_geoid = bc.block_group_geoid
    where bc.homes > 0
),
anchor as (
    select percentile_cont(0.9) within group (order by raw_gap) as anchor_value from raw where raw_gap > 0
)
select
    r.block_group_geoid, r.homes, r.base_customers, r.other_backup, r.prospects,
    r.base_share_of_backup, r.backup_penetration, r.mean_prospect_score,
    case when a.anchor_value is null or a.anchor_value <= 0 then null
         else least(1, r.raw_gap / a.anchor_value) end as gap_score
from raw r
cross join anchor a;

-- gap_score's 90th-percentile anchor is computed inline, per-batch, in
-- the INSERT above (CTE `anchor`) -- not stored in core.signal_anchors,
-- since it is not one of the per-home weighted-score terms that table
-- otherwise holds.

create or replace view api.coverage_gaps_bg as
    select block_group_geoid, homes, base_customers, other_backup, prospects,
           base_share_of_backup, backup_penetration, mean_prospect_score, gap_score
    from core.coverage_gaps_bg;

comment on view api.coverage_gaps_bg is
    'core.coverage_gaps_bg: zone-level (block group) coverage counts and '
    'gap_score for the /ranking/coverage map. Never an individual '
    'address. Full scan of a small table (516-ish Travis block groups), '
    'well under 1 s.';

revoke all on api.coverage_gaps_bg from public, anon, authenticated;
grant select on api.coverage_gaps_bg to service_role, zeus_web_ro;

-- ===========================================================================
-- Part D — core.default_weights: new weight keys + outage basis fix
-- ===========================================================================
--
-- outage's basis text (0212_home_signals_build.sql) wrongly quoted
-- home_value's own numbers (both rows read "11.5x ... AUC 0.727" --
-- copy/paste from the same time-split study line). Outage could not
-- actually be tested in that study: every covered home shares Austin
-- Energy's one 2025 SAIDI figure (181.98 minutes), so it carries zero
-- within-sample variation to correlate against adoption -- the AUC/lift
-- numbers under 'outage' were never outage's own. Its weight instead
-- follows published, cited evidence that power outages materially drive
-- battery/backup adoption.
-- ---------------------------------------------------------------------------

update core.default_weights
set basis = 'Not testable in the 2026-09-26 time-split study: every covered home shares Austin Energy''s single 2025 SAIDI figure (181.98 min), zero within-sample variation to correlate against adoption (the AUC/lift figure previously shown here was home_value''s, copied in error). Weight instead follows published evidence that power outages materially drive battery/backup adoption: J. Public Economics 2024, https://www.sciencedirect.com/science/article/pii/S004727272400152X'
where signal_key = 'outage';

insert into core.default_weights (signal_key, weight, basis) values
    ('income_100k', 5, 'M2-P10: ACS 2024 5yr block-group share of households earning $100k+, scaled to the Travis 90th percentile -- team-chosen weight (home_value already captures much of this signal; see python -m pipelines.check ranking for the single-signal AUC)'),
    ('age_35_64',   3, 'M2-P10: ACS 2024 5yr block-group share of population aged 35-64, scaled to the Travis 90th percentile -- team-chosen weight (weaker, narrower-band signal than income; see python -m pipelines.check ranking for the single-signal AUC)'),
    ('permit_risk', 2, 'M2-P9: Austin permit-timeline risk (median days-to-issue vs its own p90, plus share never finished, core.permit_path_stats) -- an installability/eligibility signal, not evaluated in the 2026-09-26 adoption study (same status as installability)')
on conflict (signal_key) do update set weight = excluded.weight, basis = excluded.basis;

-- ===========================================================================
-- Part E — wire the new terms into the scoring functions. Every existing
-- output column/order/argument keeps working; new weight keys default to
-- 0 (the same `weights ? 'key'` pattern already in use); p_exclude_backup
-- is a new TRAILING parameter, default true, so an old positional call
-- still works. top_homes_weighted / homes_ranked_weighted / home_score_
-- breakdown gain new output columns (income_100k_share, age_35_64_share,
-- permit_path, permit_risk_term) -- Postgres cannot CREATE OR REPLACE a
-- function whose RETURNS TABLE row type changes even by appending
-- columns, so those three need DROP FUNCTION + CREATE (both statements
-- in one transaction with everything else in this file, so there is no
-- window where the function is missing). homes_ranked_weighted_count and
-- blockgroup_scores_weighted keep their exact return type, so a plain
-- CREATE OR REPLACE (just adding the trailing p_exclude_backup param and
-- the 3 new weight keys inside the function body) is enough for them.
-- ===========================================================================

drop function if exists api.top_homes_weighted(jsonb, text);
create function api.top_homes_weighted(weights jsonb, p_county_fips text default null::text, p_exclude_backup boolean default true)
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
    stats as materialized (
        -- LEFT JOIN LATERAL, never a bare CTE select, so this ALWAYS
        -- produces exactly one row (all-null if core.permit_path_stats
        -- has no matching quarter row yet) -- a plain 0-row CTE here
        -- would silently drop every home from the whole function via
        -- the `cross join stats` below.
        select st.median_days, st.p90_days, st.share_never_finished
        from (values (1)) one(x)
        left join lateral (
            select median_days, p90_days, share_never_finished
            from core.permit_path_stats
            where jurisdiction = 'ALL' and label = 'battery' and period_type = 'quarter'
            order by period desc limit 1
        ) st on true
    ),
    medians as (
        select county_fips, jsonb_object_agg(signal_key, median) as med from core.signal_medians group by county_fips
    ),
    narrow as (
        select
            s.prop_id,
            s.outage_term::float8 as outage_term, s.flood_term::float8 as flood_term,
            s.empower_term::float8 as empower_term, s.age65_term::float8 as age65_term,
            s.electric_heat_term::float8 as electric_heat_term,
            s.backup_intent_rate, s.backup_intent_term::float8 as backup_intent_term,
            s.owner_65::int::float8 as owner65_term, s.home_permits_flag::int::float8 as permits_term,
            s.installability_term::float8 as installability_term, s.home_value_term::float8 as home_value_term,
            least(1, ia.income_100k_share / nullif(anc_inc.anchor_value, 0))::float8 as income100k_term,
            least(1, ia.age_35_64_share / nullif(anc_age.anchor_value, 0))::float8 as age3564_term,
            case when s.territory_eia_id = '1015' then 'city_battery_permit'
                 when s.territory_eia_id is not null then 'state_rules_only'
                 else null end as permit_path,
            (case
                when s.territory_eia_id = '1015' and stats.median_days is not null and stats.share_never_finished is not null then
                    1 - least(1, greatest(0,
                        0.5 * least(1, stats.median_days::float8 / greatest(stats.p90_days, 1)::float8)
                        + 0.5 * stats.share_never_finished::float8
                    ))
                when s.territory_eia_id is not null and s.territory_eia_id != '1015' then 1.0
                else null
            end) as permitrisk_term
        from core.mv_home_signals s
        left join core.acs_income_age_bg ia on ia.geoid = s.block_group_geoid
        left join core.signal_anchors anc_inc on anc_inc.signal_key = 'income_100k'
        left join core.signal_anchors anc_age on anc_age.signal_key = 'age_35_64'
        cross join stats
        left join core.home_coverage hc on hc.prop_id = s.prop_id
        where s.gate_reason is null
          and (p_county_fips is null or s.county_fips = p_county_fips)
          and (not p_exclude_backup or coalesce(hc.bucket, 'prospect') not in ('base_customer', 'other_backup'))
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
        select
            scored.prop_id,
            scored.backup_intent_rate,
            (scored.weighted_sum / scored.weight_sum)::numeric as final_score
        from scored
        where scored.weight_sum > 0
        order by final_score desc, scored.backup_intent_rate desc nulls last, scored.prop_id
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
        s.block_group_geoid,
        s.county_fips,
        r.final_score as score,
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
        s.territory_eia_id,
        s.distributor_name,
        s.distributor_saidi,
        s.distributor_saidi_year,
        s.distributor_saidi_early_release,
        s.flood_flag,
        s.empower_rate,
        s.acs_pct_65_plus,
        s.acs_pct_electric_heat,
        s.backup_intent_rate,
        s.source_ids,
        s.owner_65,
        s.home_solar,
        s.home_ev,
        s.home_generator,
        s.home_panel_upgrade,
        s.home_battery,
        s.battery_permit_date,
        s.permit_null_reason,
        s.yr_built,
        s.living_area,
        s.outage_minutes,
        s.outage_year,
        s.outage_basis,
        s.outage_source_ids,
        s.home_value_term,
        s.installability_term,
        ia.income_100k_share,
        ia.age_35_64_share,
        (case when s.territory_eia_id = '1015' then 'city_battery_permit'
              when s.territory_eia_id is not null then 'state_rules_only'
              else null end) as permit_path,
        (case
            when s.territory_eia_id = '1015' and stats.median_days is not null and stats.share_never_finished is not null then
                1 - least(1, greatest(0,
                    0.5 * least(1, stats.median_days::float8 / greatest(stats.p90_days, 1)::float8)
                    + 0.5 * stats.share_never_finished::float8
                ))
            when s.territory_eia_id is not null and s.territory_eia_id != '1015' then 1.0
            else null
        end) as permit_risk_term
    from ranked r
    join core.mv_home_signals s on s.prop_id = r.prop_id
    join core.parcels p on p.prop_id = r.prop_id
    left join core.acs_income_age_bg ia on ia.geoid = s.block_group_geoid
    left join medians md on md.county_fips = s.county_fips
    cross join w
    cross join (
        select st.median_days, st.p90_days, st.share_never_finished
        from (values (1)) one(x)
        left join lateral (
            select median_days, p90_days, share_never_finished
            from core.permit_path_stats
            where jurisdiction = 'ALL' and label = 'battery' and period_type = 'quarter'
            order by period desc limit 1
        ) st on true
    ) stats
    order by r.final_score desc, r.backup_intent_rate desc nulls last, r.prop_id;
$function$;

drop function if exists api.homes_ranked_weighted(jsonb, text, text, numeric, text, integer);
create function api.homes_ranked_weighted(weights jsonb, p_county_fips text default null::text, p_block_group_geoid text default null::text, after_score numeric default null::numeric, after_prop_id text default null::text, page_size integer default 50, p_exclude_backup boolean default true)
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
    stats as materialized (
        -- LEFT JOIN LATERAL, never a bare CTE select, so this ALWAYS
        -- produces exactly one row (all-null if core.permit_path_stats
        -- has no matching quarter row yet) -- a plain 0-row CTE here
        -- would silently drop every home from the whole function via
        -- the `cross join stats` below.
        select st.median_days, st.p90_days, st.share_never_finished
        from (values (1)) one(x)
        left join lateral (
            select median_days, p90_days, share_never_finished
            from core.permit_path_stats
            where jurisdiction = 'ALL' and label = 'battery' and period_type = 'quarter'
            order by period desc limit 1
        ) st on true
    ),
    medians as (
        select county_fips, jsonb_object_agg(signal_key, median) as med from core.signal_medians group by county_fips
    ),
    narrow as (
        select
            s.prop_id,
            s.outage_term::float8 as outage_term, s.flood_term::float8 as flood_term,
            s.empower_term::float8 as empower_term, s.age65_term::float8 as age65_term,
            s.electric_heat_term::float8 as electric_heat_term,
            s.backup_intent_rate, s.backup_intent_term::float8 as backup_intent_term,
            s.owner_65::int::float8 as owner65_term, s.home_permits_flag::int::float8 as permits_term,
            s.installability_term::float8 as installability_term, s.home_value_term::float8 as home_value_term,
            least(1, ia.income_100k_share / nullif(anc_inc.anchor_value, 0))::float8 as income100k_term,
            least(1, ia.age_35_64_share / nullif(anc_age.anchor_value, 0))::float8 as age3564_term,
            (case
                when s.territory_eia_id = '1015' and stats.median_days is not null and stats.share_never_finished is not null then
                    1 - least(1, greatest(0,
                        0.5 * least(1, stats.median_days::float8 / greatest(stats.p90_days, 1)::float8)
                        + 0.5 * stats.share_never_finished::float8
                    ))
                when s.territory_eia_id is not null and s.territory_eia_id != '1015' then 1.0
                else null
            end) as permitrisk_term
        from core.mv_home_signals s
        left join core.acs_income_age_bg ia on ia.geoid = s.block_group_geoid
        left join core.signal_anchors anc_inc on anc_inc.signal_key = 'income_100k'
        left join core.signal_anchors anc_age on anc_age.signal_key = 'age_35_64'
        cross join stats
        left join core.home_coverage hc on hc.prop_id = s.prop_id
        where s.gate_reason is null
          and (p_county_fips is null or s.county_fips = p_county_fips)
          and (p_block_group_geoid is null or s.block_group_geoid = p_block_group_geoid)
          and (not p_exclude_backup or coalesce(hc.bucket, 'prospect') not in ('base_customer', 'other_backup'))
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
        select
            scored.prop_id,
            scored.backup_intent_rate,
            (scored.weighted_sum / scored.weight_sum)::numeric as final_score
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
        p.prop_id,
        pc.geo_id,
        pc.situs_num,
        pc.situs_street,
        pc.situs_city,
        pc.situs_zip,
        pc.market_value,
        s.block_group_geoid,
        s.county_fips,
        p.final_score as score,
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
        s.territory_eia_id,
        s.distributor_name,
        s.distributor_saidi,
        s.distributor_saidi_year,
        s.distributor_saidi_early_release,
        s.flood_flag,
        s.empower_rate,
        s.acs_pct_65_plus,
        s.acs_pct_electric_heat,
        s.backup_intent_rate,
        s.source_ids,
        extensions.ST_X(pg.centroid) as lon,
        extensions.ST_Y(pg.centroid) as lat,
        s.owner_65,
        s.home_solar,
        s.home_ev,
        s.home_generator,
        s.home_panel_upgrade,
        s.home_battery,
        s.battery_permit_date,
        s.permit_null_reason,
        s.yr_built,
        s.living_area,
        s.outage_minutes,
        s.outage_year,
        s.outage_basis,
        s.outage_source_ids,
        s.home_value_term,
        s.installability_term,
        ia.income_100k_share,
        ia.age_35_64_share,
        (case when s.territory_eia_id = '1015' then 'city_battery_permit'
              when s.territory_eia_id is not null then 'state_rules_only'
              else null end) as permit_path,
        (case
            when s.territory_eia_id = '1015' and stats.median_days is not null and stats.share_never_finished is not null then
                1 - least(1, greatest(0,
                    0.5 * least(1, stats.median_days::float8 / greatest(stats.p90_days, 1)::float8)
                    + 0.5 * stats.share_never_finished::float8
                ))
            when s.territory_eia_id is not null and s.territory_eia_id != '1015' then 1.0
            else null
        end) as permit_risk_term
    from page p
    join core.mv_home_signals s on s.prop_id = p.prop_id
    join core.parcels pc on pc.prop_id = p.prop_id
    left join core.parcel_geoms pg on pg.prop_id = p.prop_id
    left join core.acs_income_age_bg ia on ia.geoid = s.block_group_geoid
    left join medians md on md.county_fips = s.county_fips
    cross join w
    cross join (
        select st.median_days, st.p90_days, st.share_never_finished
        from (values (1)) one(x)
        left join lateral (
            select median_days, p90_days, share_never_finished
            from core.permit_path_stats
            where jurisdiction = 'ALL' and label = 'battery' and period_type = 'quarter'
            order by period desc limit 1
        ) st on true
    ) stats
    order by p.final_score desc, p.prop_id;
$function$;

-- Adding a trailing parameter via CREATE OR REPLACE creates a NEW
-- overload (Postgres resolves by parameter TYPE list, not defaults),
-- which makes a 2-arg call ambiguous between the old and new signatures
-- -- drop the old 3-arg signature first.
drop function if exists api.homes_ranked_weighted_count(jsonb, text, text);
create function api.homes_ranked_weighted_count(weights jsonb, p_county_fips text default null::text, p_block_group_geoid text default null::text, p_exclude_backup boolean default true)
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
    stats as materialized (
        -- LEFT JOIN LATERAL, never a bare CTE select, so this ALWAYS
        -- produces exactly one row (all-null if core.permit_path_stats
        -- has no matching quarter row yet) -- a plain 0-row CTE here
        -- would silently drop every home from the whole function via
        -- the `cross join stats` below.
        select st.median_days, st.p90_days, st.share_never_finished
        from (values (1)) one(x)
        left join lateral (
            select median_days, p90_days, share_never_finished
            from core.permit_path_stats
            where jurisdiction = 'ALL' and label = 'battery' and period_type = 'quarter'
            order by period desc limit 1
        ) st on true
    ),
    narrow as (
        select
            s.outage_term::float8 as outage_term, s.flood_term::float8 as flood_term,
            s.empower_term::float8 as empower_term, s.age65_term::float8 as age65_term,
            s.electric_heat_term::float8 as electric_heat_term, s.backup_intent_term::float8 as backup_intent_term,
            s.owner_65::int::float8 as owner65_term, s.home_permits_flag::int::float8 as permits_term,
            s.installability_term::float8 as installability_term, s.home_value_term::float8 as home_value_term,
            least(1, ia.income_100k_share / nullif(anc_inc.anchor_value, 0))::float8 as income100k_term,
            least(1, ia.age_35_64_share / nullif(anc_age.anchor_value, 0))::float8 as age3564_term,
            (case
                when s.territory_eia_id = '1015' and stats.median_days is not null and stats.share_never_finished is not null then
                    1 - least(1, greatest(0,
                        0.5 * least(1, stats.median_days::float8 / greatest(stats.p90_days, 1)::float8)
                        + 0.5 * stats.share_never_finished::float8
                    ))
                when s.territory_eia_id is not null and s.territory_eia_id != '1015' then 1.0
                else null
            end) as permitrisk_term
        from core.mv_home_signals s
        left join core.acs_income_age_bg ia on ia.geoid = s.block_group_geoid
        left join core.signal_anchors anc_inc on anc_inc.signal_key = 'income_100k'
        left join core.signal_anchors anc_age on anc_age.signal_key = 'age_35_64'
        cross join stats
        left join core.home_coverage hc on hc.prop_id = s.prop_id
        where s.gate_reason is null
          and (p_county_fips is null or s.county_fips = p_county_fips)
          and (p_block_group_geoid is null or s.block_group_geoid = p_block_group_geoid)
          and (not p_exclude_backup or coalesce(hc.bucket, 'prospect') not in ('base_customer', 'other_backup'))
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

drop function if exists api.blockgroup_scores_weighted(jsonb, text);
create function api.blockgroup_scores_weighted(weights jsonb, p_county_fips text default null::text, p_exclude_backup boolean default true)
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
    stats as materialized (
        -- LEFT JOIN LATERAL, never a bare CTE select, so this ALWAYS
        -- produces exactly one row (all-null if core.permit_path_stats
        -- has no matching quarter row yet) -- a plain 0-row CTE here
        -- would silently drop every home from the whole function via
        -- the `cross join stats` below.
        select st.median_days, st.p90_days, st.share_never_finished
        from (values (1)) one(x)
        left join lateral (
            select median_days, p90_days, share_never_finished
            from core.permit_path_stats
            where jurisdiction = 'ALL' and label = 'battery' and period_type = 'quarter'
            order by period desc limit 1
        ) st on true
    ),
    narrow as (
        select
            s.block_group_geoid,
            s.outage_term::float8 as outage_term, s.flood_term::float8 as flood_term,
            s.empower_term::float8 as empower_term, s.age65_term::float8 as age65_term,
            s.electric_heat_term::float8 as electric_heat_term, s.backup_intent_term::float8 as backup_intent_term,
            s.owner_65::int::float8 as owner65_term, s.home_permits_flag::int::float8 as permits_term,
            s.installability_term::float8 as installability_term, s.home_value_term::float8 as home_value_term,
            least(1, ia.income_100k_share / nullif(anc_inc.anchor_value, 0))::float8 as income100k_term,
            least(1, ia.age_35_64_share / nullif(anc_age.anchor_value, 0))::float8 as age3564_term,
            (case
                when s.territory_eia_id = '1015' and stats.median_days is not null and stats.share_never_finished is not null then
                    1 - least(1, greatest(0,
                        0.5 * least(1, stats.median_days::float8 / greatest(stats.p90_days, 1)::float8)
                        + 0.5 * stats.share_never_finished::float8
                    ))
                when s.territory_eia_id is not null and s.territory_eia_id != '1015' then 1.0
                else null
            end) as permitrisk_term
        from core.mv_home_signals s
        left join core.acs_income_age_bg ia on ia.geoid = s.block_group_geoid
        left join core.signal_anchors anc_inc on anc_inc.signal_key = 'income_100k'
        left join core.signal_anchors anc_age on anc_age.signal_key = 'age_35_64'
        cross join stats
        left join core.home_coverage hc on hc.prop_id = s.prop_id
        where s.gate_reason is null
          and (p_county_fips is null or s.county_fips = p_county_fips)
          and (not p_exclude_backup or coalesce(hc.bucket, 'prospect') not in ('base_customer', 'other_backup'))
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
        select
            scored.block_group_geoid,
            (scored.weighted_sum / scored.weight_sum)::numeric as final_score
        from scored
        where scored.weight_sum > 0
    ),
    bg_mean as (
        select
            home_scored.block_group_geoid,
            avg(home_scored.final_score) as mean_score,
            count(*)                     as homes_scored
        from home_scored
        where home_scored.block_group_geoid is not null
        group by home_scored.block_group_geoid
    )
    select
        bg_mean.block_group_geoid,
        percent_rank() over (order by bg_mean.mean_score) as score,
        bg_mean.homes_scored
    from bg_mean;
$function$;

-- ---------------------------------------------------------------------------
-- api.home_score_breakdown — no new OUTPUT columns (same 12: key, label,
-- raw_value, raw_unit, percentile, weight, contribution, available,
-- null_reason, term, anchor_value, anchor_basis), so plain CREATE OR
-- REPLACE (new weight keys in `w`, three new VALUES rows).
-- ---------------------------------------------------------------------------

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
    -- Both ia/stats are LEFT JOIN LATERAL against a guaranteed
    -- single-row driver, never a bare CTE select against a real table
    -- -- s is cross-joined against both below, so a 0-row ia/stats
    -- would otherwise silently empty the whole breakdown.
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
    derived as (
        select
            s.prop_id,
            least(1, ia.income_100k_share / nullif((select anchor_value from anc where signal_key = 'income_100k'), 0)) as income100k_term,
            least(1, ia.age_35_64_share / nullif((select anchor_value from anc where signal_key = 'age_35_64'), 0)) as age3564_term,
            (case when s.territory_eia_id = '1015' then 'city_battery_permit'
                  when s.territory_eia_id is not null then 'state_rules_only'
                  else null end) as permit_path,
            (case
                when s.territory_eia_id = '1015' and stats.median_days is not null and stats.share_never_finished is not null then
                    1 - least(1, greatest(0,
                        0.5 * least(1, stats.median_days::numeric / greatest(stats.p90_days, 1)::numeric)
                        + 0.5 * stats.share_never_finished
                    ))
                when s.territory_eia_id is not null and s.territory_eia_id != '1015' then 1.0
                else null
            end) as permitrisk_term
        from s
        left join ia on true
        cross join stats
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
        from s cross join w cross join derived d
    )
    select
        v.key,
        v.label,
        v.raw_value,
        v.raw_unit,
        v.percentile,
        v.weight,
        case when v.available and wt.weight_sum > 0
             then (v.weight * v.term) / wt.weight_sum
             else null end as contribution,
        v.available,
        v.null_reason,
        v.term,
        v.anchor_value,
        v.anchor_basis
    from s
    cross join w
    cross join ia
    cross join stats
    cross join derived d
    cross join weight_total wt
    cross join lateral (
        values
            (
                'outage', 'Outage exposure',
                s.distributor_saidi, 'minutes without power/customer/year (SAIDI, incl. major events, or the EAGLE-I county proxy when the distributor reports none)',
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
                'home_value', 'Home value (TCAD market value)',
                s.market_value,
                'dollars, TCAD 2026 Certified Appraisal Export market value',
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

-- ===========================================================================
-- Part F — refresh once (per Speed mode: never more than once). Run as
-- its own statement, outside this migration's transaction (REFRESH
-- MATERIALIZED VIEW CONCURRENTLY against ~150k+ rows exceeds the
-- session pooler's default statement_timeout inside a big multi-
-- statement batch): `select core.refresh_all_scores();` with
-- `set statement_timeout = 0` for that one call.
-- ===========================================================================
