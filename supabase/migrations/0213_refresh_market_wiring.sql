-- core.refresh_all_scores() also refreshes the per-market serve counts
-- (core.refresh_market(), 0206), so the market split can never go stale
-- after a score refresh. Full function body restated from the live
-- definition (0203 order) with that one call appended.

CREATE OR REPLACE FUNCTION core.refresh_all_scores()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
begin
    refresh materialized view concurrently core.mv_home_block_group;
    refresh materialized view concurrently core.mv_home_signals;
    refresh materialized view concurrently core.mv_join_rate;
    -- core.mv_blockgroup_scores / core.mv_top_homes (0102) are retired
    -- by 0201_m2.sql (core.mv_home_signals + api.top_homes_weighted
    -- replace their per-home semantics) but are kept refreshed for now,
    -- since the pre-existing api.top_homes view still reads
    -- core.mv_top_homes and the web app has not switched off it yet
    -- (M2-W1). Drop these two lines once M2-W1 lands.
    refresh materialized view concurrently core.mv_blockgroup_scores;
    refresh materialized view concurrently core.mv_top_homes;
    -- 0203_perf_precompute.sql: precomputed request-time rollups. Must
    -- come after mv_home_signals (mv_gate_counts reads it) and after
    -- mv_blockgroup_scores (mv_blockgroup_geojson reads it).
    refresh materialized view concurrently core.mv_gate_counts;
    refresh materialized view concurrently core.mv_parcel_gate_counts;
    refresh materialized view concurrently core.mv_blockgroup_geojson;
    -- 0206_retail_market.sql: servable homes split by electricity market
    -- (reads mv_home_signals, so it must come after it).
    perform core.refresh_market();
end;
$function$;
