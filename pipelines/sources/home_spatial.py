"""M3-P6 spatial precompute: core.home_spatial loader.

Not a new raw source — no ops.source_manifest row is created here. This
module derives block-group / flood-zone / utility-territory answers for
every parcel from tables that are already loaded and already carry their
own source_id (core.parcels, core.parcel_geoms, core.block_groups,
core.flood_zones_sub, core.territories_sub, core.utility_crosswalk, and
now core.electric_ccn / core.electric_ccn_crosswalk). Real data in, real
data out: every home_spatial row's boundary_source_ids traces straight
back to those tables' own source_ids (real-data rule 1 — nothing
invented, no new provenance is fabricated, only threaded through).

Why this exists (tickets/M3/M3-P6.md, measured on Supabase Small):
raw-polygon flood point-in-polygon over 1.2M homes projects to ~15 min;
after ST_Subdivide(geom, 256) (core.flood_zones_sub / core.territories_sub,
supabase/migrations/0304_spatial_precompute.sql), ~1.5 min. Recomputing
that on every scoring refresh is wasted work: a home's spatial answer
depends only on (parcel geometry, boundary-file version), both far more
stable than a scoring refresh's cadence. This loader computes each
answer ONCE per (home, boundary-file version) into core.home_spatial;
core.mv_home_signals (0304b) then joins onto it by prop_id, doing zero
geometry work per refresh.

BLOCK-GROUP / FLOOD SECTIONS (`bg_match`, `county_flood_loaded`,
`flood_match`): owned by another concurrent agent's ticket, UNCHANGED
here byte-for-byte from the shared draft. Do not touch those CTEs in
this file — this module's diff is confined to the TERRITORY section
below (per coordinator instruction, prep task follow-up).

Territory resolution (user decisions confirmed via chat, this session):
  * Harris (48201): UNCHANGED — pinned to CenterPoint (eia_id '8901'),
    territory_basis='most_likely_county_utility', if 8901 exists in both
    core.territories and core.utility_crosswalk (fail-open: falls back
    to the real ST_Within/HIFLD match otherwise — never fabricates a
    match).
  * Williamson (48491) AND Travis (48453): resolved via PUCT's electric
    CCN boundaries (core.electric_ccn, supabase/migrations/0305_puct_ccn.sql)
    instead of the coarse HIFLD core.territories_sub polygons that made
    Williamson unresolvable (every home matched 5 overlapping utilities)
    and disagreed with reality for ~13% of Travis homes near boundaries
    (see the puct-ccn validation report). Pick rule ("agree-or-
    unconfirmed", confirmed by the user this session):
      - 0 CCN holders match the home's point: null,
        territory_null_reason='no_ccn_match'.
      - Exactly 1 CCN holder, and it has a known Base-served status
        (core.electric_ccn_crosswalk -> core.utility_crosswalk.mapped):
        resolve to that eia_id, territory_basis='puct_ccn'.
      - Exactly 1 CCN holder, but that holder has NO
        core.electric_ccn_crosswalk row (its Base-served status is
        genuinely unknown, not just "no" — e.g. a co-op/muni this
        session never verified against a real eia_utility_number):
        null, territory_null_reason='ccn_holder_unmapped'. Distinct from
        'multiply_certificated' — this is a mapping gap, not a boundary
        disagreement, and "missing means empty" (CLAUDE.md) means this
        session refuses to guess at Base-served status for an unverified
        holder.
      - More than one distinct CCN holder (multiply-certificated, real
        for ~5% of homes in these two counties — small border towns
        like Jarrell/Bartlett/Elgin where a co-op and a municipal/IOU
        utility legitimately overlap): resolve ONLY if every holder's
        Base-served status agrees (all known-yes or all known-no) —
        pick any one such holder's eia_id (interchangeable for the
        gate), territory_basis='puct_ccn'. If holders DISAGREE, OR any
        holder's status is unknown, keep null,
        territory_null_reason='multiply_certificated' — ranked (still
        gated in, same as today's Williamson 'utility_not_confirmed'
        treatment) but never counted as confirmed-servable on a
        genuinely disputed or unverified boundary.
    Fail-open (same pattern as the two pre-existing "table not loaded"
    checks above): if core.electric_ccn or core.electric_ccn_crosswalk
    is empty (this migration/pipeline not yet applied), Williamson/
    Travis fall back to their EXACT PRE-THIS-SESSION behavior --
    Williamson withheld ('utility_not_confirmed'), Travis resolved via
    HIFLD/core.territories_sub ('service_area_polygon') -- so this
    module is safe to deploy before 0305/puct_ccn.py have run.
  * Every other county: UNCHANGED — the real ST_Within match against
    core.territories_sub, tie-broken toward a Base-mapped utility
    (core.utility_crosswalk.mapped='yes'), territory_basis=
    'service_area_polygon'.

territory_source_id / crosswalk_source_id are REUSED (not renamed --
no home_spatial schema change needed) to carry whichever boundary
actually resolved the row: a core.territories_sub.source_id (HIFLD) for
every non-CCN county, or a core.electric_ccn.source_id / the crosswalk
row's own source_id for a CCN-resolved Williamson/Travis home. Both
already flow into boundary_source_ids and input_hash below, so a CCN
reload (new source_id on core.electric_ccn or on the
core.electric_ccn_crosswalk seed) changes those homes' input_hash and
they get recomputed on the next run -- this was verified by inspection
of the hash formula, not assumed (see module bottom / test file for the
column-level reasoning).

pipelines/sources/territory_overrides.py (Austin Energy's own, more
accurate service-area polygon, overriding core.territories.geom for
eia_id='1015') is UNCHANGED by this session and still adds real value:
(a) it is exactly what core.territories_sub's `tm` match uses in the
Williamson/Travis CCN-fail-open branch above, so those two counties
still benefit from the corrected Austin Energy polygon if core.electric_ccn
is ever temporarily empty; and (b) any future county (e.g. Hays, Bastrop)
that overlaps Austin Energy's HIFLD polygon and is NOT yet covered by a
CCN-based branch still resolves through core.territories_sub, so the
override keeps mattering there. It does NOT affect the new CCN branch
itself (core.electric_ccn is an entirely separate table from
core.territories/core.territories_sub).

Georgetown Utility Systems (a MUNI CCN holder covering part of
Williamson/Travis): confirmed NOT Base-served either way this session --
Base's own served-utility list (data/raw/base_service_areas/pricing.md)
does not mention Georgetown at all, and core.utility_crosswalk's
existing 'City of Georgetown' row (eia_id 7129) is already mapped='no'.
The crosswalk seed (0305_puct_ccn.sql) maps 'Georgetown Utility Systems'
to that same eia_id 7129 by NAME MATCH ONLY (not independently confirmed
against a PUCT CCN-number cross-check) -- but since the answer
('not Base-served') is identical whether or not that specific name match
is exactly right, the assumption carries no risk to any home's gate
outcome, only to which non-Base eia_id a resolved-but-not-served
Georgetown-area home shows.

Incremental (lesson 3 / acceptance "Incremental"): each row's
input_hash is md5() of every source_id that fed it (parcel geometry,
block-group boundary, flood boundary, territory/CCN boundary,
crosswalk), in a fixed order. A batch's upsert only writes rows whose
input_hash changed — a re-run with no upstream source change writes
zero rows.

Bulk load (lesson 9): COPY into a session-temp staging table, one
upsert per batch, per-county, each batch its own commit (lesson 4 — a
one-transaction build multiplies retry cost on failure).

Session tuning for the one-time, per-county heavy build (spec's
"Session settings for heavy steps"): work_mem 64MB, maintenance_work_mem
256MB, max_parallel_workers_per_gather 0, statement_timeout 0. Set once
per connection, never globally.

CLI-only: `python -m pipelines.run home_spatial --county 48201`. Too
large for a single Vercel Function call; the caller chunks by prop_id
range (BATCH_SIZE below) and this module resumes via ops.pipeline_runs's
cursor exactly like pipelines/sources/parcels.py.
"""
from __future__ import annotations

from typing import Any, Literal

import psycopg

from pipelines.core import db, runs

SOURCE = "home_spatial"
BATCH_SIZE = 20_000
HARRIS_FIPS = "48201"
WILLIAMSON_FIPS = "48491"
TRAVIS_FIPS = "48453"
HARRIS_PIN_EIA_ID = "8901"

Runner = Literal["cron", "cli"]

# ---------------------------------------------------------------------------
# The one big per-batch query. Parameters: %(county_fips)s, %(after_prop_id)s
# (keyset pagination — prop_id is core.parcels' primary key), %(limit)s.
#
# pt: ST_PointOnSurface of the parcel polygon when core.parcel_geoms has
# one, else the stored centroid — ST_PointOnSurface is guaranteed to lie
# inside a (possibly concave) polygon, centroid is not; either is a real
# geometry derived from the real parcel boundary file, never invented.
#
# BLOCK-GROUP / FLOOD CTEs (bg_match, county_flood_loaded, flood_match)
# are UNCHANGED — owned by another agent's concurrent ticket. Everything
# from `territory_candidates` (HIFLD) onward, plus the new `ccn_*` CTEs
# and `resolution_mode`, is this session's territory-section change.
# ---------------------------------------------------------------------------
_BATCH_SQL = """
with batch as (
    select p.prop_id, p.county_fips, p.source_id as parcel_source_id
    from core.parcels p
    where p.county_fips = %(county_fips)s
      and p.prop_id > coalesce(%(after_prop_id)s::text, '')
    order by p.prop_id
    limit %(limit)s
),
geo as (
    select
        b.prop_id, b.county_fips, b.parcel_source_id,
        coalesce(extensions.ST_PointOnSurface(pg.geom), pg.centroid) as pt,
        pg.source_id as geom_source_id
    from batch b
    left join core.parcel_geoms pg on pg.prop_id = b.prop_id
),
bg_match as (
    -- Data-correctness fix (2026-09-26, cross-county block-group bug):
    -- the live version of this lateral join matched g.pt against EVERY
    -- county's block groups with no county scoping at all, so a parcel
    -- near a county line could silently pick up a NEIGHBORING county's
    -- GEOID via ST_Within (verified live: 42 Williamson/WCAD parcels
    -- matched a Travis 48453-prefixed block group, 110 Harris/HCAD
    -- parcels matched Fort Bend/Montgomery/Waller block groups, plus
    -- unverified Travis/TCAD crossings into Bastrop/Hays/Comal). HCAD
    -- and WCAD each appraise only their own county (pipelines/sources/
    -- hcad_parcels.py, wcad_parcels.py -- no documented cross-county
    -- roll for either), so any match outside g.county_fips for those
    -- counties is a real bug, not a real home -- fixed here by scoping
    -- the match to g.county_fips.
    --
    -- The ONE exception, kept exactly as-is: TCAD (Travis, 48453) is
    -- separately verified and DOCUMENTED to appraise some parcels whose
    -- real geometry sits inside Williamson (48491) -- see
    -- pipelines/sources/wcad_parcels.py's module docstring ("The 137
    -- TCAD-rolled parcels already sitting in Williamson... county
    -- assignment is geometry-based, not the parcel's own county_fips
    -- attribute", per 0102_m1_materialize.sql) and that module's own
    -- overlap-dedup logic built specifically around this fact. Every
    -- OTHER cross-county match this fix drops was never documented or
    -- verified anywhere in this repo, so per the real-data rule
    -- ("nothing invented") it is not assumed real -- those rows get a
    -- null block_group_geoid instead (missing means empty, never a
    -- force-assigned neighboring-county GEOID).
    select
        g.prop_id,
        bg.geoid as block_group_geoid,
        bg.source_id as bg_source_id,
        -- Follow-up fix (coordinator, same 2026-09-26 session): a home
        -- whose point only matches a NEIGHBORING county's block group
        -- (rejected by the scoping above) must still get an honest
        -- reason, not just a bare null -- distinguished here from a
        -- point that matches no block group at all in ANY county
        -- (a real coverage gap, e.g. core.block_groups missing rows).
        case
            when bg.geoid is not null then null
            when g.pt is null then 'no_parcel_point'
            when any_bg.geoid is not null then 'no_block_group_in_county'
            else 'point_outside_loaded_block_groups'
        end as block_group_null_reason
    from geo g
    left join lateral (
        select bg.geoid, bg.source_id
        from core.block_groups bg
        where g.pt is not null
          and extensions.ST_Within(g.pt, bg.geom)
          and (
              bg.county_fips = g.county_fips
              or (g.county_fips = %(travis_fips)s and bg.county_fips = %(williamson_fips)s)
          )
        limit 1
    ) bg on true
    left join lateral (
        select bg2.geoid
        from core.block_groups bg2
        where g.pt is not null and extensions.ST_Within(g.pt, bg2.geom)
        limit 1
    ) any_bg on true
),
county_flood_loaded as (
    select distinct bg.county_fips
    from core.block_groups bg
    where exists (
        select 1 from core.flood_zones_sub fz
        where fz.fld_zone ~ '^(A|V)' and extensions.ST_Intersects(fz.geom, bg.geom)
    )
),
flood_match as (
    select
        g.prop_id,
        case
            when (select count(*) from core.flood_zones) = 0 then null
            when not exists (select 1 from county_flood_loaded cfl where cfl.county_fips = g.county_fips) then null
            else fz.id is not null
        end as in_sfha,
        fz.source_id as flood_source_id,
        case
            when (select count(*) from core.flood_zones) = 0 then 'flood_zones_not_loaded'
            when not exists (select 1 from county_flood_loaded cfl where cfl.county_fips = g.county_fips) then 'flood_zones_not_loaded'
            else null
        end as flood_null_reason
    from geo g
    left join lateral (
        select f.id, f.source_id
        from core.flood_zones_sub f
        where g.pt is not null and f.fld_zone ~ '^(A|V)' and extensions.ST_Within(g.pt, f.geom)
        limit 1
    ) fz on true
),
-- =========================================================================
-- TERRITORY SECTION -- this session's change starts here.
-- =========================================================================

-- HIFLD candidates/match -- UNCHANGED, still needed for: Harris's pin
-- fallback, every non-CCN county's default resolution, and the
-- Williamson/Travis fail-open path if core.electric_ccn isn't loaded.
territory_candidates as (
    select
        g.prop_id,
        array_agg(distinct t.eia_id) as candidates
    from geo g
    join core.territories_sub t on g.pt is not null and extensions.ST_Within(g.pt, t.geom)
    group by g.prop_id
),
territory_match as (
    select distinct on (g.prop_id)
        g.prop_id,
        t.eia_id,
        t.source_id as territory_source_id,
        cw.mapped,
        cw.source_id as crosswalk_source_id
    from geo g
    join core.territories_sub t on g.pt is not null and extensions.ST_Within(g.pt, t.geom)
    left join core.utility_crosswalk cw on cw.eia_utility_number = t.eia_id
    order by g.prop_id, (cw.mapped = 'yes') desc nulls last, t.eia_id
),
harris_pin as (
    select t.eia_id, t.source_id as territory_source_id, cw.mapped, cw.source_id as crosswalk_source_id
    from core.territories t
    join core.utility_crosswalk cw on cw.eia_utility_number = t.eia_id
    where t.eia_id = %(harris_pin_eia_id)s
    limit 1
),

-- NEW: PUCT electric CCN candidates for Williamson/Travis only. One row
-- per (home, distinct CCN holder) it falls inside -- `distinct` because
-- a subdivided company polygon can contribute more than one piece under
-- the same point (that must count as ONE holder, not several).
ccn_holder_status as (
    select distinct
        g.prop_id,
        ecc.company_name,
        ecc.source_id as ccn_source_id,
        xw.eia_utility_number,
        xw.crosswalk_source_id,
        coalesce(cw.mapped, 'unknown') as status  -- 'yes' | 'no' | 'unknown' (holder not in core.electric_ccn_crosswalk yet)
    from geo g
    join core.electric_ccn ecc
        on g.county_fips in (%(williamson_fips)s, %(travis_fips)s)
       and g.pt is not null
       and extensions.ST_Within(g.pt, ecc.geom)
    left join core.electric_ccn_crosswalk xw on xw.ccn_company_name = ecc.company_name
    left join core.utility_crosswalk cw on cw.eia_utility_number = xw.eia_utility_number
),
ccn_status_agg as (
    select prop_id, array_agg(distinct status) as statuses, count(distinct company_name) as n_holders
    from ccn_holder_status
    group by prop_id
),
ccn_pick as (
    -- One representative resolvable row per prop_id. Only ever consulted
    -- when ccn_resolved decides the group is unanimous ('yes'-only or
    -- 'no'-only), so which specific agreeing holder gets picked doesn't
    -- change the outcome -- this just needs to be deterministic.
    select distinct on (chs.prop_id)
        chs.prop_id, chs.eia_utility_number as eia_id, chs.ccn_source_id,
        chs.crosswalk_source_id, chs.status
    from ccn_holder_status chs
    where chs.status in ('yes', 'no')
    order by chs.prop_id, (chs.status = 'yes') desc, chs.company_name
),
ccn_candidates as (
    select prop_id, array_agg(distinct eia_utility_number) as candidates
    from ccn_holder_status
    where eia_utility_number is not null
    group by prop_id
),
ccn_resolved as (
    select
        sa.prop_id,
        case when cardinality(sa.statuses) = 1 and sa.statuses[1] in ('yes', 'no')
             then cp.eia_id else null end as eia_id,
        case when cardinality(sa.statuses) = 1 and sa.statuses[1] in ('yes', 'no')
             then cp.ccn_source_id else null end as ccn_source_id,
        case when cardinality(sa.statuses) = 1 and sa.statuses[1] in ('yes', 'no')
             then cp.crosswalk_source_id else null end as crosswalk_source_id,
        case when cardinality(sa.statuses) = 1 and sa.statuses[1] in ('yes', 'no')
             then 'puct_ccn' else null end as basis,
        case
            when cardinality(sa.statuses) = 1 and sa.statuses[1] in ('yes', 'no') then null
            when sa.n_holders = 1 and sa.statuses[1] = 'unknown' then 'ccn_holder_unmapped'
            else 'multiply_certificated'
        end as null_reason,
        case
            when cardinality(sa.statuses) = 1 and sa.statuses[1] = 'yes' then null
            when cardinality(sa.statuses) = 1 and sa.statuses[1] = 'no' then 'territory_not_base_served'
            else null
        end as gate_reason
    from ccn_status_agg sa
    left join ccn_pick cp on cp.prop_id = sa.prop_id
),

-- One resolution "mode" per home, computed once and reused across every
-- output column below (reduces the risk of the 6 case-blocks drifting
-- out of sync with each other, versus repeating every condition 6x).
resolution_mode as (
    select
        g.prop_id,
        g.county_fips,
        case
            when (select count(*) from core.territories) = 0 then 'fail_open_no_territories'
            when (select count(*) from core.utility_crosswalk) = 0 then 'fail_open_no_crosswalk'
            when g.county_fips = %(harris_fips)s then 'harris_pin'
            -- A home with no point (68,448 in Travis today) was never
            -- tested against ANY polygon, HIFLD or CCN -- routing it
            -- through 'ccn_counties' would wrongly label it
            -- 'no_ccn_match' (a real answer: 0 CCN holders matched) when
            -- the truth is "not tested at all". 'default_hifld' with
            -- g.pt null reproduces the EXACT pre-existing behavior for
            -- these rows (tm.eia_id is null when pt is null, giving the
            -- same gate_reason='territory_not_base_served',
            -- null_reason=null, basis=null this session found live in
            -- core.home_spatial before touching anything).
            when g.county_fips in (%(williamson_fips)s, %(travis_fips)s) and g.pt is null
                then 'default_hifld'
            when g.county_fips in (%(williamson_fips)s, %(travis_fips)s)
                 and ((select count(*) from core.electric_ccn) = 0
                      or (select count(*) from core.electric_ccn_crosswalk) = 0)
                then 'ccn_counties_fail_open'
            when g.county_fips in (%(williamson_fips)s, %(travis_fips)s) then 'ccn_counties'
            else 'default_hifld'
        end as mode
    from geo g
),
resolved as (
    select
        g.prop_id, g.county_fips, g.parcel_source_id, g.geom_source_id, g.pt,
        rm.mode,
        case rm.mode
            when 'fail_open_no_territories' then tm.eia_id
            when 'fail_open_no_crosswalk' then tm.eia_id
            when 'harris_pin' then coalesce(hp.eia_id, tm.eia_id)
            when 'ccn_counties_fail_open' then
                case when g.county_fips = %(williamson_fips)s then null else tm.eia_id end
            when 'ccn_counties' then cr.eia_id
            else tm.eia_id
        end as resolved_territory_eia_id,
        case rm.mode
            when 'fail_open_no_territories' then tm.territory_source_id
            when 'fail_open_no_crosswalk' then tm.territory_source_id
            when 'harris_pin' then coalesce(hp.territory_source_id, tm.territory_source_id)
            when 'ccn_counties_fail_open' then
                case when g.county_fips = %(williamson_fips)s then null else tm.territory_source_id end
            when 'ccn_counties' then cr.ccn_source_id
            else tm.territory_source_id
        end as territory_source_id,
        case rm.mode
            when 'fail_open_no_territories' then null
            when 'fail_open_no_crosswalk' then null
            when 'harris_pin' then
                case when hp.eia_id is not null then 'most_likely_county_utility'
                     when tm.eia_id is not null then 'service_area_polygon'
                     else null end
            when 'ccn_counties_fail_open' then
                case when g.county_fips = %(williamson_fips)s then null
                     when tm.eia_id is not null then 'service_area_polygon'
                     else null end
            when 'ccn_counties' then cr.basis
            else case when tm.eia_id is not null then 'service_area_polygon' else null end
        end as territory_basis,
        case rm.mode
            when 'fail_open_no_territories' then 'territories_not_loaded'
            when 'fail_open_no_crosswalk' then 'crosswalk_not_loaded'
            when 'harris_pin' then null
            when 'ccn_counties_fail_open' then
                case when g.county_fips = %(williamson_fips)s then 'utility_not_confirmed' else null end
            -- A resolved home has no null reason. The earlier
            -- coalesce(cr.null_reason, 'no_ccn_match') stamped 'no_ccn_match'
            -- on every resolved Travis/Williamson home too, which bucketed
            -- them out of api.loaded_counties and took both counties off
            -- the site on 2026-09-26.
            when 'ccn_counties' then
                case when cr.eia_id is not null then null
                     else coalesce(cr.null_reason, 'no_ccn_match') end
            else null
        end as territory_null_reason,
        case rm.mode
            when 'fail_open_no_territories' then null
            when 'fail_open_no_crosswalk' then null
            when 'harris_pin' then
                case when hp.eia_id is not null then null
                     when tm.eia_id is null then 'territory_not_base_served'
                     when tm.mapped is distinct from 'yes' then 'territory_not_base_served'
                     else null end
            when 'ccn_counties_fail_open' then
                case when g.county_fips = %(williamson_fips)s then null
                     when tm.eia_id is null then 'territory_not_base_served'
                     when tm.mapped is distinct from 'yes' then 'territory_not_base_served'
                     else null end
            when 'ccn_counties' then cr.gate_reason
            else
                case when tm.eia_id is null then 'territory_not_base_served'
                     when tm.mapped is distinct from 'yes' then 'territory_not_base_served'
                     else null end
        end as territory_gate_reason,
        case rm.mode
            when 'fail_open_no_territories' then tm.crosswalk_source_id
            when 'fail_open_no_crosswalk' then tm.crosswalk_source_id
            when 'harris_pin' then coalesce(hp.crosswalk_source_id, tm.crosswalk_source_id)
            when 'ccn_counties_fail_open' then
                case when g.county_fips = %(williamson_fips)s then null else tm.crosswalk_source_id end
            when 'ccn_counties' then cr.crosswalk_source_id
            else tm.crosswalk_source_id
        end as crosswalk_source_id
    from geo g
    join resolution_mode rm on rm.prop_id = g.prop_id
    left join territory_match tm on tm.prop_id = g.prop_id
    left join harris_pin hp on g.county_fips = %(harris_fips)s
    left join ccn_resolved cr on cr.prop_id = g.prop_id
)
-- =========================================================================
-- End of territory section.
-- =========================================================================
select
    r.prop_id,
    r.county_fips,
    r.pt,
    bm.block_group_geoid,
    bm.bg_source_id,
    bm.block_group_null_reason,
    fm.in_sfha,
    fm.flood_source_id,
    fm.flood_null_reason,
    case when r.mode = 'ccn_counties' then coalesce(cc.candidates, array[]::text[])
         else coalesce(tc.candidates, array[]::text[])
    end as territory_candidates,
    r.resolved_territory_eia_id,
    r.territory_source_id,
    r.territory_basis,
    r.territory_null_reason,
    r.territory_gate_reason,
    r.crosswalk_source_id,
    r.parcel_source_id,
    r.geom_source_id,
    array(
        select distinct s.s
        from unnest(array[
            r.parcel_source_id, r.geom_source_id, bm.bg_source_id,
            r.territory_source_id, r.crosswalk_source_id, fm.flood_source_id
        ]) s(s)
        where s.s is not null
    ) as boundary_source_ids,
    md5(
        coalesce(r.parcel_source_id::text, '') || '|' ||
        coalesce(r.geom_source_id::text, '') || '|' ||
        coalesce(bm.bg_source_id::text, '') || '|' ||
        coalesce(r.territory_source_id::text, '') || '|' ||
        coalesce(r.crosswalk_source_id::text, '') || '|' ||
        coalesce(fm.flood_source_id::text, '') || '|' ||
        coalesce(r.resolved_territory_eia_id, '') || '|' ||
        coalesce(r.territory_basis, '') || '|' ||
        coalesce(bm.block_group_null_reason, '') ||
        -- Appends '|' + territory_null_reason ONLY when it's non-null
        -- (concatenation with NULL yields NULL, so the outer coalesce
        -- falls through to '' instead) -- keeps the hash BYTE-IDENTICAL
        -- for every row whose null_reason is null (Harris always; every
        -- other already-loaded county too), so this addition does not
        -- force a global rewrite. It only changes the hash for
        -- Williamson/Travis rows that now carry a null_reason
        -- ('no_ccn_match' / 'ccn_holder_unmapped' / 'multiply_certificated'
        -- / 'utility_not_confirmed'), which is exactly the point.
        coalesce('|' || r.territory_null_reason, '')
    ) as input_hash
from resolved r
left join bg_match bm on bm.prop_id = r.prop_id
left join flood_match fm on fm.prop_id = r.prop_id
left join territory_candidates tc on tc.prop_id = r.prop_id
left join ccn_candidates cc on cc.prop_id = r.prop_id
order by r.prop_id
"""

_STAGE_COLUMNS = (
    "prop_id", "county_fips", "pt", "block_group_geoid", "bg_source_id",
    "block_group_null_reason",
    "in_sfha", "flood_source_id", "flood_null_reason", "territory_candidates",
    "resolved_territory_eia_id", "territory_source_id", "territory_basis",
    "territory_null_reason", "territory_gate_reason", "crosswalk_source_id",
    "parcel_source_id", "geom_source_id", "boundary_source_ids", "input_hash",
)


def _ensure_staging_table(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            create temporary table if not exists home_spatial_stage (
                prop_id text, county_fips text, pt extensions.geometry(point, 4326),
                block_group_geoid text, bg_source_id uuid, block_group_null_reason text,
                in_sfha boolean, flood_source_id uuid, flood_null_reason text,
                territory_candidates text[], resolved_territory_eia_id text,
                territory_source_id uuid, territory_basis text,
                territory_null_reason text, territory_gate_reason text,
                crosswalk_source_id uuid, parcel_source_id uuid,
                geom_source_id uuid, boundary_source_ids uuid[], input_hash text
            ) on commit preserve rows
            """
        )
    conn.commit()


def _set_session_tuning(conn: psycopg.Connection) -> None:
    """Per-connection only (never a global ALTER ROLE/DATABASE) — lesson
    10: work_mem decides whether the batch's sorts/hashes stay in memory
    instead of spilling to the same disk data lives on."""
    with conn.cursor() as cur:
        cur.execute("set work_mem = '64MB'")
        cur.execute("set maintenance_work_mem = '256MB'")
        cur.execute("set max_parallel_workers_per_gather = 0")
        cur.execute("set statement_timeout = 0")
    conn.commit()


def new_state(county_fips: str) -> dict[str, Any]:
    return {"county_fips": county_fips, "after_prop_id": None, "rows_seen": 0, "rows_written": 0}


def _run_batch(conn: psycopg.Connection, *, county_fips: str, after_prop_id: str | None, limit: int) -> tuple[int, int, str | None]:
    """Compute one batch into the staging table, then upsert into
    core.home_spatial WHERE input_hash differs (lesson 3: a rerun with no
    upstream change writes zero rows). Returns
    (rows_computed, rows_written, last_prop_id_in_batch)."""
    with conn.cursor() as cur:
        cur.execute("truncate home_spatial_stage")
        cur.execute(
            f"insert into home_spatial_stage ({', '.join(_STAGE_COLUMNS)}) {_BATCH_SQL}",
            {
                "county_fips": county_fips,
                "after_prop_id": after_prop_id,
                "limit": limit,
                "harris_fips": HARRIS_FIPS,
                "williamson_fips": WILLIAMSON_FIPS,
                "travis_fips": TRAVIS_FIPS,
                "harris_pin_eia_id": HARRIS_PIN_EIA_ID,
            },
        )
        rows_computed = cur.rowcount

        cur.execute("select max(prop_id) from home_spatial_stage")
        last_prop_id = cur.fetchone()[0]
        if last_prop_id is None:
            return 0, 0, None

        cur.execute(
            f"""
            insert into core.home_spatial ({', '.join(_STAGE_COLUMNS)}, computed_at)
            select {', '.join(_STAGE_COLUMNS)}, now() from home_spatial_stage
            on conflict (prop_id) do update set
                county_fips = excluded.county_fips,
                pt = excluded.pt,
                block_group_geoid = excluded.block_group_geoid,
                bg_source_id = excluded.bg_source_id,
                block_group_null_reason = excluded.block_group_null_reason,
                in_sfha = excluded.in_sfha,
                flood_source_id = excluded.flood_source_id,
                flood_null_reason = excluded.flood_null_reason,
                territory_candidates = excluded.territory_candidates,
                resolved_territory_eia_id = excluded.resolved_territory_eia_id,
                territory_source_id = excluded.territory_source_id,
                territory_basis = excluded.territory_basis,
                territory_null_reason = excluded.territory_null_reason,
                territory_gate_reason = excluded.territory_gate_reason,
                crosswalk_source_id = excluded.crosswalk_source_id,
                parcel_source_id = excluded.parcel_source_id,
                geom_source_id = excluded.geom_source_id,
                boundary_source_ids = excluded.boundary_source_ids,
                input_hash = excluded.input_hash,
                computed_at = excluded.computed_at
            where core.home_spatial.input_hash is distinct from excluded.input_hash
            """
        )
        rows_written = cur.rowcount
    conn.commit()
    return rows_computed, rows_written, last_prop_id


def _loaded_counties() -> list[str]:
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute("select distinct county_fips from core.parcels order by county_fips")
            return [row[0] for row in cur.fetchall()]


def run(*, runner: Runner, backfill: bool = False, cursor: dict[str, Any] | None = None) -> dict[str, Any]:
    """Registry contract entrypoint (pipelines/pipelines/core/registry.py):
    `python -m pipelines.run home_spatial [--backfill]` and the cron route
    both call this exact signature, with no county argument. Runs every
    county already present in core.parcels, one at a time, each its own
    committed batch sequence (lesson 4) — so a failure partway through
    only redoes the county in flight, and a bare re-run with no upstream
    change (any county) touches zero rows. Use `run_county()` directly
    for a single-county CLI/test invocation."""
    counties = cursor.get("counties") if cursor else None
    if counties is None:
        counties = _loaded_counties()
    results: dict[str, Any] = {"counties": {}}
    start_index = 0
    if cursor and cursor.get("county_index") is not None:
        start_index = cursor["county_index"]
    for i, county_fips in enumerate(counties):
        if i < start_index:
            continue
        county_cursor = cursor.get("county_cursor") if (cursor and i == start_index) else None
        results["counties"][county_fips] = run_county(
            county_fips=county_fips, runner=runner, backfill=backfill, cursor=county_cursor,
        )
    return results


def run_county(*, county_fips: str, runner: Runner, backfill: bool = False, cursor: dict[str, Any] | None = None) -> dict[str, Any]:
    """Populate/refresh core.home_spatial for one county, one committed
    batch at a time (lesson 4). `backfill=True` resumes the latest
    non-success run for this county's cursor, matching
    pipelines/sources/parcels.py's pattern."""
    state = cursor
    if state is None and backfill:
        state = _find_resumable_cursor(county_fips)
    if state is None:
        state = new_state(county_fips)

    with db.connect(pooled=False) as conn:
        _set_session_tuning(conn)
        _ensure_staging_table(conn)
        run_id = runs.start(conn, source=SOURCE, runner=runner, cursor=state)

        def checkpoint() -> None:
            runs.finish(
                conn, run_id, status="running",
                rows_in=state["rows_seen"], rows_loaded=state["rows_written"],
                filter_drops={}, cursor=state,
            )
            conn.commit()

        try:
            while True:
                rows_computed, rows_written, last_prop_id = _run_batch(
                    conn, county_fips=state["county_fips"],
                    after_prop_id=state["after_prop_id"], limit=BATCH_SIZE,
                )
                state["rows_seen"] += rows_computed
                state["rows_written"] += rows_written
                if last_prop_id is not None:
                    state["after_prop_id"] = last_prop_id
                checkpoint()
                if rows_computed < BATCH_SIZE:
                    break
            runs.finish(
                conn, run_id, status="success",
                rows_in=state["rows_seen"], rows_loaded=state["rows_written"],
                filter_drops={}, cursor=state,
            )
        except Exception as exc:
            conn.rollback()
            runs.finish(conn, run_id, status="failed", error=str(exc), cursor=state)
            raise
    return state


def _find_resumable_cursor(county_fips: str) -> dict[str, Any] | None:
    with db.connect(pooled=False) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select cursor from ops.pipeline_runs
                where source = %s and status != 'success'
                  and cursor ->> 'county_fips' = %s
                order by started_at desc
                limit 1
                """,
                (SOURCE, county_fips),
            )
            row = cur.fetchone()
    return row[0] if row else None
