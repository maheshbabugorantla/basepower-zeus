-- 0212_home_signals_build.sql — M2-P8, BUILD half: home-level signals
-- (owner_65, home solar/ev/generator/panel/battery from the home's own
-- permits, installability from yr_built), a corrected outage percentile
-- (ranked against ALL Texas EIA-861 distributors, with an EAGLE-I county
-- proxy when a distributor reports no SAIDI), and anchored 0-1 score
-- terms (2026-09-26 decision: percentiles are out for scoring; every
-- term is now a real value scaled against a stored anchor).
--
-- Split from a single 0212_home_signals.sql into two files (2026-09-26,
-- per the M2-P8 coordinator: no apply attempt should pay this file's
-- ~5-6 min core.mv_home_signals_v2 build cost just to discover a bug in
-- the swap DDL) so the swap can be dry-run-iterated in seconds:
--   THIS FILE (0212_home_signals_build.sql): new tables (core.
--     parcel_improvements, core.signal_medians, core.signal_anchors,
--     core.default_weights + api.default_weights), and
--     core.mv_home_signals_v2 itself, built fully and populated under a
--     NEW name, alongside the still-live core.mv_home_signals -- the
--     site is completely unaffected by this file.
--   0212b_home_signals_swap.sql: the short swap transaction (rename
--     mv_home_signals -> _old, mv_home_signals_v2 -> mv_home_signals;
--     rebuild the two small gate-count aggregates + their api views;
--     drop+create the api/scoring functions whose output columns grew).
-- Both files are additive/idempotent-safe individually and must be
-- applied once, in order, from a clean (pre-M2-P8) state.
--
-- Backward-compatible, near-zero-downtime plan (binding for this
-- migration, per the M2-P8 coordinator note):
--   1. New tables (core.parcel_improvements, core.signal_medians) are
--      plain CREATE TABLE IF NOT EXISTS — additive, no risk.
--   2. The new materialized view is built under a NEW name
--      (core.mv_home_signals_v2), fully populated, *before* the swap
--      file runs — so the swap only needs a rename, not a multi-minute
--      rebuild while the site is affected.
--   3. The swap (0212b_home_signals_swap.sql) runs in one short
--      transaction.
--   4. Every existing api function/view keeps its existing output
--      columns, in their existing order, and its existing argument
--      list — new columns are appended, never inserted/removed/renamed.
--      A weights jsonb object containing only the six original keys
--      (outage, flood, empower, age65, electric_heat, backup_intent)
--      continues to work unchanged (new weight keys default to 0 via
--      the same `weights ? 'key'` pattern already used for every key).
--
-- ===========================================================================
-- Part 1 — new tables (additive, safe to apply immediately)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- core.parcel_improvements — one row per Travis gated-home prop_id, from
-- the TCAD export's IMP_DET.TXT (File #8: Improvement Detail), loaded by
-- pipelines/sources/tcad_improvements.py (M2-P8). yr_built/living_area
-- are the main improvement's (see that module's docstring for the exact
-- "main living-area detail" rule). Null (never a placeholder year/area)
-- until the backfill runs, or for a prop_id IMP_DET.TXT has no floor
-- detail for.
-- ---------------------------------------------------------------------------

create table if not exists core.parcel_improvements (
    prop_id      text primary key,
    yr_built     int,
    living_area  numeric,
    source_id    uuid not null references ops.source_manifest (id),
    created_at   timestamptz not null default now()
);

comment on table core.parcel_improvements is
    'Year built + living area per Travis gated-home prop_id, from the '
    'TCAD export''s IMP_DET.TXT (main living-area improvement, see '
    'pipelines/sources/tcad_improvements.py for the exact rule). Null '
    '(not zero/placeholder) when IMP_DET.TXT has no floor-code detail '
    'for that prop_id. Filled by M2-P8.';

-- ---------------------------------------------------------------------------
-- core.signal_medians — per-county median of each scored home-level term
-- (the same [0,1]-scaled value used in the weighted-average score),
-- recomputed by core.refresh_all_scores() alongside core.mv_home_signals.
-- Backs "top signals" (M2-P8 (3)): a home's top signals are ranked by
-- weight * (its term − this county median for that term), not by raw
-- percentile, so a term that is nearly the same for every home in the
-- county (e.g. flood_pctile, 98%+ of Travis homes read 1.0 "outside a
-- flood zone") stops dominating every home's reasons. signal_key values
-- match the weight keys in api.*_weighted's `weights` jsonb argument.
-- ---------------------------------------------------------------------------

create table if not exists core.signal_medians (
    county_fips  text not null,
    signal_key   text not null,
    median       numeric,
    created_at   timestamptz not null default now(),
    primary key (county_fips, signal_key)
);

comment on table core.signal_medians is
    'Per-county median of each scored home-level term (percentile or 0/1 '
    'flag, same scale the weighted score uses), for "top signals" ranking '
    'by deviation from the county norm rather than raw value. Recomputed '
    'by core.refresh_all_scores(). Filled by M2-P8.';

alter table core.parcel_improvements enable row level security;
alter table core.signal_medians      enable row level security;

revoke all on core.parcel_improvements from public, anon, authenticated;
revoke all on core.signal_medians      from public, anon, authenticated;

-- zeus_web_ro: 0210_web_readonly_role.sql already grants SELECT on every
-- current/future core table via `alter default privileges`, but that only
-- covers tables created by the same role going forward — re-assert
-- explicitly here too (belt and braces, matches the ticket's ask to
-- "re-grant SELECT ... for new RLS tables (pattern in 0210)").
grant select on core.parcel_improvements, core.signal_medians to zeus_web_ro;

drop policy if exists web_ro_select on core.parcel_improvements;
create policy web_ro_select on core.parcel_improvements for select to zeus_web_ro using (true);

drop policy if exists web_ro_select on core.signal_medians;
create policy web_ro_select on core.signal_medians for select to zeus_web_ro using (true);

-- ---------------------------------------------------------------------------
-- core.signal_anchors — denominators for the anchored 0–1 score terms
-- below. Superseding percentiles for scoring (2026-09-26 user decision:
-- percentiles discard magnitude — every Austin Energy home's identical
-- 181.98 SAIDI minutes ranked 0, every ZIP 78730 empower rate ranked 0,
-- purely because each was compared only against homes sharing its own
-- single distributor/ZIP rate, not against a real, load-bearing
-- benchmark). Recomputed by core.refresh_all_scores(); source_ids trace
-- each anchor back to the manifest row(s) it was computed from.
-- ---------------------------------------------------------------------------

create table if not exists core.signal_anchors (
    signal_key       text primary key,
    anchor_value     numeric not null,
    -- Only home_value uses a two-sided (low, high) anchor: term =
    -- clamp01((ln(value) - anchor_value_low) / (anchor_value - anchor_value_low)).
    -- Every other signal_key leaves this null (single anchor_value only).
    anchor_value_low numeric,
    basis        text not null,
    year         int,
    source_ids   uuid[] not null,
    created_at   timestamptz not null default now()
);

comment on table core.signal_anchors is
    'Denominator for each anchored 0–1 score term (term = min(1, raw '
    'value / anchor_value)). basis is the plain-words description shown '
    'in api.home_score_breakdown.anchor_basis. Recomputed by '
    'core.refresh_all_scores(). Filled by M2-P8.';

alter table core.signal_anchors enable row level security;
revoke all on core.signal_anchors from public, anon, authenticated;
grant select on core.signal_anchors to zeus_web_ro;
drop policy if exists web_ro_select on core.signal_anchors;
create policy web_ro_select on core.signal_anchors for select to zeus_web_ro using (true);

-- ===========================================================================
-- Part 2 — core.mv_home_signals_v2 (built under a new name; swapped in
-- at the end of this file in one short transaction)
-- ===========================================================================
--
-- Term definitions (each 0–1, linear on the real value, capped at 1;
-- 2026-09-26 user decision, replacing the old percent_rank() terms):
--   outage         min(1, outage_minutes / anchor['outage'])
--                  anchor['outage'] = 90th percentile of the latest
--                  (2025) EIA-861 SAIDI-incl-major-events figure across
--                  every Texas distributor that reported one (45 in
--                  2025). Applies identically whether outage_minutes
--                  came from the home's own distributor's SAIDI or (when
--                  that distributor reported none, e.g. Oncor) the
--                  EAGLE-I county proxy — both are the same unit,
--                  minutes without power per customer per year.
--   electric_heat  acs_pct_electric_heat directly — already a 0–1 share,
--                  no anchor needed.
--   age65          min(1, acs_pct_65_plus / anchor['age65'])
--                  anchor['age65'] = 90th percentile of acs_pct_65_plus
--                  across every Travis block group with at least one
--                  gated home.
--   empower        min(1, empower_rate / anchor['empower'])
--                  anchor['empower'] = 90th percentile of the same rate
--                  (power-dependent DME devices / Medicare beneficiaries)
--                  across every Texas ZIP in the emPOWER file (not just
--                  ZIPs a home matches), so a home's rate is judged
--                  against the real statewide spread, not against
--                  itself.
--   backup_intent  min(1, backup_intent_rate / anchor['backup_intent'])
--                  anchor['backup_intent'] = 90th percentile of the same
--                  rate across every distinct Travis-area block group
--                  this view assigns one to.
--   flood          1 outside a FEMA Special Flood Hazard Area, 0 inside
--                  (penalty only) — kept in the weighted average (an
--                  SFHA home loses ground) but never a candidate "top
--                  signal" (near-constant: ~98.5% of homes read 1).
--   owner_65       (core.parcels.ov65_exempt = 'T')::numeric — 1/0.
--   home_permits   1 if the home's own Austin permits (core.permits.
--                  tcad_id = this home's geo_id, rules-labelled) include
--                  solar, ev, or generator, else 0; null when this
--                  home's block group has never had ANY permit recorded
--                  (the existing bg_permit_counts/any_permits_count
--                  "no_permit_coverage" logic core.mv_home_signals
--                  already uses for backup_intent, reused here at
--                  home-level scope) — never a false for a home the
--                  permits dataset simply doesn't cover.
--   installability 1 if the home has its own panel-upgrade permit, or
--                  yr_built >= 2000 (the same team-chosen cutoff as the
--                  "Hide homes built before 2000" UI filter — a team
--                  choice, not a Base rule, per M2-P8's own note); 0 if
--                  yr_built is known and < 2000 and no panel permit;
--                  null only when BOTH yr_built and the panel permit
--                  flag are unknown.
-- ===========================================================================

drop materialized view if exists core.mv_home_signals_v2;

create materialized view core.mv_home_signals_v2 as
with base as (
    select
        hb.prop_id,
        hb.geo_id,
        hb.block_group_geoid,
        bg.county_fips,
        pg.centroid,
        p.situs_zip,
        p.ov65_exempt,
        p.market_value,
        p.source_id  as parcel_source_id,
        hb.geom_source_id,
        hb.bg_source_id
    from core.mv_home_block_group hb
    join core.parcels p on p.prop_id = hb.prop_id
    left join core.parcel_geoms pg on pg.prop_id = hb.prop_id
    left join core.block_groups bg on bg.geoid = hb.block_group_geoid
),
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
-- Distributor-level SAIDI (unchanged from the pre-M2-P8 view; kept for
-- backward compat with anything reading distributor_saidi directly).
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
-- County-year EAGLE-I proxy, one row per county at its latest loaded
-- year — exactly the inputs api.county_outage.hours_per_customer uses
-- (customer_hours_out / core.county_customers.customers), times 60 to
-- get minutes/customer/year, the same unit as EIA-861 SAIDI.
county_proxy as (
    select distinct on (o.county_fips)
        o.county_fips,
        o.year,
        (o.customer_hours_out * 60.0 / c.customers) as proxy_minutes,
        array(
            select distinct s from unnest(o.source_ids || array[c.source_id]) s where s is not null
        ) as source_ids,
        (c.customers is null or c.customers = 0) as customers_missing
    from core.outage_county_year o
    left join core.county_customers c on c.county_fips = o.county_fips
    where o.customer_hours_out is not null
    order by o.county_fips, o.year desc
),
-- M2-P8 outage fix: distributor SAIDI always wins when present; else the
-- home's own county's EAGLE-I proxy, on the same Texas scale. Never a
-- home-level percentile against homes sharing one distributor (the bug
-- this ticket fixes: Austin Energy's 139k+ homes all shared 181.98
-- minutes, so percent_rank() over homes gave 0 for every one of them).
outage as (
    select
        b.prop_id,
        case when r.distributor_saidi is not null then r.distributor_saidi
             when cp.proxy_minutes is not null then cp.proxy_minutes
             else null end as outage_minutes,
        case when r.distributor_saidi is not null then r.distributor_saidi_year
             when cp.proxy_minutes is not null then cp.year
             else null end as outage_year,
        case when r.distributor_saidi is not null then 'distributor_saidi'
             when cp.proxy_minutes is not null then 'county_eaglei_proxy'
             else null end as outage_basis,
        case when r.distributor_saidi is not null then array[r.reliability_source_id]
             when cp.proxy_minutes is not null then cp.source_ids
             else array[]::uuid[] end as outage_source_ids,
        case
            when r.distributor_saidi is not null then null
            when cp.proxy_minutes is not null then null
            when r.distributor_saidi_null_reason not in ('no_eia861_figure_for_distributor') then r.distributor_saidi_null_reason
            when (select count(*) from core.outage_county_year) = 0 then 'eaglei_not_loaded'
            when cp.customers_missing then 'county_customers_not_loaded'
            else 'no_outage_figure_for_county'
        end as outage_null_reason
    from base b
    join reliability r on r.prop_id = b.prop_id
    left join county_proxy cp on cp.county_fips = b.county_fips
),
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
bg_home_counts as (
    select block_group_geoid, count(*) as homes_gated
    from core.mv_home_block_group
    group by block_group_geoid
),
-- prop_id is carried through here (M2-P8) so home_backup_permits below
-- can compute each home's OWN backup-permit count, which the peer rate
-- (bg_backup) must subtract out — 2026-09-26 evidence-based fix: a
-- home's own battery/generator permit must never inflate its own
-- "neighbours are adopting backup" signal.
permits_in_window as (
    select
        pm.permit_number,
        hb.block_group_geoid,
        hb.prop_id,
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
-- Each home's own battery/generator permit count within the same
-- 36-month window bg_permit_counts uses — subtracted from the block
-- group's backup_permits_count before computing that home's peer rate.
home_backup_permits as (
    select prop_id, count(distinct permit_number) as own_backup_permits
    from permits_in_window
    where label in ('battery', 'generator')
    group by prop_id
),
permits_loaded as (
    select exists (select 1 from core.permit_labels where labeller = 'rules') as any_rules_labels
),
-- Peer backup-intent rate (M2-P8, corrected 2026-09-26): battery/
-- generator permits per 1,000 OTHER gated homes in this home's block
-- group, over the last 36 months -- excludes the home's own permit(s),
-- so a home is never scored on its own adoption. A block group with
-- only 1 gated home has no peers (null, reason 'no_peer_homes').
bg_backup as (
    select
        hc.prop_id,
        hc.block_group_geoid,
        case
            when hc.peer_homes <= 0 then null
            when pc.any_permits_count is null then null
            else (greatest(0, pc.backup_permits_count - coalesce(hbp.own_backup_permits, 0))::numeric / hc.peer_homes) * 1000
        end as backup_intent_rate,
        pc.permit_source_ids,
        case
            when hc.peer_homes <= 0 then 'no_peer_homes_in_block_group'
            when not pl.any_rules_labels then 'permits_not_loaded'
            when pc.any_permits_count is null then 'no_permit_coverage'
            else null
        end as backup_intent_null_reason
    from (
        select hb.prop_id, hb.block_group_geoid, bhc.homes_gated - 1 as peer_homes
        from core.mv_home_block_group hb
        join bg_home_counts bhc on bhc.block_group_geoid = hb.block_group_geoid
    ) hc
    left join bg_permit_counts pc on pc.block_group_geoid = hc.block_group_geoid
    left join home_backup_permits hbp on hbp.prop_id = hc.prop_id
    cross join permits_loaded pl
),
-- Home-level permit flags (M2-P8): the home's own geo_id, not the block
-- group. Coverage reuses bg_permit_counts.any_permits_count -- the same
-- "has this block group EVER had any permit recorded" signal
-- backup_intent already uses for 'no_permit_coverage' -- at home scope,
-- so a home in a block group the Austin permits dataset has simply never
-- covered reads null, never false.
home_permit_agg as (
    select
        b.prop_id,
        b.block_group_geoid,
        bool_or(pl.label = 'solar')      as has_solar,
        bool_or(pl.label = 'ev')          as has_ev,
        bool_or(pl.label = 'generator')   as has_generator,
        bool_or(pl.label = 'panel')       as has_panel,
        bool_or(pl.label = 'battery')     as has_battery,
        min(pm.issue_date) filter (where pl.label = 'battery') as battery_permit_date,
        array_agg(distinct pm.source_id) filter (where pl.label is not null) as home_permit_source_ids
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
        case when pi.prop_id is null then
            case when (select count(*) from core.parcel_improvements) = 0
                 then 'tcad_improvements_not_loaded' else 'no_living_area_detail' end
        end as yr_built_null_reason
    from base b
    left join core.parcel_improvements pi on pi.prop_id = b.prop_id
),
owner65 as (
    select
        b.prop_id,
        case when b.ov65_exempt is null then null else (b.ov65_exempt = 'T') end as owner_65_flag,
        case when b.ov65_exempt is null then 'exemption_data_missing' else null end as owner_65_null_reason
    from base b
),
raw as (
    select
        b.prop_id,
        b.geo_id,
        b.block_group_geoid,
        b.county_fips,
        b.situs_zip,
        b.market_value,
        g.gate_reason,
        g.territory_eia_id,
        g.territory_null_reason,
        r.distributor_saidi,
        r.distributor_saidi_year,
        r.distributor_saidi_early_release,
        r.distributor_name,
        r.distributor_saidi_null_reason,
        o.outage_minutes,
        o.outage_year,
        o.outage_basis,
        o.outage_source_ids,
        o.outage_null_reason,
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
        ow.owner_65_flag,
        ow.owner_65_null_reason,
        hp.home_solar,
        hp.home_ev,
        hp.home_generator,
        hp.home_panel_upgrade,
        hp.home_battery,
        hp.battery_permit_date,
        hp.permit_null_reason,
        im.yr_built,
        im.living_area,
        im.yr_built_null_reason,
        case
            when hp.permit_null_reason is not null then null
            else (coalesce(hp.home_solar, false) or coalesce(hp.home_ev, false) or coalesce(hp.home_generator, false))
        end as home_permits_flag,
        case
            when coalesce(hp.home_panel_upgrade, false) then 1
            when im.yr_built is not null then (case when im.yr_built >= 2000 then 1 else 0 end)
            when hp.permit_null_reason is null then 0
            else null
        end as installability_term,
        case
            when coalesce(hp.home_panel_upgrade, false) or im.yr_built is not null then null
            when hp.permit_null_reason is null then null
            when im.yr_built_null_reason is not null then 'no_permit_coverage_and_' || im.yr_built_null_reason
            else 'no_permit_coverage_and_year_built_not_loaded'
        end as installability_null_reason,
        array(
            select distinct s from unnest(
                array[
                    b.parcel_source_id, b.geom_source_id, b.bg_source_id,
                    g.territory_source_id, g.crosswalk_source_id,
                    r.reliability_source_id, f.flood_source_id,
                    e.empower_source_id, a.acs_source_id, im.improvements_source_id
                ] || coalesce(bb.permit_source_ids, array[]::uuid[])
                  || coalesce(o.outage_source_ids, array[]::uuid[])
                  || coalesce(hp.home_permit_source_ids, array[]::uuid[])
            ) s where s is not null
        ) as source_ids
    from base b
    join gate g on g.prop_id = b.prop_id
    left join reliability r on r.prop_id = b.prop_id
    left join outage o on o.prop_id = b.prop_id
    left join flood f on f.prop_id = b.prop_id
    left join empower e on e.prop_id = b.prop_id
    left join acs a on a.prop_id = b.prop_id
    left join bg_backup bb on bb.prop_id = b.prop_id
    left join owner65 ow on ow.prop_id = b.prop_id
    left join home_permits hp on hp.prop_id = b.prop_id
    left join improvements im on im.prop_id = b.prop_id
),
-- Anchors (90th percentiles), computed once here off the same `raw`
-- population this refresh already built (Travis-area gated homes) —
-- age65/backup_intent are Travis-only by construction (every gated home
-- is a Travis TCAD parcel); outage/empower anchors are Texas-wide, off
-- core.utility_reliability / core.empower_zip directly (every TX
-- distributor/ZIP, not just ones a home matches).
anchors as (
    select
        (select percentile_cont(0.9) within group (order by saidi_incl_major)
         from core.utility_reliability
         where year = (select max(year) from core.utility_reliability where saidi_incl_major is not null)
           and saidi_incl_major is not null) as outage_anchor,
        (select percentile_cont(0.9) within group (order by (power_dependent_devices_dme::numeric / medicare_benes))
         from core.empower_zip
         where not power_dependent_devices_dme_suppressed and medicare_benes > 0
           and power_dependent_devices_dme is not null) as empower_anchor,
        (select percentile_cont(0.9) within group (order by acs_pct_65_plus)
         from (select distinct block_group_geoid, acs_pct_65_plus from raw where acs_pct_65_plus is not null) t
        ) as age65_anchor,
        -- backup_intent_rate is now per-HOME (peer rate, self excluded,
        -- 2026-09-26 fix) rather than uniform per block group, so the
        -- anchor is the 90th percentile across homes directly, no dedup.
        (select percentile_cont(0.9) within group (order by backup_intent_rate)
         from raw where raw.gate_reason is null and backup_intent_rate is not null
        ) as backup_anchor,
        (select percentile_cont(0.1) within group (order by ln(market_value))
         from raw where raw.gate_reason is null and market_value > 0
        ) as home_value_anchor_low,
        (select percentile_cont(0.9) within group (order by ln(market_value))
         from raw where raw.gate_reason is null and market_value > 0
        ) as home_value_anchor_high
),
gated as (
    select
        raw.prop_id,
        percent_rank() over (partition by (raw.distributor_saidi is null) order by raw.distributor_saidi)      as pr_saidi,
        percent_rank() over (partition by (raw.flood_flag is null) order by raw.flood_flag::int)                as pr_flood,
        percent_rank() over (partition by (raw.empower_rate is null) order by raw.empower_rate)                 as pr_empower,
        percent_rank() over (partition by (raw.acs_pct_65_plus is null) order by raw.acs_pct_65_plus)            as pr_acs65,
        percent_rank() over (partition by (raw.acs_pct_electric_heat is null) order by raw.acs_pct_electric_heat) as pr_acsheat,
        percent_rank() over (partition by (raw.backup_intent_rate is null) order by raw.backup_intent_rate)      as pr_backup
    from raw
    where raw.gate_reason is null
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
    -- *_pctile columns kept, unchanged formula, for backward compat with
    -- anything still reading them directly (no scoring function uses
    -- these anymore -- see the outage/anchors CTEs above for the terms
    -- that do).
    (case when raw.distributor_saidi is not null then gated.pr_saidi end) as distributor_saidi_pctile,
    raw.outage_minutes,
    raw.outage_year,
    raw.outage_basis,
    raw.outage_source_ids,
    raw.outage_null_reason,
    (case when raw.outage_minutes is not null and anchors.outage_anchor > 0
          then least(1.0, raw.outage_minutes / anchors.outage_anchor) end) as outage_term,
    raw.flood_flag,
    raw.flood_null_reason,
    (case when raw.flood_flag is not null then gated.pr_flood end) as flood_pctile,
    (case when raw.flood_flag is not null then (case when raw.flood_flag then 0 else 1 end) end) as flood_term,
    raw.empower_rate,
    raw.empower_null_reason,
    (case when raw.empower_rate is not null then gated.pr_empower end) as empower_pctile,
    (case when raw.empower_rate is not null and anchors.empower_anchor > 0
          then least(1.0, raw.empower_rate / anchors.empower_anchor) end) as empower_term,
    raw.acs_pct_65_plus,
    raw.acs_65_null_reason,
    (case when raw.acs_pct_65_plus is not null then gated.pr_acs65 end) as acs_65_pctile,
    (case when raw.acs_pct_65_plus is not null and anchors.age65_anchor > 0
          then least(1.0, raw.acs_pct_65_plus / anchors.age65_anchor) end) as age65_term,
    raw.acs_pct_electric_heat,
    raw.acs_heat_null_reason,
    (case when raw.acs_pct_electric_heat is not null then gated.pr_acsheat end) as acs_heat_pctile,
    raw.acs_pct_electric_heat as electric_heat_term,
    raw.backup_intent_rate,
    raw.backup_intent_null_reason,
    (case when raw.backup_intent_rate is not null then gated.pr_backup end) as backup_intent_pctile,
    (case when raw.backup_intent_rate is not null and anchors.backup_anchor > 0
          then least(1.0, raw.backup_intent_rate / anchors.backup_anchor) end) as backup_intent_term,
    raw.market_value,
    (case when raw.market_value > 0
          then least(1.0, greatest(0.0,
              (ln(raw.market_value) - anchors.home_value_anchor_low)
              / (anchors.home_value_anchor_high - anchors.home_value_anchor_low)
          ))
     end) as home_value_term,
    (case when raw.market_value > 0 then null else 'market_value_not_loaded' end) as home_value_null_reason,
    raw.owner_65_flag as owner_65,
    raw.owner_65_null_reason,
    raw.home_solar,
    raw.home_ev,
    raw.home_generator,
    raw.home_panel_upgrade,
    raw.home_battery,
    raw.battery_permit_date,
    raw.permit_null_reason,
    raw.home_permits_flag,
    raw.yr_built,
    raw.living_area,
    raw.yr_built_null_reason,
    raw.installability_term,
    raw.installability_null_reason,
    raw.source_ids
from raw
cross join anchors
left join gated on gated.prop_id = raw.prop_id;

create unique index mv_home_signals_v2_prop_id_idx on core.mv_home_signals_v2 (prop_id);
create index mv_home_signals_v2_gate_reason_idx on core.mv_home_signals_v2 (gate_reason) where gate_reason is null;
create index mv_home_signals_v2_county_fips_idx on core.mv_home_signals_v2 (county_fips);
create index mv_home_signals_v2_bg_geoid_idx on core.mv_home_signals_v2 (block_group_geoid);

-- ---------------------------------------------------------------------------
-- core.signal_anchors — populate/refresh from the view we just built
-- (same anchors it used internally; stored here so the home page can
-- show "739 minutes -- Texas utilities' 90th-percentile outage minutes,
-- EIA-861 2025" as plain-words provenance, and so refresh_all_scores()
-- can keep this table current without re-deriving the SQL by hand).
-- ---------------------------------------------------------------------------

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
     from (select distinct block_group_geoid, acs_pct_65_plus from core.mv_home_signals_v2 where acs_pct_65_plus is not null) t),
    null::numeric,
    '90th-percentile share of population age 65+, across every Travis County block group with a gated home, Census ACS',
    null::int,
    (select array_agg(distinct source_id) from core.acs_bg)
union all
select
    'backup_intent',
    (select percentile_cont(0.9) within group (order by backup_intent_rate)
     from core.mv_home_signals_v2 where gate_reason is null and backup_intent_rate is not null),
    null::numeric,
    '90th-percentile rate of battery/generator permits per 1,000 OTHER gated homes (peer rate, self excluded, 36 months), across Travis County homes, Austin permits',
    null::int,
    (select array_agg(distinct source_id) from core.permits)
union all
select
    'home_value',
    (select percentile_cont(0.9) within group (order by ln(market_value))
     from core.mv_home_signals_v2 where gate_reason is null and market_value > 0),
    (select percentile_cont(0.1) within group (order by ln(market_value))
     from core.mv_home_signals_v2 where gate_reason is null and market_value > 0),
    '10th-to-90th-percentile range of ln(market value) across Travis gated homes, TCAD 2026 Certified Appraisal Export',
    2026,
    (select array_agg(distinct source_id) from core.parcels where county_fips = '48453')
on conflict (signal_key) do update set
    anchor_value     = excluded.anchor_value,
    anchor_value_low = excluded.anchor_value_low,
    basis            = excluded.basis,
    year             = excluded.year,
    source_ids       = excluded.source_ids,
    created_at       = now();

-- ---------------------------------------------------------------------------
-- core.signal_medians — per-county median of each anchored/flag term
-- (same [0,1] scale the score uses), for "top signals" ranking by
-- deviation from the county norm. flood is excluded from the source list
-- entirely (it is never a top-signal candidate regardless).
-- ---------------------------------------------------------------------------

delete from core.signal_medians;

insert into core.signal_medians (county_fips, signal_key, median)
select county_fips, 'outage', percentile_cont(0.5) within group (order by outage_term)
from core.mv_home_signals_v2 where gate_reason is null and outage_term is not null group by county_fips
union all
select county_fips, 'home_value', percentile_cont(0.5) within group (order by home_value_term)
from core.mv_home_signals_v2 where gate_reason is null and home_value_term is not null group by county_fips
union all
select county_fips, 'empower', percentile_cont(0.5) within group (order by empower_term)
from core.mv_home_signals_v2 where gate_reason is null and empower_term is not null group by county_fips
union all
select county_fips, 'age65', percentile_cont(0.5) within group (order by age65_term)
from core.mv_home_signals_v2 where gate_reason is null and age65_term is not null group by county_fips
union all
select county_fips, 'electric_heat', percentile_cont(0.5) within group (order by electric_heat_term)
from core.mv_home_signals_v2 where gate_reason is null and electric_heat_term is not null group by county_fips
union all
select county_fips, 'backup_intent', percentile_cont(0.5) within group (order by backup_intent_term)
from core.mv_home_signals_v2 where gate_reason is null and backup_intent_term is not null group by county_fips
union all
select county_fips, 'owner_65', percentile_cont(0.5) within group (order by owner_65::int)
from core.mv_home_signals_v2 where gate_reason is null and owner_65 is not null group by county_fips
union all
select county_fips, 'home_permits', percentile_cont(0.5) within group (order by home_permits_flag::int)
from core.mv_home_signals_v2 where gate_reason is null and home_permits_flag is not null group by county_fips
union all
select county_fips, 'installability', percentile_cont(0.5) within group (order by installability_term)
from core.mv_home_signals_v2 where gate_reason is null and installability_term is not null group by county_fips;

-- ---------------------------------------------------------------------------
-- core.default_weights — team-chosen default weight per signal (config,
-- not observed data — same status as ops.refresh_policy's seed rows),
-- from the orchestrator's 2026-09-26 time-split adoption study (permits
-- before 2025-07-01 as signals, battery/generator permit 2025-07-01..
-- 2026-09 as the outcome, 135,083 Austin-coverage homes without prior
-- backup, 734 adopters): outage and home_value carried the strongest
-- lift (11.5x / 0.727 AUC and similar for outage), backup_intent (peer
-- rate) next (5.1x / 0.682), age65 and home_permits moderate, empower
-- and electric_heat weak, flood a penalty-only term (never a positive
-- driver, excluded from "top signal" candidates regardless of weight).
-- ---------------------------------------------------------------------------

create table if not exists core.default_weights (
    signal_key text primary key,
    weight     numeric not null check (weight >= 0 and weight <= 10),
    basis      text not null
);

comment on table core.default_weights is
    'Team-chosen default weight (0-10) per score signal, from the '
    '2026-09-26 time-split adoption study. Config, not observed data. '
    'Read by api.default_weights (web default weights UI).';

-- no-mock-check: config-seed default weights are the team's evidence-based judgment call from the time-split study, not source data
insert into core.default_weights (signal_key, weight, basis) values
    ('outage',         8, 'time-split study: 11.5x top-vs-bottom-quintile adoption lift, AUC 0.727'),
    ('home_value',     8, 'time-split study: ln(market_value), 11.5x lift, AUC 0.727'),
    ('backup_intent',  7, 'time-split study: peer adoption rate (self excluded), 5.1x lift, AUC 0.682'),
    ('age65',          4, 'time-split study: 2.9x lift, AUC 0.594'),
    ('home_permits',   4, 'time-split study: own solar/EV/panel, ~2.3x lift each but rare'),
    ('electric_heat',  2, 'time-split study: 0.8x lift, weak signal'),
    ('empower',        2, 'time-split study: 0.4x lift, AUC 0.373 (weaker than random on this outcome, kept small but nonzero for medical-need visibility)'),
    ('owner_65',       1, 'time-split study: 1.1x lift, near-neutral'),
    ('installability',  2, 'team judgment: not evaluated in the adoption study (Base eligibility signal, not an adoption predictor)'),
    ('flood',          2, 'penalty-only term (never a positive driver or a top signal); team judgment')
on conflict (signal_key) do update set weight = excluded.weight, basis = excluded.basis;

alter table core.default_weights enable row level security;
revoke all on core.default_weights from public, anon, authenticated;
grant select on core.default_weights to zeus_web_ro;
drop policy if exists web_ro_select on core.default_weights;
create policy web_ro_select on core.default_weights for select to zeus_web_ro using (true);

create or replace view api.default_weights as
    select signal_key, weight, basis from core.default_weights;

comment on view api.default_weights is
    'Team-chosen default weight (0-10) per score signal -- the UI''s '
    'starting weights object before a user drags any slider. Config, '
    'not sourced data (see core.default_weights).';

revoke all on api.default_weights from public, anon, authenticated;
grant select on api.default_weights to service_role, zeus_web_ro;

-- ===========================================================================
