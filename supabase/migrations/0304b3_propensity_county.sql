set local statement_timeout = 0;
set local work_mem = '64MB';
set local maintenance_work_mem = '256MB';
set local max_parallel_workers_per_gather = 0;
-- 0304b3: home_propensity.county_fips backfill, committed on its own (split out of 0304b).
-- core.home_propensity.county_fips — new column, backfilled here (once,
-- against mv_home_signals_v2, before the swap so it's ready the moment
-- api.home_propensity repoints to read it directly instead of joining
-- core.mv_home_signals just for the county filter).
-- ---------------------------------------------------------------------------
alter table core.home_propensity add column if not exists county_fips text;

update core.home_propensity hp
set county_fips = s.county_fips
from core.mv_home_signals_v2 s
where s.prop_id = hp.prop_id
  and hp.county_fips is distinct from s.county_fips;

create index if not exists home_propensity_county_p_idx
    on core.home_propensity (county_fips, p_install_12m desc, prop_id);

