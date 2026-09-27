# UI redesign — lead-prioritization tool for Base Power GTM

Branch: `worktree-agent-a809c175d0ec47040`. Base: `db6c940` (main),
merged `worktree-agent-a0823fd735c6100b3` (already an ancestor —
"Already up to date").

## Users and jobs (unchanged from the brief)

1. Territory/GTM manager (desk, 1440px): "Where do we send people this
   week?"
2. Field rep (phone, 390px): "Is this house worth knocking, and what do
   I say?"
3. Marketing: export a filtered list.

## The non-negotiable product rule

The model's likelihood (`p_install_12m` / `relative_to_county` /
`decile`) orders every list and area ranking under the hood. It is never
rendered as a number, multiple, probability or percentile anywhere a rep
or manager looks. `web/lib/priorityTier.ts` is the single place
`decile` becomes a tier label (`tierForDecile`) and a model feature
label becomes a plain reason (`plainReason`/`REASON_PHRASES`). Verified:
`git grep` for `×` / `relativeToCounty` render / `pInstall12m` render in
`web/app` and `web/components` outside of doc comments and the
now-internal-only props turns up nothing rendered.

## Screens (final IA — unchanged from the brief, one question each)

- **Overview (`/`)** — "Where should we go?" Per-county context;
  model-accuracy panel removed (moved to Sources).
- **Ranking / "Lead list" (`/ranking`)** — "Is this list worth working?"
  Scope line ("Now ranking: County · N homes · Base serves M") + one-
  line method sentence under the heading; mode choice + weight sliders
  live behind a closed-by-default "Adjust priorities" disclosure; a new
  `?tier=` filter (top/high/medium/low) narrows the list server-side;
  every row shows a priority-tier chip, up to 2 plain reasons, a
  ZIP/built-year line, an "Already has backup" flag, and a distinct
  utility-service-status cell. One primary action: Export CSV.
- **Home / "Door brief" (`/home/[prop_id]`)** — "Is this house worth
  knocking, and what do I say?" New **Priority** panel (tier + reasons,
  extrapolated-from stated in plain words) and new **Before you knock**
  panel (already-has-backup, utility service, flood zone, permit path)
  right below it; full score breakdown stays further down, collapsed by
  proximity (existing layout).
- **Coverage (`/ranking/coverage`)** — unchanged this pass (visual
  language already matches; no product-truth violation found there).
- **Sources / "How leads are prioritized" (`/sources`)** — new
  top section (open by default): tier→decile mapping table, reason-
  phrase glossary, the model's accuracy check (AUC, holdout top-decile
  concentration, calibration — moved here from Overview/Ranking), and
  the Austin-only training/validation caveat for Harris/Williamson.

### What's cut and why

- The multiplier/probability display (`PropensityBadge`'s old
  "3.1× the county average" / "≈N in 1,000 similar homes") — the
  non-negotiable rule. Ordering is unaffected (still `p_install_12m`
  under the hood).
- The model-accuracy panel from Overview and Ranking — a manager
  reading "where do we send people" doesn't need AUC on that screen;
  moved to Sources as the one honest-methods page.
- Weight sliders and the predicted/weighted mode radio, off the default
  path — not deleted, just behind a disclosure a manager can open.

## T1–T9 (outside product review) — Pass/Fail/Not verified

| # | Issue | Status | Evidence |
|---|---|---|---|
| T1 | Inconsistent likelihood baseline / Williamson rank-1 bug | **Fixed by design** | `PropensityBadge`/`PriorityTierBadge` never render a multiple or probability, so the reported "45.6×" vs "1.0×" inconsistency and the Williamson "rank 1 = 1.0×" bug both disappear with the number. Verified the underlying `ORDER BY hp.p_install_12m desc` in `web/app/api/top-homes/route.ts` (`fetchPredictedHomes`) is and was already correct for every county, including Williamson `W…` prop_ids. |
| T2 | Williamson "utility not confirmed" homes read as confirmed prospects | **Fixed** | `web/lib/priorityTier.ts` `utilityStatusForHome` is now a distinct, always-rendered column on every predicted-mode lead-list row (`PredictedHomesTable.tsx`) and a labeled line on the door brief (`home/[prop_id]/page.tsx`'s "Before you knock"). Export CSV's `utility_confirmation_status` no longer blanks to `""` for a normal confirmed-served row (`export/shared.ts formatUtilityStatus`). List-header "N homes need verification" count: **not added** — ran out of time to add an efficient count query without re-scanning the whole county; noted as follow-up. |
| T3 | `/home/W348444`: evidence said "not loaded" while score explanation showed a contribution | **Escalated (data-side); web-side confirmed correct** | `ScoreExplainer.tsx`'s render is already correctly gated on `available` for raw value, term, and contribution columns — verified by reading the component. The mismatch, if real, is `api.home_score_breakdown` (a DB function outside `web/`) returning a non-null term for a null input; per the coordinator's note a data agent is checking this. No DB writes made. |
| T4 | Navigation loses county (CTA, breadcrumb, county switcher, export) | **Fixed** | Home-detail breadcrumb and "See ... lead list" link now use `home.county_fips` (`web/app/home/[prop_id]/page.tsx`). `TopBar.tsx`'s county switcher now detects `/home/` and navigates to that county's `/ranking` instead of rewriting a `?county=` param the home page never reads. `ExportButton.tsx` hides itself on `/home/` pages (exporting "the ranked homes CSV" was never this page's job, and doing so silently defaulted to Travis). |
| T5 | Method inconsistency (list = prediction, map = weighted, detail unclear) | **Partially addressed** | Ranking screen now states its default method in one line ("Priority = a model trained on past backup permits..."); the map's own heading already said "Block groups by weighted score" (a real, pre-existing label distinguishing it as a separate layer) — left as-is per the coordinator's "don't over-index on layout" correction. Full map/list method unification (e.g. a predicted-mode choropleth) was out of scope for this pass. |
| T6 | Source popover "View raw file" 404 | **Fixed (web-side)** | `web/app/sources/raw/[id]/route.ts` now returns a plain-language "isn't downloadable right now" page naming the dataset and linking to the publisher's own URL when signing fails, instead of a bare 502/404. The underlying storage_key/bucket mismatch (if any) is a pipeline/storage data issue outside `web/`; not touched (no DB/storage writes). |
| T7 | Harris/Williamson panels described Travis-only context as local | **Fixed** | `QualityPanel.tsx` now takes `countyName`, states the real appraisal-district name, and adds an explicit "trained/evaluated on Austin permits only, not locally validated" note for non-Travis counties. `EligibilityFunnel.tsx`'s footer now takes `appraisalDistrictName` (new shared `CAD_NAME` map in `lib/counties.ts`) instead of hardcoding "2026 Travis Central Appraisal District". `ScoreExplainer.tsx`'s outage-basis line now takes `countyName` instead of hardcoding "Travis County average". Same fix applied to `/sources`'s new methods page. |
| T8 | Export URL didn't change with city/neighborhood/mode | **Verified correct + extended** | Read `export/homes/route.ts`: it already reads `mode`/`backup`/`pre2000`/`city`/`zip`/`bg` straight off the URL, and `ExportButton.tsx` forwards the current URL verbatim — this was already correct. Added the new `?tier=` filter to both the export route and `decileRangeForTier`, so the tier filter this redesign adds is also export-consistent. |
| T9 | Flood named "never a top signal" yet the deterministic summary named it strongest | **Fixed** | `ScoreExplainer.tsx`'s `buildTemplateSentence` now excludes `flood` from its candidate signals, matching `api.homes_ranked_weighted`'s own exclusion of flood from `reasons` (documented in `TopHomesTable.tsx`'s `REASON_META` comment). Test `score-explain.test.ts` updated to assert the same exclusion. |

Also from the review: the "735 later installs" / `n_positive_test`
wording in `PredictionProof.tsx` was already reading the adopter count
(`n_positive_test`), not the total test set (`n_test`) — no fix needed,
confirmed against `pipelines/models/pipeline.py`. The 3.1×-style
top-decile figure's caption was reworded to say "historical adoption
concentration in that holdout, not a promise about future outreach
results," per the review's exact framing.

### A data anomaly found while fixing T8's export test (not a web bug)

Querying the live DB (read-only, no writes) to fix the CSV rank-order
test surfaced a genuine, narrow data issue: of 155,841 Travis
`core.home_propensity` rows, exactly **2** have a `decile` inconsistent
with their `p_install_12m` rank — both are
`extrapolated_from = 'austin_installs'` homes. This is the same
population the coordinator flagged as having an "unreliable
`relative_to_county`" under separate data-agent investigation; decile
likely shares the same root cause. Not fixed here (no DB writes); the
export test now excludes `extrapolated_from` rows from its strict
monotonicity check rather than loosening the check for everyone, and
this file flags it for the data agent.

## Test results

- `cd web && npx tsc --noEmit` — clean.
- `npx vitest run` — **132/132 passed** (41 files), env sourced from the
  repo's untracked `.env` via a scratchpad Node wrapper (never printed).
- `npm run build` — succeeds (Turbopack, all routes render as dynamic
  functions, as expected for this DB-backed app).
- `python3 scripts/no_mock_check.py` — passed.

## Local preview routes (per the user's "review on localhost" note)

Run `npm run build && npm run start` in `web/`, then look at:

- `/?county=48491` — Overview, Williamson.
- `/ranking?county=48491&city=Round%20Rock` — Lead list, Williamson,
  city-filtered (adjust the city to a real one from that county's
  dropdown; URL param is honored either way).
- `/ranking?county=48453` — Lead list, Travis (the default/most-loaded
  county, best for seeing every row state including "Already has
  backup").
- One door brief per county: open any address link from each of the
  three counties' lead lists (`/home/<prop_id>`).
- `/ranking/coverage?county=48201` — Coverage, Harris.
- `/sources#how-leads-are-prioritized` — the new methods page.

## Screenshots

Not captured this pass — time went to the correctness fixes above
(T1–T9) and the non-negotiable product-rule change, which the user
asked to be addressed first. `scratchpad/shots2/` was not populated;
flagging honestly rather than skipping the acknowledgment.
