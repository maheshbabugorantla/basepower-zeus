# Apply order — data-fixes branch (0307 batched scoring, 0305 PUCT CCN, 0306 eligibility fix)

Built by merging `perf/scoring-batched-refresh` (0307_batched_scoring_*),
`worktree-agent-ac350cf7a06df536c` (0306_eligibility_fix.sql), and
`worktree-agent-ad1861480a870dd31` (0305_puct_ccn.sql) onto `main`
(db6c940) on branch `data-fixes`.

**Numbering note:** filenames are 0305 < 0306 < 0307 but the SAFE apply
order is 0307 (build+swap) → 0305 (puct_ccn) → 0306 (eligibility_fix) →
0307-drop. This is intentional, not a mistake: 0307's build/swap only
touches `core.mv_home_signals`/`core.mv_home_terms` (turns them from MVs
into plain upserted tables) and has no dependency on 0305 or 0306. 0305
only adds `core.electric_ccn`/`core.electric_ccn_crosswalk` and is
independent of both. 0306 rebuilds `core.mv_home_block_group` and the
permit-rate scoring MVs (`mv_blockgroup_scores`/`mv_top_homes`/
`mv_blockgroup_geojson`) — it does NOT reference `mv_home_signals`/
`mv_home_terms` at all, so it is safe to run before or after 0307. Doing
0307 first lets the parity check (step b) run against the smallest
possible blast radius (a pure mechanical MV→table conversion) before any
data-correctness change lands. Files were left at their original names
(0305/0306/0307) rather than renumbered, to avoid rewriting cross-file
comment references across 6 files under this task's read-only-DB, no-risk
mandate — treat this doc's step letters, not the filenames, as the order
of truth.

Real numbers referenced below (read-only, live DB, 2026-09-26):
`core.mv_home_signals` 805 MB, `core.mv_home_terms` 296 MB,
`core.mv_home_block_group` 178 MB, `core.home_spatial` 692 MB,
`core.parcels` 311 MB, DB total 4719 MB. Disk budget 12 GB, WAL budget
~2.5 GB. Prior real `home_spatial` full-county runs (`ops.pipeline_runs`):
Williamson (48491) 158,475 rows / 61 s; Travis (48453) 441,961 rows /
158 s; Harris (48201) 836,310 rows / 314 s. Prior MV-style `refresh_scores`
full runs at the OLD (pre-0307) row count of ~241k took up to 42 min —
this is exactly why 0307 exists; at the CURRENT 1.44M-parcel scale the old
MV-refresh approach would not finish inside a 300 s Vercel function.

Run every step with `psql -v ON_ERROR_STOP=1 -f <file>` against
`POSTGRES_URL_NON_POOLING` (session pooler, port 5432 — required for
migrations per CLAUDE.md). Stop immediately on any non-zero exit; do not
proceed to the next step.

## Step a — 0307 batched scoring: build + swap

```
psql "$POSTGRES_URL_NON_POOLING" -v ON_ERROR_STOP=1 -f supabase/migrations/0307_batched_scoring_build.sql
psql "$POSTGRES_URL_NON_POOLING" -v ON_ERROR_STOP=1 -f supabase/migrations/0307_batched_scoring_swap.sql
```

Builds `core.mv_home_signals_v2`/`core.mv_home_terms_v2` as plain tables
(verbatim copy of the current MV contents), then renames the old MVs to
`*_pre_batched` and the new tables into the live names.

- **Estimated time:** copying ~1.44M rows across two ~1.1 GB source MVs
  plus building their indexes — 3–6 min.
- **Peak extra disk:** ~1.1–1.4 GB (new tables) while both old MVs and
  new tables coexist, before step g drops the old copies. Well inside
  the 12 GB / ~7 GB-free budget.

## Step b — PARITY CHECK (read-only, must be 0 rows both ways)

Run `scoring_refresh`'s per-home SELECT (no upsert — pass a dry-run/
`--check-only` flag, or wrap the query in a temp view) against the
unchanged inputs from step a, and diff every column against the
pre-swap copy:

```sql
-- against core.mv_home_signals_pre_batched / core.mv_home_terms_pre_batched
-- (the renamed originals) vs. the just-built core.mv_home_signals / core.mv_home_terms.
-- Exclude volatile metadata columns (refreshed_at, run_id) from the column list.
select prop_id, county_fips, block_group_geoid, gate_reason, territory_eia_id,
       territory_null_reason, territory_basis, market_value, situs_zip
from core.mv_home_signals
except
select prop_id, county_fips, block_group_geoid, gate_reason, territory_eia_id,
       territory_null_reason, territory_basis, market_value, situs_zip
from core.mv_home_signals_pre_batched;

-- and the reverse direction:
select prop_id, county_fips, block_group_geoid, gate_reason, territory_eia_id,
       territory_null_reason, territory_basis, market_value, situs_zip
from core.mv_home_signals_pre_batched
except
select prop_id, county_fips, block_group_geoid, gate_reason, territory_eia_id,
       territory_null_reason, territory_basis, market_value, situs_zip
from core.mv_home_signals;

-- repeat both directions for core.mv_home_terms / core.mv_home_terms_pre_batched
-- with its own (non-metadata) column list.
```

Both `EXCEPT` queries must return **0 rows**. If `scoring_refresh` skips
unchanged rows via a hash/dirty flag, force a full recompute for this
check (real-data rule: this is a verification pass, not evidence unless
every row was actually recomputed).

- **Estimated time:** two `EXCEPT` scans over ~1.44M rows, ~1–2 min each,
  under 10 min total.
- **Peak extra disk:** temp sort/hash spill for `EXCEPT` on wide columns —
  budget ~1 GB of `work_mem`/temp; do NOT let it spill to the 8 GB disk
  floor the way the earlier M3-P6 CTE incident did (see `beba1b0`/`ff3acbc`
  commit messages) — set `work_mem` conservatively per-session, not
  globally.

**If parity fails, stop.** Do not proceed to steps c–h until the
`scoring_refresh` per-home query is fixed to match `0304b2`'s
`mv_home_signals` definition exactly.

## Step c — 0305 PUCT CCN load

```
psql "$POSTGRES_URL_NON_POOLING" -v ON_ERROR_STOP=1 -f supabase/migrations/0305_puct_ccn.sql
python3 -m pipelines.run puct_ccn
```

Creates `core.electric_ccn` / `core.electric_ccn_crosswalk` and loads the
downloaded PUCT CCN boundary geojsons (`data/raw/puct_ccn/*.geojson`,
~32 MB combined) plus the crosswalk seed.

- **Estimated time:** DDL + geometry load for 3 geojsons (~32 MB raw,
  higher after PostGIS geometry expansion) — 2–4 min.
- **Peak extra disk:** ~150–300 MB (new tables + spatial indexes).

## Step d — 0306 eligibility fix

```
psql "$POSTGRES_URL_NON_POOLING" -v ON_ERROR_STOP=1 -f supabase/migrations/0306_eligibility_fix.sql
```

Rebuilds `core.mv_home_block_group` (county-scoped block-group match,
new `block_group_null_reason`) and the permit-rate scoring MVs
(`mv_blockgroup_scores`/`mv_top_homes`/`mv_blockgroup_geojson`) that key
off it. Independent of `mv_home_signals`/`mv_home_terms` (0307) — safe
regardless of step-a having run.

- **Estimated time:** ~178 MB source MV rebuild + 3 dependent MV rebuilds
  — 2–4 min.
- **Peak extra disk:** ~200–350 MB while `mv_home_block_group_pre_0306`
  and the new copy coexist (this migration drops the pre-0306 copy at
  its own end — confirm that DROP actually ran before step g).

## Step e — home_spatial reruns

```
python3 -m pipelines.run home_spatial --county 48491   # Williamson — territory CCN resolution
python3 -m pipelines.run home_spatial --county 48453   # Travis — territory CCN resolution
python3 -m pipelines.run home_spatial --county 48201   # Harris — only ~110 cross-county BG rows rewrite
```

`--county` must be added to `pipelines/pipelines/run.py`'s `home_spatial`
subcommand if not already present (typed `%(county)s::text` param, same
pattern as the keyset fix). `input_hash` only changes for rows whose
territory or block-group inputs actually changed, so the upsert writes:
all of Williamson/Travis (new CCN resolution replaces the old
withheld/HIFLD answers for essentially every row) and only the ~110
Harris rows the county-scoped BG fix actually corrects.

- **Estimated time (from real prior full-county runs in
  `ops.pipeline_runs`):** Williamson ~60 s, Travis ~160 s. Harris scans
  all 836,310 rows to find the ~110 changed ones — same scan cost as a
  full run, ~5 min, but a near-zero write. Total ~7–8 min.
- **Peak extra disk:** upsert dead tuples, roughly proportional to rows
  *written* (Williamson+Travis full county ≈ 600k rows ≈ ~300 MB of
  `core.home_spatial`'s 692 MB total; Harris's 110 rows are negligible).
  Budget ~350–400 MB extra until step h's vacuum.

## Step f — scoring_refresh (batched), timed

```
time python3 -m pipelines.sources.scoring_refresh --county 48491
time python3 -m pipelines.sources.scoring_refresh --county 48453
time python3 -m pipelines.sources.scoring_refresh --county 48201
time python3 -m pipelines.sources.scoring_refresh  # remaining counties, unaffected — should write ~0 rows
```

Recomputes `core.mv_home_signals`/`core.mv_home_terms` for the counties
whose `home_spatial` inputs changed in step e, in Vercel-Hobby-sized
batches (well under 300 s per invocation per CLAUDE.md).

- **Estimated time:** proportional to rows written, not rows scanned —
  Williamson+Travis (~600k) + Harris (~110) ≈ 4–8 min total, a small
  fraction of the old 42-minute full MV refresh at a third the row count.
- **Peak extra disk:** batched upsert dead tuples, ~200–400 MB.

## Step g — drop old copies

```
psql "$POSTGRES_URL_NON_POOLING" -v ON_ERROR_STOP=1 -f supabase/migrations/0307_batched_scoring_drop_pre_batched.sql
```

Drops `core.mv_home_signals_pre_batched` / `core.mv_home_terms_pre_batched`
(≈1.1 GB reclaimed). 0306's own pre-0306 block-group copy is already
dropped inside 0306_eligibility_fix.sql (step d) — verify with
`select 1 from pg_class where relname = 'mv_home_block_group_pre_0306'`
(expect 0 rows) before considering step g's disk math final.

- **Estimated time:** <1 min (DROP MATERIALIZED VIEW is metadata-only
  until the next checkpoint).
- **Disk freed:** ~1.1 GB (plus 0306's already-freed ~178 MB from step d).

## Step h — vacuum

```
psql "$POSTGRES_URL_NON_POOLING" -v ON_ERROR_STOP=1 -c "vacuum (analyze) core.home_spatial;"
psql "$POSTGRES_URL_NON_POOLING" -v ON_ERROR_STOP=1 -c "vacuum (analyze) core.mv_home_signals;"
psql "$POSTGRES_URL_NON_POOLING" -v ON_ERROR_STOP=1 -c "vacuum (analyze) core.mv_home_terms;"
```

Reclaims the dead-tuple bloat from steps e/f's upserts (no `VACUUM FULL`
— would take an exclusive lock and needs as much free space as the table
itself, risky at 800 MB+ under a 12 GB ceiling).

- **Estimated time:** 1–3 min.
- **Peak extra disk:** none (plain `VACUUM` is disk-neutral to slightly
  disk-freeing).

## Running total

Peak simultaneous extra disk across all steps (worst case, steps don't
overlap): ~1.4 GB (step a) is the single largest transient add, well
under the ~7 GB currently free (12 GB disk − 4.7 GB DB). WAL generated
per step is bounded by rows *written*, not scanned — the two largest
writers (step a's table build, step e/f's Williamson+Travis upserts) are
each well under the ~2.5 GB WAL budget individually; do not run steps a
and e/f concurrently.

## Gate-reason semantics (territory)

`core.home_spatial.territory_gate_reason` (surfaced verbatim as
`gate_reason` in `mv_home_signals`/`scoring_refresh`) already treats the
new CCN null reasons correctly, confirmed by reading the merged
`ccn_resolved` CTE in `pipelines/sources/home_spatial.py`:

- `no_ccn_match`, `ccn_holder_unmapped`, `multiply_certificated` →
  `territory_gate_reason = NULL` (never gated out — ranked, shown as
  "territory unconfirmed" via `territory_null_reason`, not excluded from
  the ranking the way `territory_not_base_served` is). This matches
  Williamson's pre-existing `utility_not_confirmed` treatment: unconfirmed
  ≠ not served.
- Only a unanimous "no" among CCN holders sets
  `territory_gate_reason = 'territory_not_base_served'` (gated out) — the
  same bar as the pre-existing HIFLD path.

No code change was needed for this; it was already implemented this way
on `worktree-agent-ad1861480a870dd31`, verified here by reading the
merged SQL rather than assumed.
