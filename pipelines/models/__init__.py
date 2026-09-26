"""M4-P4: calibrated 12-month backup-adoption propensity model.

Real-data only -- every feature and label below comes straight off
core.mv_home_signals / core.permits / core.permit_labels / core.parcels /
core.acs_income_age_bg via a live Postgres connection (POSTGRES_URL_
NON_POOLING). No synthetic rows, no seeded fakes.

    features.py   builds an as-of feature frame (a pandas DataFrame),
                  reusing pipelines/pipelines/evaluate_ranking.py's
                  as-of pattern: permit-derived features (the home's own
                  prior solar/EV/panel/battery/generator permits, and
                  its block group's battery+generator peer rate
                  excluding the home) are recomputed directly from
                  core.permits/core.permit_labels with issue_date before
                  the as-of cutoff -- never from mv_home_signals' own
                  present-day permit columns, which reflect permits up
                  to today regardless of the requested cutoff.
    pipeline.py   out-of-time train/evaluate (writes checks/M4-P4.md),
                  and the final fit + core.home_propensity /
                  core.model_card write (python -m pipelines.models
                  train|score).
"""
