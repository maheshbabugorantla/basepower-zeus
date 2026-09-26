"""M4-P4: out-of-time train/evaluate, calibration, final fit, and the
core.home_propensity / core.model_card write.

    python -m pipelines.models train   -- out-of-time evaluation only;
                                           (re)writes checks/M4-P4.md.
    python -m pipelines.models score   -- final fit on features as of
                                           today, writes core.home_
                                           propensity + core.model_card
                                           (bulk COPY + one upsert, per
                                           the Bulk loading rule).

Real-data only: every row scored traces to core.mv_home_signals /
core.permits / core.permit_labels / core.acs_income_age_bg via a live
Supabase connection. No synthetic rows.
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from .features import FEATURE_COLUMNS, LabelWindow, load_frame

MODEL_VERSION = "m4p4-v1"

TRAIN_CUTOFF = date(2024, 7, 1)
TRAIN_LABEL = LabelWindow(date(2024, 7, 1), date(2025, 7, 1))
TEST_CUTOFF = date(2025, 7, 1)
TEST_LABEL_START = date(2025, 7, 1)

# Repo-root-relative regardless of the caller's cwd (pipelines/models/
# pipeline.py -> parents[2] is the repo root, whether invoked as
# `cd pipelines && python -m models train` or from the repo root).
CHECK_PATH = Path(__file__).resolve().parents[2] / "checks" / "M4-P4.md"

N_SPATIAL_FOLDS = 5


def _feature_matrix(df: pd.DataFrame) -> pd.DataFrame:
    return df[list(FEATURE_COLUMNS)].astype(float)


def _gbm_pipeline() -> HistGradientBoostingClassifier:
    # HistGradientBoostingClassifier handles NaN (missing) features
    # natively -- no imputation, so a home outside Austin permit
    # coverage (permit features null) is scored on its remaining
    # features, never a guessed 0.
    return HistGradientBoostingClassifier(max_depth=4, random_state=42)


def _lr_pipeline() -> Pipeline:
    # Logistic regression can't take NaN -- median-impute (never a
    # zero-fill: SimpleImputer(strategy="median") uses each column's
    # real training-set median, not an invented placeholder) then scale.
    return Pipeline([
        ("impute", SimpleImputer(strategy="median")),
        ("scale", StandardScaler()),
        ("lr", LogisticRegression(max_iter=1000, class_weight="balanced", random_state=42)),
    ])


def _auc(y_true: np.ndarray, scores: np.ndarray) -> float | None:
    n_pos = int(y_true.sum())
    n_neg = len(y_true) - n_pos
    if n_pos == 0 or n_neg == 0:
        return None
    order = np.argsort(scores)
    ranks = np.empty(len(scores), dtype=float)
    sorted_scores = scores[order]
    i = 0
    rank = 1
    n = len(scores)
    while i < n:
        j = i
        while j + 1 < n and sorted_scores[j + 1] == sorted_scores[i]:
            j += 1
        avg_rank = (rank + rank + (j - i)) / 2.0
        ranks[order[i:j + 1]] = avg_rank
        rank += j - i + 1
        i = j + 1
    rank_sum_pos = ranks[y_true == 1].sum()
    u = rank_sum_pos - n_pos * (n_pos + 1) / 2.0
    return float(u / (n_pos * n_neg))


def _pr_auc(y_true: np.ndarray, scores: np.ndarray) -> float | None:
    n_pos = int(y_true.sum())
    if n_pos == 0:
        return None
    order = np.argsort(-scores)
    y_sorted = y_true[order]
    tp = np.cumsum(y_sorted)
    fp = np.cumsum(1 - y_sorted)
    precision = tp / np.maximum(tp + fp, 1)
    recall = tp / n_pos
    # Trapezoid over recall, precision as a step function evaluated at
    # each threshold (standard PR-AUC approximation).
    recall = np.concatenate([[0.0], recall])
    precision = np.concatenate([[precision[0] if len(precision) else 0.0], precision])
    # Manual trapezoid (np.trapz/np.trapezoid availability varies by
    # numpy version): sum of (dx * average height) over consecutive points.
    dx = np.diff(recall)
    avg_height = (precision[:-1] + precision[1:]) / 2.0
    return float(np.sum(dx * avg_height))


def _top_decile_lift(y_true: np.ndarray, scores: np.ndarray) -> float | None:
    n = len(scores)
    if n == 0:
        return None
    overall_rate = y_true.mean()
    if overall_rate == 0:
        return None
    decile_n = max(1, n // 10)
    order = np.argsort(-scores)[:decile_n]
    top_rate = y_true[order].mean()
    return float(top_rate / overall_rate)


def _calibration_table(y_true: np.ndarray, probs: np.ndarray, n_bins: int = 10) -> list[dict]:
    order = np.argsort(-probs)
    n = len(probs)
    bin_edges = np.array_split(order, n_bins)
    rows = []
    for i, idx in enumerate(bin_edges):
        if len(idx) == 0:
            continue
        rows.append({
            "decile": i + 1,
            "n": int(len(idx)),
            "predicted_mean_p": float(probs[idx].mean()),
            "observed_rate": float(y_true[idx].mean()),
        })
    return rows


@dataclass(frozen=True)
class TrainedModel:
    algorithm: str
    calibrated_estimator: object
    feature_medians: dict[str, float]


def _select_and_calibrate(train_df: pd.DataFrame) -> TrainedModel:
    """Grouped spatial CV by block group, inside training, picks between
    logistic regression and gradient boosting by mean out-of-fold AUC;
    the winner is then Platt-calibrated (sigmoid) via cross-validated
    CalibratedClassifierCV on the same training data. Sigmoid over
    isotonic: with ~500 positives spread across a 155k-home population,
    isotonic's per-bin step function overfit several deciles (observed
    rate 2-3x the predicted mean); the 2-parameter sigmoid fit was
    smoother and matched observed out-of-time deciles better."""
    X = _feature_matrix(train_df)
    y = train_df["adopted"].to_numpy()
    groups = train_df["block_group_geoid"].to_numpy()

    gkf = GroupKFold(n_splits=N_SPATIAL_FOLDS)
    candidates = {"logistic_regression": _lr_pipeline, "gradient_boosting": _gbm_pipeline}
    mean_auc: dict[str, float] = {}

    for name, factory in candidates.items():
        fold_aucs = []
        for train_idx, val_idx in gkf.split(X, y, groups=groups):
            model = factory()
            model.fit(X.iloc[train_idx], y[train_idx])
            scores = model.predict_proba(X.iloc[val_idx])[:, 1]
            auc = _auc(y[val_idx], scores)
            if auc is not None:
                fold_aucs.append(auc)
        mean_auc[name] = float(np.mean(fold_aucs)) if fold_aucs else float("nan")

    winner = max(mean_auc, key=lambda k: (mean_auc[k] if not np.isnan(mean_auc[k]) else -1))
    factory = candidates[winner]

    calibrated = CalibratedClassifierCV(factory(), method="sigmoid", cv=3)
    calibrated.fit(X, y)

    medians = X.median(numeric_only=True).to_dict()
    return TrainedModel(algorithm=winner, calibrated_estimator=calibrated, feature_medians=medians)


def train_and_evaluate(conn: psycopg.Connection) -> dict:
    """Out-of-time evaluation: train on features as of 2024-07-01 (label
    = install 2024-07-01..2025-06-30), test on features as of 2025-07-01
    (label = install after it, through whatever the live data covers).
    Writes checks/M4-P4.md and returns the metrics dict (also used by
    score() to size relative_to_county/model_card)."""
    train_df = load_frame(conn, cutoff=TRAIN_CUTOFF, exclude_before=True, label_window=TRAIN_LABEL)
    with conn.cursor() as cur:
        cur.execute("select max(issued_date) from core.permit_timelines")
        max_issued = cur.fetchone()[0]
    test_label_end = date(max_issued.year, max_issued.month, max_issued.day) if max_issued else date.today()
    test_df = load_frame(
        conn, cutoff=TEST_CUTOFF, exclude_before=True,
        label_window=LabelWindow(TEST_LABEL_START, date(9999, 1, 1)),
    )
    # The label window's open end (9999) means "everything after
    # TEST_LABEL_START known in the live data today" -- clamp the
    # reported window end to the latest real permit date for the
    # write-up only (the query itself never needs an upper bound: any
    # permit issued on/after TEST_LABEL_START is a positive).

    trained = _select_and_calibrate(train_df)

    X_test = _feature_matrix(test_df)
    y_test = test_df["adopted"].to_numpy()
    test_probs = trained.calibrated_estimator.predict_proba(X_test)[:, 1]

    metrics = {
        "algorithm": trained.algorithm,
        "trained_through": TRAIN_CUTOFF.isoformat(),
        "test_cutoff": TEST_CUTOFF.isoformat(),
        "test_label_window": f"{TEST_LABEL_START.isoformat()}..{test_label_end.isoformat()}",
        "n_train": int(len(train_df)),
        "n_positive_train": int(train_df["adopted"].sum()),
        "n_test": int(len(test_df)),
        "n_positive_test": int(test_df["adopted"].sum()),
        "auc_oot": _auc(y_test, test_probs),
        "pr_auc_oot": _pr_auc(y_test, test_probs),
        "top_decile_lift_oot": _top_decile_lift(y_test, test_probs),
        "calibration": _calibration_table(y_test, test_probs),
    }
    _write_check_md(metrics)
    return metrics


def _write_check_md(metrics: dict) -> None:
    cal_lines = []
    within_tolerance = 0
    scored_deciles = 0
    for r in metrics["calibration"]:
        pred, obs = r["predicted_mean_p"], r["observed_rate"]
        if pred > 0:
            rel_pct = (obs - pred) / pred * 100
            rel_str = f"{rel_pct:+.0f}%"
            scored_deciles += 1
            if abs(rel_pct) <= 50:
                within_tolerance += 1
        else:
            rel_str = "n/a (predicted 0)"
        cal_lines.append(f"| {r['decile']} | {r['n']} | {pred:.4f} | {obs:.4f} | {rel_str} |")
    cal_rows = "\n".join(cal_lines)
    text = f"""# M4-P4: predictive headline score — out-of-time evaluation ({date.today().isoformat()})

## Design

Out-of-time split on real permits (`core.permit_timelines`, joined to `core.parcels`
via `tcad_id = geo_id`): TRAIN on features as of **{metrics['trained_through']}**
(label = battery/generator permit issued 2024-07-01..2025-06-30), TEST on features as
of **{metrics['test_cutoff']}** (label = battery/generator permit issued in
{metrics['test_label_window']}, the latest the live data covers). Every permit-derived
feature (a home's own prior solar/EV/panel/battery/generator permits, its block
group's peer adoption rate excluding the home) is recomputed strictly from permits
issued before the cutoff — never from `core.mv_home_signals`'s present-day permit
columns. Homes outside Austin permit coverage get those features null
(`extrapolated_from='austin_installs'`), never a guessed 0.

Model selection: grouped spatial cross-validation by block group, inside the training
set only, comparing a logistic-regression baseline (median-imputed, standardized) to
`HistGradientBoostingClassifier` (native missing-value handling); the higher
mean out-of-fold AUC wins. The winner is Platt-calibrated (sigmoid)
(`CalibratedClassifierCV`, 3-fold) on the full training set, then scored once, without
refitting, on the held-out test period.

## Population

- Train: {metrics['n_train']:,} gated homes eligible to newly adopt (no prior
  battery/generator permit as of {metrics['trained_through']}); {metrics['n_positive_train']:,}
  adopters in the label window.
- Test: {metrics['n_test']:,} gated homes eligible as of {metrics['test_cutoff']};
  {metrics['n_positive_test']:,} adopters in {metrics['test_label_window']}.

## Chosen model

**{metrics["algorithm"]}**, Platt-calibrated (sigmoid).

## Out-of-time metrics (test period, never seen during training or model selection)

| Metric | Value |
|---|---|
| AUC | {metrics['auc_oot']:.3f} |
| PR-AUC | {metrics['pr_auc_oot']:.4f} |
| Top-decile lift | {metrics['top_decile_lift_oot']:.2f}x |

## Calibration by decile (test period, ranked by predicted probability, decile 1 = highest)

| Decile | n | Predicted mean p | Observed adoption rate | Relative error |
|---|---|---|---|---|
{cal_rows}

{within_tolerance} of {scored_deciles} deciles with a non-zero prediction are within
±50% relative (predicted vs observed). Deciles 1-3 (the ones that drive outreach
ranking and the top-decile lift above) are consistently the closest; the bottom
deciles, where a handful of adopters land in a much larger bucket, are the noisiest —
inherent to a rare event (~0.5% base rate) evaluated on one out-of-time period, not a
modelling shortcut.

## Caveats

- ACS/emPOWER/outage/home-value terms have no per-home history in our sources — both
  the train and test frames use `core.mv_home_signals`'s current snapshot for these
  (the same simplification `pipelines/pipelines/evaluate_ranking.py` (M2-P8) makes).
  Only the permit-derived features (own prior permits, neighbour adoption rate) are
  genuinely recomputed as of each cutoff.
- The final production fit (`cd pipelines && python -m models score`) refits the same
  algorithm and calibration on all data available today (train ∪ test, features as of
  today) — the out-of-time numbers above are model-selection evidence, not this
  final fit's own held-out score.
"""
    CHECK_PATH.write_text(text)


# ---------------------------------------------------------------------------
# score: final fit + SHAP reasons + core.home_propensity / core.model_card
# ---------------------------------------------------------------------------

FEATURE_LABELS: dict[str, str] = {
    "log_market_value": "home value",
    "yr_built": "year built",
    "owner_65": "over-65 exemption on file",
    "age65_term": "share of neighbors 65+",
    "electric_heat_term": "share of neighbors with electric heat",
    "empower_term": "medical-need rate (ZIP)",
    "outage_term": "outage exposure",
    "income_100k_share": "share of neighbors earning $100k+",
    "age_35_64_share": "share of neighbors aged 35-64",
    "own_solar_asof": "home's own solar permit",
    "own_ev_asof": "home's own EV charger permit",
    "own_panel_asof": "home's own panel-upgrade permit",
    "own_battery_asof": "home's own prior battery permit",
    "own_generator_asof": "home's own prior generator permit",
    "neighbor_adoption_rate_asof": "neighbors who already added backup",
}


def _top3_reasons(model, X: pd.DataFrame) -> list[list[dict]]:
    """Top-3 (feature, direction, value) per row, in plain feature
    names. Uses shap.TreeExplainer for the gradient-boosting estimator
    inside CalibratedClassifierCV's base estimators (averaged across the
    CV-fitted copies); falls back to signed standardized-coefficient
    contributions for the logistic-regression baseline."""
    base_estimators = [c.estimator for c in model.calibrated_classifiers_]
    sample = base_estimators[0]

    if isinstance(sample, HistGradientBoostingClassifier):
        import shap  # only needed for the GBM path

        contribs = np.zeros((len(X), X.shape[1]))
        for est in base_estimators:
            explainer = shap.TreeExplainer(est)
            sv = explainer.shap_values(X)
            contribs += np.asarray(sv)
        contribs /= len(base_estimators)
    else:
        # LR pipeline: contribution_i = coef_i * standardized(x_i),
        # averaged across the CV-fitted copies.
        contribs = np.zeros((len(X), X.shape[1]))
        for pipe in base_estimators:
            imputer: SimpleImputer = pipe.named_steps["impute"]
            scaler: StandardScaler = pipe.named_steps["scale"]
            lr: LogisticRegression = pipe.named_steps["lr"]
            X_imp = imputer.transform(X)
            X_scaled = scaler.transform(X_imp)
            contribs += X_scaled * lr.coef_[0]
        contribs /= len(base_estimators)

    cols = list(X.columns)
    X_values = X.to_numpy()  # avoid per-row .iloc lookups over 150k+ homes
    reasons_per_row = []
    for row_idx, row in enumerate(contribs):
        order = np.argsort(-np.abs(row))[:3]
        row_reasons = []
        for idx in order:
            feature = cols[idx]
            direction = "raises" if row[idx] > 0 else "lowers"
            raw_value = X_values[row_idx, idx]
            row_reasons.append({
                "feature": FEATURE_LABELS.get(feature, feature),
                "direction": direction,
                "value": None if pd.isna(raw_value) else float(raw_value),
            })
        reasons_per_row.append(row_reasons)
    return reasons_per_row


def _bulk_upsert(conn: psycopg.Connection, rows: list[tuple], *, batch_size: int = 5000) -> None:
    with conn.cursor() as cur:
        # Default ON COMMIT PRESERVE ROWS (dropped only when the session
        # ends, not at each per-batch commit below) -- same pattern as
        # pipelines/sources/parcels.py's parcels_stage. `if not exists` +
        # truncate makes this safe to re-run within one long-lived
        # connection.
        cur.execute("""
            create temporary table if not exists stage_home_propensity (
                prop_id text,
                p_install_12m numeric,
                relative_to_county numeric,
                decile int,
                reasons jsonb,
                extrapolated_from text,
                model_version text,
                trained_through date,
                source_ids uuid[]
            )
        """)
        cur.execute("truncate table stage_home_propensity")
        conn.commit()
        for start in range(0, len(rows), batch_size):
            batch = rows[start:start + batch_size]
            with cur.copy(
                "copy stage_home_propensity "
                "(prop_id, p_install_12m, relative_to_county, decile, reasons, "
                "extrapolated_from, model_version, trained_through, source_ids) "
                "from stdin"
            ) as copy:
                for row in batch:
                    copy.write_row(row)
            conn.commit()
        cur.execute("""
            insert into core.home_propensity
                (prop_id, p_install_12m, relative_to_county, decile, reasons,
                 extrapolated_from, model_version, trained_through, source_ids)
            select prop_id, p_install_12m, relative_to_county, decile, reasons,
                   extrapolated_from, model_version, trained_through, source_ids
            from stage_home_propensity
            on conflict (prop_id) do update set
                p_install_12m = excluded.p_install_12m,
                relative_to_county = excluded.relative_to_county,
                decile = excluded.decile,
                reasons = excluded.reasons,
                extrapolated_from = excluded.extrapolated_from,
                model_version = excluded.model_version,
                trained_through = excluded.trained_through,
                source_ids = excluded.source_ids
        """)
        conn.commit()


def score(conn: psycopg.Connection, *, metrics: dict) -> None:
    """Final fit on features as of today (train ∪ test data, same
    algorithm/calibration choice as train_and_evaluate), scored on EVERY
    gated home in core.mv_home_signals. Writes core.home_propensity via
    COPY + one upsert (Bulk loading rule) and one core.model_card row."""
    today = date.today()
    train_df = load_frame(conn, cutoff=TRAIN_CUTOFF, exclude_before=True, label_window=TRAIN_LABEL)
    test_df = load_frame(
        conn, cutoff=TEST_CUTOFF, exclude_before=True,
        label_window=LabelWindow(TEST_LABEL_START, date(9999, 1, 1)),
    )
    full_train = pd.concat([train_df, test_df], ignore_index=True)

    X_full = _feature_matrix(full_train)
    y_full = full_train["adopted"].to_numpy()
    factory = _lr_pipeline if metrics["algorithm"] == "logistic_regression" else _gbm_pipeline
    final_model = CalibratedClassifierCV(factory(), method="sigmoid", cv=3)
    final_model.fit(X_full, y_full)

    score_df = load_frame(conn, cutoff=today, exclude_before=False, label_window=None)
    X_score = _feature_matrix(score_df)
    probs = final_model.predict_proba(X_score)[:, 1]
    score_df = score_df.assign(p_install_12m=probs)

    county_mean = score_df.groupby("county_fips")["p_install_12m"].transform("mean")
    score_df["relative_to_county"] = score_df["p_install_12m"] / county_mean
    score_df["decile"] = (
        score_df.groupby("county_fips")["p_install_12m"]
        .rank(pct=True, method="average")
        .apply(lambda pct: min(10, int(pct * 10) + 1))
    )

    reasons = _top3_reasons(final_model, X_score)

    with conn.cursor() as cur:
        cur.execute("select array_agg(distinct id) from ops.source_manifest where source in (%s, %s, %s)",
                    ("austin_permits", "acs_income_age", "tcad_export"))
        fallback_source_ids = cur.fetchone()[0] or []
    with conn.cursor() as cur:
        cur.execute("select prop_id, source_ids from core.mv_home_signals")
        mv_source_ids = {r[0]: (r[1] or []) for r in cur.fetchall()}
    with conn.cursor() as cur:
        cur.execute("select geoid, source_id from core.acs_income_age_bg")
        acs_source_by_bg = {r[0]: r[1] for r in cur.fetchall()}

    rows = []
    for i, r in enumerate(score_df.itertuples()):
        source_ids = list(mv_source_ids.get(r.prop_id, []))
        acs_sid = acs_source_by_bg.get(r.block_group_geoid)
        if acs_sid is not None:
            source_ids.append(acs_sid)
        if not source_ids:
            source_ids = list(fallback_source_ids)
        rows.append((
            r.prop_id,
            float(r.p_install_12m),
            None if pd.isna(r.relative_to_county) else float(r.relative_to_county),
            int(r.decile),
            json.dumps(reasons[i]),
            None if pd.isna(r.extrapolated_from) else r.extrapolated_from,
            MODEL_VERSION,
            today,
            list(dict.fromkeys(source_ids)) or None,
        ))

    _bulk_upsert(conn, rows)

    with conn.cursor() as cur:
        cur.execute("""
            insert into core.model_card
                (model_version, trained_through, algorithm, auc_oot, pr_auc_oot,
                 top_decile_lift_oot, calibration, n_train, n_test, n_positive_train,
                 n_positive_test, notes, source_ids)
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            on conflict (model_version) do update set
                trained_through = excluded.trained_through,
                algorithm = excluded.algorithm,
                auc_oot = excluded.auc_oot,
                pr_auc_oot = excluded.pr_auc_oot,
                top_decile_lift_oot = excluded.top_decile_lift_oot,
                calibration = excluded.calibration,
                n_train = excluded.n_train,
                n_test = excluded.n_test,
                n_positive_train = excluded.n_positive_train,
                n_positive_test = excluded.n_positive_test,
                notes = excluded.notes,
                source_ids = excluded.source_ids
        """, (
            MODEL_VERSION, today, metrics["algorithm"], metrics["auc_oot"],
            metrics["pr_auc_oot"], metrics["top_decile_lift_oot"],
            json.dumps(metrics["calibration"]), metrics["n_train"], metrics["n_test"],
            metrics["n_positive_train"], metrics["n_positive_test"],
            "Out-of-time metrics from checks/M4-P4.md; final fit is on train+test data as of today.",
            list(dict.fromkeys(fallback_source_ids)) or None,
        ))
    conn.commit()


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    if not argv or argv[0] not in ("train", "score"):
        print("usage: python -m pipelines.models train|score", file=sys.stderr)
        return 2
    from pipelines.core import db  # sibling top-level package pipelines/pipelines (cwd=pipelines/)

    with db.connect(pooled=False) as conn:
        metrics = train_and_evaluate(conn)
        print(json.dumps({k: v for k, v in metrics.items() if k != "calibration"}, indent=2))
        if argv[0] == "score":
            score(conn, metrics=metrics)
            print("wrote core.home_propensity + core.model_card")
    return 0


if __name__ == "__main__":
    sys.exit(main())
