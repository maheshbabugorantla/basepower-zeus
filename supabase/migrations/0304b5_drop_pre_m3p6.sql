-- 0304b5: drop the pre-swap copies as soon as nothing reads them (disk on Supabase Small is 8 GB).
-- Plain drop, no cascade: fails loudly if anything still depends on them.
drop materialized view core.mv_home_signals_pre_m3p6;
drop materialized view core.mv_home_block_group_pre_m3p6;
