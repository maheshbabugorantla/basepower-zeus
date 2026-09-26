"""M2-P8: time-split evaluation of the ranking score against a real
outcome -- whether a home pulled its own battery/generator permit,
reproducing the study the M2-P8 coordinator ran (2026-09-26) that led to
the new anchored score terms and core.default_weights.

Design (real data only -- every number below comes straight off
core.mv_home_signals / core.permits / core.permit_labels / core.parcels
via POSTGRES_URL_NON_POOLING; no synthetic rows, no seeded fakes):

    Cutoff:  2025-07-01 (CUTOFF)
    Signals: computed AS OF the cutoff -- permit-derived features
             (backup_intent's peer rate, "home has its own solar/EV/
             panel permit") use only permits issued BEFORE the cutoff.
             The ACS/EIA-861/emPOWER-backed terms (age65, electric_heat,
             empower, outage) and home_value have no per-home history in
             our sources, so the evaluation uses their current
             core.mv_home_signals value for every home -- the same
             simplification the coordinator's own study made (these
             inputs are single-snapshot, not time series).
    Outcome: adopter = 1 if the home has its own battery or generator
             permit with issue_date in [CUTOFF, now), else 0.
    Population: homes with known permit coverage (permit_null_reason is
             null in core.mv_home_signals -- i.e. inside the Austin
             permit dataset's coverage area) that had NO battery/
             generator permit before the cutoff (a home already backed
             up before the study window can't "adopt" during it).

Metrics per signal (single) and per weights object (combined):
    AUC            rank-based (Mann-Whitney U / (n_pos * n_neg), average
                   ranks for ties) -- the standard scale-free ranking
                   metric, and what `contract_out` -- oh wait, no
                   contract here; just: what the coordinator's own report
                   quoted.
    top_decile_lift  (adoption rate among the top 10% by score) /
                   (overall adoption rate) -- "how much better than
                   average is our top decile".

Typed output: EvalResult (per single-signal or weights-object run) and
RankingEvaluation (the whole report) are dataclasses so `python -m
pipelines.check ranking` (this module's `main()`, wired in
pipelines/pipelines/check.py) has a stable, typed contract instead of ad
hoc prints.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass, field
from datetime import date

from .core import db

CUTOFF = date(2025, 7, 1)

# Single-signal keys evaluated, and the SQL expression (against the
# per-home feature dict built by `_load_population`) each one scores a
# home by alone. Matches the coordinator's evidence-based study.
SINGLE_SIGNAL_KEYS = (
    "home_value",
    "outage",
    "backup_intent_asof",
    "age65",
    "home_permits_asof",
    "owner_65",
    "electric_heat",
    "empower",
    # M2-P10: added terms only -- static/neighborhood (block-group)
    # signals, evaluated the same way as age65/electric_heat/empower/
    # home_value (current core.mv_home_signals-adjacent value for every
    # home; no per-home history in our sources to compute an as-of-cutoff
    # version, same simplification already made for those four).
    "income_100k",
    "age_35_64",
)

# Combined-score feature sets: (label, {signal_key: weight}).
EQUAL_WEIGHTS = {k: 1.0 for k in SINGLE_SIGNAL_KEYS}


@dataclass(frozen=True)
class EvalResult:
    label: str
    n: int
    n_adopters: int
    overall_adoption_rate: float
    auc: float | None
    top_decile_lift: float | None


@dataclass(frozen=True)
class RankingEvaluation:
    cutoff: date
    population_n: int
    adopters_n: int
    single_signal: list[EvalResult] = field(default_factory=list)
    equal_weights: EvalResult | None = None
    default_weights: EvalResult | None = None
    default_weights_used: dict[str, float] = field(default_factory=dict)


# core.default_weights' signal_key values (the scoring-function weight
# keys) vs this evaluation's feature names -- 'backup_intent' and
# 'home_permits' are computed here AS OF the cutoff (peer rate / own
# permits before the cutoff), so they're named with an '_asof' suffix to
# make that explicit; every other key matches core.default_weights
# exactly.
DEFAULT_WEIGHT_KEY_TO_SIGNAL = {
    "backup_intent_asof": "backup_intent",
    "home_permits_asof": "home_permits",
}


def _default_weights(conn) -> dict[str, float]:
    with conn.cursor() as cur:
        cur.execute("select signal_key, weight from core.default_weights")
        rows = {k: float(w) for k, w in cur.fetchall()}
    # Only the keys this evaluation actually scores homes on (flood is
    # penalty-only and installability wasn't part of the adoption study).
    out: dict[str, float] = {}
    for key in SINGLE_SIGNAL_KEYS:
        signal_key = DEFAULT_WEIGHT_KEY_TO_SIGNAL.get(key, key)
        if signal_key in rows:
            out[key] = rows[signal_key]
    return out


def _load_population(conn, *, cutoff: date) -> list[dict]:
    """One row per eligible home: static terms from core.mv_home_signals
    (age65_term, electric_heat_term, empower_term, outage_term,
    home_value_term, owner_65), plus the two permit-derived features
    recomputed AS OF `cutoff` from core.permits/core.permit_labels
    directly (never from the current, present-day mv_home_signals
    columns, which reflect permits up to today)."""
    with conn.cursor() as cur:
        cur.execute(
            """
            with eligible as (
                select s.prop_id, s.geo_id, s.block_group_geoid,
                       s.age65_term as age65, s.electric_heat_term as electric_heat, s.empower_term as empower,
                       s.outage_term as outage, s.home_value_term as home_value,
                       case when s.owner_65 is null then null else s.owner_65::int::numeric end as owner_65,
                       least(1, ia.income_100k_share / nullif(anc_inc.anchor_value, 0)) as income_100k,
                       least(1, ia.age_35_64_share / nullif(anc_age.anchor_value, 0)) as age_35_64
                from core.mv_home_signals s
                left join core.acs_income_age_bg ia on ia.geoid = s.block_group_geoid
                left join core.signal_anchors anc_inc on anc_inc.signal_key = 'income_100k'
                left join core.signal_anchors anc_age on anc_age.signal_key = 'age_35_64'
                where s.gate_reason is null
                  and s.permit_null_reason is null
                  and not exists (
                      select 1 from core.permits pm
                      join core.permit_labels pl
                        on pl.permit_number = pm.permit_number and pl.labeller = 'rules'
                      where pm.tcad_id = s.geo_id
                        and pl.label in ('battery', 'generator')
                        and pm.issue_date < %(cutoff)s
                  )
            ),
            own_asof as (
                select p.tcad_id,
                       bool_or(pl.label in ('solar', 'ev', 'panel')) as home_permits_asof
                from core.permits p
                join core.permit_labels pl
                  on pl.permit_number = p.permit_number and pl.labeller = 'rules'
                where p.issue_date < %(cutoff)s
                group by p.tcad_id
            ),
            bg_backup_asof as (
                select hb.block_group_geoid,
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
            bg_home_counts as (
                select block_group_geoid, count(*) as homes_gated
                from core.mv_home_block_group
                group by block_group_geoid
            ),
            own_backup_asof as (
                select p.geo_id as tcad_id,
                       count(distinct pm.permit_number) as own_backup_asof
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
                  and pm.issue_date >= %(cutoff)s
                group by p.geo_id
            )
            select
                e.prop_id,
                e.age65, e.electric_heat, e.empower, e.outage,
                e.home_value, e.owner_65,
                e.income_100k, e.age_35_64,
                coalesce(oa.home_permits_asof, false)::int::numeric as home_permits_asof,
                case
                    when bhc.homes_gated - 1 <= 0 then null
                    when bb.backup_permits_asof is null then null
                    else (greatest(0, bb.backup_permits_asof - (case when ob.own_backup_asof is null then 0 else ob.own_backup_asof end))::numeric
                          / (bhc.homes_gated - 1)) * 1000
                end as backup_intent_asof_raw,
                coalesce(o.adopted, false) as adopted
            from eligible e
            left join own_asof oa on oa.tcad_id = e.geo_id
            left join bg_backup_asof bb on bb.block_group_geoid = e.block_group_geoid
            left join bg_home_counts bhc on bhc.block_group_geoid = e.block_group_geoid
            left join own_backup_asof ob on ob.tcad_id = e.geo_id
            left join outcome o on o.tcad_id = e.geo_id
            """,
            {"cutoff": cutoff},
        )
        cols = [d.name for d in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]

    if not rows:
        return rows

    # backup_intent_asof: anchor at the 90th percentile of the raw
    # peer rate across this same population (same anchoring method as
    # core.signal_anchors['backup_intent'], recomputed on the as-of-cutoff
    # population since the live anchor reflects today's permits).
    raw_rates = sorted(float(r["backup_intent_asof_raw"]) for r in rows if r["backup_intent_asof_raw"] is not None)
    anchor = _percentile(raw_rates, 0.9) if raw_rates else None
    for r in rows:
        raw = r.pop("backup_intent_asof_raw")
        if raw is None or not anchor or anchor <= 0:
            r["backup_intent_asof"] = None
        else:
            r["backup_intent_asof"] = min(1.0, float(raw) / float(anchor))
    return rows


def _percentile(sorted_values: list[float], p: float) -> float:
    if not sorted_values:
        raise ValueError("empty series")
    if len(sorted_values) == 1:
        return sorted_values[0]
    idx = p * (len(sorted_values) - 1)
    lo = int(idx)
    hi = min(lo + 1, len(sorted_values) - 1)
    frac = idx - lo
    return sorted_values[lo] * (1 - frac) + sorted_values[hi] * frac


def _auc(scores: list[float], labels: list[bool]) -> float | None:
    """Rank-based AUC (Mann-Whitney U), average ranks for ties. None if
    either class is empty (AUC undefined)."""
    n = len(scores)
    n_pos = sum(labels)
    n_neg = n - n_pos
    if n_pos == 0 or n_neg == 0:
        return None
    order = sorted(range(n), key=lambda i: scores[i])
    ranks = [0.0] * n
    i = 0
    rank = 1
    while i < n:
        j = i
        while j + 1 < n and scores[order[j + 1]] == scores[order[i]]:
            j += 1
        avg_rank = (rank + rank + (j - i)) / 2.0
        for k in range(i, j + 1):
            ranks[order[k]] = avg_rank
        rank += (j - i + 1)
        i = j + 1
    rank_sum_pos = sum(ranks[i] for i in range(n) if labels[i])
    u = rank_sum_pos - n_pos * (n_pos + 1) / 2.0
    return u / (n_pos * n_neg)


def _top_decile_lift(scores: list[float], labels: list[bool]) -> float | None:
    n = len(scores)
    if n == 0:
        return None
    overall_rate = sum(labels) / n
    if overall_rate == 0:
        return None
    decile_n = max(1, n // 10)
    order = sorted(range(n), key=lambda i: scores[i], reverse=True)
    top = order[:decile_n]
    top_rate = sum(1 for i in top if labels[i]) / len(top)
    return top_rate / overall_rate


def _score_rows(rows: list[dict], weights: dict[str, float]) -> tuple[list[float], list[bool]]:
    scores: list[float] = []
    labels: list[bool] = []
    for r in rows:
        weighted_sum = 0.0
        weight_sum = 0.0
        for key, w in weights.items():
            v = r.get(key)
            if v is not None:
                weighted_sum += w * float(v)
                weight_sum += w
        if weight_sum <= 0:
            continue
        scores.append(weighted_sum / weight_sum)
        labels.append(bool(r["adopted"]))
    return scores, labels


def _eval_weights(rows: list[dict], *, label: str, weights: dict[str, float]) -> EvalResult:
    scores, labels = _score_rows(rows, weights)
    n = len(scores)
    n_adopters = sum(labels)
    return EvalResult(
        label=label,
        n=n,
        n_adopters=n_adopters,
        overall_adoption_rate=(n_adopters / n) if n else 0.0,
        auc=_auc(scores, labels),
        top_decile_lift=_top_decile_lift(scores, labels),
    )


def evaluate(conn, *, cutoff: date = CUTOFF) -> RankingEvaluation:
    rows = _load_population(conn, cutoff=cutoff)
    default_weights = _default_weights(conn)

    single_results = [
        _eval_weights(rows, label=key, weights={key: 1.0}) for key in SINGLE_SIGNAL_KEYS
    ]
    equal_result = _eval_weights(rows, label="equal_weights", weights=EQUAL_WEIGHTS)
    default_result = _eval_weights(rows, label="default_weights", weights=default_weights)

    return RankingEvaluation(
        cutoff=cutoff,
        population_n=len(rows),
        adopters_n=sum(1 for r in rows if r["adopted"]),
        single_signal=single_results,
        equal_weights=equal_result,
        default_weights=default_result,
        default_weights_used=default_weights,
    )


def _print_report(ev: RankingEvaluation) -> None:
    print(f"cutoff={ev.cutoff} population_n={ev.population_n} adopters_n={ev.adopters_n}")
    print(f"{'signal':<22} {'n':>8} {'adopters':>9} {'auc':>8} {'top_decile_lift':>16}")
    for r in ev.single_signal:
        print(f"{r.label:<22} {r.n:>8} {r.n_adopters:>9} {fmt(r.auc):>8} {fmt(r.top_decile_lift):>16}")
    for r in (ev.equal_weights, ev.default_weights):
        if r is not None:
            print(f"{r.label:<22} {r.n:>8} {r.n_adopters:>9} {fmt(r.auc):>8} {fmt(r.top_decile_lift):>16}")
    print(f"default_weights_used={ev.default_weights_used}")


def fmt(v: float | None) -> str:
    return "n/a" if v is None else f"{v:.3f}"


def main(argv: list[str] | None = None) -> int:
    with db.connect(pooled=False) as conn:
        ev = evaluate(conn)
    _print_report(ev)
    return 0


if __name__ == "__main__":
    sys.exit(main())
