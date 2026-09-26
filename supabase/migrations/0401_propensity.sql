-- 0401_propensity.sql — M4-P4: predictive headline score. core.
-- home_propensity holds a calibrated 12-month backup-adoption
-- probability per gated home (pipelines/models/pipeline.py writes it via
-- COPY + one upsert, per the Bulk loading rule); core.model_card holds
-- the out-of-time evaluation metrics for the model version that wrote
-- those rows. Additive only — this migration does not touch
-- core.mv_home_signals or any existing scoring function/view.

begin;

-- ---------------------------------------------------------------------------
-- core.home_propensity — one row per gated home scored by the model.
-- p_install_12m is a calibrated probability (isotonic/Platt), never a
-- percentile. relative_to_county = p_install_12m / mean(p_install_12m)
-- within the home's county (core.mv_home_signals.county_fips) — how far
-- above/below its county's own average the home ranks. decile is
-- 1 (highest p) .. 10 (lowest p), ranked within county. reasons is the
-- top-3 SHAP (or model-native) contributions, each
-- {"feature": <plain name>, "direction": "raises"|"lowers", "value": <raw
-- feature value or null>} — plain feature names only, per the
-- on-screen-copy rule (no core.*/api.* names, no ticket IDs). extrapo-
-- lated_from = 'austin_installs' for a home whose permit-derived
-- features are null (outside Austin permit coverage — core.mv_home_
-- signals.permit_null_reason = 'no_permit_coverage'), else null.
-- ---------------------------------------------------------------------------

create table if not exists core.home_propensity (
    prop_id             text primary key references core.parcels (prop_id),
    p_install_12m       numeric not null check (p_install_12m >= 0 and p_install_12m <= 1),
    relative_to_county  numeric,
    decile              integer not null check (decile between 1 and 10),
    reasons             jsonb not null,
    extrapolated_from   text,
    model_version       text not null,
    trained_through     date not null,
    source_ids          uuid[] not null,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists home_propensity_decile_idx on core.home_propensity (decile);
create index if not exists home_propensity_model_version_idx on core.home_propensity (model_version);

comment on table core.home_propensity is
    'M4-P4: calibrated probability a gated home adds battery/generator '
    'backup in the next 12 months (out-of-time trained, isotonic-'
    'calibrated; see core.model_card for evaluation metrics and '
    'checks/M4-P4.md for the write-up). Never a percentile, never an '
    'invented value — a home outside Austin permit coverage gets its '
    'permit-derived features null (extrapolated_from=''austin_installs'') '
    'and is still scored on its remaining features by the same model '
    '(HistGradientBoostingClassifier/logistic regression handle missing '
    'features, whichever won out-of-time AUC). Filled by '
    'pipelines/models/pipeline.py (python -m models score).';

-- ---------------------------------------------------------------------------
-- core.model_card — one row per model_version, the out-of-time
-- evaluation metrics from checks/M4-P4.md (train on features as of
-- 2024-07-01, label 2024-07-01..2025-06-30; test on features as of
-- 2025-07-01, label after it). calibration is the per-decile
-- [{"decile", "n", "predicted_mean_p", "observed_rate"}] table.
-- ---------------------------------------------------------------------------

create table if not exists core.model_card (
    model_version         text primary key,
    trained_through       date not null,
    algorithm             text not null,
    auc_oot               numeric,
    pr_auc_oot            numeric,
    top_decile_lift_oot   numeric,
    calibration           jsonb,
    n_train               integer,
    n_test                integer,
    n_positive_train      integer,
    n_positive_test       integer,
    notes                 text,
    source_ids            uuid[] not null,
    created_at            timestamptz not null default now()
);

comment on table core.model_card is
    'M4-P4: out-of-time evaluation metrics (AUC, PR-AUC, top-decile '
    'lift, per-decile calibration) for each core.home_propensity.'
    'model_version, matching checks/M4-P4.md. Filled by '
    'pipelines/models/pipeline.py (python -m models train|score).';

alter table core.home_propensity enable row level security;
alter table core.model_card      enable row level security;

revoke all on core.home_propensity from public, anon, authenticated;
revoke all on core.model_card      from public, anon, authenticated;

grant select on core.home_propensity, core.model_card to zeus_web_ro;

drop policy if exists web_ro_select on core.home_propensity;
create policy web_ro_select on core.home_propensity for select to zeus_web_ro using (true);

drop policy if exists web_ro_select on core.model_card;
create policy web_ro_select on core.model_card for select to zeus_web_ro using (true);

-- ---------------------------------------------------------------------------
-- api.home_propensity — plain SELECT, joined to core.mv_home_signals
-- only for county_fips (so the web agent can filter to the displayed
-- county without a second round trip); no request-time aggregation.
-- ---------------------------------------------------------------------------

create or replace view api.home_propensity as
select
    hp.prop_id,
    s.county_fips,
    hp.p_install_12m,
    hp.relative_to_county,
    hp.decile,
    hp.reasons,
    hp.extrapolated_from,
    hp.model_version,
    hp.trained_through,
    hp.source_ids
from core.home_propensity hp
join core.mv_home_signals s on s.prop_id = hp.prop_id;

revoke all on api.home_propensity from public, anon, authenticated;
grant select on api.home_propensity to service_role;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'zeus_web_ro') then
        execute 'grant select on api.home_propensity to zeus_web_ro';
    end if;
end $$;

comment on view api.home_propensity is
    'core.home_propensity joined to core.mv_home_signals for county_fips '
    'only. p_install_12m is a calibrated probability (never a '
    'percentile); reasons holds the top-3 plain-language contributions. '
    'Look up by prop_id or filter by county_fips/decile — both indexed.';

create or replace view api.model_card as
select
    model_version, trained_through, algorithm, auc_oot, pr_auc_oot,
    top_decile_lift_oot, calibration, n_train, n_test, n_positive_train,
    n_positive_test, notes, source_ids
from core.model_card;

revoke all on api.model_card from public, anon, authenticated;
grant select on api.model_card to service_role;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'zeus_web_ro') then
        execute 'grant select on api.model_card to zeus_web_ro';
    end if;
end $$;

comment on view api.model_card is
    'core.model_card: out-of-time AUC/PR-AUC/top-decile-lift/calibration '
    'per model_version, matching checks/M4-P4.md. A small table, full '
    'scan well under 50 ms.';

-- ---------------------------------------------------------------------------
-- ops.refresh_policy — backfill/CLI only (features and permits change
-- daily at most; re-run manually, same pattern as permit_timelines).
-- ---------------------------------------------------------------------------

-- no-mock-check: config-seed refresh cycle is the team's freshness policy from the spec, not source data
insert into ops.refresh_policy (source, refresh_cycle_days, note) values
    ('home_propensity', 1, 'core.home_propensity / core.model_card (M4-P4) -- backfill/CLI only: re-run `python -m models score` (pipelines/models/pipeline.py) after new permits or parcels load')
on conflict (source) do update
    set refresh_cycle_days = excluded.refresh_cycle_days,
        note                = excluded.note;

commit;
