-- 0101_m1.sql — M1-S1: TCAD parcels + geometry, block groups, permits, score v0, ranked views
--
-- Idempotent-safe: every DDL statement uses IF NOT EXISTS / CREATE OR REPLACE /
-- ON CONFLICT so this file can be re-applied to the same database without error
-- or duplication. The whole file runs inside one transaction (BEGIN/COMMIT
-- below) so a partial failure never leaves a half-applied schema.
--
-- Real-data rule: this migration creates no data rows for parcels, geometry,
-- block groups, or permits. The only rows it seeds are `ops.refresh_policy`
-- key replacements, which are static configuration, not observed data.
--
-- Gates (used identically in every view below):
--   single-family  = imprv_state_cd or land_state_cd starts with 'A1' (Texas PTAD category A1)
--   owner-occupied = hs_exempt = 'T' (homestead exemption flag)
-- No owner-name column exists anywhere in this migration (see checks/T0-H3.md).

begin;

-- ---------------------------------------------------------------------------
-- core.parcels — TCAD 2026 Certified Appraisal Export attributes (PROP.TXT).
-- Filled by M1-P1. Keyed on TCAD prop_id; geo_id is the permit join key.
-- ---------------------------------------------------------------------------

create table if not exists core.parcels (
    prop_id           text primary key,
    geo_id            text,
    county_fips       text,
    prop_type_cd      text,
    imprv_state_cd    text,
    land_state_cd     text,
    hs_exempt         text,
    ov65_exempt       text,
    situs_num         text,
    situs_street      text,
    situs_city        text,
    situs_zip         text,
    market_value      numeric,
    tax_year          int,
    source_id         uuid not null references ops.source_manifest (id),
    created_at        timestamptz not null default now()
);

create index if not exists parcels_geo_id_idx on core.parcels (geo_id);
create index if not exists parcels_county_fips_idx on core.parcels (county_fips);

comment on table core.parcels is
    'TCAD Certified Appraisal Export attributes, one row per prop_id (R '
    'property records only, de-duplicated across multi-owner rows). No owner '
    'name is stored. geo_id is the 10-digit key that Austin permits '
    'tcad_id joins against. Filled by M1-P1.';

-- ---------------------------------------------------------------------------
-- core.parcel_geoms — Travis County TCAD_public layer polygon + centroid.
-- Filled by M1-P4, independently of core.parcels (same prop_id key space,
-- no FK — the two pipelines run in parallel against different sources).
-- ---------------------------------------------------------------------------

create table if not exists core.parcel_geoms (
    prop_id     text primary key,
    geo_id      text,
    geom        extensions.geometry(MultiPolygon, 4326),
    centroid    extensions.geometry(Point, 4326),
    source_id   uuid not null references ops.source_manifest (id),
    created_at  timestamptz not null default now()
);

create index if not exists parcel_geoms_geo_id_idx on core.parcel_geoms (geo_id);
create index if not exists parcel_geoms_geom_gix on core.parcel_geoms using gist (geom);
create index if not exists parcel_geoms_centroid_gix on core.parcel_geoms using gist (centroid);

comment on table core.parcel_geoms is
    'Parcel polygon + centroid (EPSG:4326) from the Travis County TCAD_public '
    'MapServer layer, keyed on TCAD prop_id. Filled by M1-P4.';

-- ---------------------------------------------------------------------------
-- core.block_groups — Census TIGER/Line block group polygons for Texas.
-- Filled by M1-P2.
-- ---------------------------------------------------------------------------

create table if not exists core.block_groups (
    geoid       text primary key,
    county_fips text,
    geom        extensions.geometry(MultiPolygon, 4326),
    source_id   uuid not null references ops.source_manifest (id),
    created_at  timestamptz not null default now()
);

create index if not exists block_groups_county_fips_idx on core.block_groups (county_fips);
create index if not exists block_groups_geom_gix on core.block_groups using gist (geom);

comment on table core.block_groups is
    'Census TIGER/Line 2024 block group polygons (Texas), EPSG:4326. Filled by M1-P2.';

-- ---------------------------------------------------------------------------
-- core.permits — Austin Issued Construction Permits (Socrata 3syk-w9eu),
-- last 36 months, filled by M1-P3. tcad_id joins to core.parcels.geo_id.
-- ---------------------------------------------------------------------------

create table if not exists core.permits (
    permit_number     text primary key,
    tcad_id           text,
    issue_date        date,
    work_class        text,
    permit_class      text,
    permit_type_desc  text,
    description       text,
    status_current    text,
    original_address1 text,
    latitude          numeric,
    longitude         numeric,
    source_id         uuid not null references ops.source_manifest (id),
    created_at        timestamptz not null default now()
);

create index if not exists permits_tcad_id_idx on core.permits (tcad_id);
create index if not exists permits_issue_date_idx on core.permits (issue_date);

comment on table core.permits is
    'Austin Issued Construction Permits, last 36 months, daily cron. tcad_id '
    'is the 10-digit key that joins to core.parcels.geo_id. Filled by M1-P3.';

-- ---------------------------------------------------------------------------
-- core.permit_labels — backup-intent classification per permit. labeller
-- distinguishes the rules classifier (M1-P3) from Claude hand-labels (M1-H1),
-- so classifier precision can compare the two per permit.
-- ---------------------------------------------------------------------------

create table if not exists core.permit_labels (
    id            uuid primary key default gen_random_uuid(),
    permit_number text not null references core.permits (permit_number),
    label         text not null check (label in ('battery', 'generator', 'solar', 'panel', 'ev', 'other')),
    labeller      text not null check (labeller in ('rules', 'claude')),
    rationale     text,
    source_id     uuid references ops.source_manifest (id),
    created_at    timestamptz not null default now(),
    unique (permit_number, labeller, label)
);

create index if not exists permit_labels_permit_number_idx on core.permit_labels (permit_number);

comment on table core.permit_labels is
    'One or more labels per permit per labeller (a permit may match several '
    'categories, e.g. solar + battery). labeller = rules is written by the '
    'M1-P3 classifier; labeller = claude is written by the M1-H1 hand-label '
    'pass (Claude reading real permit descriptions, not a human — see '
    'checks/M1-H1.md). rationale records why that label was assigned. '
    'source_id is nullable: Claude hand-labels have no manifest row.';

-- ---------------------------------------------------------------------------
-- ops.label_queue — the 100 permits M1-P3 samples for M1-H1 to label.
-- ---------------------------------------------------------------------------

create table if not exists ops.label_queue (
    id            uuid primary key default gen_random_uuid(),
    permit_number text not null references core.permits (permit_number),
    sampled_at    timestamptz not null default now(),
    labelled      boolean not null default false,
    unique (permit_number)
);

comment on table ops.label_queue is
    '100 permits sampled by M1-P3 for the M1-H1 hand-label pass that feeds '
    'api.classifier_precision.';

-- ---------------------------------------------------------------------------
-- Row-level security: enabled on every new table, with NO policies — no
-- anon or authenticated access at all, matching the M0 convention.
-- ---------------------------------------------------------------------------

alter table core.parcels       enable row level security;
alter table core.parcel_geoms  enable row level security;
alter table core.block_groups  enable row level security;
alter table core.permits       enable row level security;
alter table core.permit_labels enable row level security;
alter table ops.label_queue    enable row level security;

revoke all on core.parcels       from public, anon, authenticated;
revoke all on core.parcel_geoms  from public, anon, authenticated;
revoke all on core.block_groups  from public, anon, authenticated;
revoke all on core.permits       from public, anon, authenticated;
revoke all on core.permit_labels from public, anon, authenticated;
revoke all on ops.label_queue    from public, anon, authenticated;

-- Re-assert the M0 schema-level revokes (idempotent no-ops if already applied).
revoke all on schema ops  from public, anon, authenticated;
revoke all on schema core from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- ops.refresh_policy — M0 seeded a `parcels` key against the (blocked) TxGIO
-- route. Replace it with the two real Travis sources from checks/T0-H3.md,
-- both backfill-only (null cycle: refreshed ~yearly upstream, no daily cron).
-- ---------------------------------------------------------------------------

-- no-mock-check: config-seed refresh cycles are the team's freshness policy from the spec, not source data
insert into ops.refresh_policy (source, refresh_cycle_days, note) values
    ('tcad_export',   null, 'TCAD 2026 Certified Appraisal Export (PROP.TXT) — backfill only, refreshed yearly upstream'),
    ('tcad_geometry', null, 'Travis County TCAD_public parcel geometry layer — backfill only, refreshed yearly upstream')
on conflict (source) do update
    set refresh_cycle_days = excluded.refresh_cycle_days,
        note                = excluded.note;

delete from ops.refresh_policy where source = 'parcels';

-- ---------------------------------------------------------------------------
-- api.parcel_gate_counts — parcel gate funnel (single-family / homestead),
-- extended by M2 with further gates.
-- ---------------------------------------------------------------------------

create or replace view api.parcel_gate_counts as
select
    count(*) as total_parcels,
    count(*) filter (
        where imprv_state_cd like 'A1%' or land_state_cd like 'A1%'
    ) as single_family_count,
    count(*) filter (
        where not (coalesce(imprv_state_cd, '') like 'A1%' or coalesce(land_state_cd, '') like 'A1%')
    ) as not_single_family_count,
    count(*) filter (where hs_exempt = 'T') as homestead_count,
    count(*) filter (where hs_exempt is distinct from 'T') as not_homestead_count,
    array(select distinct source_id from core.parcels where source_id is not null) as source_ids
from core.parcels
having count(*) > 0;

comment on view api.parcel_gate_counts is
    'Parcel gate funnel: single-family (imprv_state_cd/land_state_cd starts '
    'A1) and homestead (hs_exempt = T) counts, for M2 to extend. Returns zero '
    'rows (via HAVING) until core.parcels has at least one row, not an error.';

-- ---------------------------------------------------------------------------
-- api.blockgroup_scores — score v0 (backup intent): generator+battery
-- permits (rules labels) in the last 36 months, per 1,000 gated
-- single-family homes, per block group. Homes assigned to a block group via
-- ST_Within(parcel centroid, block group geom). Percentile-ranked; null with
-- reason where there is no data.
-- ---------------------------------------------------------------------------

create or replace view api.blockgroup_scores as
with gated_homes as (
    select
        p.prop_id,
        p.geo_id,
        pg.centroid,
        p.source_id  as parcel_source_id,
        pg.source_id as geom_source_id
    from core.parcels p
    join core.parcel_geoms pg on pg.prop_id = p.prop_id
    where (p.imprv_state_cd like 'A1%' or p.land_state_cd like 'A1%')
      and p.hs_exempt = 'T'
      and pg.centroid is not null
),
home_bg as (
    select
        gh.prop_id,
        bg.geoid as block_group_geoid,
        gh.parcel_source_id,
        gh.geom_source_id,
        bg.source_id as bg_source_id
    from gated_homes gh
    join core.block_groups bg on extensions.ST_Within(gh.centroid, bg.geom)
),
bg_home_counts as (
    select
        block_group_geoid,
        count(*) as homes_gated,
        array_agg(distinct parcel_source_id) as parcel_source_ids,
        array_agg(distinct geom_source_id) as geom_source_ids,
        array_agg(distinct bg_source_id) as bg_source_ids
    from home_bg
    group by block_group_geoid
),
-- Any rules-labelled permit (any category) that joins to a gated home, in
-- the score window. This is a coverage proxy: a block group with zero rows
-- here has no permit data touching its gated homes, which is "no data",
-- never "zero intent" — distinct from a block group that has coverage but
-- zero backup-intent permits (a real, scoreable zero rate).
permits_in_window as (
    select
        pm.permit_number,
        gh.prop_id,
        pl.label,
        pm.source_id as permit_source_id
    from core.permits pm
    join core.permit_labels pl
        on pl.permit_number = pm.permit_number
       and pl.labeller = 'rules'
    join core.parcels p on p.geo_id = pm.tcad_id
    join gated_homes gh on gh.prop_id = p.prop_id
    where pm.issue_date >= (current_date - interval '36 months')
),
permits_bg as (
    select
        hb.block_group_geoid,
        piw.permit_number,
        piw.label,
        piw.permit_source_id
    from permits_in_window piw
    join home_bg hb on hb.prop_id = piw.prop_id
),
bg_permit_counts as (
    select
        block_group_geoid,
        count(distinct permit_number) filter (where label in ('battery', 'generator')) as backup_permits_count,
        count(distinct permit_number) as any_permits_count,
        array_agg(distinct permit_source_id) as permit_source_ids
    from permits_bg
    group by block_group_geoid
),
permits_loaded as (
    select exists (select 1 from core.permit_labels where labeller = 'rules') as any_rules_labels
),
bg_rates as (
    select
        bg.geoid as block_group_geoid,
        bg.county_fips,
        hc.homes_gated,
        pc.backup_permits_count,
        case
            when hc.homes_gated is null or hc.homes_gated = 0 then null
            when pc.any_permits_count is null then null
            else (pc.backup_permits_count::numeric / hc.homes_gated) * 1000
        end as rate_per_1000,
        case
            when hc.homes_gated is null or hc.homes_gated = 0 then 'no_gated_homes_in_block_group'
            when not pl2.any_rules_labels then 'permits_not_loaded'
            when pc.any_permits_count is null then 'no_permit_coverage'
            else null
        end as rate_null_reason,
        array(
            select distinct s from unnest(
                array[bg.source_id]
                || coalesce(hc.parcel_source_ids, array[]::uuid[])
                || coalesce(hc.geom_source_ids, array[]::uuid[])
                || coalesce(hc.bg_source_ids, array[]::uuid[])
                || coalesce(pc.permit_source_ids, array[]::uuid[])
            ) s where s is not null
        ) as source_ids
    from core.block_groups bg
    left join bg_home_counts hc on hc.block_group_geoid = bg.geoid
    left join bg_permit_counts pc on pc.block_group_geoid = bg.geoid
    cross join permits_loaded pl2
),
scored as (
    select block_group_geoid, percent_rank() over (order by rate_per_1000) as score
    from bg_rates
    where rate_per_1000 is not null
)
select
    r.block_group_geoid,
    r.county_fips,
    r.homes_gated,
    r.backup_permits_count,
    r.rate_per_1000,
    s.score,
    case when s.score is null then r.rate_null_reason else null end as score_null_reason,
    r.source_ids
from bg_rates r
left join scored s on s.block_group_geoid = r.block_group_geoid;

comment on view api.blockgroup_scores is
    'Score v0 (backup intent only): generator+battery rules-labelled permits '
    'on gated (single-family + homestead) homes in the last 36 months, per '
    '1,000 gated homes, per block group, percentile-ranked (0-1). score is '
    'null with a reason: no_gated_homes_in_block_group (denominator is '
    'zero), permits_not_loaded (no rules labels exist anywhere yet), or '
    'no_permit_coverage (a coverage proxy — no rules-labelled permit of any '
    'category touches this block group''s gated homes in the window, e.g. '
    'outside Austin permit jurisdiction). Empty until M1-P1/P2/P4 load; '
    'returns zero rows, not an error.';

-- ---------------------------------------------------------------------------
-- api.top_homes — top 50 gated homes in the highest-scoring block groups,
-- with reasons.
-- ---------------------------------------------------------------------------

create or replace view api.top_homes as
with gated_homes as (
    select
        p.prop_id,
        p.geo_id,
        p.situs_num,
        p.situs_street,
        p.situs_city,
        p.situs_zip,
        p.market_value,
        pg.centroid,
        p.source_id  as parcel_source_id,
        pg.source_id as geom_source_id
    from core.parcels p
    join core.parcel_geoms pg on pg.prop_id = p.prop_id
    where (p.imprv_state_cd like 'A1%' or p.land_state_cd like 'A1%')
      and p.hs_exempt = 'T'
      and pg.centroid is not null
),
home_bg as (
    select
        gh.*,
        bg.geoid as block_group_geoid
    from gated_homes gh
    join core.block_groups bg on extensions.ST_Within(gh.centroid, bg.geom)
)
select
    hb.prop_id,
    hb.geo_id,
    hb.situs_num,
    hb.situs_street,
    hb.situs_city,
    hb.situs_zip,
    hb.market_value,
    hb.block_group_geoid,
    bs.score,
    bs.rate_per_1000,
    array['gated single-family/homestead home in block group ' || hb.block_group_geoid ||
          ' (score ' || coalesce(bs.score::text, 'not loaded') || ')'] as reasons,
    array(
        select distinct s from unnest(
            array[hb.parcel_source_id, hb.geom_source_id] || coalesce(bs.source_ids, array[]::uuid[])
        ) s where s is not null
    ) as source_ids
from home_bg hb
join api.blockgroup_scores bs on bs.block_group_geoid = hb.block_group_geoid
where bs.score is not null
order by bs.score desc, hb.market_value desc nulls last
limit 50;

comment on view api.top_homes is
    'Top 50 gated (single-family + homestead) homes in the highest-scoring '
    'block groups, with a human-readable reason and provenance. Empty until '
    'scores exist; returns zero rows, not an error.';

-- ---------------------------------------------------------------------------
-- api.home_detail — parcel + its permits, for /home/[prop_id].
-- ---------------------------------------------------------------------------

create or replace view api.home_detail as
select
    p.prop_id,
    p.geo_id,
    p.county_fips,
    p.prop_type_cd,
    p.imprv_state_cd,
    p.land_state_cd,
    p.hs_exempt,
    p.ov65_exempt,
    (p.imprv_state_cd like 'A1%' or p.land_state_cd like 'A1%') as is_single_family,
    (p.hs_exempt = 'T') as is_homestead,
    p.situs_num,
    p.situs_street,
    p.situs_city,
    p.situs_zip,
    p.market_value,
    p.tax_year,
    pg.geom,
    pg.centroid,
    coalesce(
        (
            select jsonb_agg(jsonb_build_object(
                'permit_number', pm.permit_number,
                'issue_date', pm.issue_date,
                'work_class', pm.work_class,
                'permit_class', pm.permit_class,
                'description', pm.description,
                'status_current', pm.status_current,
                'label', pl.label,
                'labeller', pl.labeller,
                'source_id', pm.source_id
            ) order by pm.issue_date desc)
            from core.permits pm
            left join core.permit_labels pl
                on pl.permit_number = pm.permit_number and pl.labeller = 'rules'
            where pm.tcad_id = p.geo_id
        ),
        '[]'::jsonb
    ) as permits,
    array(
        select distinct s from unnest(
            array[p.source_id, pg.source_id]
        ) s where s is not null
    ) as source_ids
from core.parcels p
left join core.parcel_geoms pg on pg.prop_id = p.prop_id;

comment on view api.home_detail is
    'One parcel with its joined permits (via geo_id = tcad_id) as a jsonb '
    'array, each carrying its own source_id. Empty until M1-P1 loads; '
    'returns zero rows, not an error.';

-- ---------------------------------------------------------------------------
-- api.join_rate — permits with tcad_id matched to parcels.geo_id, over all
-- permits that carry a tcad_id.
-- ---------------------------------------------------------------------------

create or replace view api.join_rate as
with permits_with_tcad as (
    select pm.permit_number, pm.tcad_id, pm.source_id
    from core.permits pm
    where pm.tcad_id is not null
),
matched as (
    select pwt.permit_number, pwt.source_id
    from permits_with_tcad pwt
    where exists (select 1 from core.parcels p where p.geo_id = pwt.tcad_id)
)
select
    (select count(*) from permits_with_tcad) as permits_with_tcad_id,
    (select count(*) from matched) as matched_to_parcels,
    case
        when (select count(*) from permits_with_tcad) = 0 then null
        else (select count(*) from matched)::numeric / (select count(*) from permits_with_tcad)
    end as join_rate,
    case
        when (select count(*) from permits_with_tcad) = 0 then 'no_permits_loaded_yet'
        else null
    end as join_rate_null_reason,
    array(select distinct source_id from permits_with_tcad where source_id is not null) as source_ids;

comment on view api.join_rate is
    'Permits with a tcad_id that match a core.parcels.geo_id, over all '
    'permits carrying a tcad_id. Always one row; join_rate is null with a '
    'reason until permits are loaded.';

-- ---------------------------------------------------------------------------
-- api.classifier_precision — battery and generator precision of the rules
-- classifier against Claude hand-labels (M1-H1). Null with reason until
-- Claude labels exist.
-- ---------------------------------------------------------------------------

create or replace view api.classifier_precision as
with rules_labels as (
    -- Rules classifier positives for the label under test.
    select permit_number, label, source_id
    from core.permit_labels
    where labeller = 'rules' and label in ('battery', 'generator')
),
claude_labels as (
    -- Every Claude hand-label, unfiltered: a permit Claude labelled 'other'
    -- (or any other category) must count as a false positive against a
    -- rules-positive 'battery'/'generator' label, not be dropped.
    select permit_number, label, source_id
    from core.permit_labels
    where labeller = 'claude'
),
claude_labelled_permits as (
    -- Distinct permits Claude hand-labelled at all (any label), one row
    -- per permit regardless of how many labels Claude gave it.
    select distinct permit_number, source_id
    from claude_labels
),
-- Precision: per-permit basis, one row per rules-positive permit that is
-- also Claude-labelled. Denominator is a COUNT(DISTINCT permit_number), so
-- a permit Claude gave several labels (e.g. battery+solar) is counted once,
-- not once per Claude label row.
precision_base as (
    select
        rl.label,
        rl.permit_number,
        rl.source_id       as rules_source_id,
        clp.source_id      as claude_source_id,
        exists (
            select 1 from claude_labels cl
            where cl.permit_number = rl.permit_number and cl.label = rl.label
        ) as is_true_positive
    from rules_labels rl
    join claude_labelled_permits clp on clp.permit_number = rl.permit_number
),
precision_per_label as (
    select
        label,
        count(distinct permit_number) as claude_labelled_count,
        count(distinct permit_number) filter (where is_true_positive) as true_positive_count,
        array_agg(distinct rules_source_id) filter (where rules_source_id is not null) as rules_source_ids,
        array_agg(distinct claude_source_id) filter (where claude_source_id is not null) as claude_source_ids
    from precision_base
    group by label
),
-- Recall: per-permit basis, one row per permit Claude gave label L.
-- Denominator is the Claude-labelled permits for L; numerator is those that
-- also have a rules label L.
recall_base as (
    select
        cl.label,
        cl.permit_number,
        cl.source_id as claude_source_id,
        exists (
            select 1 from rules_labels rl
            where rl.permit_number = cl.permit_number and rl.label = cl.label
        ) as has_rules_label
    from claude_labels cl
    where cl.label in ('battery', 'generator')
),
recall_per_label as (
    select
        label,
        count(distinct permit_number) as claude_label_count,
        count(distinct permit_number) filter (where has_rules_label) as recall_true_positive_count,
        array_agg(distinct claude_source_id) filter (where claude_source_id is not null) as claude_label_source_ids
    from recall_base
    group by label
)
select
    l.label,
    pl.claude_labelled_count,
    pl.true_positive_count,
    case
        when pl.claude_labelled_count is null or pl.claude_labelled_count = 0 then null
        else pl.true_positive_count::numeric / pl.claude_labelled_count
    end as precision,
    case
        when pl.claude_labelled_count is null or pl.claude_labelled_count = 0 then 'no_claude_labels_yet'
        else null
    end as precision_null_reason,
    array(
        select distinct s from unnest(
            coalesce(pl.rules_source_ids, array[]::uuid[])
            || coalesce(pl.claude_source_ids, array[]::uuid[])
            || coalesce(rcl.claude_label_source_ids, array[]::uuid[])
        ) s where s is not null
    ) as source_ids,
    rcl.claude_label_count,
    rcl.recall_true_positive_count,
    case
        when rcl.claude_label_count is null or rcl.claude_label_count = 0 then null
        else rcl.recall_true_positive_count::numeric / rcl.claude_label_count
    end as recall,
    case
        when rcl.claude_label_count is null or rcl.claude_label_count = 0 then 'no_claude_labels_yet'
        else null
    end as recall_null_reason
from (values ('battery'), ('generator')) as l(label)
left join precision_per_label pl on pl.label = l.label
left join recall_per_label rcl on rcl.label = l.label;

comment on view api.classifier_precision is
    'Rules-classifier precision and recall for battery and generator '
    'labels, measured per-permit (a permit Claude gave several labels, '
    'e.g. battery+solar, counts once, not once per Claude label row) '
    'against the permits Claude actually hand-labelled (checks/M1-H1.md '
    '— the ~100-permit ops.label_queue sample, not every rules-positive '
    'permit). Precision denominator: distinct permits with a rules label L '
    'that are Claude-labelled (any label). Recall denominator: distinct '
    'permits with a Claude label L. Always one row per label; precision/ '
    'recall are null with reason no_claude_labels_yet until M1-H1 runs.';

-- ---------------------------------------------------------------------------
-- Grants: service_role only. Re-assert (idempotent) on top of the M0
-- default privileges so every new api view is covered even if a different
-- role applied this migration.
-- ---------------------------------------------------------------------------

revoke all on all tables in schema api from public, anon, authenticated;
grant select on all tables in schema api to service_role;

commit;
