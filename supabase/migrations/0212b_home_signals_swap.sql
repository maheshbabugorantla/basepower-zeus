-- 0212b_home_signals_swap.sql — M2-P8, SWAP half. Requires
-- 0212_home_signals_build.sql already applied (core.mv_home_signals_v2
-- built and populated). Short transaction: rename mv_home_signals_v2
-- into place, rebuild the two small gate-count aggregates (+ their api
-- views, dropped CASCADE and recreated), and replace every dependent
-- api/scoring function to use the new anchored terms + new weight keys
-- (owner_65, home_permits, installability, home_value). Every function
-- keeps its existing output columns/order/args; new columns are
-- appended only -- three functions (top_homes_weighted,
-- homes_ranked_weighted, home_score_breakdown) need DROP FUNCTION +
-- CREATE rather than CREATE OR REPLACE, since Postgres does not allow
-- CREATE OR REPLACE to change a RETURNS TABLE row type even by
-- appending columns; both statements are in this same transaction, so
-- there is no window where the function is missing.
-- One-time cutover: this file is not meant to be re-run after it has
-- already succeeded once (mv_home_signals_v2/mv_home_signals_old no
-- longer exist by then) -- re-running from scratch means re-applying
-- the build file first.
-- ===========================================================================

begin;

alter materialized view core.mv_home_signals rename to mv_home_signals_old;
alter materialized view core.mv_home_signals_v2 rename to mv_home_signals;

alter index core.mv_home_signals_v2_prop_id_idx rename to mv_home_signals_prop_id_idx2;
alter index core.mv_home_signals_v2_gate_reason_idx rename to mv_home_signals_gate_reason_idx2;
alter index core.mv_home_signals_v2_county_fips_idx rename to mv_home_signals_county_fips_idx2;
alter index core.mv_home_signals_v2_bg_geoid_idx rename to mv_home_signals_bg_geoid_idx2;

drop materialized view if exists core.mv_gate_counts cascade;
create materialized view core.mv_gate_counts as
with homes as (
    select
        s.prop_id,
        s.source_ids,
        coalesce(s.gate_reason, s.territory_null_reason, 'passed') as reason
    from core.mv_home_signals s
    join core.parcels p on p.prop_id = s.prop_id
    where s.county_fips = p.county_fips
),
counts as (
    select reason, count(distinct prop_id) as home_count
    from homes
    group by reason
),
srcs as (
    select reason, array_agg(distinct src) as source_ids
    from homes
    cross join lateral unnest(homes.source_ids) as src
    group by reason
)
select c.reason, c.home_count, coalesce(sr.source_ids, array[]::uuid[]) as source_ids
from counts c
left join srcs sr on sr.reason = c.reason;

create unique index mv_gate_counts_reason_idx on core.mv_gate_counts (reason);

create or replace view api.gate_counts as
    select reason, home_count, source_ids from core.mv_gate_counts;
revoke all on api.gate_counts from public, anon, authenticated;
grant select on api.gate_counts to service_role, zeus_web_ro;

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
    group by market, reason
),
srcs as (
    select market, reason, array_agg(distinct src) as source_ids
    from joined
    cross join lateral unnest(joined.source_ids) as src
    group by market, reason
)
select c.market, c.reason, c.home_count, coalesce(sr.source_ids, array[]::uuid[]) as source_ids
from counts c
left join srcs sr on sr.market = c.market and sr.reason = c.reason;

create unique index mv_gate_counts_by_market_idx on core.mv_gate_counts_by_market (market, reason);

create or replace view api.gate_counts_by_market as
    select market, reason, home_count, source_ids from core.mv_gate_counts_by_market;
revoke all on api.gate_counts_by_market from public, anon, authenticated;
grant select on api.gate_counts_by_market to service_role, zeus_web_ro;

drop materialized view core.mv_home_signals_old;

-- ---------------------------------------------------------------------------
-- api.top_homes_weighted — new weight keys owner_65, home_permits,
-- installability, home_value; outage/empower/age65/electric_heat/
-- backup_intent now score off the anchored *_term columns, not raw
-- percent_rank(); flood stays a penalty-only term (1 outside SFHA, 0
-- inside) and is still never a "top signal" candidate. Existing output
-- columns/order unchanged; new columns appended.
-- ---------------------------------------------------------------------------

-- New output columns are appended -- Postgres does not allow CREATE OR
-- REPLACE FUNCTION to change a RETURNS TABLE's OUT-parameter row type
-- even by appending, so this one signature is replaced with DROP +
-- CREATE (safe: both happen inside this same short transaction, so
-- there is no window where the function is missing -- MVCC callers see
-- either the pre-migration or post-migration definition, never neither).
drop function if exists api.top_homes_weighted(jsonb, text);
create function api.top_homes_weighted(weights jsonb, p_county_fips text default null::text)
 returns table(prop_id text, geo_id text, situs_num text, situs_street text, situs_city text, situs_zip text, market_value numeric, block_group_geoid text, county_fips text, score numeric, reasons text[], territory_eia_id text, distributor_name text, distributor_saidi numeric, distributor_saidi_year integer, distributor_saidi_early_release boolean, flood_flag boolean, empower_rate numeric, acs_pct_65_plus numeric, acs_pct_electric_heat numeric, backup_intent_rate numeric, source_ids uuid[], owner_65 boolean, home_solar boolean, home_ev boolean, home_generator boolean, home_panel_upgrade boolean, home_battery boolean, home_battery_permit_date date, permit_null_reason text, yr_built int, living_area numeric, outage_minutes numeric, outage_year int, outage_basis text, outage_source_ids uuid[], home_value_term numeric, installability_term numeric)
 language sql
 stable parallel safe
as $function$
    with w as materialized (
        select
            (case when weights ? 'outage'        then (weights ->> 'outage')::numeric        else 0 end) as w_outage,
            (case when weights ? 'flood'          then (weights ->> 'flood')::numeric          else 0 end) as w_flood,
            (case when weights ? 'empower'        then (weights ->> 'empower')::numeric        else 0 end) as w_empower,
            (case when weights ? 'age65'          then (weights ->> 'age65')::numeric          else 0 end) as w_age65,
            (case when weights ? 'electric_heat'  then (weights ->> 'electric_heat')::numeric  else 0 end) as w_heat,
            (case when weights ? 'backup_intent'  then (weights ->> 'backup_intent')::numeric  else 0 end) as w_backup,
            (case when weights ? 'owner_65'       then (weights ->> 'owner_65')::numeric       else 0 end) as w_owner65,
            (case when weights ? 'home_permits'   then (weights ->> 'home_permits')::numeric   else 0 end) as w_permits,
            (case when weights ? 'installability' then (weights ->> 'installability')::numeric else 0 end) as w_install,
            (case when weights ? 'home_value'     then (weights ->> 'home_value')::numeric     else 0 end) as w_homevalue
    ),
    medians as (
        select county_fips, jsonb_object_agg(signal_key, median) as med from core.signal_medians group by county_fips
    ),
    narrow as (
        select
            s.prop_id,
            s.outage_term, s.flood_term, s.empower_term, s.age65_term, s.electric_heat_term,
            s.backup_intent_rate, s.backup_intent_term,
            s.owner_65::int::numeric as owner65_term, s.home_permits_flag::int::numeric as permits_term,
            s.installability_term, s.home_value_term
        from core.mv_home_signals s
        where s.gate_reason is null
          and (p_county_fips is null or s.county_fips = p_county_fips)
    ),
    scored as (
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
            ) as weighted_sum,
            (
                case when n.outage_term is not null then w.w_outage else 0 end
                + case when n.flood_term is not null then w.w_flood else 0 end
                + case when n.empower_term is not null then w.w_empower else 0 end
                + case when n.age65_term is not null then w.w_age65 else 0 end
                + case when n.electric_heat_term is not null then w.w_heat else 0 end
                + case when n.backup_intent_term is not null then w.w_backup else 0 end
                + case when n.owner65_term is not null then w.w_owner65 else 0 end
                + case when n.permits_term is not null then w.w_permits else 0 end
                + case when n.installability_term is not null then w.w_install else 0 end
                + case when n.home_value_term is not null then w.w_homevalue else 0 end
            ) as weight_sum
        from narrow n
        cross join w
    ),
    ranked as (
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
                    -- flood intentionally excluded: penalty-only, never a "top signal"
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
        s.installability_term
    from ranked r
    join core.mv_home_signals s on s.prop_id = r.prop_id
    join core.parcels p on p.prop_id = r.prop_id
    left join medians md on md.county_fips = s.county_fips
    cross join w
    order by r.final_score desc, r.backup_intent_rate desc nulls last, r.prop_id;
$function$;

-- ---------------------------------------------------------------------------
-- api.homes_ranked_weighted — same term/weight changes as top_homes_
-- weighted above, plus keyset pagination (unchanged args/behavior).
-- ---------------------------------------------------------------------------

drop function if exists api.homes_ranked_weighted(jsonb, text, text, numeric, text, integer);
create function api.homes_ranked_weighted(weights jsonb, p_county_fips text default null::text, p_block_group_geoid text default null::text, after_score numeric default null::numeric, after_prop_id text default null::text, page_size integer default 50)
 returns table(prop_id text, geo_id text, situs_num text, situs_street text, situs_city text, situs_zip text, market_value numeric, block_group_geoid text, county_fips text, score numeric, reasons text[], territory_eia_id text, distributor_name text, distributor_saidi numeric, distributor_saidi_year integer, distributor_saidi_early_release boolean, flood_flag boolean, empower_rate numeric, acs_pct_65_plus numeric, acs_pct_electric_heat numeric, backup_intent_rate numeric, source_ids uuid[], lon double precision, lat double precision, owner_65 boolean, home_solar boolean, home_ev boolean, home_generator boolean, home_panel_upgrade boolean, home_battery boolean, home_battery_permit_date date, permit_null_reason text, yr_built int, living_area numeric, outage_minutes numeric, outage_year int, outage_basis text, outage_source_ids uuid[], home_value_term numeric, installability_term numeric)
 language sql
 stable parallel safe
as $function$
    with w as materialized (
        select
            (case when weights ? 'outage'        then (weights ->> 'outage')::numeric        else 0 end) as w_outage,
            (case when weights ? 'flood'          then (weights ->> 'flood')::numeric          else 0 end) as w_flood,
            (case when weights ? 'empower'        then (weights ->> 'empower')::numeric        else 0 end) as w_empower,
            (case when weights ? 'age65'          then (weights ->> 'age65')::numeric          else 0 end) as w_age65,
            (case when weights ? 'electric_heat'  then (weights ->> 'electric_heat')::numeric  else 0 end) as w_heat,
            (case when weights ? 'backup_intent'  then (weights ->> 'backup_intent')::numeric  else 0 end) as w_backup,
            (case when weights ? 'owner_65'       then (weights ->> 'owner_65')::numeric       else 0 end) as w_owner65,
            (case when weights ? 'home_permits'   then (weights ->> 'home_permits')::numeric   else 0 end) as w_permits,
            (case when weights ? 'installability' then (weights ->> 'installability')::numeric else 0 end) as w_install,
            (case when weights ? 'home_value'     then (weights ->> 'home_value')::numeric     else 0 end) as w_homevalue
    ),
    medians as (
        select county_fips, jsonb_object_agg(signal_key, median) as med from core.signal_medians group by county_fips
    ),
    narrow as (
        select
            s.prop_id,
            s.outage_term, s.flood_term, s.empower_term, s.age65_term, s.electric_heat_term,
            s.backup_intent_rate, s.backup_intent_term,
            s.owner_65::int::numeric as owner65_term, s.home_permits_flag::int::numeric as permits_term,
            s.installability_term, s.home_value_term
        from core.mv_home_signals s
        where s.gate_reason is null
          and (p_county_fips is null or s.county_fips = p_county_fips)
          and (p_block_group_geoid is null or s.block_group_geoid = p_block_group_geoid)
    ),
    scored as (
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
            ) as weighted_sum,
            (
                case when n.outage_term is not null then w.w_outage else 0 end
                + case when n.flood_term is not null then w.w_flood else 0 end
                + case when n.empower_term is not null then w.w_empower else 0 end
                + case when n.age65_term is not null then w.w_age65 else 0 end
                + case when n.electric_heat_term is not null then w.w_heat else 0 end
                + case when n.backup_intent_term is not null then w.w_backup else 0 end
                + case when n.owner65_term is not null then w.w_owner65 else 0 end
                + case when n.permits_term is not null then w.w_permits else 0 end
                + case when n.installability_term is not null then w.w_install else 0 end
                + case when n.home_value_term is not null then w.w_homevalue else 0 end
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
        s.installability_term
    from page p
    join core.mv_home_signals s on s.prop_id = p.prop_id
    join core.parcels pc on pc.prop_id = p.prop_id
    left join core.parcel_geoms pg on pg.prop_id = p.prop_id
    left join medians md on md.county_fips = s.county_fips
    cross join w
    order by p.final_score desc, p.prop_id;
$function$;

-- ---------------------------------------------------------------------------
-- api.homes_ranked_weighted_count — no output columns to add (bigint).
-- ---------------------------------------------------------------------------

create or replace function api.homes_ranked_weighted_count(weights jsonb, p_county_fips text default null::text, p_block_group_geoid text default null::text)
 returns bigint
 language sql
 stable parallel safe
as $function$
    with w as materialized (
        select
            (case when weights ? 'outage'        then (weights ->> 'outage')::numeric        else 0 end) as w_outage,
            (case when weights ? 'flood'          then (weights ->> 'flood')::numeric          else 0 end) as w_flood,
            (case when weights ? 'empower'        then (weights ->> 'empower')::numeric        else 0 end) as w_empower,
            (case when weights ? 'age65'          then (weights ->> 'age65')::numeric          else 0 end) as w_age65,
            (case when weights ? 'electric_heat'  then (weights ->> 'electric_heat')::numeric  else 0 end) as w_heat,
            (case when weights ? 'backup_intent'  then (weights ->> 'backup_intent')::numeric  else 0 end) as w_backup,
            (case when weights ? 'owner_65'       then (weights ->> 'owner_65')::numeric       else 0 end) as w_owner65,
            (case when weights ? 'home_permits'   then (weights ->> 'home_permits')::numeric   else 0 end) as w_permits,
            (case when weights ? 'installability' then (weights ->> 'installability')::numeric else 0 end) as w_install,
            (case when weights ? 'home_value'     then (weights ->> 'home_value')::numeric     else 0 end) as w_homevalue
    ),
    narrow as (
        select
            s.outage_term, s.flood_term, s.empower_term, s.age65_term, s.electric_heat_term,
            s.backup_intent_term, s.owner_65::int::numeric as owner65_term, s.home_permits_flag::int::numeric as permits_term,
            s.installability_term, s.home_value_term
        from core.mv_home_signals s
        where s.gate_reason is null
          and (p_county_fips is null or s.county_fips = p_county_fips)
          and (p_block_group_geoid is null or s.block_group_geoid = p_block_group_geoid)
    ),
    weight_sums as (
        select
            (
                case when n.outage_term is not null then w.w_outage else 0 end
                + case when n.flood_term is not null then w.w_flood else 0 end
                + case when n.empower_term is not null then w.w_empower else 0 end
                + case when n.age65_term is not null then w.w_age65 else 0 end
                + case when n.electric_heat_term is not null then w.w_heat else 0 end
                + case when n.backup_intent_term is not null then w.w_backup else 0 end
                + case when n.owner65_term is not null then w.w_owner65 else 0 end
                + case when n.permits_term is not null then w.w_permits else 0 end
                + case when n.installability_term is not null then w.w_install else 0 end
                + case when n.home_value_term is not null then w.w_homevalue else 0 end
            ) as weight_sum
        from narrow n
        cross join w
    )
    select count(*) from weight_sums where weight_sum > 0;
$function$;

-- ---------------------------------------------------------------------------
-- api.blockgroup_scores_weighted — same term/weight changes; output
-- shape (block_group_geoid, score, homes_scored) unchanged.
-- ---------------------------------------------------------------------------

create or replace function api.blockgroup_scores_weighted(weights jsonb, p_county_fips text default null::text)
 returns table(block_group_geoid text, score numeric, homes_scored bigint)
 language sql
 stable parallel safe
as $function$
    with w as materialized (
        select
            (case when weights ? 'outage'        then (weights ->> 'outage')::numeric        else 0 end) as w_outage,
            (case when weights ? 'flood'          then (weights ->> 'flood')::numeric          else 0 end) as w_flood,
            (case when weights ? 'empower'        then (weights ->> 'empower')::numeric        else 0 end) as w_empower,
            (case when weights ? 'age65'          then (weights ->> 'age65')::numeric          else 0 end) as w_age65,
            (case when weights ? 'electric_heat'  then (weights ->> 'electric_heat')::numeric  else 0 end) as w_heat,
            (case when weights ? 'backup_intent'  then (weights ->> 'backup_intent')::numeric  else 0 end) as w_backup,
            (case when weights ? 'owner_65'       then (weights ->> 'owner_65')::numeric       else 0 end) as w_owner65,
            (case when weights ? 'home_permits'   then (weights ->> 'home_permits')::numeric   else 0 end) as w_permits,
            (case when weights ? 'installability' then (weights ->> 'installability')::numeric else 0 end) as w_install,
            (case when weights ? 'home_value'     then (weights ->> 'home_value')::numeric     else 0 end) as w_homevalue
    ),
    narrow as (
        select
            s.block_group_geoid,
            s.outage_term, s.flood_term, s.empower_term, s.age65_term, s.electric_heat_term,
            s.backup_intent_term, s.owner_65::int::numeric as owner65_term, s.home_permits_flag::int::numeric as permits_term,
            s.installability_term, s.home_value_term
        from core.mv_home_signals s
        where s.gate_reason is null
          and (p_county_fips is null or s.county_fips = p_county_fips)
    ),
    scored as (
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
            ) as weighted_sum,
            (
                case when n.outage_term is not null then w.w_outage else 0 end
                + case when n.flood_term is not null then w.w_flood else 0 end
                + case when n.empower_term is not null then w.w_empower else 0 end
                + case when n.age65_term is not null then w.w_age65 else 0 end
                + case when n.electric_heat_term is not null then w.w_heat else 0 end
                + case when n.backup_intent_term is not null then w.w_backup else 0 end
                + case when n.owner65_term is not null then w.w_owner65 else 0 end
                + case when n.permits_term is not null then w.w_permits else 0 end
                + case when n.installability_term is not null then w.w_install else 0 end
                + case when n.home_value_term is not null then w.w_homevalue else 0 end
            ) as weight_sum
        from narrow n
        cross join w
    ),
    home_scored as (
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
-- api.home_score_breakdown — existing columns (key, label, raw_value,
-- raw_unit, percentile, weight, contribution, available, null_reason)
-- unchanged; term/anchor_value/anchor_basis appended (2026-09-26 user
-- decision). `percentile` keeps the OLD percent_rank() figure for
-- backward compat with anything still reading it; `contribution` now
-- comes from `term` (the anchored 0-1 value actually used in the score),
-- not from `percentile`. Four new rows (owner_65, home_permits,
-- installability, home_value) alongside the original six.
-- ---------------------------------------------------------------------------

drop function if exists api.home_score_breakdown(text, jsonb);
create function api.home_score_breakdown(p_prop_id text, weights jsonb)
 returns table(key text, label text, raw_value numeric, raw_unit text, percentile numeric, weight numeric, contribution numeric, available boolean, null_reason text, term numeric, anchor_value numeric, anchor_basis text)
 language sql
 stable parallel safe
as $function$
    with w as materialized (
        select
            (case when weights ? 'outage'        then (weights ->> 'outage')::numeric        else 0 end) as w_outage,
            (case when weights ? 'flood'          then (weights ->> 'flood')::numeric          else 0 end) as w_flood,
            (case when weights ? 'empower'        then (weights ->> 'empower')::numeric        else 0 end) as w_empower,
            (case when weights ? 'age65'          then (weights ->> 'age65')::numeric          else 0 end) as w_age65,
            (case when weights ? 'electric_heat'  then (weights ->> 'electric_heat')::numeric  else 0 end) as w_heat,
            (case when weights ? 'backup_intent'  then (weights ->> 'backup_intent')::numeric  else 0 end) as w_backup,
            (case when weights ? 'owner_65'       then (weights ->> 'owner_65')::numeric       else 0 end) as w_owner65,
            (case when weights ? 'home_permits'   then (weights ->> 'home_permits')::numeric   else 0 end) as w_permits,
            (case when weights ? 'installability' then (weights ->> 'installability')::numeric else 0 end) as w_install,
            (case when weights ? 'home_value'     then (weights ->> 'home_value')::numeric     else 0 end) as w_homevalue
    ),
    s as (
        select * from core.mv_home_signals where prop_id = p_prop_id
    ),
    anc as (
        select signal_key, anchor_value, anchor_value_low, basis from core.signal_anchors
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
            ) as weight_sum
        from s cross join w
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
            )
    ) as v(key, label, raw_value, raw_unit, percentile, weight, available, null_reason, term, anchor_value, anchor_basis);
$function$;

-- ---------------------------------------------------------------------------
-- core.refresh_all_scores — add core.signal_anchors / core.signal_medians
-- to the refresh sequence (both recomputed off core.mv_home_signals,
-- so after it). mv_gate_counts / mv_gate_counts_by_market keep their
-- existing unique indexes, so REFRESH ... CONCURRENTLY still works for
-- ordinary day-to-day refreshes (this migration's one-time swap above
-- rebuilt them with plain DROP+CREATE instead, to pick up new columns).
-- ---------------------------------------------------------------------------

create or replace function core.refresh_all_scores()
 returns void
 language plpgsql
as $function$
begin
    refresh materialized view concurrently core.mv_home_block_group;
    refresh materialized view concurrently core.mv_home_signals;
    refresh materialized view concurrently core.mv_join_rate;
    -- core.mv_blockgroup_scores / core.mv_top_homes (0102) are retired
    -- by 0201_m2.sql (core.mv_home_signals + api.top_homes_weighted
    -- replace their per-home semantics) but are kept refreshed for now,
    -- since the pre-existing api.top_homes view still reads
    -- core.mv_top_homes and the web app has not switched off it yet
    -- (M2-W1). Drop these two lines once M2-W1 lands.
    refresh materialized view concurrently core.mv_blockgroup_scores;
    refresh materialized view concurrently core.mv_top_homes;
    -- 0203_perf_precompute.sql: precomputed request-time rollups. Must
    -- come after mv_home_signals (mv_gate_counts reads it) and after
    -- mv_blockgroup_scores (mv_blockgroup_geojson reads it).
    refresh materialized view concurrently core.mv_gate_counts;
    refresh materialized view concurrently core.mv_parcel_gate_counts;
    refresh materialized view concurrently core.mv_blockgroup_geojson;
    -- 0206_retail_market.sql: servable homes split by electricity market
    -- (reads mv_home_signals, so it must come after it).
    perform core.refresh_market();
    refresh materialized view concurrently core.mv_gate_counts_by_market;

    -- M2-P8: anchors and medians are recomputed off the just-refreshed
    -- core.mv_home_signals, using the exact same expressions the
    -- migration's one-time population used (kept in sync by hand -- see
    -- supabase/migrations/0212_home_signals.sql's own anchors/
    -- signal_medians population statements for the authoritative SQL).
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
        '90th-percentile share of population age 65+, across every Travis County block group with a gated home, Census ACS',
        null::int,
        (select array_agg(distinct source_id) from core.acs_bg)
    union all
    select
        'backup_intent',
        (select percentile_cont(0.9) within group (order by backup_intent_rate)
         from core.mv_home_signals where gate_reason is null and backup_intent_rate is not null),
        null::numeric,
        '90th-percentile rate of battery/generator permits per 1,000 OTHER gated homes (peer rate, self excluded, 36 months), across Travis County homes, Austin permits',
        null::int,
        (select array_agg(distinct source_id) from core.permits)
    union all
    select
        'home_value',
        (select percentile_cont(0.9) within group (order by ln(market_value))
         from core.mv_home_signals where gate_reason is null and market_value > 0),
        (select percentile_cont(0.1) within group (order by ln(market_value))
         from core.mv_home_signals where gate_reason is null and market_value > 0),
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
end;
$function$;

commit;
