-- 0218: county filter the planner can index. `(p_county_fips is null or s.county_fips = p_county_fips)`
-- forced a full scan of every county (generic plan: parallel seq scan of 1.2M rows, 1.04M discarded).
-- The county is now required (defaults to Travis 48453) and compared with a plain equality.

CREATE OR REPLACE FUNCTION api.top_homes_weighted(weights jsonb, p_county_fips text DEFAULT NULL::text, p_exclude_backup boolean DEFAULT true)
 RETURNS TABLE(prop_id text, geo_id text, situs_num text, situs_street text, situs_city text, situs_zip text, market_value numeric, block_group_geoid text, county_fips text, score numeric, reasons text[], territory_eia_id text, distributor_name text, distributor_saidi numeric, distributor_saidi_year integer, distributor_saidi_early_release boolean, flood_flag boolean, empower_rate numeric, acs_pct_65_plus numeric, acs_pct_electric_heat numeric, backup_intent_rate numeric, source_ids uuid[], owner_65 boolean, home_solar boolean, home_ev boolean, home_generator boolean, home_panel_upgrade boolean, home_battery boolean, home_battery_permit_date date, permit_null_reason text, yr_built integer, living_area numeric, outage_minutes numeric, outage_year integer, outage_basis text, outage_source_ids uuid[], home_value_term numeric, installability_term numeric, income_100k_share numeric, age_35_64_share numeric, permit_path text, permit_risk_term numeric)
 LANGUAGE sql
 STABLE PARALLEL SAFE
AS $function$
    with anc_one as materialized (
        select max(anchor_value) filter (where signal_key = 'income_100k') as inc_anchor,
               max(anchor_value) filter (where signal_key = 'age_35_64')  as age_anchor
        from core.signal_anchors
    ),
    w as materialized (
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
            least(1, ia.income_100k_share / nullif(anc_inc.inc_anchor, 0))::float8 as income100k_term,
            least(1, ia.age_35_64_share / nullif(anc_age.age_anchor, 0))::float8 as age3564_term,
            case when s.territory_eia_id = '1015' then 'city_battery_permit'
                 when s.territory_eia_id is not null then 'state_rules_only'
                 else null end as permit_path,
            (case
                when s.territory_eia_id = '1015' and stats.median_days is not null then
                    1 - least(1, greatest(0,
                        0.5 * least(1, stats.median_days::float8 / greatest(stats.p90_days, 1)::float8)
                        + 0.5 * stats.share_never_finished::float8
                    ))
                when s.territory_eia_id is not null and s.territory_eia_id != '1015' then 1.0
                else null
            end) as permitrisk_term
        from core.mv_home_signals s
        left join core.acs_income_age_bg ia on ia.geoid = s.block_group_geoid
        cross join anc_one anc_inc
        cross join anc_one anc_age
        cross join stats
        left join core.home_coverage hc on hc.prop_id = s.prop_id
        where s.gate_reason is null
          and s.county_fips = coalesce(p_county_fips, '48453')
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
            when s.territory_eia_id = '1015' and stats.median_days is not null then
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

CREATE OR REPLACE FUNCTION api.homes_ranked_weighted_count(weights jsonb, p_county_fips text DEFAULT NULL::text, p_block_group_geoid text DEFAULT NULL::text, p_exclude_backup boolean DEFAULT true)
 RETURNS bigint
 LANGUAGE sql
 STABLE PARALLEL SAFE
AS $function$
    with anc_one as materialized (
        select max(anchor_value) filter (where signal_key = 'income_100k') as inc_anchor,
               max(anchor_value) filter (where signal_key = 'age_35_64')  as age_anchor
        from core.signal_anchors
    ),
    w as materialized (
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
            least(1, ia.income_100k_share / nullif(anc_inc.inc_anchor, 0))::float8 as income100k_term,
            least(1, ia.age_35_64_share / nullif(anc_age.age_anchor, 0))::float8 as age3564_term,
            (case
                when s.territory_eia_id = '1015' and stats.median_days is not null then
                    1 - least(1, greatest(0,
                        0.5 * least(1, stats.median_days::float8 / greatest(stats.p90_days, 1)::float8)
                        + 0.5 * stats.share_never_finished::float8
                    ))
                when s.territory_eia_id is not null and s.territory_eia_id != '1015' then 1.0
                else null
            end) as permitrisk_term
        from core.mv_home_signals s
        left join core.acs_income_age_bg ia on ia.geoid = s.block_group_geoid
        cross join anc_one anc_inc
        cross join anc_one anc_age
        cross join stats
        left join core.home_coverage hc on hc.prop_id = s.prop_id
        where s.gate_reason is null
          and s.county_fips = coalesce(p_county_fips, '48453')
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

CREATE OR REPLACE FUNCTION api.blockgroup_scores_weighted(weights jsonb, p_county_fips text DEFAULT NULL::text, p_exclude_backup boolean DEFAULT true)
 RETURNS TABLE(block_group_geoid text, score numeric, homes_scored bigint)
 LANGUAGE sql
 STABLE PARALLEL SAFE
AS $function$
    with anc_one as materialized (
        select max(anchor_value) filter (where signal_key = 'income_100k') as inc_anchor,
               max(anchor_value) filter (where signal_key = 'age_35_64')  as age_anchor
        from core.signal_anchors
    ),
    w as materialized (
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
            least(1, ia.income_100k_share / nullif(anc_inc.inc_anchor, 0))::float8 as income100k_term,
            least(1, ia.age_35_64_share / nullif(anc_age.age_anchor, 0))::float8 as age3564_term,
            (case
                when s.territory_eia_id = '1015' and stats.median_days is not null then
                    1 - least(1, greatest(0,
                        0.5 * least(1, stats.median_days::float8 / greatest(stats.p90_days, 1)::float8)
                        + 0.5 * stats.share_never_finished::float8
                    ))
                when s.territory_eia_id is not null and s.territory_eia_id != '1015' then 1.0
                else null
            end) as permitrisk_term
        from core.mv_home_signals s
        left join core.acs_income_age_bg ia on ia.geoid = s.block_group_geoid
        cross join anc_one anc_inc
        cross join anc_one anc_age
        cross join stats
        left join core.home_coverage hc on hc.prop_id = s.prop_id
        where s.gate_reason is null
          and s.county_fips = coalesce(p_county_fips, '48453')
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

CREATE OR REPLACE FUNCTION api.homes_ranked_weighted(weights jsonb, p_county_fips text DEFAULT NULL::text, p_block_group_geoid text DEFAULT NULL::text, after_score numeric DEFAULT NULL::numeric, after_prop_id text DEFAULT NULL::text, page_size integer DEFAULT 50, p_exclude_backup boolean DEFAULT true)
 RETURNS TABLE(prop_id text, geo_id text, situs_num text, situs_street text, situs_city text, situs_zip text, market_value numeric, block_group_geoid text, county_fips text, score numeric, reasons text[], territory_eia_id text, distributor_name text, distributor_saidi numeric, distributor_saidi_year integer, distributor_saidi_early_release boolean, flood_flag boolean, empower_rate numeric, acs_pct_65_plus numeric, acs_pct_electric_heat numeric, backup_intent_rate numeric, source_ids uuid[], lon double precision, lat double precision, owner_65 boolean, home_solar boolean, home_ev boolean, home_generator boolean, home_panel_upgrade boolean, home_battery boolean, home_battery_permit_date date, permit_null_reason text, yr_built integer, living_area numeric, outage_minutes numeric, outage_year integer, outage_basis text, outage_source_ids uuid[], home_value_term numeric, installability_term numeric, income_100k_share numeric, age_35_64_share numeric, permit_path text, permit_risk_term numeric)
 LANGUAGE sql
 STABLE PARALLEL SAFE
AS $function$
    with anc_one as materialized (
        select max(anchor_value) filter (where signal_key = 'income_100k') as inc_anchor,
               max(anchor_value) filter (where signal_key = 'age_35_64')  as age_anchor
        from core.signal_anchors
    ),
    w as materialized (
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
            least(1, ia.income_100k_share / nullif(anc_inc.inc_anchor, 0))::float8 as income100k_term,
            least(1, ia.age_35_64_share / nullif(anc_age.age_anchor, 0))::float8 as age3564_term,
            (case
                when s.territory_eia_id = '1015' and stats.median_days is not null then
                    1 - least(1, greatest(0,
                        0.5 * least(1, stats.median_days::float8 / greatest(stats.p90_days, 1)::float8)
                        + 0.5 * stats.share_never_finished::float8
                    ))
                when s.territory_eia_id is not null and s.territory_eia_id != '1015' then 1.0
                else null
            end) as permitrisk_term
        from core.mv_home_signals s
        left join core.acs_income_age_bg ia on ia.geoid = s.block_group_geoid
        cross join anc_one anc_inc
        cross join anc_one anc_age
        cross join stats
        left join core.home_coverage hc on hc.prop_id = s.prop_id
        where s.gate_reason is null
          and s.county_fips = coalesce(p_county_fips, '48453')
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
            when s.territory_eia_id = '1015' and stats.median_days is not null then
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
