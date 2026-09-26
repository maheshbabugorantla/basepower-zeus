-- Overview "is this distributor present among loaded homes?" check reads
-- core.mv_home_signals by (county_fips, territory_eia_id) instead of a
-- request-time ST_Intersects against core.block_groups. This index keeps
-- that lookup an index-only probe (a miss was a 200 ms scan without it).
create index if not exists mv_home_signals_county_territory_idx
  on core.mv_home_signals (county_fips, territory_eia_id);
