-- 0205_map_sync.sql — M2-W3: map in sync with the weighted ranking.
--
-- User feedback: the map colours block groups by the retired M1 v0
-- backup-intent-only score (core.mv_blockgroup_scores, read through
-- core.mv_blockgroup_geojson / api.blockgroup_geojson), while the Top
-- homes table ranks by api.top_homes_weighted's v1 weighted score
-- (0201/0202/0204_*.sql) — moving a slider only re-ranked the table.
--
-- Fix here: api.blockgroup_scores_weighted(weights jsonb, p_county_fips
-- text) — same per-signal terms, weight normalisation, and flood
-- direction fix as api.top_homes_weighted (0204_flood_direction.sql),
-- but over EVERY gate-passed home (no LIMIT 50), grouped by
-- block_group_geoid: a block group's score is the percent_rank of the
-- MEAN weighted home score over its gate-passed homes. The web route
-- (web/app/api/blockgroup-scores/route.ts, M2-W3) calls this on every
-- debounced slider change and recolors the map via maplibre
-- feature-state — geometry keeps coming from the precomputed
-- api.blockgroup_geojson (0203_perf_precompute.sql), unchanged here.
--
-- Idempotent-safe: CREATE OR REPLACE FUNCTION only. No data rows
-- created or altered; no materialized view is touched or refreshed by
-- this migration (core.mv_home_signals is read-only here, per the IO
-- budget — never REFRESH it from this ticket).

begin;

-- ---------------------------------------------------------------------------
-- api.blockgroup_scores_weighted — reuses core.mv_home_signals_score_idx
-- (0202_m2_perf.sql: partial covering index on (county_fips) INCLUDE-ing
-- the 6 percentile columns + backup_intent_rate, WHERE gate_reason IS
-- NULL) for the same narrow, single-pass access path
-- api.top_homes_weighted uses — one seq/index scan over the gate-passed
-- rows for the requested county (or all counties when p_county_fips is
-- null), no repeated subqueries per row (the `w` CTE is MATERIALIZED so
-- the jsonb weight extraction runs once, not once per home).
-- ---------------------------------------------------------------------------

create or replace function api.blockgroup_scores_weighted(weights jsonb, p_county_fips text default null)
returns table (
    block_group_geoid text,
    score             numeric,
    homes_scored       bigint
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
            s.block_group_geoid,
            s.distributor_saidi_pctile,
            s.flood_pctile,
            s.empower_pctile,
            s.acs_65_pctile,
            s.acs_heat_pctile,
            s.backup_intent_pctile
        from core.mv_home_signals s
        where s.gate_reason is null
          and (p_county_fips is null or s.county_fips = p_county_fips)
    ),
    scored as (
        select
            n.block_group_geoid,
            (
                case when n.distributor_saidi_pctile is not null then w.w_outage * n.distributor_saidi_pctile else 0 end
                -- Installability: favors OUTSIDE the flood zone — same
                -- (1 - flood_pctile) inversion as api.top_homes_weighted
                -- (0204_flood_direction.sql); flood_pctile itself is the
                -- percentile of being INSIDE a FEMA SFHA.
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
    home_scored as (
        -- Same guard as api.top_homes_weighted's `ranked` CTE: a home
        -- with zero total weight (every available signal weighted 0, or
        -- every signal null) contributes no score, never a 0/0 or a
        -- COALESCE-to-0 (no_mock_check check 6).
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
$$;

comment on function api.blockgroup_scores_weighted(jsonb, text) is
    'Map-sync score (M2-W3): a block group''s score is percent_rank() '
    'of the MEAN weighted home score (sum(w_i*p_i)/sum(w_i) over each '
    'gate-passed home''s available percentile signals, identical terms '
    'and flood-direction fix — (1 - flood_pctile) — to '
    'api.top_homes_weighted, 0204_flood_direction.sql) over its '
    'gate-passed, nonzero-weight-sum homes, ranked against every other '
    'block group''s mean in the same call. homes_scored is the count of '
    'gate-passed homes that contributed (nonzero weight sum) — a block '
    'group absent from this result set has zero such homes and the '
    'caller (web/app/api/blockgroup-scores/route.ts) must render it '
    'hatched, never as score 0. Reuses '
    'core.mv_home_signals_score_idx (0202_m2_perf.sql) for the same '
    'narrow, single-pass access path as api.top_homes_weighted — no '
    'LIMIT, since every gate-passed home (not just the top 50) counts '
    'toward its block group''s mean. PARALLEL SAFE (reads no session '
    'state, calls no volatile functions).';

revoke all on function api.blockgroup_scores_weighted(jsonb, text) from public, anon, authenticated;
grant execute on function api.blockgroup_scores_weighted(jsonb, text) to service_role;

-- ---------------------------------------------------------------------------
-- api.homes_ranked_weighted — mid-build scope change: the Top-homes table
-- is no longer a fixed top-50. With no block group selected it pages
-- through EVERY gated county home (score desc, prop_id asc, keyset
-- pagination via after_score/after_prop_id — no OFFSET, so a page is
-- never duplicated/skipped if the underlying signals change between
-- requests); with a block group selected (block_group_geoid) it pages
-- through every gated home in just that block group. Same scoring terms,
-- weight normalisation and flood-direction fix as api.top_homes_weighted
-- (0204_flood_direction.sql) — only the LIMIT 50 and the lack of a
-- keyset/block-group filter differ. Adds the parcel centroid
-- (core.parcel_geoms, primary-key join) so the same row can drive both
-- the table and the map dots without a second round trip.
-- ---------------------------------------------------------------------------

create or replace function api.homes_ranked_weighted(
    weights jsonb,
    p_county_fips text default null,
    p_block_group_geoid text default null,
    after_score numeric default null,
    after_prop_id text default null,
    page_size int default 50
)
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
    source_ids                     uuid[],
    lon                            double precision,
    lat                            double precision
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
          and (p_block_group_geoid is null or s.block_group_geoid = p_block_group_geoid)
    ),
    scored as (
        select
            n.prop_id,
            n.backup_intent_rate,
            (
                case when n.distributor_saidi_pctile is not null then w.w_outage * n.distributor_saidi_pctile else 0 end
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
            select array_agg(c.label order by c.contrib desc)
            from (
                select label, contrib
                from (values
                    ('outage',        case when s.distributor_saidi_pctile is not null
                                          then (select w_outage from w) * s.distributor_saidi_pctile end),
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
        s.source_ids,
        extensions.ST_X(pg.centroid) as lon,
        extensions.ST_Y(pg.centroid) as lat
    from page p
    join core.mv_home_signals s on s.prop_id = p.prop_id
    join core.parcels pc on pc.prop_id = p.prop_id
    left join core.parcel_geoms pg on pg.prop_id = p.prop_id
    order by p.final_score desc, p.prop_id;
$$;

comment on function api.homes_ranked_weighted(jsonb, text, text, numeric, text, int) is
    'Keyset-paginated, block-group-filterable version of '
    'api.top_homes_weighted (same score terms/flood-direction fix, '
    '0204_flood_direction.sql) for the ranking table + map dots after '
    'the top-50 scope change: with p_block_group_geoid null, pages '
    'through every gate-passed county home (order: score desc, prop_id '
    'asc); with p_block_group_geoid set, restricts to that block '
    'group''s gate-passed homes only. after_score/after_prop_id are the '
    'last row of the previous page (keyset, never OFFSET — stable under '
    'concurrent signal changes). Adds lon/lat (ST_X/ST_Y of '
    'core.parcel_geoms.centroid, a primary-key join) for map dots/pins; '
    'null when no parcel geometry has loaded for that prop_id. '
    'PARALLEL SAFE.';

revoke all on function api.homes_ranked_weighted(jsonb, text, text, numeric, text, int) from public, anon, authenticated;
grant execute on function api.homes_ranked_weighted(jsonb, text, text, numeric, text, int) to service_role;

-- ---------------------------------------------------------------------------
-- api.homes_ranked_weighted_count — the denominator for "Showing 1-50 of
-- N homes". A plain count (no window/group-by), same narrow/scored/
-- ranked filter as api.homes_ranked_weighted minus the keyset window, so
-- the route can call it once per weights/selection change (page 1 only,
-- per the scope-change note) and reuse the number across Next/Previous.
-- ---------------------------------------------------------------------------

create or replace function api.homes_ranked_weighted_count(
    weights jsonb,
    p_county_fips text default null,
    p_block_group_geoid text default null
)
returns bigint
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
            s.distributor_saidi_pctile,
            s.flood_pctile,
            s.empower_pctile,
            s.acs_65_pctile,
            s.acs_heat_pctile,
            s.backup_intent_pctile
        from core.mv_home_signals s
        where s.gate_reason is null
          and (p_county_fips is null or s.county_fips = p_county_fips)
          and (p_block_group_geoid is null or s.block_group_geoid = p_block_group_geoid)
    ),
    weight_sums as (
        select
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
    )
    select count(*) from weight_sums where weight_sum > 0;
$$;

comment on function api.homes_ranked_weighted_count(jsonb, text, text) is
    'Total row count api.homes_ranked_weighted would page through for '
    'the same weights/county/block-group filter (nonzero weight-sum '
    'gate-passed homes) — a plain count, no window function, called '
    'once per weights/selection change by the route (never once per '
    'page). PARALLEL SAFE.';

revoke all on function api.homes_ranked_weighted_count(jsonb, text, text) from public, anon, authenticated;
grant execute on function api.homes_ranked_weighted_count(jsonb, text, text) to service_role;

commit;
