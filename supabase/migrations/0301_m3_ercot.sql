-- M3-S1 / M3-P1 / M3-P4 (combined slice): ERCOT settlement point prices,
-- grid-value-by-load-zone (spread + scarcity, anchored not percentiled),
-- county-to-load-zone crosswalk, and a per-utility base_capture view.
--
-- These are NEW, STANDALONE tables/views. Per the ticket's explicit
-- instruction, nothing here is wired into core.mv_home_signals or any
-- scoring function yet -- that join is left for a later ticket.

-- ---------------------------------------------------------------------------
-- core.ercot_spp -- raw 15-minute real-time settlement point prices,
-- ERCOT report NP6-905-CD (spp_node_zone_hub), settlementPointType=LZ
-- ONLY (never LZEW -- the same 8 LZ_* names return different prices under
-- that type; filtering by type, not name, is what keeps one price per
-- zone per interval. See checks/M3-H1.md and checks/M3-ercot-layering.md
-- section A).
--
-- Keyed by (settlement_point, delivery_date, delivery_hour,
-- delivery_interval, dst_flag) -- NOT by a UTC interval_start alone --
-- because the fall-back DST day repeats hour-ending 2 twice (dst_flag
-- distinguishes the two passes); collapsing on interval_start alone would
-- silently drop 4 real intervals every November.
-- ---------------------------------------------------------------------------

create table if not exists core.ercot_spp (
    id                   uuid primary key default gen_random_uuid(),
    settlement_point     text not null,
    delivery_date        date not null,
    delivery_hour        smallint not null check (delivery_hour between 1 and 24),
    delivery_interval    smallint not null check (delivery_interval between 1 and 4),
    dst_flag             boolean not null,
    interval_start       timestamptz not null,
    price_usd_mwh        numeric not null,
    source_id            uuid not null references ops.source_manifest (id),
    created_at           timestamptz not null default now(),
    unique (settlement_point, delivery_date, delivery_hour, delivery_interval, dst_flag)
);

create index if not exists ercot_spp_zone_date_idx
    on core.ercot_spp (settlement_point, delivery_date);

comment on table core.ercot_spp is
    'Real-time 15-min settlement point prices, ERCOT NP6-905-CD '
    'spp_node_zone_hub, settlementPointType=LZ only. interval_start is the '
    'UTC start of the interval, computed from delivery_date/hour/interval '
    'in America/Chicago using dst_flag to disambiguate the repeated '
    'fall-back hour. Loaded by M3-P1 (pipelines/sources/ercot_spp.py).';

alter table core.ercot_spp enable row level security;
revoke all on core.ercot_spp from public, anon, authenticated;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'zeus_web_ro') then
        execute 'drop policy if exists web_ro_select on core.ercot_spp';
        execute 'create policy web_ro_select on core.ercot_spp for select to zeus_web_ro using (true)';
    end if;
end $$;

create or replace view api.ercot_spp as
select
    settlement_point,
    delivery_date,
    delivery_hour,
    delivery_interval,
    dst_flag,
    interval_start,
    price_usd_mwh,
    source_id
from core.ercot_spp;

revoke all on api.ercot_spp from public, anon, authenticated;
grant select on api.ercot_spp to service_role;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'zeus_web_ro') then
        execute 'grant select on api.ercot_spp to zeus_web_ro';
    end if;
end $$;

comment on view api.ercot_spp is
    'Raw ERCOT real-time settlement point prices (NP6-905-CD, LZ only), '
    'one row per 15-min interval per load zone. M3-P1.';

-- ---------------------------------------------------------------------------
-- core.grid_value_lz -- one row per ERCOT load zone: trailing-12-month
-- mean daily spread (top-4-hour minus bottom-4-hour average price, both
-- computed from hour-level averages of the 4 real intervals in that
-- hour) and scarcity_days (days whose max 15-min price exceeded a FIXED,
-- documented $/MWh threshold, chosen before any data was computed --
-- never threshold-shopped). Both terms are anchored to the 90th
-- percentile of the real value ACROSS the 8 load zones, capped at 1 --
-- never a cross-zone or cross-home percentile rank (M2-P8's decision).
--
-- window_start/window_end anchor the acceptance check to a reproducible
-- window (the actual loaded data range), not to now() at check time.
-- ---------------------------------------------------------------------------

create table if not exists core.grid_value_lz (
    load_zone                  text primary key,
    window_start                date,
    window_end                  date,
    avg_daily_spread_usd_mwh    numeric,
    spread_anchor_usd_mwh       numeric,
    spread_term                 numeric check (spread_term is null or (spread_term >= 0 and spread_term <= 1)),
    -- Fixed, documented threshold (checks/M3-ercot-layering.md section C
    -- item 2's $200/MWh recommendation) -- set once, never tuned after
    -- seeing the data.
    scarcity_threshold_usd_mwh  numeric not null default 200,
    scarcity_days               integer,
    scarcity_anchor_days         numeric,
    scarcity_term                numeric check (scarcity_term is null or (scarcity_term >= 0 and scarcity_term <= 1)),
    anchor_method                text not null default 'percentile_cont(0.9) across the 8 load zones',
    grid_value_null_reason       text,
    source_ids                   uuid[] not null default '{}',
    computed_at                  timestamptz not null default now()
);

comment on table core.grid_value_lz is
    'One row per ERCOT load zone: trailing-12-month mean daily price '
    'spread and scarcity-day count, each anchored to the 90th percentile '
    'across the 8 load zones (capped at 1), never a percentile rank. '
    'Recomputed by core.refresh_grid_value_lz(). NOT wired into home '
    'scoring by this ticket -- base_capture gating happens per-utility, '
    'not per-zone, and is a separate downstream ticket''s job. '
    'grid_value_null_reason covers zone-level gaps (e.g. fewer than 8 '
    'zones loaded yet, so no valid anchor); it never zero-fills.';

alter table core.grid_value_lz enable row level security;
revoke all on core.grid_value_lz from public, anon, authenticated;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'zeus_web_ro') then
        execute 'drop policy if exists web_ro_select on core.grid_value_lz';
        execute 'create policy web_ro_select on core.grid_value_lz for select to zeus_web_ro using (true)';
    end if;
end $$;

create or replace view api.grid_value_lz as
select
    load_zone,
    window_start,
    window_end,
    avg_daily_spread_usd_mwh,
    spread_anchor_usd_mwh,
    spread_term,
    scarcity_threshold_usd_mwh,
    scarcity_days,
    scarcity_anchor_days,
    scarcity_term,
    anchor_method,
    grid_value_null_reason,
    source_ids,
    computed_at
from core.grid_value_lz;

revoke all on api.grid_value_lz from public, anon, authenticated;
grant select on api.grid_value_lz to service_role;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'zeus_web_ro') then
        execute 'grant select on api.grid_value_lz to zeus_web_ro';
    end if;
end $$;

comment on view api.grid_value_lz is
    'Grid value (price spread) and scarcity_days per ERCOT load zone, '
    'each anchored (value / 90th-pct across the 8 zones, capped at 1). '
    'M3-S1/M3-P1. Not yet joined into home scoring.';

-- ---------------------------------------------------------------------------
-- core.refresh_grid_value_lz() -- recompute core.grid_value_lz from
-- core.ercot_spp. Trailing-12-month window anchored to the latest loaded
-- delivery_date (not now()), so a later hand-check against the raw file
-- is reproducible regardless of when it's run.
-- ---------------------------------------------------------------------------

create or replace function core.refresh_grid_value_lz() returns void
language plpgsql
as $$
declare
    v_window_end date;
    v_window_start date;
begin
    select max(delivery_date) into v_window_end from core.ercot_spp;
    if v_window_end is null then
        return; -- nothing loaded yet; leave the table empty, never zero-fill
    end if;
    v_window_start := v_window_end - interval '12 months';

    with hourly as (
        -- Average the 4 real 15-min intervals in each (zone, day, hour,
        -- dst pass) before ranking hours -- never rank individual
        -- 15-min prices as if they were hours.
        select
            settlement_point,
            delivery_date,
            delivery_hour,
            dst_flag,
            avg(price_usd_mwh) as hour_avg_price
        from core.ercot_spp
        where delivery_date >= v_window_start and delivery_date <= v_window_end
        group by 1, 2, 3, 4
    ),
    ranked as (
        select
            settlement_point,
            delivery_date,
            hour_avg_price,
            row_number() over (partition by settlement_point, delivery_date order by hour_avg_price desc) as rank_desc,
            row_number() over (partition by settlement_point, delivery_date order by hour_avg_price asc) as rank_asc
        from hourly
    ),
    daily_spread as (
        select
            settlement_point,
            delivery_date,
            avg(hour_avg_price) filter (where rank_desc <= 4) - avg(hour_avg_price) filter (where rank_asc <= 4) as spread
        from ranked
        group by 1, 2
    ),
    zone_spread as (
        select settlement_point as load_zone, avg(spread) as avg_daily_spread_usd_mwh
        from daily_spread
        group by 1
    ),
    daily_max as (
        select settlement_point, delivery_date, max(price_usd_mwh) as day_max_price
        from core.ercot_spp
        where delivery_date >= v_window_start and delivery_date <= v_window_end
        group by 1, 2
    ),
    zone_scarcity as (
        select settlement_point as load_zone, count(*) filter (where day_max_price > 200) as scarcity_days
        from daily_max
        group by 1
    ),
    zone_sources as (
        select settlement_point as load_zone, array_agg(distinct source_id) as source_ids
        from core.ercot_spp
        where delivery_date >= v_window_start and delivery_date <= v_window_end
        group by 1
    ),
    combined as (
        select
            coalesce(zs.load_zone, zc.load_zone) as load_zone,
            zs.avg_daily_spread_usd_mwh,
            zc.scarcity_days
        from zone_spread zs
        full outer join zone_scarcity zc on zc.load_zone = zs.load_zone
    ),
    anchors as (
        select
            percentile_cont(0.9) within group (order by avg_daily_spread_usd_mwh) as spread_anchor,
            percentile_cont(0.9) within group (order by scarcity_days) as scarcity_anchor,
            count(*) as zones_loaded
        from combined
    )
    insert into core.grid_value_lz (
        load_zone, window_start, window_end,
        avg_daily_spread_usd_mwh, spread_anchor_usd_mwh, spread_term,
        scarcity_threshold_usd_mwh, scarcity_days, scarcity_anchor_days, scarcity_term,
        grid_value_null_reason, source_ids, computed_at
    )
    select
        c.load_zone,
        v_window_start,
        v_window_end,
        c.avg_daily_spread_usd_mwh,
        a.spread_anchor,
        case
            when a.spread_anchor is null or a.spread_anchor = 0 or c.avg_daily_spread_usd_mwh is null then null
            else least(1.0, c.avg_daily_spread_usd_mwh / a.spread_anchor)
        end,
        200,
        c.scarcity_days,
        a.scarcity_anchor,
        case
            when a.scarcity_anchor is null or a.scarcity_anchor = 0 or c.scarcity_days is null then null
            else least(1.0, c.scarcity_days / a.scarcity_anchor)
        end,
        case
            when a.zones_loaded < 8 then 'fewer_than_8_load_zones_loaded_anchor_unreliable'
            else null
        end,
        coalesce(zsrc.source_ids, array[]::uuid[]),
        now()
    from combined c
    cross join anchors a
    left join zone_sources zsrc on zsrc.load_zone = c.load_zone
    on conflict (load_zone) do update set
        window_start = excluded.window_start,
        window_end = excluded.window_end,
        avg_daily_spread_usd_mwh = excluded.avg_daily_spread_usd_mwh,
        spread_anchor_usd_mwh = excluded.spread_anchor_usd_mwh,
        spread_term = excluded.spread_term,
        scarcity_threshold_usd_mwh = excluded.scarcity_threshold_usd_mwh,
        scarcity_days = excluded.scarcity_days,
        scarcity_anchor_days = excluded.scarcity_anchor_days,
        scarcity_term = excluded.scarcity_term,
        grid_value_null_reason = excluded.grid_value_null_reason,
        source_ids = excluded.source_ids,
        computed_at = excluded.computed_at;
end;
$$;

comment on function core.refresh_grid_value_lz() is
    'Recomputes core.grid_value_lz from core.ercot_spp: trailing 12 months '
    'anchored to the latest loaded delivery_date, spread = mean(top 4 '
    'hour-avg prices) - mean(bottom 4 hour-avg prices) per day averaged '
    'over the window, scarcity_days = days whose max 15-min price > '
    '$200/MWh (fixed, documented, never tuned). Both anchored to the 90th '
    'percentile across the 8 load zones, capped at 1. Called by '
    'pipelines/sources/ercot_spp.py after loading rows.';

-- ---------------------------------------------------------------------------
-- core.county_loadzone -- county/utility -> ERCOT settlement point,
-- from data/manual/county_loadzone.csv (M3-H1, already cited: Austin
-- Energy -> LZ_AEN, Pedernales/Bluebonnet co-ops -> LZ_LCRA, CenterPoint
-- Houston -> LZ_HOUSTON). Loaded by M3-P4 (pipelines/sources/county_loadzone.py).
-- ---------------------------------------------------------------------------

create table if not exists core.county_loadzone (
    county_fips     text not null,
    county_name     text,
    utility_name    text not null,
    ercot_load_zone text not null,
    settlement_point text not null,
    source_url      text not null,
    retrieved_at    timestamptz not null,
    notes           text,
    source_id       uuid not null references ops.source_manifest (id),
    created_at      timestamptz not null default now(),
    primary key (county_fips, utility_name)
);

comment on table core.county_loadzone is
    'County + utility -> ERCOT settlement point / load zone, from '
    'data/manual/county_loadzone.csv (M3-H1, cited to ERCOT''s Load Zone '
    'map + Board memos). NOT joined to core.retail_market by utility name '
    '(utility_name spellings differ, e.g. "CenterPoint Energy Houston '
    'Electric" here vs "CenterPoint Energy" there) -- an open item for a '
    'later ticket, per checks/M3-ercot-layering.md item 8.';

alter table core.county_loadzone enable row level security;
revoke all on core.county_loadzone from public, anon, authenticated;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'zeus_web_ro') then
        execute 'drop policy if exists web_ro_select on core.county_loadzone';
        execute 'create policy web_ro_select on core.county_loadzone for select to zeus_web_ro using (true)';
    end if;
end $$;

create or replace view api.county_loadzone as
select
    county_fips, county_name, utility_name, ercot_load_zone, settlement_point,
    source_url, retrieved_at, notes, source_id
from core.county_loadzone;

revoke all on api.county_loadzone from public, anon, authenticated;
grant select on api.county_loadzone to service_role;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'zeus_web_ro') then
        execute 'grant select on api.county_loadzone to zeus_web_ro';
    end if;
end $$;

comment on view api.county_loadzone is
    'County + utility -> ERCOT load zone / settlement point crosswalk, '
    'from data/manual/county_loadzone.csv. M3-P4.';

-- ---------------------------------------------------------------------------
-- core.base_capture -- per-UTILITY view (keyed by eia_utility_number,
-- same key core.retail_market already uses), derived from the
-- already-loaded core.retail_market. Base's own service-tier table
-- (checks/M3-ercot-layering.md, primer citation) gates which homes its
-- ERCOT/VPP economics apply to at all:
--   'full'        deregulated TDU (Oncor, CenterPoint, TNMP)          -- full grid-value/VPP economics
--   'partner'     co-op Base actually serves via a partner deal (GVEC, Farmers Electric) -- per retail_market.csv's own
--                 plain_language ("Cooperative area Base serves")
--   'backup_only' municipal/regulated utility (Austin Energy, El Paso Electric) -- Base sells
--                 backup only, no VPP economics, per retail_market.csv's own plain_language
--   'not_served'  co-op retail_market.csv explicitly says is "not on Base's service list"
--                 (Pedernales, Bluebonnet) -- real Travis-area co-ops, but Base doesn't serve them
--
-- This is a deliberate, explicit CASE by eia_utility_number (not a name
-- pattern like ILIKE '%Cooperative%', which would wrongly tag Pedernales/
-- Bluebonnet -- both cooperatives, but both "not on Base's service list"
-- per their own cited plain_language column -- as 'partner'). Any
-- eia_utility_number not in this explicit list is NULL with a reason,
-- never defaulted to a tier.
-- ---------------------------------------------------------------------------

create or replace view core.base_capture as
select
    eia_utility_number,
    utility_name,
    retail_market,
    case eia_utility_number
        when '44372' then 'full'         -- Oncor Electric Delivery: deregulated TDU
        when '8901'  then 'full'         -- CenterPoint Energy: deregulated TDU
        when '40051' then 'full'         -- Texas-New Mexico Power (TNMP): deregulated TDU
        when '7752'  then 'partner'      -- GVEC: retail_market.csv plain_language "Cooperative area Base serves"
        when '6182'  then 'partner'      -- Farmers Electric Cooperative: same, "Cooperative area Base serves"
        when '1015'  then 'backup_only'  -- Austin Energy: municipal, no retail choice
        when '5701'  then 'backup_only'  -- El Paso Electric: "Utility area Base serves" but not_deregulated/regulated, backup only
        when '14626' then 'not_served'   -- Pedernales Electric Cooperative: "not on Base's service list"
        when '1892'  then 'not_served'   -- Bluebonnet Electric Cooperative: "not on Base's service list"
        else null
    end as base_capture,
    case
        when eia_utility_number in ('44372', '8901', '40051', '7752', '6182', '1015', '5701', '14626', '1892') then null
        else 'utility_tier_not_classified'
    end as base_capture_null_reason,
    source_id
from core.retail_market;

comment on view core.base_capture is
    'Per-utility Base service tier (full/partner/backup_only/not_served), '
    'derived by an explicit case-by-eia_utility_number over the '
    'already-loaded core.retail_market -- see the view definition for the '
    'citation backing each row (retail_market.csv''s own plain_language/'
    'quote columns). NOT a name-pattern match: Pedernales and Bluebonnet '
    'are cooperatives but retail_market.csv says Base does not serve '
    'them, so they are not_served, not partner. Any utility not in the '
    'explicit list is NULL with base_capture_null_reason. Gates ERCOT/VPP '
    'value attribution per M3-S1; grid-value terms for backup_only/'
    'not_served homes must read NULL with reason, never a spread number '
    'or a 0 -- a later ticket''s job to wire in, not this one''s.';

do $$
begin
    if exists (select 1 from pg_roles where rolname = 'zeus_web_ro') then
        execute 'grant select on core.base_capture to zeus_web_ro';
    end if;
end $$;
grant select on core.base_capture to service_role;

create or replace view api.base_capture as
select eia_utility_number, utility_name, retail_market, base_capture, base_capture_null_reason, source_id
from core.base_capture;

revoke all on api.base_capture from public, anon, authenticated;
grant select on api.base_capture to service_role;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'zeus_web_ro') then
        execute 'grant select on api.base_capture to zeus_web_ro';
    end if;
end $$;

comment on view api.base_capture is
    'Per-utility Base service tier (full/partner/backup_only/not_served), '
    'derived from core.retail_market. See core.base_capture for the '
    'citation-backed derivation of each tier. M3-S1.';
