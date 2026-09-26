-- 0212c_home_signals_perf.sql — M2-P8 perf follow-up. Requires 0212b_
-- home_signals_swap.sql already applied.
--
-- Measured after the swap: api.top_homes_weighted (10 weight keys, one
-- county, 155,726 candidate rows) took 1.05-1.17s against
-- POSTGRES_URL_NON_POOLING, over the acceptance criterion's <1s bound
-- (EXPLAIN ANALYZE showed ~994ms in the per-row weighted_sum/weight_sum
-- CASE expression itself). Cause: the `scored`/`ranked` CTEs are
-- referenced only once, so Postgres inlines them and recomputes the
-- whole 10-term expression (mixing numeric and double precision, with
-- several ::numeric casts) at ORDER BY time instead of once; every term
-- column and weight is also `numeric` (arbitrary precision, slower than
-- float8 for this much per-row arithmetic).
--
-- Fix, verified against the live DB before writing this file (isolated
-- test query, same shape, 1.05s -> ~0.46-0.55s): weights and term
-- columns cast to `double precision` throughout, and `scored`/`ranked`/
-- `weight_sums`/`home_scored` marked `materialized` so the score is
-- computed once per row before sorting/grouping, not re-evaluated
-- inline. No output column, type, or semantic change -- `final_score`
-- is still cast back to `numeric` for the RETURNS TABLE contract, and
-- `home_score_breakdown` (single-row, already fast) is untouched.
-- Plain CREATE OR REPLACE is safe here: signatures and output columns
-- are byte-identical to what 0212b just created.

create or replace function api.top_homes_weighted(weights jsonb, p_county_fips text default null::text)
 returns table(prop_id text, geo_id text, situs_num text, situs_street text, situs_city text, situs_zip text, market_value numeric, block_group_geoid text, county_fips text, score numeric, reasons text[], territory_eia_id text, distributor_name text, distributor_saidi numeric, distributor_saidi_year integer, distributor_saidi_early_release boolean, flood_flag boolean, empower_rate numeric, acs_pct_65_plus numeric, acs_pct_electric_heat numeric, backup_intent_rate numeric, source_ids uuid[], owner_65 boolean, home_solar boolean, home_ev boolean, home_generator boolean, home_panel_upgrade boolean, home_battery boolean, home_battery_permit_date date, permit_null_reason text, yr_built integer, living_area numeric, outage_minutes numeric, outage_year integer, outage_basis text, outage_source_ids uuid[], home_value_term numeric, installability_term numeric)
 language sql
 stable parallel safe
as $function$
    with w as materialized (
        select
            (case when weights ? 'outage'        then (weights ->> 'outage')::float8        else 0 end) as w_outage,
            (case when weights ? 'flood'          then (weights ->> 'flood')::float8          else 0 end) as w_flood,
            (case when weights ? 'empower'        then (weights ->> 'empower')::float8        else 0 end) as w_empower,
            (case when weights ? 'age65'          then (weights ->> 'age65')::float8          else 0 end) as w_age65,
            (case when weights ? 'electric_heat'  then (weights ->> 'electric_heat')::float8  else 0 end) as w_heat,
            (case when weights ? 'backup_intent'  then (weights ->> 'backup_intent')::float8  else 0 end) as w_backup,
            (case when weights ? 'owner_65'       then (weights ->> 'owner_65')::float8       else 0 end) as w_owner65,
            (case when weights ? 'home_permits'   then (weights ->> 'home_permits')::float8   else 0 end) as w_permits,
            (case when weights ? 'installability' then (weights ->> 'installability')::float8 else 0 end) as w_install,
            (case when weights ? 'home_value'     then (weights ->> 'home_value')::float8     else 0 end) as w_homevalue
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
            s.installability_term::float8 as installability_term, s.home_value_term::float8 as home_value_term
        from core.mv_home_signals s
        where s.gate_reason is null
          and (p_county_fips is null or s.county_fips = p_county_fips)
    ),
    scored as materialized (
        select
            n.prop_id,
            n.backup_intent_rate,
            (
                coalesce(w.w_outage * n.outage_term, 0)
                + coalesce(w.w_flood * n.flood_term, 0)
                + coalesce(w.w_empower * n.empower_term, 0)
                + coalesce(w.w_age65 * n.age65_term, 0)
                + coalesce(w.w_heat * n.electric_heat_term, 0)
                + coalesce(w.w_backup * n.backup_intent_term, 0)
                + coalesce(w.w_owner65 * n.owner65_term, 0)
                + coalesce(w.w_permits * n.permits_term, 0)
                + coalesce(w.w_install * n.installability_term, 0)
                + coalesce(w.w_homevalue * n.home_value_term, 0)
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
                                          then (select w_outage from w) * (s.outage_term - coalesce((md.med->>'outage')::numeric, 0)) end, true),
                    ('empower',       case when s.empower_term is not null
                                          then (select w_empower from w) * (s.empower_term - coalesce((md.med->>'empower')::numeric, 0)) end, false),
                    ('age65',         case when s.age65_term is not null
                                          then (select w_age65 from w) * (s.age65_term - coalesce((md.med->>'age65')::numeric, 0)) end, false),
                    ('electric_heat', case when s.electric_heat_term is not null
                                          then (select w_heat from w) * (s.electric_heat_term - coalesce((md.med->>'electric_heat')::numeric, 0)) end, false),
                    ('backup_intent', case when s.backup_intent_term is not null
                                          then (select w_backup from w) * (s.backup_intent_term - coalesce((md.med->>'backup_intent')::numeric, 0)) end, true),
                    ('owner_65',      case when s.owner_65 is not null
                                          then (select w_owner65 from w) * (s.owner_65::int::numeric - coalesce((md.med->>'owner_65')::numeric, 0)) end, true),
                    ('home_permits',  case when s.home_permits_flag is not null
                                          then (select w_permits from w) * (s.home_permits_flag::int::numeric - coalesce((md.med->>'home_permits')::numeric, 0)) end, true),
                    ('installability', case when s.installability_term is not null
                                          then (select w_install from w) * (s.installability_term - coalesce((md.med->>'installability')::numeric, 0)) end, true),
                    ('home_value',    case when s.home_value_term is not null
                                          then (select w_homevalue from w) * (s.home_value_term - coalesce((md.med->>'home_value')::numeric, 0)) end, true)
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

create or replace function api.homes_ranked_weighted(weights jsonb, p_county_fips text default null::text, p_block_group_geoid text default null::text, after_score numeric default null::numeric, after_prop_id text default null::text, page_size integer default 50)
 returns table(prop_id text, geo_id text, situs_num text, situs_street text, situs_city text, situs_zip text, market_value numeric, block_group_geoid text, county_fips text, score numeric, reasons text[], territory_eia_id text, distributor_name text, distributor_saidi numeric, distributor_saidi_year integer, distributor_saidi_early_release boolean, flood_flag boolean, empower_rate numeric, acs_pct_65_plus numeric, acs_pct_electric_heat numeric, backup_intent_rate numeric, source_ids uuid[], lon double precision, lat double precision, owner_65 boolean, home_solar boolean, home_ev boolean, home_generator boolean, home_panel_upgrade boolean, home_battery boolean, home_battery_permit_date date, permit_null_reason text, yr_built integer, living_area numeric, outage_minutes numeric, outage_year integer, outage_basis text, outage_source_ids uuid[], home_value_term numeric, installability_term numeric)
 language sql
 stable parallel safe
as $function$
    with w as materialized (
        select
            (case when weights ? 'outage'        then (weights ->> 'outage')::float8        else 0 end) as w_outage,
            (case when weights ? 'flood'          then (weights ->> 'flood')::float8          else 0 end) as w_flood,
            (case when weights ? 'empower'        then (weights ->> 'empower')::float8        else 0 end) as w_empower,
            (case when weights ? 'age65'          then (weights ->> 'age65')::float8          else 0 end) as w_age65,
            (case when weights ? 'electric_heat'  then (weights ->> 'electric_heat')::float8  else 0 end) as w_heat,
            (case when weights ? 'backup_intent'  then (weights ->> 'backup_intent')::float8  else 0 end) as w_backup,
            (case when weights ? 'owner_65'       then (weights ->> 'owner_65')::float8       else 0 end) as w_owner65,
            (case when weights ? 'home_permits'   then (weights ->> 'home_permits')::float8   else 0 end) as w_permits,
            (case when weights ? 'installability' then (weights ->> 'installability')::float8 else 0 end) as w_install,
            (case when weights ? 'home_value'     then (weights ->> 'home_value')::float8     else 0 end) as w_homevalue
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
            s.installability_term::float8 as installability_term, s.home_value_term::float8 as home_value_term
        from core.mv_home_signals s
        where s.gate_reason is null
          and (p_county_fips is null or s.county_fips = p_county_fips)
          and (p_block_group_geoid is null or s.block_group_geoid = p_block_group_geoid)
    ),
    scored as materialized (
        select
            n.prop_id,
            n.backup_intent_rate,
            (
                coalesce(w.w_outage * n.outage_term, 0)
                + coalesce(w.w_flood * n.flood_term, 0)
                + coalesce(w.w_empower * n.empower_term, 0)
                + coalesce(w.w_age65 * n.age65_term, 0)
                + coalesce(w.w_heat * n.electric_heat_term, 0)
                + coalesce(w.w_backup * n.backup_intent_term, 0)
                + coalesce(w.w_owner65 * n.owner65_term, 0)
                + coalesce(w.w_permits * n.permits_term, 0)
                + coalesce(w.w_install * n.installability_term, 0)
                + coalesce(w.w_homevalue * n.home_value_term, 0)
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
                                          then (select w_outage from w) * (s.outage_term - coalesce((md.med->>'outage')::numeric, 0)) end, true),
                    ('empower',       case when s.empower_term is not null
                                          then (select w_empower from w) * (s.empower_term - coalesce((md.med->>'empower')::numeric, 0)) end, false),
                    ('age65',         case when s.age65_term is not null
                                          then (select w_age65 from w) * (s.age65_term - coalesce((md.med->>'age65')::numeric, 0)) end, false),
                    ('electric_heat', case when s.electric_heat_term is not null
                                          then (select w_heat from w) * (s.electric_heat_term - coalesce((md.med->>'electric_heat')::numeric, 0)) end, false),
                    ('backup_intent', case when s.backup_intent_term is not null
                                          then (select w_backup from w) * (s.backup_intent_term - coalesce((md.med->>'backup_intent')::numeric, 0)) end, true),
                    ('owner_65',      case when s.owner_65 is not null
                                          then (select w_owner65 from w) * (s.owner_65::int::numeric - coalesce((md.med->>'owner_65')::numeric, 0)) end, true),
                    ('home_permits',  case when s.home_permits_flag is not null
                                          then (select w_permits from w) * (s.home_permits_flag::int::numeric - coalesce((md.med->>'home_permits')::numeric, 0)) end, true),
                    ('installability', case when s.installability_term is not null
                                          then (select w_install from w) * (s.installability_term - coalesce((md.med->>'installability')::numeric, 0)) end, true),
                    ('home_value',    case when s.home_value_term is not null
                                          then (select w_homevalue from w) * (s.home_value_term - coalesce((md.med->>'home_value')::numeric, 0)) end, true)
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

create or replace function api.homes_ranked_weighted_count(weights jsonb, p_county_fips text default null::text, p_block_group_geoid text default null::text)
 returns bigint
 language sql
 stable parallel safe
as $function$
    with w as materialized (
        select
            (case when weights ? 'outage'        then (weights ->> 'outage')::float8        else 0 end) as w_outage,
            (case when weights ? 'flood'          then (weights ->> 'flood')::float8          else 0 end) as w_flood,
            (case when weights ? 'empower'        then (weights ->> 'empower')::float8        else 0 end) as w_empower,
            (case when weights ? 'age65'          then (weights ->> 'age65')::float8          else 0 end) as w_age65,
            (case when weights ? 'electric_heat'  then (weights ->> 'electric_heat')::float8  else 0 end) as w_heat,
            (case when weights ? 'backup_intent'  then (weights ->> 'backup_intent')::float8  else 0 end) as w_backup,
            (case when weights ? 'owner_65'       then (weights ->> 'owner_65')::float8       else 0 end) as w_owner65,
            (case when weights ? 'home_permits'   then (weights ->> 'home_permits')::float8   else 0 end) as w_permits,
            (case when weights ? 'installability' then (weights ->> 'installability')::float8 else 0 end) as w_install,
            (case when weights ? 'home_value'     then (weights ->> 'home_value')::float8     else 0 end) as w_homevalue
    ),
    narrow as (
        select
            s.outage_term::float8 as outage_term, s.flood_term::float8 as flood_term,
            s.empower_term::float8 as empower_term, s.age65_term::float8 as age65_term,
            s.electric_heat_term::float8 as electric_heat_term, s.backup_intent_term::float8 as backup_intent_term,
            s.owner_65::int::float8 as owner65_term, s.home_permits_flag::int::float8 as permits_term,
            s.installability_term::float8 as installability_term, s.home_value_term::float8 as home_value_term
        from core.mv_home_signals s
        where s.gate_reason is null
          and (p_county_fips is null or s.county_fips = p_county_fips)
          and (p_block_group_geoid is null or s.block_group_geoid = p_block_group_geoid)
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
            ) as weight_sum
        from narrow n
        cross join w
    )
    select count(*) from weight_sums where weight_sum > 0;
$function$;

create or replace function api.blockgroup_scores_weighted(weights jsonb, p_county_fips text default null::text)
 returns table(block_group_geoid text, score numeric, homes_scored bigint)
 language sql
 stable parallel safe
as $function$
    with w as materialized (
        select
            (case when weights ? 'outage'        then (weights ->> 'outage')::float8        else 0 end) as w_outage,
            (case when weights ? 'flood'          then (weights ->> 'flood')::float8          else 0 end) as w_flood,
            (case when weights ? 'empower'        then (weights ->> 'empower')::float8        else 0 end) as w_empower,
            (case when weights ? 'age65'          then (weights ->> 'age65')::float8          else 0 end) as w_age65,
            (case when weights ? 'electric_heat'  then (weights ->> 'electric_heat')::float8  else 0 end) as w_heat,
            (case when weights ? 'backup_intent'  then (weights ->> 'backup_intent')::float8  else 0 end) as w_backup,
            (case when weights ? 'owner_65'       then (weights ->> 'owner_65')::float8       else 0 end) as w_owner65,
            (case when weights ? 'home_permits'   then (weights ->> 'home_permits')::float8   else 0 end) as w_permits,
            (case when weights ? 'installability' then (weights ->> 'installability')::float8 else 0 end) as w_install,
            (case when weights ? 'home_value'     then (weights ->> 'home_value')::float8     else 0 end) as w_homevalue
    ),
    narrow as (
        select
            s.block_group_geoid,
            s.outage_term::float8 as outage_term, s.flood_term::float8 as flood_term,
            s.empower_term::float8 as empower_term, s.age65_term::float8 as age65_term,
            s.electric_heat_term::float8 as electric_heat_term, s.backup_intent_term::float8 as backup_intent_term,
            s.owner_65::int::float8 as owner65_term, s.home_permits_flag::int::float8 as permits_term,
            s.installability_term::float8 as installability_term, s.home_value_term::float8 as home_value_term
        from core.mv_home_signals s
        where s.gate_reason is null
          and (p_county_fips is null or s.county_fips = p_county_fips)
    ),
    scored as materialized (
        select
            n.block_group_geoid,
            (
                coalesce(w.w_outage * n.outage_term, 0)
                + coalesce(w.w_flood * n.flood_term, 0)
                + coalesce(w.w_empower * n.empower_term, 0)
                + coalesce(w.w_age65 * n.age65_term, 0)
                + coalesce(w.w_heat * n.electric_heat_term, 0)
                + coalesce(w.w_backup * n.backup_intent_term, 0)
                + coalesce(w.w_owner65 * n.owner65_term, 0)
                + coalesce(w.w_permits * n.permits_term, 0)
                + coalesce(w.w_install * n.installability_term, 0)
                + coalesce(w.w_homevalue * n.home_value_term, 0)
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
