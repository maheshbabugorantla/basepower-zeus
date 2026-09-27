set local statement_timeout = 0;
set local work_mem = '64MB';
set local maintenance_work_mem = '256MB';
set local max_parallel_workers_per_gather = 0;

-- 0307_batched_scoring_build.sql — perf follow-up to M3-P6.
--
-- Why: `core.refresh_all_scores()` measured 439s live on 2026-09-26
-- (Travis+Harris+Williamson). Two costs dominate that aren't in
-- M3-P6's own scope:
--   1. `refresh materialized view concurrently core.mv_home_signals`
--      (805 MB, 1.2M rows) and `...mv_home_terms` (296 MB) each build a
--      FULL second copy beside the live one, then diff row-by-row via
--      the unique index, before swapping. That diff is pure overhead a
--      plain table doesn't pay.
--   2. `update core.home_propensity set county_fips = ... from
--      core.mv_home_signals` -- measured 101.9s standalone
--      (pg_stat_statements, read-only check, 2026-09-26) the one time it
--      ran as a full backfill. It joins and rewrites ~1.2M rows on every
--      refresh even though county_fips no longer changes after the
--      models write it (pipelines/models sets it once at scoring time).
--
-- Fix: convert core.mv_home_signals and core.mv_home_terms from
-- materialized views into plain tables, kept current by a new batched
-- Python runner (pipelines/sources/scoring_refresh.py) that upserts by
-- prop_id keyset range instead of concurrent-refreshing the whole
-- object. Retire the home_propensity update from the routine refresh
-- entirely (0307_batched_scoring_swap.sql).
--
-- This file is the BUILD half (lesson 4: commit the expensive step on
-- its own, before the fast DDL swap). It copies the two live matviews
-- into new tables verbatim -- `create table ... as select * from
-- core.mv_home_signals` -- so no column, type, row, or value changes:
-- the swap has nothing to recompute, only to rebind (per this project's
-- advisor guidance: avoid re-running the 198s+ per-home query during a
-- migration when the live matview already holds the identical rows).
--
-- Peak extra disk while this file and the swap are both live (before
-- 0307_batched_scoring_drop_pre_batched.sql, a follow-up NOT applied by
-- this ticket): current db size 4.72 GB (pg_database_size, measured
-- read-only 2026-09-26) + this file's ~805 MB + ~296 MB copies + their
-- indexes (~200-300 MB combined, proportional to the originals) ~= 6.0-
-- 6.3 GB, under the ~7 GB budget. The old copies (renamed
-- *_pre_batched, not dropped by this file) add back the original
-- 805+296 MB until the drop follow-up runs, so peak during the swap
-- window is ~6.8-7.1 GB -- tight but under the 8 GB paid threshold.
-- ---------------------------------------------------------------------------

create table core.mv_home_signals_v3 as
select * from core.mv_home_signals;

alter table core.mv_home_signals_v3 add primary key (prop_id);

create index mv_home_signals_v3_gate_reason_idx on core.mv_home_signals_v3 (gate_reason) where gate_reason is null;
create index mv_home_signals_v3_county_fips_idx on core.mv_home_signals_v3 (county_fips);
create index mv_home_signals_v3_bg_geoid_idx on core.mv_home_signals_v3 (block_group_geoid);
create index mv_home_signals_v3_county_gated_idx on core.mv_home_signals_v3 (county_fips, prop_id) where gate_reason is null;
create index mv_home_signals_v3_county_territory_idx on core.mv_home_signals_v3 (county_fips, territory_eia_id);
create index mv_home_signals_v3_territory_idx on core.mv_home_signals_v3 (territory_eia_id);

analyze core.mv_home_signals_v3;

create table core.mv_home_terms_v3 as
select * from core.mv_home_terms;

alter table core.mv_home_terms_v3 add primary key (prop_id);

create index mv_home_terms_v3_county_prop_idx on core.mv_home_terms_v3 (county_fips, prop_id);
create index mv_home_terms_v3_county_bg_idx on core.mv_home_terms_v3 (county_fips, block_group_geoid);

analyze core.mv_home_terms_v3;
