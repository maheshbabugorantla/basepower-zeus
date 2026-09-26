# M2-P8: evidence for the ranking signals and default weights (2026-09-26)

## Question

Which signals predict that a home will actually add backup power? The answer sets the default slider weights. The weights remain labelled as a team choice.

## Method: time-split study on real permits

- **Homes:** gate-passed Travis homes inside the City of Austin permit area (`core.mv_home_signals`, backup_intent covered). Homes with a battery or generator permit before 2025-07-01 are excluded. Cohort: **135,083** homes.
- **Signals:** use only data known before 2025-07-01. That covers the home's own earlier solar, EV and panel permits, and its block group's battery+generator permit rate *excluding the home itself*. ACS, emPOWER and TCAD values are as loaded.
- **Outcome:** a battery or generator permit issued between 2025-07-01 and 2026-09-24 (`core.permit_labels`, rules labeller; permits join parcels via `permits.tcad_id = parcels.geo_id`). **734** adopters (0.54%), 467 of them batteries.

## Results

| Signal | Adoption rate, bottom→top quintile (or no→yes) | Lift | Single-signal AUC |
|---|---|---|---|
| Home value (TCAD market value, log) | 0.12% → 1.36% | 11.5× | 0.727 |
| Neighbour adoption (block group, excl. self) | 0.23% → 1.17% | 5.1× | 0.682 |
| Age 65+ share (block group, ACS) | 0.29% → 0.84% | 2.9× | 0.594 |
| Own solar permit | 0.54% → 1.27% | 2.4× | 0.505 (948 homes) |
| Own EV charger permit | 0.54% → 1.25% | 2.3× | 0.502 (401 homes) |
| Own panel-upgrade permit | 0.54% → 1.19% | 2.2× | 0.507 (1,677 homes) |
| Owner 65+ exemption (TCAD) | 0.52% → 0.59% | 1.1× | 0.513 |
| Electric heat share (block group, ACS) | 0.50% → 0.41% | 0.8× | 0.475 |
| Medical need (ZIP, emPOWER) | 0.68% → 0.28% | 0.4× | 0.373 |
| Outage exposure | not testable: every covered home is Austin Energy (one SAIDI value) | — | — |

- **Combined:** the prior equal-weight percentile score scores AUC **0.633**. A logistic model on all signals scores **0.733** (in-sample). Standardized coefficients: home value +0.55, neighbour adoption +0.14, electric heat −0.14, own panel +0.06, own solar +0.06, own EV +0.03, age 65+ +0.03, medical need +0.02, owner 65+ +0.01.

## Outside evidence (for what local data cannot test)

- A major power outage leads to a significant rise in battery purchases over the following quarters: one standard deviation more outage hours raised monthly battery storage capacity by 32% within 3–5 months ([Journal of Public Economics, "The value of electricity reliability: Evidence from battery adoption"](https://www.sciencedirect.com/science/article/pii/S004727272400152X)).
- Frequent outages and higher income predict owning a backup generator or battery ([PMC, "Buying electricity resilience"](https://pmc.ncbi.nlm.nih.gov/articles/PMC10163284/); [JAERE, "Backup Power"](https://www.journals.uchicago.edu/doi/10.1086/730158)).
- Battery adoption shows socioeconomic disparities ([Energy Policy, California](https://www.sciencedirect.com/science/article/abs/pii/S0301421522001021)).

## Default weights (0–10; team choice, based on the above)

outage 8 · home value 8 · neighbour adoption 7 · age 65+ 4 · own solar/EV/panel 4 · installability 2 · electric heat 2 · medical need 2 · owner 65+ 1 · flood (penalty only) 2.

## Caveats

- Permits measure purchases. Base's membership model lowers upfront cost, so home value likely matters less for Base sign-ups than for these purchases. That is why it is not weighted above outage.
- Weighting home value tilts outreach toward wealthier homes. ZIP medical need, kept as a mission signal, tilts the other way. Both are visible sliders.
- In-sample AUC. `python -m pipelines.check ranking` (M2-P8) re-runs this study on the live data for every future weight change.
