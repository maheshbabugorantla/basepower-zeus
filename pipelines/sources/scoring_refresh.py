"""Batched refresh for core.mv_home_signals / core.mv_home_terms
(perf follow-up to M3-P6, 2026-09-26/27).

Why this exists: `core.refresh_all_scores()` measured 439s live on
2026-09-26. `REFRESH MATERIALIZED VIEW CONCURRENTLY core.mv_home_signals`
(805 MB / 1.2M rows) and `...mv_home_terms` (296 MB) each build a full
second copy of the object, then diff it row-by-row against the live
copy via the unique index, before swapping in. `supabase/migrations/
0307_batched_scoring_swap.sql` converts both from materialized views
into plain tables with the same name, columns, types and rows (a
verbatim `create table as select *` copy -- nothing recomputed in that
migration). This module is what keeps those two tables current after
that cutover: it upserts by prop_id keyset batch instead of rebuilding
the whole object, so unchanged rows create no dead tuples and reads stay
available throughout (no swap, no lock beyond each batch's own upsert).

Design, keyed to the M3-P6 lessons this project already learned:

1. Precompute the SMALL aggregate tables ONCE per run (lesson 3: don't
   recompute a static fact on every pass) -- reliability by territory
   (~141 rows), county_proxy (~10s of counties), bg_home_counts /
   bg_permit_counts / home_backup_permits (per block group, ~18.6k
   rows). In the original monolithic `core.mv_home_signals_v2` build
   (0304b2) these were CTEs computed once per query execution; here they
   are computed once per RUN and reused by every batch, which matters
   once there is more than one batch.
2. Compute the six global anchors ONCE, from a THIN pass over just the
   columns each anchor needs (outage_minutes, empower_rate,
   acs_pct_65_plus, backup_intent_rate, market_value) -- not the full
   ~30-column `raw` row set with its permit/improvement joins and
   arrays. Anchors are global, never per-county (this project's
   anchored-absolute scoring rule) and must be fixed BEFORE any batch
   computes a home's term columns, so every batch agrees.
3. Batch `core.mv_home_signals` by prop_id keyset range (~150k rows per
   batch, four batches for 1.2M homes) with `INSERT ... ON CONFLICT
   (prop_id) DO UPDATE ... WHERE ... IS DISTINCT FROM ...` -- an
   unchanged row writes nothing.
4. Batch `core.mv_home_terms` by county_fips (three counties today; it
   depends only on `core.signal_anchors` rows this module does not
   write -- income_100k/age_35_64, loaded by a separate pipeline step --
   and `core.mv_home_signals` already being current, not on
   `core.signal_medians`, so there is no medians ordering dependency).
5. Delete orphans (prop_ids no longer in core.home_spatial's eligible
   set) from both tables.
6. Call `core.refresh_all_scores()` last -- it no longer touches
   mv_home_signals/mv_home_terms (0307_batched_scoring_swap.sql retired
   those two `REFRESH ... CONCURRENTLY` statements and the
   `home_propensity.county_fips` backfill update from that function) but
   still refreshes the legacy v0 chain, gate counts, market, the global
   anchors/medians tables, geo rollup and county territories -- all of
   which read core.mv_home_signals and must see this run's batches.

NOT executed as part of writing this file (hard rule for this task: no
database writes). Every statement below is written to the same
semantics as the live `core.mv_home_signals_v2` / `core.mv_home_terms`
definitions (0304b2, 0304b4) verified read-only against the live schema
on 2026-09-26/27; it has not been run against the live database.
Verify with a read-only EXCEPT-both-ways parity check on a 5k-prop_id
sample per county before ever applying 0307_batched_scoring_swap.sql.

CLI-only, like pipelines/sources/refresh_scores.py: uses
POSTGRES_URL_NON_POOLING (session pooler) with an autocommit connection,
since each batch commits on its own (lesson 4: don't multiply retry
cost with one giant transaction) and no step here needs
REFRESH...CONCURRENTLY's "outside any transaction block" restriction
directly, but batches still shouldn't share a long-lived transaction on
a disk-constrained instance.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

import psycopg

from pipelines.core import config

BATCH_SIZE = 150_000

# ---------------------------------------------------------------------------
# Step 1: small tables, built once per run. Same CTEs 0304b2 had inline;
# here they are persisted so every batch reuses them instead of
# recomputing over the full core.permits / core.utility_reliability /
# core.home_spatial each time.
# ---------------------------------------------------------------------------
SMALL_TABLE_STATEMENTS: tuple[str, ...] = (
    "drop table if exists _scoring_bg_home_counts",
    """
    create temp table _scoring_bg_home_counts as
    select block_group_geoid, count(*) as homes_gated
    from core.home_spatial
    group by block_group_geoid
    """,
    "create unique index on _scoring_bg_home_counts (block_group_geoid)",

    "drop table if exists _scoring_permits_in_window",
    """
    create temp table _scoring_permits_in_window as
    select pm.permit_number, hs.block_group_geoid, hs.prop_id, pl.label, pm.source_id as permit_source_id
    from core.permits pm
    join core.permit_labels pl on pl.permit_number = pm.permit_number and pl.labeller = 'rules'
    join core.parcels p on p.geo_id = pm.tcad_id
    join core.home_spatial hs on hs.prop_id = p.prop_id
    where pm.issue_date >= current_date - interval '3 years'
    """,
    "create index on _scoring_permits_in_window (block_group_geoid)",
    "create index on _scoring_permits_in_window (prop_id)",

    "drop table if exists _scoring_bg_permit_counts",
    """
    create temp table _scoring_bg_permit_counts as
    select
        block_group_geoid,
        count(distinct permit_number) filter (where label = any (array['battery', 'generator'])) as backup_permits_count,
        count(distinct permit_number) as any_permits_count,
        array_agg(distinct permit_source_id) as permit_source_ids
    from _scoring_permits_in_window
    group by block_group_geoid
    """,
    "create unique index on _scoring_bg_permit_counts (block_group_geoid)",

    "drop table if exists _scoring_home_backup_permits",
    """
    create temp table _scoring_home_backup_permits as
    select prop_id, count(distinct permit_number) as own_backup_permits
    from _scoring_permits_in_window
    where label = any (array['battery', 'generator'])
    group by prop_id
    """,
    "create unique index on _scoring_home_backup_permits (prop_id)",

    "drop table if exists _scoring_county_proxy",
    """
    create temp table _scoring_county_proxy as
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
    """,
    "create unique index on _scoring_county_proxy (county_fips)",

    "drop table if exists _scoring_permits_loaded",
    """
    create temp table _scoring_permits_loaded as
    select exists (select 1 from core.permit_labels where labeller = 'rules') as any_rules_labels
    """,
)

# ---------------------------------------------------------------------------
# Step 2: thin anchor pass. Same six percentile_cont expressions as
# 0304b2's `anchors` CTE, but computed once over a small thin
# projection of `base` (no permit/improvement joins, no arrays) instead
# of the full ~30-column `raw` row set.
# ---------------------------------------------------------------------------
THIN_ANCHOR_INPUTS_SQL = """
drop table if exists _scoring_anchor_inputs;
create temp table _scoring_anchor_inputs as
with base as (
    select
        hbg.prop_id, hs.county_fips, hbg.block_group_geoid, p.market_value,
        hs.resolved_territory_eia_id as territory_eia_id,
        hs.territory_gate_reason as gate_reason
    from core.mv_home_block_group hbg
    join core.home_spatial hs on hs.prop_id = hbg.prop_id
    join core.parcels p on p.prop_id = hbg.prop_id
),
reliability as (
    select b.prop_id,
           (select r.saidi_incl_major from core.utility_reliability r
            where r.eia_id = b.territory_eia_id and r.saidi_incl_major is not null
            order by r.year desc limit 1) as distributor_saidi
    from base b
),
outage as (
    select b.prop_id,
           coalesce(r.distributor_saidi, cp.proxy_minutes) as outage_minutes
    from base b
    left join reliability r on r.prop_id = b.prop_id
    left join _scoring_county_proxy cp on cp.county_fips = b.county_fips
),
empower as (
    select b.prop_id,
           case when ez.zip_code is not null and not ez.power_dependent_devices_dme_suppressed
                     and ez.medicare_benes > 0 and ez.power_dependent_devices_dme is not null
                then ez.power_dependent_devices_dme / ez.medicare_benes else null end as empower_rate
    from base b
    left join core.parcels p on p.prop_id = b.prop_id
    left join core.empower_zip ez on ez.zip_code = left(trim(p.situs_zip), 5)
),
acs as (
    select b.prop_id,
           case when a.geoid is not null and a.pop_total > 0 and a.pop_65_plus is not null
                then a.pop_65_plus / a.pop_total else null end as acs_pct_65_plus
    from base b
    left join core.acs_bg a on a.geoid = b.block_group_geoid
),
backup as (
    select hc.prop_id,
           case when bhc.homes_gated - 1 <= 0 then null
                when pc.any_permits_count is null then null
                else greatest(0, pc.backup_permits_count - (case when hbp.own_backup_permits is null then 0 else hbp.own_backup_permits end))::numeric
                     / (bhc.homes_gated - 1) * 1000
           end as backup_intent_rate
    from base hc
    join _scoring_bg_home_counts bhc on bhc.block_group_geoid = hc.block_group_geoid
    left join _scoring_bg_permit_counts pc on pc.block_group_geoid = hc.block_group_geoid
    left join _scoring_home_backup_permits hbp on hbp.prop_id = hc.prop_id
)
select b.prop_id, b.gate_reason, b.market_value,
       o.outage_minutes, e.empower_rate, a.acs_pct_65_plus, bk.backup_intent_rate
from base b
left join outage o on o.prop_id = b.prop_id
left join empower e on e.prop_id = b.prop_id
left join acs a on a.prop_id = b.prop_id
left join backup bk on bk.prop_id = b.prop_id;
"""

ANCHOR_SCALARS_SQL = """
select
    (select percentile_cont(0.9) within group (order by outage_minutes)
     from _scoring_anchor_inputs where outage_minutes is not null) as outage_anchor,
    (select percentile_cont(0.9) within group (order by empower_rate)
     from _scoring_anchor_inputs where empower_rate is not null) as empower_anchor,
    (select percentile_cont(0.9) within group (order by acs_pct_65_plus)
     from (select distinct block_group_geoid, acs_pct_65_plus from _scoring_anchor_inputs
           join core.home_spatial hs using (prop_id) where acs_pct_65_plus is not null) t) as age65_anchor,
    (select percentile_cont(0.9) within group (order by backup_intent_rate)
     from _scoring_anchor_inputs where gate_reason is null and backup_intent_rate is not null) as backup_anchor,
    (select percentile_cont(0.1) within group (order by ln(market_value))
     from _scoring_anchor_inputs where gate_reason is null and market_value > 0) as home_value_anchor_low,
    (select percentile_cont(0.9) within group (order by ln(market_value))
     from _scoring_anchor_inputs where gate_reason is null and market_value > 0) as home_value_anchor_high
"""


@dataclass
class Anchors:
    outage: float | None
    empower: float | None
    age65: float | None
    backup: float | None
    home_value_low: float | None
    home_value_high: float | None


# ---------------------------------------------------------------------------
# Step 3: per-batch mv_home_signals upsert. Same column list/expressions
# as 0304b2's `raw` + final select, restricted to one prop_id keyset
# range and reading the precomputed small tables + this run's fixed
# anchor scalars (bound as parameters, not recomputed per batch).
# ---------------------------------------------------------------------------
HOME_SIGNALS_BATCH_SQL = """
with keys as (
    select hs.prop_id
    from core.home_spatial hs
    where hs.prop_id > %(after)s
    order by hs.prop_id
    limit %(batch_size)s
),
base as (
    select
        hbg.prop_id, hbg.geo_id, hs.county_fips, hbg.block_group_geoid,
        p.situs_zip, p.ov65_exempt, p.market_value, hbg.parcel_source_id,
        hs.resolved_territory_eia_id as territory_eia_id, hs.territory_source_id,
        hs.territory_basis, hs.territory_null_reason,
        hs.territory_gate_reason as gate_reason,
        hs.in_sfha as flood_flag, hs.flood_source_id, hs.flood_null_reason,
        hs.boundary_source_ids
    from keys k
    join core.mv_home_block_group hbg on hbg.prop_id = k.prop_id
    join core.home_spatial hs on hs.prop_id = hbg.prop_id
    join core.parcels p on p.prop_id = hbg.prop_id
),
reliability as (
    select b.prop_id, ur.saidi_incl_major as distributor_saidi, ur.year as distributor_saidi_year,
           ur.early_release as distributor_saidi_early_release, ur.utility_name as distributor_name,
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
        order by r.year desc limit 1
    ) ur on true
),
outage as (
    select
        b.prop_id,
        case when r.distributor_saidi is not null then r.distributor_saidi
             when cp.proxy_minutes is not null then cp.proxy_minutes else null end as outage_minutes,
        case when r.distributor_saidi is not null then r.distributor_saidi_year
             when cp.proxy_minutes is not null then cp.year else null end as outage_year,
        case when r.distributor_saidi is not null then 'distributor_saidi'
             when cp.proxy_minutes is not null then 'county_eaglei_proxy' else null end as outage_basis,
        case when r.distributor_saidi is not null then array[r.reliability_source_id]
             when cp.proxy_minutes is not null then cp.source_ids else array[]::uuid[] end as outage_source_ids,
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
    left join _scoring_county_proxy cp on cp.county_fips = b.county_fips
),
empower as (
    select b.prop_id,
        case when ez.zip_code is null then null
             when ez.power_dependent_devices_dme_suppressed then null
             when ez.medicare_benes is null or ez.medicare_benes = 0 then null
             else ez.power_dependent_devices_dme / ez.medicare_benes end as empower_rate,
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
    select b.prop_id,
        case when a.geoid is null or a.pop_total is null or a.pop_total = 0 or a.pop_65_plus is null then null
             else a.pop_65_plus / a.pop_total end as acs_pct_65_plus,
        case when a.geoid is null or a.housing_units_total is null or a.housing_units_total = 0 or a.heating_electric is null then null
             else a.heating_electric / a.housing_units_total end as acs_pct_electric_heat,
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
home_permit_agg as (
    select b.prop_id, b.block_group_geoid,
        bool_or(pl.label = 'solar') as has_solar, bool_or(pl.label = 'ev') as has_ev,
        bool_or(pl.label = 'generator') as has_generator, bool_or(pl.label = 'panel') as has_panel,
        bool_or(pl.label = 'battery') as has_battery,
        min(pm.issue_date) filter (where pl.label = 'battery') as battery_permit_date,
        array_agg(pm.source_id) filter (where pl.label is not null) as home_permit_source_ids
    from base b
    left join core.permits pm on pm.tcad_id = b.geo_id
    left join core.permit_labels pl on pl.permit_number = pm.permit_number and pl.labeller = 'rules'
    group by b.prop_id, b.block_group_geoid
),
home_permits as (
    select hpa.prop_id,
        case when bpc.any_permits_count is null then null else coalesce(hpa.has_solar, false) end as home_solar,
        case when bpc.any_permits_count is null then null else coalesce(hpa.has_ev, false) end as home_ev,
        case when bpc.any_permits_count is null then null else coalesce(hpa.has_generator, false) end as home_generator,
        case when bpc.any_permits_count is null then null else coalesce(hpa.has_panel, false) end as home_panel_upgrade,
        case when bpc.any_permits_count is null then null else coalesce(hpa.has_battery, false) end as home_battery,
        hpa.battery_permit_date,
        case when bpc.any_permits_count is null then 'no_permit_coverage' else null end as permit_null_reason,
        hpa.home_permit_source_ids
    from home_permit_agg hpa
    left join _scoring_bg_permit_counts bpc on bpc.block_group_geoid = hpa.block_group_geoid
),
bg_backup as (
    select hc.prop_id,
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
        select b.prop_id, b.block_group_geoid, bhc.homes_gated - 1 as peer_homes
        from base b
        join _scoring_bg_home_counts bhc on bhc.block_group_geoid = b.block_group_geoid
    ) hc
    left join _scoring_bg_permit_counts pc on pc.block_group_geoid = hc.block_group_geoid
    left join _scoring_home_backup_permits hbp on hbp.prop_id = hc.prop_id
    cross join _scoring_permits_loaded pl
),
improvements as (
    select b.prop_id, pi.yr_built, pi.living_area, pi.source_id as improvements_source_id,
        case when pi.prop_id is null then
            case when (select count(*) from core.parcel_improvements) = 0 then 'tcad_improvements_not_loaded'
                 else 'no_living_area_detail' end
            else null end as yr_built_null_reason
    from base b
    left join core.parcel_improvements pi on pi.prop_id = b.prop_id
),
owner65 as (
    select b.prop_id,
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
        case when hp2.permit_null_reason is not null then null
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
        array(
            select distinct s.s from unnest(
                b.boundary_source_ids
                || array[r.reliability_source_id, a.acs_source_id, im.improvements_source_id]
                || coalesce(bb.permit_source_ids, array[]::uuid[])
                || coalesce(o.outage_source_ids, array[]::uuid[])
                || coalesce(hp2.home_permit_source_ids, array[]::uuid[])
            ) s(s) where s.s is not null
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
)
insert into core.mv_home_signals (
    prop_id, geo_id, block_group_geoid, county_fips, situs_zip,
    gate_reason, territory_eia_id, territory_null_reason, territory_basis,
    distributor_saidi, distributor_saidi_year, distributor_saidi_early_release,
    distributor_name, distributor_saidi_null_reason,
    distributor_saidi_pctile,
    outage_minutes, outage_year, outage_basis, outage_source_ids, outage_null_reason, outage_term,
    flood_flag, flood_null_reason, flood_pctile, flood_term,
    empower_rate, empower_null_reason, empower_pctile, empower_term,
    acs_pct_65_plus, acs_65_null_reason, acs_65_pctile, age65_term,
    acs_pct_electric_heat, acs_heat_null_reason, acs_heat_pctile, electric_heat_term,
    backup_intent_rate, backup_intent_null_reason, backup_intent_pctile, backup_intent_term,
    market_value, home_value_term, home_value_null_reason,
    owner_65, owner_65_null_reason,
    home_solar, home_ev, home_generator, home_panel_upgrade, home_battery,
    battery_permit_date, permit_null_reason, home_permits_flag,
    yr_built, living_area, yr_built_null_reason,
    installability_term, installability_null_reason,
    source_ids
)
select
    raw.prop_id, raw.geo_id, raw.block_group_geoid, raw.county_fips, raw.situs_zip,
    raw.gate_reason, raw.territory_eia_id, raw.territory_null_reason, raw.territory_basis,
    raw.distributor_saidi, raw.distributor_saidi_year, raw.distributor_saidi_early_release,
    raw.distributor_name, raw.distributor_saidi_null_reason,
    null::double precision,
    raw.outage_minutes, raw.outage_year, raw.outage_basis, raw.outage_source_ids, raw.outage_null_reason,
    case when raw.outage_minutes is not null and %(outage_anchor)s > 0
         then least(1.0, raw.outage_minutes::float8 / %(outage_anchor)s) else null end,
    raw.flood_flag, raw.flood_null_reason, null::double precision,
    case when raw.flood_flag is not null then case when raw.flood_flag then 0 else 1 end else null end,
    raw.empower_rate, raw.empower_null_reason, null::double precision,
    case when raw.empower_rate is not null and %(empower_anchor)s > 0
         then least(1.0, raw.empower_rate::float8 / %(empower_anchor)s) else null end,
    raw.acs_pct_65_plus, raw.acs_65_null_reason, null::double precision,
    case when raw.acs_pct_65_plus is not null and %(age65_anchor)s > 0
         then least(1.0, raw.acs_pct_65_plus::float8 / %(age65_anchor)s) else null end,
    raw.acs_pct_electric_heat, raw.acs_heat_null_reason, null::double precision, raw.acs_pct_electric_heat,
    raw.backup_intent_rate, raw.backup_intent_null_reason, null::double precision,
    case when raw.backup_intent_rate is not null and %(backup_anchor)s > 0
         then least(1.0, raw.backup_intent_rate::float8 / %(backup_anchor)s) else null end,
    raw.market_value,
    case when raw.market_value > 0
         then least(1.0, greatest(0.0, (ln(raw.market_value)::float8 - %(home_value_anchor_low)s) / (%(home_value_anchor_high)s - %(home_value_anchor_low)s)))
         else null end,
    case when raw.market_value > 0 then null else 'market_value_not_loaded' end,
    raw.owner_65_flag, raw.owner_65_null_reason,
    raw.home_solar, raw.home_ev, raw.home_generator, raw.home_panel_upgrade, raw.home_battery,
    raw.battery_permit_date, raw.permit_null_reason, raw.home_permits_flag,
    raw.yr_built, raw.living_area, raw.yr_built_null_reason,
    raw.installability_term, raw.installability_null_reason,
    raw.source_ids
from raw
on conflict (prop_id) do update set
    geo_id = excluded.geo_id, block_group_geoid = excluded.block_group_geoid,
    county_fips = excluded.county_fips, situs_zip = excluded.situs_zip,
    gate_reason = excluded.gate_reason, territory_eia_id = excluded.territory_eia_id,
    territory_null_reason = excluded.territory_null_reason, territory_basis = excluded.territory_basis,
    distributor_saidi = excluded.distributor_saidi, distributor_saidi_year = excluded.distributor_saidi_year,
    distributor_saidi_early_release = excluded.distributor_saidi_early_release,
    distributor_name = excluded.distributor_name, distributor_saidi_null_reason = excluded.distributor_saidi_null_reason,
    outage_minutes = excluded.outage_minutes, outage_year = excluded.outage_year,
    outage_basis = excluded.outage_basis, outage_source_ids = excluded.outage_source_ids,
    outage_null_reason = excluded.outage_null_reason, outage_term = excluded.outage_term,
    flood_flag = excluded.flood_flag, flood_null_reason = excluded.flood_null_reason, flood_term = excluded.flood_term,
    empower_rate = excluded.empower_rate, empower_null_reason = excluded.empower_null_reason, empower_term = excluded.empower_term,
    acs_pct_65_plus = excluded.acs_pct_65_plus, acs_65_null_reason = excluded.acs_65_null_reason, age65_term = excluded.age65_term,
    acs_pct_electric_heat = excluded.acs_pct_electric_heat, acs_heat_null_reason = excluded.acs_heat_null_reason,
    electric_heat_term = excluded.electric_heat_term,
    backup_intent_rate = excluded.backup_intent_rate, backup_intent_null_reason = excluded.backup_intent_null_reason,
    backup_intent_term = excluded.backup_intent_term,
    market_value = excluded.market_value, home_value_term = excluded.home_value_term, home_value_null_reason = excluded.home_value_null_reason,
    owner_65 = excluded.owner_65, owner_65_null_reason = excluded.owner_65_null_reason,
    home_solar = excluded.home_solar, home_ev = excluded.home_ev, home_generator = excluded.home_generator,
    home_panel_upgrade = excluded.home_panel_upgrade, home_battery = excluded.home_battery,
    battery_permit_date = excluded.battery_permit_date, permit_null_reason = excluded.permit_null_reason,
    home_permits_flag = excluded.home_permits_flag,
    yr_built = excluded.yr_built, living_area = excluded.living_area, yr_built_null_reason = excluded.yr_built_null_reason,
    installability_term = excluded.installability_term, installability_null_reason = excluded.installability_null_reason,
    source_ids = excluded.source_ids
where (
    core.mv_home_signals.gate_reason, core.mv_home_signals.territory_eia_id, core.mv_home_signals.outage_term,
    core.mv_home_signals.flood_term, core.mv_home_signals.empower_term, core.mv_home_signals.age65_term,
    core.mv_home_signals.backup_intent_term, core.mv_home_signals.home_value_term,
    core.mv_home_signals.home_permits_flag, core.mv_home_signals.installability_term
) is distinct from (
    excluded.gate_reason, excluded.territory_eia_id, excluded.outage_term,
    excluded.flood_term, excluded.empower_term, excluded.age65_term,
    excluded.backup_intent_term, excluded.home_value_term,
    excluded.home_permits_flag, excluded.installability_term
)
returning core.mv_home_signals.prop_id
"""

DELETE_ORPHAN_SIGNALS_SQL = """
delete from core.mv_home_signals s
where not exists (select 1 from core.home_spatial hs where hs.prop_id = s.prop_id)
"""

# ---------------------------------------------------------------------------
# Step 4: mv_home_terms, batched by county_fips (verbatim column list
# from 0304b4's definition -- no logic change, just scoped + upserted).
# ---------------------------------------------------------------------------
HOME_TERMS_COUNTY_SQL = """
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
),
rows as (
    select
        s.prop_id, s.county_fips, s.block_group_geoid, p.situs_city, s.situs_zip,
        s.backup_intent_rate,
        s.outage_term::float8 as outage_term, s.flood_term::float8 as flood_term,
        s.empower_term::float8 as empower_term, s.age65_term::float8 as age65_term,
        s.electric_heat_term::float8 as electric_heat_term, s.backup_intent_term::float8 as backup_intent_term,
        s.owner_65::int::float8 as owner65_term, s.home_permits_flag::int::float8 as permits_term,
        s.installability_term::float8 as installability_term, s.home_value_term::float8 as home_value_term,
        -- T3 fix (data-fixes review): Postgres LEAST/GREATEST ignore NULL
        -- arguments and return the min/max of the REMAINING non-null ones
        -- -- `least(1, NULL)` is 1, not NULL. Without the `is null` guard
        -- a block group with no core.acs_income_age_bg row (income_100k_
        -- share NULL) got income100k_term/age3564_term = 1.0 (a strong
        -- positive contribution) instead of null -- a term whose input is
        -- null must be null with a reason (W348444/Williamson: acs_
        -- income_age_bg has no row for its block group, raw_value was
        -- correctly null but the term still contributed 0.2 to the score).
        case when ia.income_100k_share is null then null
             else least(1, ia.income_100k_share / nullif(anc_one.inc_anchor, 0)) end::float8 as income100k_term,
        case when ia.age_35_64_share is null then null
             else least(1, ia.age_35_64_share / nullif(anc_one.age_anchor, 0)) end::float8 as age3564_term,
        (case when s.territory_eia_id = '1015' then 'city_battery_permit'
              when s.territory_eia_id is not null then 'state_rules_only' else null end) as permit_path,
        -- Same LEAST/GREATEST-ignores-NULL family as income100k/age3564
        -- above: the outer `when ... stats.median_days is not null` guard
        -- does not cover stats.share_never_finished going null on its
        -- own (a separate column on the same core.permit_path_stats
        -- row) -- if it ever did, `greatest(0, NULL)` would silently
        -- return 0 instead of NULL, making permitrisk_term = 1.0 instead
        -- of null. Currently dormant (share_never_finished is never null
        -- in the live core.permit_path_stats row, checked read-only
        -- 2026-09-27) but guarded explicitly so it can't regress silently.
        (case
            when s.territory_eia_id = '1015' and stats.median_days is not null
                 and stats.share_never_finished is not null then
                1 - least(1, greatest(0,
                    0.5 * least(1, stats.median_days::float8 / greatest(stats.p90_days, 1)::float8)
                    + 0.5 * stats.share_never_finished::float8))
            when s.territory_eia_id is not null and s.territory_eia_id != '1015' then 1.0
            else null end) as permitrisk_term,
        coalesce(hc.bucket, 'prospect') as coverage_bucket
    from core.mv_home_signals s
    join core.parcels p on p.prop_id = s.prop_id
    left join core.acs_income_age_bg ia on ia.geoid = s.block_group_geoid
    cross join anc_one
    cross join stats
    left join core.home_coverage hc on hc.prop_id = s.prop_id
    where s.gate_reason is null and s.county_fips = %(county_fips)s
)
insert into core.mv_home_terms (
    prop_id, county_fips, block_group_geoid, situs_city, situs_zip, backup_intent_rate,
    outage_term, flood_term, empower_term, age65_term, electric_heat_term, backup_intent_term,
    owner65_term, permits_term, installability_term, home_value_term, income100k_term, age3564_term,
    permit_path, permitrisk_term, coverage_bucket
)
select * from rows
on conflict (prop_id) do update set
    county_fips = excluded.county_fips, block_group_geoid = excluded.block_group_geoid,
    situs_city = excluded.situs_city, situs_zip = excluded.situs_zip, backup_intent_rate = excluded.backup_intent_rate,
    outage_term = excluded.outage_term, flood_term = excluded.flood_term, empower_term = excluded.empower_term,
    age65_term = excluded.age65_term, electric_heat_term = excluded.electric_heat_term,
    backup_intent_term = excluded.backup_intent_term, owner65_term = excluded.owner65_term,
    permits_term = excluded.permits_term, installability_term = excluded.installability_term,
    home_value_term = excluded.home_value_term, income100k_term = excluded.income100k_term,
    age3564_term = excluded.age3564_term, permit_path = excluded.permit_path,
    permitrisk_term = excluded.permitrisk_term, coverage_bucket = excluded.coverage_bucket
where (
    core.mv_home_terms.outage_term, core.mv_home_terms.flood_term, core.mv_home_terms.empower_term,
    core.mv_home_terms.age65_term, core.mv_home_terms.home_value_term, core.mv_home_terms.coverage_bucket
) is distinct from (
    excluded.outage_term, excluded.flood_term, excluded.empower_term,
    excluded.age65_term, excluded.home_value_term, excluded.coverage_bucket
)
"""

DELETE_ORPHAN_TERMS_SQL = """
delete from core.mv_home_terms t
where county_fips = %(county_fips)s
  and not exists (
      select 1 from core.mv_home_signals s
      where s.prop_id = t.prop_id and s.gate_reason is null
  )
"""


def _connect() -> psycopg.Connection:
    dsn = config.postgres_url_non_pooling()
    return psycopg.connect(dsn, prepare_threshold=None, autocommit=True)


def build_small_tables(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        for stmt in SMALL_TABLE_STATEMENTS:
            cur.execute(stmt)


def compute_anchors(conn: psycopg.Connection) -> Anchors:
    with conn.cursor() as cur:
        cur.execute(THIN_ANCHOR_INPUTS_SQL)
        cur.execute(ANCHOR_SCALARS_SQL)
        row = cur.fetchone()
        assert row is not None
    return Anchors(*row)


def refresh_home_signals_batched(conn: psycopg.Connection, anchors: Anchors, batch_size: int = BATCH_SIZE) -> int:
    """Upserts core.mv_home_signals by prop_id keyset range. Returns rows touched."""
    touched = 0
    after = ""
    params = {
        "outage_anchor": anchors.outage,
        "empower_anchor": anchors.empower,
        "age65_anchor": anchors.age65,
        "backup_anchor": anchors.backup,
        "home_value_anchor_low": anchors.home_value_low,
        "home_value_anchor_high": anchors.home_value_high,
        "batch_size": batch_size,
    }
    with conn.cursor() as cur:
        while True:
            cur.execute(HOME_SIGNALS_BATCH_SQL, {**params, "after": after})
            rows = cur.fetchall()
            if not rows:
                break
            touched += len(rows)
            after = max(r[0] for r in rows)
            if len(rows) < batch_size:
                break
        cur.execute(DELETE_ORPHAN_SIGNALS_SQL)
    return touched


def refresh_home_terms_by_county(conn: psycopg.Connection, county_fips_list: list[str]) -> None:
    with conn.cursor() as cur:
        for county_fips in county_fips_list:
            cur.execute(HOME_TERMS_COUNTY_SQL, {"county_fips": county_fips})
            cur.execute(DELETE_ORPHAN_TERMS_SQL, {"county_fips": county_fips})


def get_loaded_counties(conn: psycopg.Connection) -> list[str]:
    with conn.cursor() as cur:
        cur.execute("select distinct county_fips from core.home_spatial where county_fips is not null")
        return [r[0] for r in cur.fetchall()]


def run(*, batch_size: int = BATCH_SIZE) -> dict[str, float]:
    """Full batched refresh, then core.refresh_all_scores() for the
    remainder (legacy v0 chain, gate counts, market, anchors/medians
    tables, geo rollup, county territories -- see
    0307_batched_scoring_swap.sql for what that function does now)."""
    timings: dict[str, float] = {}
    with _connect() as conn:
        t0 = time.monotonic()
        build_small_tables(conn)
        timings["small_tables_s"] = time.monotonic() - t0

        t0 = time.monotonic()
        anchors = compute_anchors(conn)
        timings["anchors_s"] = time.monotonic() - t0

        t0 = time.monotonic()
        touched = refresh_home_signals_batched(conn, anchors, batch_size)
        timings["mv_home_signals_s"] = time.monotonic() - t0
        timings["mv_home_signals_rows_touched"] = touched

        t0 = time.monotonic()
        counties = get_loaded_counties(conn)
        refresh_home_terms_by_county(conn, counties)
        timings["mv_home_terms_s"] = time.monotonic() - t0

        t0 = time.monotonic()
        with conn.cursor() as cur:
            cur.execute("select core.refresh_all_scores()")
        timings["refresh_all_scores_remainder_s"] = time.monotonic() - t0
    return timings


if __name__ == "__main__":
    print(run())
