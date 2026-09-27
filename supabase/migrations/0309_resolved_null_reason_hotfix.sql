set local statement_timeout = 0;

-- 0309 — hotfix, 2026-09-26 22:30 CDT.
--
-- pipelines/sources/home_spatial.py stamped territory_null_reason =
-- 'no_ccn_match' on every CCN-resolved Travis/Williamson home (the
-- coalesce fell through even when resolved_territory_eia_id was set).
-- core.mv_gate_counts buckets by that reason, api.loaded_counties only
-- counted 'passed' / 'utility_not_confirmed', so both counties vanished
-- from the county list and the web fell back to Harris for every page.
--
-- 1. A resolved home has no null reason.
update core.home_spatial
   set territory_null_reason = null
 where resolved_territory_eia_id is not null
   and territory_null_reason is not null;

update core.mv_home_signals
   set territory_null_reason = null
 where territory_eia_id is not null
   and territory_null_reason is not null;

-- 2. api.loaded_counties: every "ranked but unconfirmed" reason counts as
--    loaded, not only the pre-CCN 'utility_not_confirmed'.
create or replace view api.loaded_counties as
    select county_fips, sum(home_count) as homes_scored
    from core.mv_gate_counts
    where reason = any (array['passed', 'utility_not_confirmed',
                              'multiply_certificated', 'no_ccn_match',
                              'ccn_holder_unmapped'])
    group by county_fips;

grant select on api.loaded_counties to zeus_web_ro;
