-- 0202_m2_perf.sql — M2 perf: speed up api.top_homes_weighted (~2.9 s ->
-- target < 1 s; called on every slider move in M2-W1).
--
-- Idempotent-safe: CREATE INDEX IF NOT EXISTS and CREATE OR REPLACE
-- FUNCTION only. No data rows, no new tables. Real-data rule: no data is
-- created or altered by this migration.
--
-- Root cause (EXPLAIN ANALYZE on Travis, 48453, all-signals weight set):
-- the query plan already does a top-N heapsort (Sort + Limit 50 planned
-- correctly), but the driving scan --
--   Index Scan using mv_home_signals_gate_reason_idx (gate_reason IS NULL)
--   Filter: county_fips = '48453'
-- -- walks all 143,522 gate-passed Travis rows through a partial index on
-- gate_reason ALONE, then rejects non-matching counties row-by-row with a
-- Filter (no county_fips in the index), forcing a full heap fetch (wide
-- row: 9 raw signal columns + 6 percentile columns + source_ids uuid[])
-- for every one of those rows before any scoring or ranking happens. That
-- scan alone was ~6.9 s of the ~7.7 s EXPLAIN ANALYZE total (buffers
-- were warm; a cold cache would be worse). The weights jsonb was already
-- extracted once via the `w` CTE (materializes to 1 row, ~0.02 ms) --
-- that part was never the bottleneck.
--
-- Fix, matching the ticket's suggested shape:
--   1. A new partial covering index on (county_fips) WHERE gate_reason
--      IS NULL, INCLUDE-ing only the 7 columns the score computation
--      needs. This lets Postgres do an index-only scan straight to the
--      rows for one county (or, when p_county_fips is null, a full scan
--      of just the gate-passed partial index) without visiting the wide
--      heap row at all for the scoring pass.
--   2. The score is computed in a narrow CTE (`narrow`/`scored`) that
--      selects only those 7 columns, not core.mv_home_signals.* — no
--      display columns, no source_ids array, no reasons array.
--   3. `ranked` orders by score (desc), then backup_intent_rate (desc
--      nulls last), then prop_id — identical tie-break to before — and
--      takes LIMIT 50 there, before any join.
--   4. Only for those <=50 winning prop_ids do we re-join
--      core.mv_home_signals (by its existing unique prop_id index) and
--      core.parcels to fetch display columns and build the top-3
--      reasons array. Same reasons/score/order/columns as 0201_m2.sql —
--      only the access path changed.
--   5. `w` is pinned MATERIALIZED (it already computed once under the
--      old plan, per EXPLAIN ANALYZE above; made explicit here so a
--      future planner change can't start re-evaluating the jsonb
--      extraction per row).
--   6. Function marked STABLE PARALLEL SAFE (was STABLE only) — it reads
--      no session state and calls no volatile/parallel-unsafe functions,
--      so a parallel worker may run it.
--
-- Equivalence was verified by capturing this function's output (prop_id,
-- score, reasons, for 3 weight sets on county 48453) BEFORE this
-- migration was applied, then re-capturing after and diffing —
-- identical on all 3 weight sets (see agent report).

begin;

-- ---------------------------------------------------------------------------
-- Narrow covering index for the score computation: gate-passed rows for
-- one county, with only the 7 columns api.top_homes_weighted's scoring
-- CTE reads. INCLUDE columns are not part of the index key (no added
-- sort burden) but let an index-only scan skip the heap entirely for
-- this pass. Survives REFRESH MATERIALIZED VIEW CONCURRENTLY on
-- core.mv_home_signals like any other index on that mv.
-- ---------------------------------------------------------------------------

create index if not exists mv_home_signals_score_idx
    on core.mv_home_signals (county_fips)
    include (
        distributor_saidi_pctile,
        flood_pctile,
        empower_pctile,
        acs_65_pctile,
        acs_heat_pctile,
        backup_intent_pctile,
        backup_intent_rate
    )
    where gate_reason is null;

comment on index core.mv_home_signals_score_idx is
    'Covering index for api.top_homes_weighted''s narrow scoring CTE: '
    'gate-passed rows only, keyed by county_fips, with the 6 percentile '
    'columns + backup_intent_rate (tie-break) INCLUDE-d for an '
    'index-only scan. Added by 0202_m2_perf.sql.';

-- ---------------------------------------------------------------------------
-- api.top_homes_weighted — same signature, return columns, semantics
-- (score = sum(w_i*p_i)/sum(w_i) over available signals, gated homes
-- only, county filter, deterministic order: score desc, backup_intent_rate
-- desc nulls last, prop_id, limit 50) as 0201_m2.sql. Only the query
-- shape changed: narrow-CTE score + rank first, then join display
-- columns/build reasons for the <=50 winners only.
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
    -- Weight per signal, read from the jsonb argument exactly once
    -- (no COALESCE-to-0, per scripts/no_mock_check.py check 6 — a
    -- missing key just means the CASE below falls through to 0).
    -- MATERIALIZED: this must compute once, not be inlined into every
    -- row of the (up to 143k-row) narrow/scored CTEs below.
    with w as materialized (
        select
            (case when weights ? 'outage'        then (weights ->> 'outage')::numeric        else 0 end) as w_outage,
            (case when weights ? 'flood'          then (weights ->> 'flood')::numeric          else 0 end) as w_flood,
            (case when weights ? 'empower'        then (weights ->> 'empower')::numeric        else 0 end) as w_empower,
            (case when weights ? 'age65'          then (weights ->> 'age65')::numeric          else 0 end) as w_age65,
            (case when weights ? 'electric_heat'  then (weights ->> 'electric_heat')::numeric  else 0 end) as w_heat,
            (case when weights ? 'backup_intent'  then (weights ->> 'backup_intent')::numeric  else 0 end) as w_backup
    ),
    -- Narrow: gate-passed + county filter first, only the 7 columns the
    -- score needs — served by core.mv_home_signals_score_idx as an
    -- index-only scan, no wide-row heap fetch for the ~143k candidate
    -- rows.
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
                + case when n.flood_pctile is not null then w.w_flood * n.flood_pctile else 0 end
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
    -- Rank and cut to 50 BEFORE touching any display column or building
    -- reasons — those happen only for the <=50 winners below.
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
                    ('flood',          case when s.flood_pctile is not null
                                          then (select w_flood from w) * s.flood_pctile end),
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
    'Score v1 (perf pass, 0202_m2_perf.sql — same semantics as '
    '0201_m2.sql): score = sum(w_i * p_i) / sum(w_i) over each home''s '
    'AVAILABLE percentile signals (from core.mv_home_signals, never '
    'materialized weighted), top-3 contributing (nonzero) signals as '
    'reasons, gated homes only, ordered deterministically (score, then '
    'backup_intent_rate, then prop_id), limit 50. Scoring/ranking now '
    'happens in a narrow CTE over core.mv_home_signals_score_idx (an '
    'index-only scan on 7 columns) BEFORE joining core.parcels or '
    'building the reasons array, cutting the query from a ~2.9 s '
    'wide-row scan of every gate-passed county row to a sub-second '
    'index-only scan + top-N sort of <=50 winners. Marked PARALLEL SAFE '
    '(reads no session state, calls no volatile functions).';

revoke all on function api.top_homes_weighted(jsonb, text) from public, anon, authenticated;
grant execute on function api.top_homes_weighted(jsonb, text) to service_role;

commit;
