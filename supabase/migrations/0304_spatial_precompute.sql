-- 0304_spatial_precompute.sql — M3-P6, BUILD half (DDL only, no data).
--
-- Course correction (coordinator, after the first draft of this ticket):
-- 0303_utility_gate_counts.sql / 0303b_utility_gate_counts_swap.sql
-- (elsewhere, uncommitted, never applied) build core.mv_home_signals_v2
-- with LIVE ST_Within against core.territories (full-size, un-subdivided)
-- and only core.flood_zones_sub for flood — that build is itself the
-- 25-35+ minute step that already hit OOM/disk-full on 2026-09-26. This
-- migration pair does NOT depend on 0303/0303b ever being applied, and
-- the apply path in checks/M3-P6.md never runs 0303's heavy build at
-- all: this file creates core.flood_zones_sub, core.territories_sub, and
-- core.home_spatial from scratch, DDL-only; 0304b then builds
-- core.mv_home_signals directly from the CURRENT live schema (the
-- pre-0303 mv_home_signals, verified via pg_catalog against the live DB
-- during this session — no territory_basis column yet, six *_pctile
-- columns already exist from 0212, core.mv_gate_counts has no
-- county_fips) as pure ID joins onto core.home_spatial, carrying every
-- semantic 0303/0303b intended (territory_basis, county-aware gate
-- counts, mv_home_terms, mv_home_geo_rollup, api.loaded_counties,
-- mv_county_territories) without ever doing the live geometry build.
--
-- Why subdivide at all (measured, tickets/M3/M3-P6.md): FEMA flood
-- point-in-polygon against raw (unsubdivided) polygons projects to
-- ~15 min for 1.2M homes, ~10x faster after ST_Subdivide (identical hit
-- counts). Territory point-in-polygon gained only 1.6x from subdividing
-- (HIFLD polygons overlap so heavily every home matches several
-- anyway), but every spatial answer (block group, flood, territory
-- candidates) is a static fact of (parcel geometry, boundary file
-- version) that need not be recomputed on every scoring refresh (lesson
-- 3). This migration adds:
--   * core.flood_zones_sub / core.territories_sub — subdivided copies.
--   * core.home_spatial — one row per parcel with a geometry, holding the
--     block group, flood, and territory answers precomputed once, keyed
--     by an input_hash of the source rows that produced them so a rerun
--     with no upstream change touches zero rows (lesson 3, acceptance
--     "Incremental").
-- No swap here; core.mv_home_signals is NOT touched by this file — see
-- 0304b. This file is DDL-only: population is
-- pipelines/sources/home_spatial.py, run per county, each county its own
-- committed step (lesson 4 — a giant single-transaction build multiplies
-- retry cost).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- core.flood_zones_sub — ST_Subdivide(geom, 256) so the GiST index
-- returns tight, specific candidates instead of one sprawling
-- multipolygon per flood zone (measured: 3.71s raw vs 0.37s subdivided
-- over 5,000 homes, identical hit counts, ~10x).
-- ---------------------------------------------------------------------------
create table core.flood_zones_sub as
select id, county_fips, fld_zone, source_id, created_at,
       extensions.ST_Subdivide(geom, 256) as geom
from core.flood_zones;

create index flood_zones_sub_geom_idx on core.flood_zones_sub using gist (geom);

analyze core.flood_zones_sub;

-- ---------------------------------------------------------------------------
-- core.territories_sub — same technique. Measured gain on territories
-- was only 1.6x (HIFLD service areas overlap for every Harris/Williamson
-- home regardless), but it is still real and the table costs little to
-- keep — home_spatial's territory_candidates array is built from this
-- table, not from core.territories directly.
-- ---------------------------------------------------------------------------
create table core.territories_sub as
select eia_id, name, state, source_id, created_at,
       extensions.ST_Subdivide(geom, 256) as geom
from core.territories;

create index territories_sub_geom_idx on core.territories_sub using gist (geom);

analyze core.territories_sub;

-- ---------------------------------------------------------------------------
-- core.home_spatial — one row per parcel with a geometry. Populated and
-- kept current by pipelines/sources/home_spatial.py, never by a view: a
-- home's block group / flood-zone membership / territory candidates
-- depend only on (parcel geometry, boundary file version), both of which
-- change far less often than a scoring refresh runs.
--
-- input_hash: md5 of every source_id that fed this row (parcel geom,
-- block-group boundary, flood boundary, territory boundary, crosswalk),
-- concatenated in a fixed order. The loader recomputes a home's row only
-- when this hash changes vs. the stored one — a full boundary-file
-- re-load changes every row's hash (since every home shares that
-- boundary's source_id); an unrelated county's parcel refresh does not
-- touch this county's rows at all.
-- ---------------------------------------------------------------------------
create table core.home_spatial (
    prop_id                 text primary key references core.parcels (prop_id),
    county_fips             text not null,
    pt                      extensions.geometry(point, 4326),
    block_group_geoid       text,
    bg_source_id            uuid,
    in_sfha                 boolean,
    flood_source_id         uuid,
    flood_null_reason       text,
    territory_candidates    text[] not null default array[]::text[],
    resolved_territory_eia_id text,
    territory_source_id     uuid,
    territory_basis         text,          -- 'service_area_polygon' | 'most_likely_county_utility' | null
    territory_null_reason   text,
    -- Precomputed gate outcome for the territory signal (same rule 0303
    -- encoded per-refresh: null when the resolved utility is Base-served
    -- per core.utility_crosswalk.mapped='yes', else
    -- 'territory_not_base_served'; also null, with territory_null_reason
    -- set instead, for a withheld county like Williamson). Storing it
    -- here means mv_home_signals never re-evaluates the crosswalk join.
    territory_gate_reason   text,
    crosswalk_source_id     uuid,
    parcel_source_id        uuid,
    geom_source_id          uuid,
    boundary_source_ids     uuid[] not null default array[]::uuid[],
    input_hash              text not null,
    computed_at             timestamptz not null default now()
);

create index home_spatial_county_idx on core.home_spatial (county_fips);
create index home_spatial_bg_idx on core.home_spatial (block_group_geoid);
create index home_spatial_territory_idx on core.home_spatial (resolved_territory_eia_id);
-- GiST kept only for ad-hoc/debug spatial queries against the cached
-- points; the hot scoring path never does a spatial predicate against
-- this table again (that is the entire point of caching).
create index home_spatial_pt_gix on core.home_spatial using gist (pt);

grant select on core.flood_zones_sub, core.territories_sub, core.home_spatial to zeus_web_ro;
