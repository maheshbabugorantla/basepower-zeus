-- A TCAD parcel whose location (block group, TIGER 2024) falls outside
-- Travis County is counted as its own gate reason, `outside_county`,
-- instead of "passed". Parcels whose TCAD roll county (core.parcels.
-- county_fips) differs from the county their geometry lands in are
-- straddlers along the county line (181 homes: 137 Williamson, 24 Hays,
-- 13 Burnet, 6 Bastrop, 1 Blanco). Round Rock / Hutto *mailing*
-- addresses inside Travis are unaffected: postal city ≠ county (Census
-- geocoder confirmed samples are in Travis County).
-- Only mv_gate_counts changes; rankings already filter county_fips.

drop materialized view if exists core.mv_gate_counts cascade;

create materialized view core.mv_gate_counts as
with homes as (
    select
        s.prop_id,
        s.source_ids,
        case
            when s.county_fips is distinct from p.county_fips then 'outside_county'
            else coalesce(s.gate_reason, s.territory_null_reason, 'passed')
        end as reason
    from core.mv_home_signals s
    join core.parcels p on p.prop_id = s.prop_id
),
counts as (
    select reason, count(distinct prop_id) as home_count
    from homes
    group by 1
),
srcs as (
    select reason, array_agg(distinct src) as source_ids
    from homes
    cross join lateral unnest(source_ids) as src
    group by 1
)
select
    c.reason,
    c.home_count,
    coalesce(sr.source_ids, array[]::uuid[]) as source_ids
from counts c
left join srcs sr on sr.reason = c.reason;

create unique index mv_gate_counts_reason_idx on core.mv_gate_counts (reason);

revoke all on core.mv_gate_counts from public, anon, authenticated;

create or replace view api.gate_counts as
select reason, home_count, source_ids
from core.mv_gate_counts;

revoke all on api.gate_counts from public, anon, authenticated;
grant select on api.gate_counts to service_role;

comment on view api.gate_counts is
    'Gate funnel: home count per reason, from core.mv_gate_counts. reason '
    'is one of: territory_not_base_served, outside_county (parcel on the '
    'TCAD roll but located across the county line), territories_not_loaded '
    '/ crosswalk_not_loaded, or passed.';
