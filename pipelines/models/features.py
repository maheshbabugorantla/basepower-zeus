"""As-of feature frame for the M4-P4 propensity model.

Reuses pipelines/pipelines/evaluate_ranking.py's as-of pattern (permits
join parcels via core.permit_timelines.tcad_id = core.parcels.geo_id;
neighbour rate excludes the home). No synthetic rows: every column comes
straight off core.mv_home_signals / core.permits / core.permit_labels /
core.parcels / core.acs_income_age_bg via a live connection.

FEATURE_COLUMNS is the exact, ordered set of model input columns (missing
stays NaN -- never filled with 0/median in this module; HistGradient-
BoostingClassifier handles NaN natively, the logistic-regression baseline
imputes explicitly in pipeline.py, never here).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date

import pandas as pd
import psycopg

FEATURE_COLUMNS: tuple[str, ...] = (
    "log_market_value",
    "yr_built",
    "owner_65",
    "age65_term",
    "electric_heat_term",
    "empower_term",
    "outage_term",
    "income_100k_share",
    "age_35_64_share",
    "own_solar_asof",
    "own_ev_asof",
    "own_panel_asof",
    "own_battery_asof",
    "own_generator_asof",
    "neighbor_adoption_rate_asof",
)

# Features that come from the Austin permits dataset (null, never a
# guessed 0, when a home's block group has no permit coverage at all --
# core.mv_home_signals.permit_null_reason = 'no_permit_coverage').
PERMIT_DERIVED_COLUMNS: tuple[str, ...] = (
    "own_solar_asof",
    "own_ev_asof",
    "own_panel_asof",
    "own_battery_asof",
    "own_generator_asof",
    "neighbor_adoption_rate_asof",
)


@dataclass(frozen=True)
class LabelWindow:
    start: date  # inclusive
    end: date  # exclusive


# The as-of query. `%(cutoff)s` gates every permit-derived feature (only
# permits issued strictly before the cutoff are used to build them --
# never the current, present-day mv_home_signals permit columns, which
# reflect permits up to today regardless of the requested cutoff).
# `%(exclude_before)s` controls whether homes that already had a
# battery/generator permit before the cutoff are dropped from the
# population -- true for train/test framing ("eligible to adopt during
# the window"), false for final scoring (score every gated home,
# including ones that already installed).
_SQL = """
with eligible as (
    select
        s.prop_id, s.geo_id, s.block_group_geoid, s.county_fips,
        s.age65_term, s.electric_heat_term, s.empower_term, s.outage_term,
        s.market_value, s.yr_built,
        case when s.owner_65 is null then null else s.owner_65::int::numeric end as owner_65,
        ia.income_100k_share, ia.age_35_64_share,
        s.permit_null_reason
    from core.mv_home_signals s
    left join core.acs_income_age_bg ia on ia.geoid = s.block_group_geoid
    where s.gate_reason is null
      and (
          %(exclude_before)s = false
          or not exists (
              select 1 from core.permits pm
              join core.permit_labels pl
                on pl.permit_number = pm.permit_number and pl.labeller = 'rules'
              where pm.tcad_id = s.geo_id
                and pl.label in ('battery', 'generator')
                and pm.issue_date < %(cutoff)s
          )
      )
),
own_asof as (
    select
        p.tcad_id,
        bool_or(pl.label = 'solar') as own_solar_asof,
        bool_or(pl.label = 'ev') as own_ev_asof,
        bool_or(pl.label = 'panel') as own_panel_asof,
        bool_or(pl.label = 'battery') as own_battery_asof,
        bool_or(pl.label = 'generator') as own_generator_asof
    from core.permits p
    join core.permit_labels pl
      on pl.permit_number = p.permit_number and pl.labeller = 'rules'
    where p.issue_date < %(cutoff)s
    group by p.tcad_id
),
bg_home_counts as (
    select block_group_geoid, count(*) as homes_gated
    from core.mv_home_block_group
    group by block_group_geoid
),
bg_backup_asof as (
    select
        hb.block_group_geoid,
        count(distinct pm.permit_number) filter (
            where pl.label in ('battery', 'generator')
        ) as backup_permits_asof
    from core.mv_home_block_group hb
    left join core.parcels p on p.prop_id = hb.prop_id
    left join core.permits pm on pm.tcad_id = p.geo_id and pm.issue_date < %(cutoff)s
    left join core.permit_labels pl
      on pl.permit_number = pm.permit_number and pl.labeller = 'rules'
    group by hb.block_group_geoid
),
own_backup_asof as (
    select
        p.geo_id as tcad_id,
        count(distinct pm.permit_number) as n
    from core.parcels p
    join core.permits pm on pm.tcad_id = p.geo_id
    join core.permit_labels pl
      on pl.permit_number = pm.permit_number and pl.labeller = 'rules'
    where pl.label in ('battery', 'generator') and pm.issue_date < %(cutoff)s
    group by p.geo_id
),
outcome as (
    select p.geo_id as tcad_id, true as adopted
    from core.parcels p
    join core.permits pm on pm.tcad_id = p.geo_id
    join core.permit_labels pl
      on pl.permit_number = pm.permit_number and pl.labeller = 'rules'
    where pl.label in ('battery', 'generator')
      and pm.issue_date >= %(label_start)s and pm.issue_date < %(label_end)s
    group by p.geo_id
)
select
    e.prop_id, e.county_fips, e.block_group_geoid,
    e.market_value, e.yr_built, e.owner_65,
    e.age65_term, e.electric_heat_term, e.empower_term, e.outage_term,
    e.income_100k_share, e.age_35_64_share,
    e.permit_null_reason,
    case when e.permit_null_reason is not null then null
         else coalesce(oa.own_solar_asof, false)::int::numeric end as own_solar_asof,
    case when e.permit_null_reason is not null then null
         else coalesce(oa.own_ev_asof, false)::int::numeric end as own_ev_asof,
    case when e.permit_null_reason is not null then null
         else coalesce(oa.own_panel_asof, false)::int::numeric end as own_panel_asof,
    case when e.permit_null_reason is not null then null
         else coalesce(oa.own_battery_asof, false)::int::numeric end as own_battery_asof,
    case when e.permit_null_reason is not null then null
         else coalesce(oa.own_generator_asof, false)::int::numeric end as own_generator_asof,
    case
        when e.permit_null_reason is not null then null
        when bhc.homes_gated - 1 <= 0 then null
        when bb.backup_permits_asof is null then null
        else greatest(0, bb.backup_permits_asof - (case when ob.n is null then 0 else ob.n end))::numeric
             / (bhc.homes_gated - 1)
    end as neighbor_adoption_rate_asof,
    (%(has_label)s = true and o.adopted is not null) as adopted
from eligible e
left join own_asof oa on oa.tcad_id = e.geo_id
left join bg_backup_asof bb on bb.block_group_geoid = e.block_group_geoid
left join bg_home_counts bhc on bhc.block_group_geoid = e.block_group_geoid
left join own_backup_asof ob on ob.tcad_id = e.geo_id
left join outcome o on o.tcad_id = e.geo_id
"""


def load_frame(
    conn: psycopg.Connection,
    *,
    cutoff: date,
    exclude_before: bool,
    label_window: LabelWindow | None,
) -> pd.DataFrame:
    """One row per gated home, features as-of `cutoff` (permit-derived
    features use only permits with issue_date < cutoff). When
    `label_window` is given, `adopted` is 1 if the home has a
    battery/generator permit issued in [label_window.start,
    label_window.end), else 0 -- used for train/test framing only.
    `exclude_before=True` drops homes that already had a battery/
    generator permit before the cutoff (can't "newly adopt" during the
    window) -- the population core.mv_home_signals train/test uses.
    `exclude_before=False` is the final-scoring population: every gated
    home, including ones that already installed."""
    has_label = label_window is not None
    params = {
        "cutoff": cutoff,
        "exclude_before": exclude_before,
        "has_label": has_label,
        "label_start": label_window.start if has_label else date(9999, 1, 1),
        "label_end": label_window.end if has_label else date(9999, 1, 2),
    }
    with conn.cursor() as cur:
        cur.execute(_SQL, params)
        cols = [d.name for d in cur.description]
        rows = cur.fetchall()
    df = pd.DataFrame(rows, columns=cols)
    if df.empty:
        return df
    df["log_market_value"] = df["market_value"].apply(
        lambda v: None if pd.isna(v) or float(v) <= 0 else math.log(float(v))
    )
    df["extrapolated_from"] = df["permit_null_reason"].apply(
        lambda r: "austin_installs" if not pd.isna(r) else None
    )
    for col in FEATURE_COLUMNS:
        if col not in df.columns:
            continue
        df[col] = pd.to_numeric(df[col], errors="coerce")
    if not has_label:
        df = df.drop(columns=["adopted"])
    else:
        df["adopted"] = df["adopted"].astype(int)
    return df
