-- 0204_flood_direction.sql — fix flood-direction scoring bug in
-- api.top_homes_weighted.
--
-- Bug: core.mv_home_signals.flood_pctile (0201_m2.sql) is
--   percent_rank() over (partition by (flood_flag is null)
--                         order by flood_flag::int)
-- i.e. the percentile of flood_flag = true among gated homes: homes
-- INSIDE a FEMA Special Flood Hazard Area (flood_flag = true = 1) rank
-- HIGHER than homes outside (flood_flag = false = 0). Live figures:
-- in-SFHA homes average flood_pctile 0.984, outside average 0.000.
--
-- api.top_homes_weighted (0201/0202) added `w_flood * flood_pctile`
-- straight into the score and into the reasons contribution, so raising
-- the flood weight pushed homes INSIDE a flood zone to the top, and
-- production's top-4 homes all carried "Flood risk" as a top reason.
--
-- That is backwards. PRODUCT.md / the build spec's Signals table lists
-- installability as "Outside a FEMA flood zone" (Base wants to install
-- batteries/generators, so a flood-exposed site is a NEGATIVE
-- installability signal, not a signal to chase). The score should favor
-- homes OUTSIDE the flood zone.
--
-- Fix here: flood_pctile itself is a materialized-view column and
-- can't change without a REFRESH MATERIALIZED VIEW CONCURRENTLY on
-- core.mv_home_signals (expensive; out of scope for this migration —
-- see the ticket's IO budget). Instead this migration only changes the
-- CONSUMER: api.top_homes_weighted now uses (1 - flood_pctile) in the
-- score sum, the weight-sum guard, and the reasons contribution. A null
-- flood_pctile (flood_flag null — not loaded, or zone not yet computed)
-- stays null and is excluded exactly as before (no COALESCE-to-a-number,
-- per scripts/no_mock_check.py check 6).
--
-- The reason KEY stays 'flood' (web/components/TopHomesTable.tsx and
-- WeightSliders.tsx key their signal-color/label maps off this string,
-- and web/app/api/top-homes/route.ts's SignalKey type lists it) — only
-- the web-side DISPLAY LABEL changes, to "Outside flood zone", in a
-- separate web-only change alongside this migration.
--
-- Idempotent-safe: CREATE OR REPLACE FUNCTION + COMMENT ON only. No data
-- rows created or altered; core.mv_home_signals is not refreshed by
-- this migration.

begin;

-- ---------------------------------------------------------------------------
-- Document core.mv_home_signals.flood_pctile's real semantics right on
-- the column, so the next consumer doesn't repeat this bug: higher
-- flood_pctile means MORE flood exposure (closer to being inside an
-- SFHA), the opposite direction from every other percentile column in
-- this view (where higher = more of the thing being favored). Any
-- consumer that wants "favors outside the flood zone" must invert it
-- (1 - flood_pctile), which is what api.top_homes_weighted does as of
-- 0204_flood_direction.sql.
-- ---------------------------------------------------------------------------

comment on column core.mv_home_signals.flood_pctile is
    'Percentile rank of flood_flag::int among gated homes in the same '
    'county-fips-agnostic full gated set (percent_rank() over flood_flag, '
    'true ranked above false) — HIGHER flood_pctile means the home is '
    'MORE likely to be inside a FEMA Special Flood Hazard Area, the '
    'OPPOSITE direction from every other *_pctile column in this view '
    '(where higher = more favorable). Null while flood_flag is null '
    '(core.flood_zones not loaded for this home''s area). Any scorer '
    'that wants to favor installability OUTSIDE the flood zone must use '
    '(1 - flood_pctile), never flood_pctile directly. Cannot be flipped '
    'in place without a REFRESH MATERIALIZED VIEW CONCURRENTLY on '
    'core.mv_home_signals; see api.top_homes_weighted '
    '(0204_flood_direction.sql) for the consumer-side fix.';

-- ---------------------------------------------------------------------------
-- api.top_homes_weighted — identical signature, return columns, and
-- deterministic ordering/perf structure to 0202_m2_perf.sql. Only
-- change: every use of flood_pctile in the score, weight-sum, and
-- reasons-contribution math is replaced with (1 - flood_pctile), so a
-- home OUTSIDE the flood zone (flood_pctile near 0) now contributes
-- near w_flood * 1, and a home INSIDE the flood zone (flood_pctile near
-- 1) contributes near 0. Null flood_pctile still contributes 0 and is
-- excluded from weight_sum, exactly as before.
-- ---------------------------------------------------------------------------

create or replace function api.top_homes_weighted(weights jsonb, p_county_fips text default null)
returns table (
    prop_id                       text,
    geo_id                        text,
    situs_num                     text,
    situs_street                  text,
    situs_city                    text,
    situs_zip                     text,
    market_value                  numeric,
    block_group_geoid             text,
    county_fips                   text,
    score                         numeric,
    reasons                       text[],
    territory_eia_id              text,
    distributor_name              text,
    distributor_saidi             numeric,
    distributor_saidi_year        int,
    distributor_saidi_early_release boolean,
    flood_flag                    boolean,
    empower_rate                  numeric,
    acs_pct_65_plus                numeric,
    acs_pct_electric_heat          numeric,
    backup_intent_rate             numeric,
    source_ids                     uuid[]
)
language sql
stable
parallel safe
as $$
    with w as materialized (
        select
            (case when weights ? 'outage'        then (weights ->> 'outage')::numeric        else 0 end) as w_outage,
            (case when weights ? 'flood'          then (weights ->> 'flood')::numeric          else 0 end) as w_flood,
            (case when weights ? 'empower'        then (weights ->> 'empower')::numeric        else 0 end) as w_empower,
            (case when weights ? 'age65'          then (weights ->> 'age65')::numeric          else 0 end) as w_age65,
            (case when weights ? 'electric_heat'  then (weights ->> 'electric_heat')::numeric  else 0 end) as w_heat,
            (case when weights ? 'backup_intent'  then (weights ->> 'backup_intent')::numeric  else 0 end) as w_backup
    ),
    narrow as (
        select
            s.prop_id,
            s.distributor_saidi_pctile,
            s.flood_pctile,
            s.empower_pctile,
            s.acs_65_pctile,
            s.acs_heat_pctile,
            s.backup_intent_pctile,
            s.backup_intent_rate
        from core.mv_home_signals s
        where s.gate_reason is null
          and (p_county_fips is null or s.county_fips = p_county_fips)
    ),
    scored as (
        select
            n.prop_id,
            n.backup_intent_rate,
            (
                case when n.distributor_saidi_pctile is not null then w.w_outage * n.distributor_saidi_pctile else 0 end
                -- Installability: outside the flood zone is favored, so
                -- the contribution uses (1 - flood_pctile) — see the
                -- flood_pctile column comment above for why the raw
                -- column can't be used directly.
                + case when n.flood_pctile is not null then w.w_flood * (1 - n.flood_pctile) else 0 end
                + case when n.empower_pctile is not null then w.w_empower * n.empower_pctile else 0 end
                + case when n.acs_65_pctile is not null then w.w_age65 * n.acs_65_pctile else 0 end
                + case when n.acs_heat_pctile is not null then w.w_heat * n.acs_heat_pctile else 0 end
                + case when n.backup_intent_pctile is not null then w.w_backup * n.backup_intent_pctile else 0 end
            ) as weighted_sum,
            (
                case when n.distributor_saidi_pctile is not null then w.w_outage else 0 end
                + case when n.flood_pctile is not null then w.w_flood else 0 end
                + case when n.empower_pctile is not null then w.w_empower else 0 end
                + case when n.acs_65_pctile is not null then w.w_age65 else 0 end
                + case when n.acs_heat_pctile is not null then w.w_heat else 0 end
                + case when n.backup_intent_pctile is not null then w.w_backup else 0 end
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
            select array_agg(c.label order by c.contrib desc)
            from (
                select label, contrib
                from (values
                    ('outage',        case when s.distributor_saidi_pctile is not null
                                          then (select w_outage from w) * s.distributor_saidi_pctile end),
                    -- Reason key stays 'flood' (web keys its label/color
                    -- maps off this string) — contribution now uses
                    -- (1 - flood_pctile), same direction fix as the score.
                    ('flood',          case when s.flood_pctile is not null
                                          then (select w_flood from w) * (1 - s.flood_pctile) end),
                    ('empower',        case when s.empower_pctile is not null
                                          then (select w_empower from w) * s.empower_pctile end),
                    ('age65',          case when s.acs_65_pctile is not null
                                          then (select w_age65 from w) * s.acs_65_pctile end),
                    ('electric_heat',  case when s.acs_heat_pctile is not null
                                          then (select w_heat from w) * s.acs_heat_pctile end),
                    ('backup_intent',  case when s.backup_intent_pctile is not null
                                          then (select w_backup from w) * s.backup_intent_pctile end)
                ) as t(label, contrib)
                where contrib is not null and contrib > 0
                order by contrib desc
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
        s.source_ids
    from ranked r
    join core.mv_home_signals s on s.prop_id = r.prop_id
    join core.parcels p on p.prop_id = r.prop_id
    order by r.final_score desc, r.backup_intent_rate desc nulls last, r.prop_id;
$$;

comment on function api.top_homes_weighted(jsonb, text) is
    'Score v1 (flood-direction fix, 0204_flood_direction.sql — same '
    'perf structure as 0202_m2_perf.sql): score = sum(w_i * p_i) / '
    'sum(w_i) over each home''s AVAILABLE percentile signals from '
    'core.mv_home_signals, gated homes only, county filter, '
    'deterministic order (score, then backup_intent_rate, then '
    'prop_id), limit 50. The flood term uses (1 - flood_pctile), not '
    'flood_pctile, because flood_pctile is the percentile of being '
    'INSIDE a FEMA Special Flood Hazard Area (see the column comment on '
    'core.mv_home_signals.flood_pctile) and installability favors homes '
    'OUTSIDE the flood zone (PRODUCT.md / spec Signals table) — a null '
    'flood_pctile still contributes 0 and is excluded from the weight '
    'sum. Reason key stays ''flood'' for web-side label/color stability; '
    'its contribution uses the same (1 - flood_pctile) inversion. '
    'PARALLEL SAFE (reads no session state, calls no volatile '
    'functions).';

revoke all on function api.top_homes_weighted(jsonb, text) from public, anon, authenticated;
grant execute on function api.top_homes_weighted(jsonb, text) to service_role;

commit;
