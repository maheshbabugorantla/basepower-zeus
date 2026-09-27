set local statement_timeout = 0;
set local work_mem = '64MB';

-- 0308_home_propensity_self_heal.sql
--
-- T1 fix (data-fixes review, 2026-09-26): a read-only investigation
-- found core.home_propensity rows whose relative_to_county/decile are
-- internally inconsistent with their own p_install_12m -- e.g. Williamson
-- prop_id W348444 has the HIGHEST p_install_12m of any of the 158,385
-- homes in county_fips='48491' (0.3345, next-highest 0.0359) yet is
-- stored with relative_to_county=1.0 and decile=10 (the model's own
-- contract: decile 1 = highest p_install_12m in county, 10 = lowest --
-- 0401_propensity.sql). Recomputing relative_to_county/decile in pandas
-- with pipelines/models/pipeline.py's exact formula (p_install_12m /
-- county mean; rank(pct=True, method='average', ascending=False)) over
-- every CURRENTLY stored p_install_12m for county_fips='48491' gives
-- decile=1 for W348444 -- confirming the code's formula is correct today
-- and these are stale/corrupted rows, not a live formula bug (a prior
-- run's writer evidently wrote decile/relative for a home while it was
-- grouped alone or with a stale county_fips -- W348444/W222470's
-- block_group_geoid, 480539601021/483319508001, carries a county prefix
-- that does not match county_fips='48491' either, consistent with a
-- home whose county/block-group assignment was corrected after its
-- home_propensity row was written and never re-scored since).
--
-- This statement is a pure, deterministic recompute of relative_to_
-- county/decile from the p_install_12m ALREADY STORED in core.home_
-- propensity, grouped by the SAME core.home_propensity.county_fips
-- column pipelines/models/pipeline.py groups by (backfilled from core.
-- mv_home_signals.county_fips, 0304b3_propensity_county.sql) -- no
-- invented values, no re-scoring, no touch to p_install_12m/reasons/
-- extrapolated_from/model_version/trained_through/source_ids. Self-
-- heals any row whose stored decile/relative_to_county doesn't match a
-- fresh computation from its own p_install_12m -- not just the two rows
-- this investigation found by hand. A future `python -m models score`
-- run (pipelines/models/pipeline.py) supersedes this once it re-runs,
-- since it always recomputes both columns together from a single,
-- consistent county grouping.

with recomputed as (
    select
        prop_id,
        p_install_12m / avg(p_install_12m) over (partition by county_fips) as relative_to_county,
        least(
            10,
            floor(
                (rank() over (partition by county_fips order by p_install_12m desc))::numeric
                / (count(*) over (partition by county_fips))::numeric
                * 10
            )::int + 1
        ) as decile
    from core.home_propensity
    where county_fips is not null
)
update core.home_propensity hp
set relative_to_county = r.relative_to_county,
    decile = r.decile,
    updated_at = now()
from recomputed r
where r.prop_id = hp.prop_id
  and (
      hp.decile is distinct from r.decile
      or hp.relative_to_county is distinct from r.relative_to_county
  );
