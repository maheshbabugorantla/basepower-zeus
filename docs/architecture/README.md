# Architecture diagrams

Three diagrams, generated with [archify](https://github.com/tt-a1i/archify) (an
HTML diagram generator, MIT license). Each has a `.json` source and a rendered
`.html` file that opens directly in a browser: pan, zoom, theme toggle, and
the "views" listed below act as guided cross-sections of the same diagram.

## Files

| Diagram | Source | Rendered |
|---|---|---|
| System design | `system-design.architecture.json` | `system-design.html` |
| Data pipeline architecture | `data-pipeline.dataflow.json` | `data-pipeline.html` |
| Scoring request flow | `scoring-request-flow.sequence.json` | `scoring-request-flow.html` |

## System design (`system-design.html`)

Two Vercel projects and the credentials each one holds. `base-power-zeus`
(the Next.js web app) reads through `zeus_web_ro`, a Postgres role with
`SELECT`/`EXECUTE` grants only, and signs Storage links with the publishable
key; it never holds a write credential and never calls Gemini.
`base-power-zeus-pipelines` (FastAPI crons plus CLI backfills) holds the
owner role and does the writing: downloading external sources, uploading
raw files to Storage, loading `ops`/`core` tables, and running
`core.refresh_all_scores()`. Gemini (`home_summaries.py`, offline) and
TypeSafe Jev (M1 permit-label spot checks) run only inside the pipelines
project. The two dashed security-group boxes mark that split.

Views: `read-path` (web to database through the read-only role), `pipeline-write-path`
(sources to database through the owner role), `offline-briefing` (Gemini and Jev,
isolated from the web app).

## Data pipeline architecture (`data-pipeline.html`)

Left to right: source, ingest (manifest + raw storage + loader), core tables
plus the materialized-view refresh, the api schema, then web routes. Every
core row carries a `source_id` foreign key into `ops.source_manifest`, so
`/sources/raw/[id]` can resolve any number on screen back to a signed link
for the file it came from.

The refresh order matters: `core.refresh_all_scores()` refreshes
`mv_home_block_group`, `mv_home_signals`, `mv_join_rate`,
`mv_blockgroup_scores`, `mv_top_homes`, then `mv_gate_counts` /
`mv_parcel_gate_counts` / `mv_blockgroup_geojson`, then
`core.refresh_market()` and `mv_gate_counts_by_market` — in that order,
because later views read earlier ones. Anchors and per-county medians
(`core.signal_anchors`, M2-P8) are recomputed last, off the just-refreshed
`mv_home_signals`. Scores are anchored to a fixed 90th-percentile scale,
never ranked by percentile across homes.

The offline-briefing branch (`mv` → Gemini → `core.home_summary` → web) is
separate from the scoring path. `home_summaries.py` is the only module in
the codebase that calls Gemini, it runs on cron/CLI only, and a reply is
stored only if every number in it is grounded in the input facts; otherwise
a deterministic template sentence is stored with `guard_failed=true`.
`core.home_summary` feeds no score term.

Not in this diagram: a predictive propensity model (`core.home_propensity`)
appears in the M4 tickets as planned work, but no such table or pipeline
exists in the code as of this snapshot, so it is left out rather than drawn
as if it shipped.

## Scoring request flow (`scoring-request-flow.html`)

What happens when an analyst drags a weight slider on `/ranking`, in three
segments: table re-rank, map sync, score breakdown.

- Table re-rank: `RankingBoard` debounces 250ms, then `POST /api/top-homes`
  calls `api.homes_ranked_weighted(weights, county_fips, block_group_geoid,
  after_score, after_prop_id, page_size)` — a keyset-paginated function, not
  offset paging. Page 1 also calls `api.homes_ranked_weighted_count` once
  for the total.
- Map sync: the same weights go to `POST /api/blockgroup-scores`, which
  calls `api.blockgroup_scores_weighted` and recolors the choropleth
  through maplibre feature-state. Geometry itself comes from
  `api.blockgroup_geojson`, unchanged by this request.
- Score breakdown: selecting a home calls `GET /ranking/breakdown`, which
  calls `api.home_score_breakdown(prop_id, weights)` for the per-signal
  terms.

Every query in this flow runs as `zeus_web_ro`. That role sets
`default_transaction_read_only = on` and a 15s statement timeout;
`web/lib/db.ts` layers its own pool-level `statement_timeout` (15s) and
`query_timeout` (20s) on top, with at most 3 connections per Vercel
instance. All three routes are `force-dynamic` with `Cache-Control:
no-store`.

No weighted score is precomputed. `core.mv_home_signals` is refreshed on a
schedule and holds raw signal values, percentiles, and anchors; the
`api.*_weighted` functions compute the weighted sum live, at request time,
over that already-refreshed table. This is why a weight change re-ranks
instantly without waiting for a cron.

## Legend

- Solid arrow, default color: a normal read or call.
- Solid arrow, bold: the primary path through that diagram.
- Dashed arrow: an offline or asynchronous path (Gemini briefings, Jev
  labeling), never on the request-time path.
- Security-styled arrow/box: a credential or role boundary.
- Database icon: a Postgres table, materialized view, or schema object.
- Cloud icon: Supabase Storage.
- External icon: something outside this codebase (a data source, Gemini,
  a browser).

## Regenerating a diagram

Install archify once, in a scratch directory (it needs Node ≥18, nothing
else):

```bash
npx -y skills add tt-a1i/archify --skill archify --agent codex --copy --yes
```

This clones the skill into `.agents/skills/archify` in whatever directory
you ran it from. From there, edit the `.json` source in this directory,
then validate and deliver against it directly (`<type>` is `architecture`,
`dataflow`, or `sequence`; use the matching `.json`/`.html` file names from
the table above):

```bash
node <path-to>/archify/bin/archify.mjs validate <type> docs/architecture/<name>.json --quality showcase --json
node <path-to>/archify/bin/archify.mjs deliver  <type> docs/architecture/<name>.json docs/architecture/<name>.html --quality showcase --json
```

`validate` reports layout problems (label overlaps, crossing lines, a font
too small at 1440px) with a suggested fix for each. `deliver` refuses to
write the HTML file until validation is clean, so a bad diagram never
overwrites a good one.
