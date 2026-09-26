-- 0207_score_explain.sql — M2-W5: explain why a home was chosen.
--
-- User request: it is not clear how the score is derived; GTM needs a
-- breakdown plus a contextual summary. Security decision (scope change,
-- github issue #65): the PUBLIC web app never calls Gemini — a public
-- route that could trigger an LLM call lets anyone burn credits. Summaries
-- are pre-generated OFFLINE by pipelines/sources/home_summaries.py (CLI/
-- cron, service-role/session-pooler credentials only) and stored in
-- core.home_summary; the web app only ever does a primary-key read
-- (api.home_summary below).
--
-- Two pieces here:
--   1. api.home_score_breakdown(prop_id, weights) — the deterministic
--      source of truth. Same per-signal terms, weight normalisation and
--      flood-direction fix (1 - flood_pctile) as api.top_homes_weighted /
--      api.homes_ranked_weighted (0201_m2.sql, 0204_flood_direction.sql):
--      contribution = w_i * p_i / sum(w_i) over AVAILABLE signals only. A
--      missing signal is dropped (available=false, contribution NULL,
--      never zero-filled) with its real *_null_reason carried through —
--      never invented. Summing every row's non-null contribution for a
--      prop_id reproduces that home's api.homes_ranked_weighted /
--      api.top_homes_weighted score exactly (same arithmetic, same
--      weight_sum denominator), so the ±0.001 acceptance check is really
--      an identity, not an approximation.
--   2. core.home_summary + api.home_summary(prop_id) — a primary-key-only
--      read of the offline-generated summary. No write path is exposed
--      through `api` (only the pipeline, using
--      POSTGRES_URL_NON_POOLING, ever writes core.home_summary directly).
--
-- Idempotent-safe: CREATE OR REPLACE FUNCTION / CREATE TABLE IF NOT
-- EXISTS only. No data rows created here — home_summaries.py owns every
-- core.home_summary row, and every one traces back to core.mv_home_signals
-- (itself built from manifested M1/M2 sources) via its source_ids column.
--
-- Read-only web role (0210_web_readonly_role.sql, main): that migration's
-- RLS-policy loop only covers tables that already had `relrowsecurity`
-- set at the time IT ran. core.home_summary is created here, numbered
-- *before* 0210 but applied to the live database *after* it already ran
-- once — so this migration enables RLS and creates zeus_web_ro's
-- SELECT-only policy itself, explicitly, rather than relying on that
-- loop to have already seen this table.

begin;

-- ---------------------------------------------------------------------------
-- api.home_score_breakdown — per-signal raw value/unit/percentile/weight/
-- contribution for one home, at the caller's weights. Primary-key lookup
-- on core.mv_home_signals (prop_id) only — no scan, no spatial join.
-- ---------------------------------------------------------------------------

create or replace function api.home_score_breakdown(p_prop_id text, weights jsonb)
returns table (
    key          text,
    label        text,
    raw_value    numeric,
    raw_unit     text,
    percentile   numeric,
    weight       numeric,
    contribution numeric,
    available    boolean,
    null_reason  text
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
    s as (
        select * from core.mv_home_signals where prop_id = p_prop_id
    ),
    weight_total as (
        select
            (
                case when s.distributor_saidi_pctile  is not null then w.w_outage  else 0 end
                + case when s.flood_pctile             is not null then w.w_flood   else 0 end
                + case when s.empower_pctile           is not null then w.w_empower else 0 end
                + case when s.acs_65_pctile            is not null then w.w_age65   else 0 end
                + case when s.acs_heat_pctile          is not null then w.w_heat    else 0 end
                + case when s.backup_intent_pctile     is not null then w.w_backup  else 0 end
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
             then (v.weight * v.percentile) / wt.weight_sum
             else null end as contribution,
        v.available,
        v.null_reason
    from s
    cross join w
    cross join weight_total wt
    cross join lateral (
        values
            (
                'outage',
                'Outage exposure (distributor SAIDI)',
                s.distributor_saidi,
                'minutes without power/year (SAIDI, incl. major events)',
                s.distributor_saidi_pctile,
                w.w_outage,
                s.distributor_saidi_pctile is not null,
                s.distributor_saidi_null_reason
            ),
            (
                'flood',
                'Outside flood zone (installability)',
                case when s.flood_flag is null then null
                     else (case when s.flood_flag then 1 else 0 end)::numeric end,
                'flag (1 = inside a FEMA Special Flood Hazard Area)',
                -- Same (1 - flood_pctile) inversion as api.top_homes_weighted /
                -- api.homes_ranked_weighted (0204_flood_direction.sql): the
                -- score rewards being OUTSIDE the flood zone.
                case when s.flood_pctile is null then null else 1 - s.flood_pctile end,
                w.w_flood,
                s.flood_pctile is not null,
                s.flood_null_reason
            ),
            (
                'empower',
                'Medical need (emPOWER)',
                case when s.empower_rate is null then null else s.empower_rate * 1000 end,
                'power-dependent Medicare devices per 1,000 Medicare beneficiaries in this ZIP',
                s.empower_pctile,
                w.w_empower,
                s.empower_pctile is not null,
                s.empower_null_reason
            ),
            (
                'age65',
                'Age 65+ (block group, ACS)',
                case when s.acs_pct_65_plus is null then null else s.acs_pct_65_plus * 100 end,
                '% of this block group''s population age 65+ (same for every home in the block group)',
                s.acs_65_pctile,
                w.w_age65,
                s.acs_65_pctile is not null,
                s.acs_65_null_reason
            ),
            (
                'electric_heat',
                'Electric heat (block group, ACS)',
                case when s.acs_pct_electric_heat is null then null else s.acs_pct_electric_heat * 100 end,
                '% of this block group''s housing units heating with electricity (same for every home in the block group)',
                s.acs_heat_pctile,
                w.w_heat,
                s.acs_heat_pctile is not null,
                s.acs_heat_null_reason
            ),
            (
                'backup_intent',
                'Backup intent (block group)',
                s.backup_intent_rate,
                'battery/generator permits per 1,000 gated homes in this block group (36 months, same for every home in the block group)',
                s.backup_intent_pctile,
                w.w_backup,
                s.backup_intent_pctile is not null,
                s.backup_intent_null_reason
            )
    ) as v(key, label, raw_value, raw_unit, percentile, weight, available, null_reason);
$$;

comment on function api.home_score_breakdown(text, jsonb) is
    'Per-signal raw value/unit/percentile/weight/contribution for one '
    'home (primary-key lookup on core.mv_home_signals), at the caller''s '
    'weights. contribution = weight * percentile / sum(weight over '
    'AVAILABLE signals) — identical terms, weight normalisation and '
    'flood-direction fix (1 - flood_pctile) as api.top_homes_weighted / '
    'api.homes_ranked_weighted, so summing every non-null contribution '
    'for a prop_id reproduces that home''s ranked score exactly. A '
    'missing signal (available=false) carries its real *_null_reason and '
    'a null contribution — never a zero-filled one.';

revoke all on function api.home_score_breakdown(text, jsonb) from public, anon, authenticated;
grant execute on function api.home_score_breakdown(text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- core.home_summary — one pre-generated "why this home" summary per home,
-- written ONLY by pipelines/sources/home_summaries.py (never by the web
-- app). At equal weights (the pipeline's fixed scoring point, so a stored
-- summary is comparable across homes regardless of what a rep's slider
-- is currently set to).
-- ---------------------------------------------------------------------------

create table if not exists core.home_summary (
    prop_id        text primary key,
    summary        text not null,
    is_template    boolean not null default false,
    guard_failed   boolean not null default false,
    model          text,
    prompt_version int not null default 1,
    facts_hash     text not null,
    source_ids     uuid[] not null default array[]::uuid[],
    generated_at   timestamptz not null default now()
);

comment on table core.home_summary is
    'One pre-generated "why this home" summary per home (prop_id primary '
    'key), written offline by pipelines/sources/home_summaries.py at '
    'equal weights. is_template=true means the grounding guard rejected '
    'the Gemini reply (guard_failed=true) or the call errored/timed out, '
    'and `summary` holds the deterministic template sentence instead — '
    'never an ungrounded LLM reply. facts_hash + prompt_version make a '
    're-run idempotent: a row whose facts_hash+prompt_version already '
    'match is skipped, not re-billed. source_ids carries forward '
    'core.mv_home_signals.source_ids for this home, for provenance.';

alter table core.home_summary enable row level security;

-- 0210_web_readonly_role.sql (main) grants zeus_web_ro SELECT-only access
-- via a loop over tables that already had RLS enabled when IT ran; this
-- table is created after that migration already applied to the live
-- database, so its policy is created explicitly here instead of relying
-- on that loop to have seen it.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'zeus_web_ro') then
    execute 'drop policy if exists web_ro_select on core.home_summary';
    execute 'create policy web_ro_select on core.home_summary for select to zeus_web_ro using (true)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- api.home_summary — primary-key read only. No INSERT/UPDATE path is
-- exposed through `api`; only the pipeline (direct core.home_summary
-- access over POSTGRES_URL_NON_POOLING) ever writes a row.
-- ---------------------------------------------------------------------------

create or replace function api.home_summary(p_prop_id text)
returns table (
    summary      text,
    is_template  boolean,
    guard_failed boolean,
    model        text,
    generated_at timestamptz
)
language sql
stable
parallel safe
as $$
    select hs.summary, hs.is_template, hs.guard_failed, hs.model, hs.generated_at
    from core.home_summary hs
    where hs.prop_id = p_prop_id;
$$;

comment on function api.home_summary(text) is
    'Primary-key read of the offline-generated "why this home" summary '
    '(core.home_summary, written only by pipelines/sources/'
    'home_summaries.py). Empty result means no summary has been '
    'generated for this home yet — the caller (ScoreExplainer.tsx) falls '
    'back to a deterministic template built client-side from the live '
    'breakdown''s top contributions. No Gemini call happens on this path.';

revoke all on function api.home_summary(text) from public, anon, authenticated;
grant execute on function api.home_summary(text) to service_role;

-- ---------------------------------------------------------------------------
-- ops.refresh_policy — register the home_summaries pipeline source. It is
-- CLI/backfill-driven (re-run manually as scored homes change, or when a
-- new BRIEF_MODEL/prompt version ships), never a daily cron: it burns
-- Gemini quota per home, and every real refresh cadence in this table is
-- an upstream publisher's, not this derived-text step's.
-- ---------------------------------------------------------------------------

-- no-mock-check: config-seed refresh cycles are the team's freshness policy from the spec, not source data
insert into ops.refresh_policy (source, refresh_cycle_days, note) values
    ('home_summaries', null, 'Pre-generated Gemini "why this home" summaries (M2-W5) — CLI/backfill-only, re-run as scoring/prompt changes')
on conflict (source) do update
    set refresh_cycle_days = excluded.refresh_cycle_days,
        note                = excluded.note;

commit;
