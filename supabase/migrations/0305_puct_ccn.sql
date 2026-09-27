-- 0305_puct_ccn.sql — PUCT electric CCN boundaries + re-resolution plan.
--
-- DRAFT. Written but NEVER applied against Supabase in this prep task
-- (hard rule: no DB writes, no apply_sql.py, no pipeline runs that
-- write). This file is the proposal; a human confirms the pick rule
-- below before any agent runs it or pipelines/sources/puct_ccn.py.
--
-- Why: core.home_spatial.resolved_territory_eia_id is NULL for every
-- one of Williamson County's (48491) 158,475 homes today, with
-- territory_null_reason = 'utility_not_confirmed' -- an explicit
-- decision (0303_utility_gate_counts.sql, confirmed live against
-- core.home_spatial in this prep task) to withhold the county rather
-- than pick an arbitrary tiebreak among core.territories_sub's (HIFLD)
-- five overlapping polygons there (Oncor, Pedernales, Bluebonnet,
-- Bartlett Electric Coop, City of Bartlett). Travis (48453) already
-- resolves via core.territories_sub for 82% of homes (mostly Austin
-- Energy 1015 / Pedernales 14626 / Oncor 44372), but 68,448 Travis
-- homes (15%) fall inside NO territories_sub polygon at all --
-- 'no_territory_match' -- and near boundaries the HIFLD polygon is
-- already known to disagree with reality (territory_overrides.py's
-- Austin Energy override is the precedent for correcting exactly this
-- kind of disagreement with a better public polygon).
--
-- What this migration adds:
--   1. core.electric_ccn — PUCT's IOU/MUNI/COOP_DIST CCN layers,
--      subdivided (ST_Subdivide(geom, 256), same technique/grid size as
--      core.territories_sub) so point-in-polygon stays fast at
--      home_spatial-rebuild scale. Filled by pipelines/sources/
--      puct_ccn.py (also written this session, never run).
--   2. core.electric_ccn_crosswalk — company_name -> eia_utility_number,
--      seeded ONLY with holders this session could verify against an
--      EXISTING, already-loaded core.utility_crosswalk /
--      core.territories row (queried live, read-only, in this prep
--      task -- see the validation report for the exact query). No
--      invented eia_utility_number is written for a holder this session
--      could not verify; those are listed below, unmapped, for a human
--      to confirm.
--   3. A documented (NOT applied) re-resolution CTE, in a comment at the
--      bottom of this file, that pipelines/sources/home_spatial.py's
--      `territory_match` CTE would need in place of its ST_Within
--      against core.territories_sub, gated to county_fips in
--      ('48491','48453') only -- every other county keeps its current
--      HIFLD-based resolution untouched.
--
-- Validation basis (read-only, against live core.home_spatial.pt +
-- core.parcels.situs_city, this prep task -- see the scratchpad
-- validation report for full output). NOTE (corrected after an advisor
-- review caught two bugs in the first pass -- see git history on this
-- file): the first run's sjoin(how="left") counted every UNMATCHED home
-- as "1 match", so it under-reported zero-match to 0%; the numbers
-- below are from the fixed script.
--   * core.home_spatial has 158,475 Williamson rows, ALL with a pt.
--     Travis has 441,961 rows but only 373,513 with a non-null pt --
--     68,448 Travis homes have NO point at all and cannot be tested
--     against ANY polygon source, HIFLD or CCN; that gap is a
--     home_spatial/geometry issue, not something this migration
--     addresses.
--   * Of the 531,988 homes WITH a point: 0.2% (1,324) fall outside
--     every PUCT CCN polygon (Williamson 0.6%/954, Travis 0.1%/370) --
--     small but nonzero, unlike this session's first (buggy) claim of
--     0%. 5.1% (27,288: Williamson 6.2%/9,754, Travis 4.7%/17,534) fall
--     inside MORE than one CCN polygon -- multiply-certificated areas
--     are real (small border towns: Jarrell 86%, Bartlett 99%, Elgin
--     70%) but far less pervasive than HIFLD's "every Williamson home
--     matches 5 utilities" problem.
--   * Applying the PICK RULE proposed below (in-memory only, never
--     written to the DB) to Williamson's 158,475 homes: 61,302 (38.7%)
--     would resolve Base-served (all Oncor), 88,506 (55.8%) would
--     resolve not-Base-served (PEC/Bluebonnet/coop), 7,713 (4.9%) stay
--     null as multiply_certificated (disagreeing holders), 954 (0.6%)
--     stay null as no_ccn_match. TODAY every one of these 158,475 homes
--     is null with territory_null_reason='utility_not_confirmed' -- the
--     rule would newly confirm Base-served status for 61,302 Williamson
--     homes that currently show as unconfirmed.
--   * Travis, same rule: 266,104 (71.2%) Base-served, 98,479 (26.4%)
--     not, 8,560 (2.3%) multiply_certificated, 370 (0.1%) no_ccn_match.
--   * Travis-only: comparing the EXISTING (already live)
--     resolved_territory_eia_id (from core.territories_sub/HIFLD)
--     against what the CCN layer alone would say: 323,118 homes agree,
--     but 50,025 homes (13.4% of the 373,513 with a point) DISAGREE --
--     HIFLD's polygon and PUCT's CCN polygon pick a different utility
--     for the same home. This is the same class of problem
--     territory_overrides.py's Austin Energy override already fixed
--     for one utility; CCN disagreement is broader and is exactly why
--     this migration proposes switching Travis's resolution basis too,
--     not just Williamson's.
--   * Leander: 100.0% (25,521/25,522) Pedernales Electric Cooperative
--     only -- confirms the user's claim.
--   * Round Rock: 90% Oncor only; Hutto: 100% Oncor only -- confirms the
--     user's claim (Oncor is Base-served, per data/raw/base_service_
--     areas/pricing.md).
--   * Georgetown: 45% Pedernales / 44% Georgetown Utility Systems (a
--     MUNI, matched by NAME to the existing 'City of Georgetown' row,
--     eia_id 7129, mapped='no' -- see the crosswalk seed comment below,
--     this specific match is NOT independently confirmed and is flagged
--     for the user) / 19% Oncor.
--   * Lakeway: 63% Pedernales / 38% Austin Energy; Bee Cave: 99% Austin
--     Energy -- confirms the user's PEC-vs-Austin-Energy claim near
--     Lakeway/Bee Cave.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- core.electric_ccn — PUCT IOU/MUNI/COOP_DIST certified electric service
-- area boundaries (subdivided). See data/raw/puct_ccn/NOTES.md: PUCT's
-- own layer description calls this data "UNOFFICIAL" (the legally
-- official record is a paper mylar map on file at PUCT Central Records);
-- this is nonetheless PUCT's own edited, publicly-hosted GIS proxy for
-- CCN boundaries and the only machine-readable one that exists. Any UI
-- surfacing a value derived from this table must carry that caveat, the
-- same way territory_null_reason surfaces 'utility_not_confirmed' today.
-- ---------------------------------------------------------------------------
create table if not exists core.electric_ccn (
    id              bigint generated always as identity primary key,
    company_name    text not null,        -- PUCT layer's COMPANY_NAME, verbatim
    company_type    text,                 -- PUCT layer's COMPANY_TYPE (often blank)
    ccn_no          text,                 -- PUCT layer's CCN_NO
    ccn_layer_type  text not null check (ccn_layer_type in ('IOU', 'MUNI', 'COOP_DIST')),
    geom            extensions.geometry(Geometry, 4326) not null,  -- subdivided piece, Polygon or MultiPolygon
    source_id       uuid not null references ops.source_manifest (id),
    created_at      timestamptz not null default now()
);

create index if not exists electric_ccn_geom_gix on core.electric_ccn using gist (geom);
create index if not exists electric_ccn_company_name_idx on core.electric_ccn (company_name);

comment on table core.electric_ccn is
    'PUCT-published, PUCT-edited "UNOFFICIAL" electric CCN service area '
    'boundaries (IOU/MUNI/COOP_DIST layers, ArcGIS Online, owner '
    'gis.user.puct / org PUCTX), subdivided (ST_Subdivide(geom, 256)) for '
    'fast point-in-polygon. See data/raw/puct_ccn/NOTES.md for the exact '
    'provenance and the "UNOFFICIAL" caveat, verbatim from PUCT''s own '
    'layer description. Filled by pipelines/sources/puct_ccn.py.';

alter table core.electric_ccn enable row level security;
revoke all on core.electric_ccn from public, anon, authenticated;
grant select on core.electric_ccn to zeus_web_ro;

-- ---------------------------------------------------------------------------
-- core.electric_ccn_crosswalk — CCN company_name -> EIA utility number,
-- so home_spatial's re-resolution CTE can join a CCN candidate straight
-- onto the EXISTING core.utility_crosswalk.mapped flag via
-- eia_utility_number, without re-deciding Base-served status here.
--
-- Seeded ONLY with holders this session verified, read-only, against an
-- eia_utility_number already present in core.utility_crosswalk /
-- core.territories (i.e. the number is not invented by this migration --
-- it is the SAME number those already-loaded, already-reviewed rows
-- carry). Every mapped=false row below is a real holder this data
-- covers but that is NOT on Base's served-utility list
-- (data/raw/base_service_areas/pricing.md).
-- ---------------------------------------------------------------------------
create table if not exists core.electric_ccn_crosswalk (
    ccn_company_name    text primary key,   -- core.electric_ccn.company_name, verbatim
    eia_utility_number  text,                -- null if genuinely unmapped (see below)
    crosswalk_source_id uuid references ops.source_manifest (id),
    note                 text,
    created_at           timestamptz not null default now()
);

comment on column core.electric_ccn_crosswalk.crosswalk_source_id is
    'The ops.source_manifest row of the core.utility_crosswalk/core.territories '
    'row this eia_utility_number was COPIED from (never invented here) -- '
    'traceability per CLAUDE.md''s real-data rule.';

alter table core.electric_ccn_crosswalk enable row level security;
revoke all on core.electric_ccn_crosswalk from public, anon, authenticated;
grant select on core.electric_ccn_crosswalk to zeus_web_ro;

-- Verified mappings: eia_utility_number confirmed live against
-- core.utility_crosswalk / core.territories in this prep task, and
-- crosswalk_source_id copied from THAT SAME already-loaded row (not a
-- new value invented by this migration) -- run this after
-- core.utility_crosswalk is loaded, in the same transaction as this
-- migration if possible, so the subselects below resolve.
insert into core.electric_ccn_crosswalk (ccn_company_name, eia_utility_number, crosswalk_source_id, note)
select v.ccn_company_name, v.eia_utility_number, cw.source_id, v.note
from (values
    ('Austin Energy',                           '1015',  'Base-served (core.utility_crosswalk.mapped=yes)'),
    ('Oncor Electric Delivery Company LLC',      '44372', 'Base-served (core.utility_crosswalk.mapped=yes)'),
    ('Pedernales Electric Cooperative, Inc.',    '14626', 'NOT Base-served (mapped=no)'),
    ('Bluebonnet Electric Cooperative, Inc.',    '1892',  'NOT Base-served (mapped=no)'),
    ('Bartlett Electric Cooperative, Inc.',      '1273',  'NOT Base-served (mapped=no)'),
    ('Bartlett City of',                         '1287',  'NOT Base-served (mapped=no); core.utility_crosswalk base_name=''City of Bartlett'''),
    ('Georgetown Utility Systems',               '7129',  'NOT Base-served (mapped=no); core.utility_crosswalk base_name=''City of Georgetown'' -- NAME MATCH ASSUMED (city-owned utility dept for the same city), not independently confirmed against a PUCT CCN-number cross-check -- flag for user'),
    ('CenterPoint Energy Houston Electric, LLC', '8901',  'Base-served (mapped=yes); Harris County only, not in Williamson/Travis validation scope')
) as v (ccn_company_name, eia_utility_number, note)
join core.utility_crosswalk cw on cw.eia_utility_number = v.eia_utility_number
on conflict (ccn_company_name) do nothing;

-- Holders present in the PUCT CCN layers (statewide, 146 distinct
-- COMPANY_NAME values across all 3 layers) that this session could NOT
-- verify against an existing eia_utility_number and is NOT inserting a
-- guess for -- flagged for the user to confirm:
--   * 'AEP Texas Inc.' -- Base's pricing.md lists 'AEP Texas Central' and
--     'AEP Texas North' as two separate served utilities, but the CCN
--     IOU layer has a single merged 'AEP Texas Inc.' (matches the real
--     2021 AEP Texas Central/North merger). core.utility_crosswalk
--     carries 'AEP Texas North' and 'AEP Texas Central' with
--     eia_utility_number = NULL, mapped='no' already -- this predates
--     this ticket and is a pre-existing crosswalk gap, not something
--     this migration should silently resolve by guessing which EIA
--     number(s) 'AEP Texas Inc.' corresponds to.
--   * 'CoServ Electric Cooperative, Inc.' -- Base's pricing.md lists
--     'CoServ' as served, but core.utility_crosswalk's 'CoServ' row
--     also already has eia_utility_number = NULL. Same pre-existing gap.
--   * 'Entergy Texas, Inc.', 'Southwestern Electric Power Company'
--     (SWEPCO), 'Southwestern Public Service Company', 'CPS Energy',
--     and the ~135 remaining municipal/cooperative holders elsewhere in
--     the state (outside Williamson/Travis, so outside this ticket's
--     validation scope) -- none are on Base's served-utility list and
--     none were checked against core.utility_crosswalk row-by-row here;
--     a future ticket adding counties beyond Williamson/Travis should
--     extend this crosswalk table then, the same width-not-depth rule
--     CLAUDE.md already states for datasets/counties.

-- ===========================================================================
-- Re-resolution: IMPLEMENTED (this session, following the user's chat
-- decisions) in pipelines/sources/home_spatial.py's territory section --
-- NOT applied to the DB (that file is a draft too; no DB writes this
-- session). Every other county's resolution (HIFLD territories_sub,
-- Harris's pin) is UNCHANGED -- see that file's module docstring for the
-- full behavior and its `resolution_mode` CTE for the exact logic.
--
-- USER DECISIONS (confirmed via chat, this session):
--   1. Pick rule = "agree-or-unconfirmed": resolve a multiply-
--      certificated home ONLY when every one of its CCN holders shares
--      the same Base-served status; otherwise territory stays NULL with
--      reason 'multiply_certificated' -- ranked (still gated in), not
--      counted as servable, same treatment as today's
--      'utility_not_confirmed'. A single unmapped holder (status
--      genuinely unknown, not "no") gets its OWN reason,
--      'ccn_holder_unmapped', distinct from a real multi-holder
--      disagreement.
--   2. Apply to BOTH Travis (48453) and Williamson (48491). Harris stays
--      pinned to CenterPoint ('most_likely_county_utility') as-is,
--      untouched.
--
-- territory_basis is 'puct_ccn' for every CCN-resolved home (single
-- holder or unanimous multi-holder alike) -- no separate
-- 'puct_ccn_unanimous' value (simplified from this migration's earlier
-- draft, per the user's literal instruction).
--
-- input_hash sensitivity (explicitly checked, not assumed): home_spatial.py
-- REUSES the existing territory_source_id / crosswalk_source_id output
-- columns to carry a CCN-resolved home's core.electric_ccn.source_id /
-- core.electric_ccn_crosswalk.crosswalk_source_id (no new home_spatial
-- column needed). Both columns already feed input_hash's md5() formula
-- (unchanged from the pre-existing formula), so a puct_ccn.py reload that
-- changes either source_id automatically changes affected homes'
-- input_hash and they get recomputed on the next home_spatial run -- this
-- was the coordinator's explicit ask ("make sure a CCN-driven change
-- alters input_hash"), verified by tracing the formula, not asserted.
-- Separately, this session ALSO added territory_null_reason into the
-- input_hash formula (it wasn't there before) so that 'no_ccn_match' /
-- 'ccn_holder_unmapped' / 'multiply_certificated' are each their own
-- hash state -- a crosswalk fix that flips a holder from "unmapped" to
-- "mapped" (same eia_id count-wise coincidentally) still gets picked up.
-- Guarded (advisor review caught the naive version of this): the
-- formula appends '|' || territory_null_reason only via
-- `coalesce('|' || r.territory_null_reason, '')`, so for every row
-- where territory_null_reason is NULL (Harris always; every other
-- already-loaded county's default path) the appended segment is ''  --
-- BYTE-IDENTICAL to the pre-this-session hash string, so Harris's
-- ~836k rows do NOT get rewritten by this change. Only Williamson (which
-- had a non-null reason, 'utility_not_confirmed', that the OLD formula
-- never hashed at all) and Travis (whose territory_basis literal changes
-- from 'service_area_polygon' to 'puct_ccn' for nearly every home with a
-- point, which alone would have changed the hash regardless) actually
-- get rewritten.
--
-- A home with NO point (68,448 in Travis today) is explicitly routed to
-- the UNCHANGED 'default_hifld' mode when g.pt is null (see
-- resolution_mode's guard for this, added after an advisor review caught
-- that the naive 'ccn_counties' routing would have mislabeled these as
-- tested-and-'no_ccn_match', and silently ungated their existing
-- 'territory_not_base_served' status) -- their hash, and their gate
-- outcome, are UNCHANGED by this session.
--
-- Apply steps (once the user confirms the pick rule above), estimated:
--   0. This branch (worktree-agent-ad1861480a870dd31) must be merged
--      into main first: pipelines/sources/puct_ccn.py hard-codes
--      RAW_DIR to the MAIN checkout's data/raw/puct_ccn/ (same
--      convention as territories.py's RAW_DIR), and the raw files are
--      Git LFS pointers in this commit (verified: `git lfs ls-files`
--      shows all 3 .geojson files as LFS objects) -- after merging,
--      run `git lfs pull` in the main checkout so the pointers resolve
--      to real bytes before puct_ccn.py's sha256 check can pass.
--   1. Apply this migration (0305_puct_ccn.sql) -- DDL only, no data,
--      seconds, via psql against POSTGRES_URL_NON_POOLING (session
--      pooler, per platform convention for migrations).
--   2. Run `python3 -m pipelines.run puct_ccn --backfill` -- discovery
--      is automatic (pipelines.core.registry globs pipelines/sources/
--      *.py by filename and calls its run(), no manual registration and
--      no code change needed -- puct_ccn.py's `if __name__ ==
--      "__main__"` refusal only blocks running that file DIRECTLY with
--      `python3 pipelines/sources/puct_ccn.py`, it does NOT block
--      `pipelines.run`, which imports the module and calls run()
--      itself); 3 files, 148 features total, well under a minute.
--   2.5. Web label gap (found this session, not yet fixed -- out of this
--      ticket's owned paths): web/components/GateCounts.tsx and
--      web/app/home/[prop_id]/page.tsx's reason-label maps only know
--      'territory_not_base_served' / 'utility_not_confirmed' /
--      'territories_not_loaded' / 'crosswalk_not_loaded'. This session's
--      three new reasons ('no_ccn_match', 'ccn_holder_unmapped',
--      'multiply_certificated') have NO label yet -- add them there
--      (a web-dev ticket) before or alongside step 4, or the UI will
--      show an unlabeled/fallback reason for every Williamson/Travis
--      home in one of those three states.
--   3. DONE (this session): pipelines/sources/home_spatial.py's territory
--      section implements the rule above (resolution_mode CTE), with the
--      pt-is-null guard and the hash-formula fix described above (both
--      added after an advisor review). Nothing further to land here --
--      just review it (still uncommitted-to-DB, no DB writes were made
--      building/testing it).
--   4. Re-run `python3 -m pipelines.run home_spatial --county 48491`
--      and `--county 48453` ONLY (per-county, resumable, per
--      0304_spatial_precompute.sql's design) -- Harris does NOT need a
--      rerun: the input_hash fix above keeps Harris's hash byte-
--      identical, so a Harris rerun would compute ~836k rows and write
--      zero of them (safe, but pointless; skip it). Rows actually
--      WRITTEN (changed): all 158,475 Williamson rows (their null_reason
--      changes even where eia_id stays null) plus most of Travis's
--      373,513 rows-with-a-point (territory_basis literal changes from
--      'service_area_polygon' to 'puct_ccn' for nearly all of them,
--      changing their hash even where the eia_id number happens to
--      match) -- roughly 530,000 rows total, not ~1.2M. Travis's 68,448
--      no-point rows are explicitly UNCHANGED (see above) and will NOT
--      be rewritten. checks/M3-P6.md's own measured guidance (not this
--      migration's guess) is "budget a few minutes per county" for a
--      full pass with the subdivided tables already in place, so plan
--      on roughly 5-10 minutes total for these two counties, not the
--      ~70s/1.2M-homes territory-only micro-benchmark alone (that number
--      excludes block-group/flood work and the per-row write).
--   5. `python3 -m pipelines.run refresh_scores` (or whatever wraps
--      core.refresh_all_scores()) to propagate into
--      core.mv_home_signals -- see checks/M3-P6.md for that step's own
--      measured cost, now that spatial answers are cached and this is
--      no longer the ~40 min path.
-- ===========================================================================
