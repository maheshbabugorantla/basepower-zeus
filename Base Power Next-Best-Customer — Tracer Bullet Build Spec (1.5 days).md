# Base Power Next-Best-Customer — Tracer Bullet Build Spec (1.5 days)

Sep 25, 2026 · @Sree

## Goal and the real-data rule

In 1.5 days, four people and one Claude Code orchestrator ship a Vercel-hosted web app that ranks Texas homes and neighborhoods for Base Power outreach. It runs on real public data only, and every number on screen links back to its source file.

**The question the app answers:** which single-family homes inside Base's current service area should Base approach next, and why?

**Scope:**

- Texas only. Illinois (ComEd) is out of scope for this sprint.
- One pilot county first, then two more.
- Homes are ranked on four real-data signals: outage exposure, grid value, installability, and household fit.

**The real-data rule.** These four constraints apply to every milestone:

1. **Traceable.** Every row in the database traces to a downloaded source file. The file is recorded with its URL, retrieval time, and SHA-256 checksum.
2. **Nothing invented.** No synthetic rows, no hard-coded sample arrays, no placeholder values, no seeded fakes in tests. Tests run against real extracts.
3. **Missing means empty.** If a dataset is not loaded yet, its feature is null with a reason, and the UI shows it as not loaded. It never shows an estimate.
4. **No made-up dollars.** Base's internal numbers (conversion rates, acquisition cost, margin) are not public, so the score leaves those terms out rather than guessing them. The only dollar values shown are ERCOT market prices.

Scoring weights are team choices, not data. The UI shows them as labeled, adjustable parameters.

## Tracer-bullet approach

Each milestone is a thin vertical slice that works end to end before the next one widens it: real file in, map and ranked list out, with a passing test.

The method comes from [Tracer Bullets: Keeping AI Slop Under Control](https://www.aihero.dev/tracer-bullets) (Matt Pocock, AI Hero), which borrows the term from *The Pragmatic Programmer*. The loop is short:

1. Build a small feature end to end.
2. Test it immediately.
3. Get feedback.
4. Start the next slice in a fresh context window.

The failure it prevents: building whole layers in isolation, then finding at integration time that the pieces don't fit.

**Rules for this build**

- **Every milestone touches all four layers:** Python pipeline → Supabase → `api` views → Next.js on Vercel. No milestone ships a layer by itself.
- **Grow width, not depth.** M1 uses one county and one dataset per layer. Later milestones add datasets or counties, never a new layer.
- **Tickets are slices of the slice.** Each milestone splits into tickets that build independently against a schema contract. The milestone's V ticket is where the bullet lands.
- **Done means deployed.** A milestone passes only when its V ticket passes on a Vercel preview, against real data in Supabase.
- **Five-minute demo at every gate.** Feedback comes before the next milestone starts.
- **Fresh context per ticket.** Each ticket runs in its own Sonnet 5 subagent, which starts with a fresh context window. The tracer-bullet prompt from the article lives in `CLAUDE.md`, which every subagent loads.

## Team and 1.5-day schedule

Four people plus one orchestrator session, six milestones, about 13 working hours: Day 1 runs 09:00–19:00 and Day 2 runs 09:00–13:00.

**Pilot county: Travis County.** Three reasons:

1. Austin publishes a live, daily-refreshed permit feed through a public API ([Issued Construction Permits, dataset 3syk-w9eu](https://data.austintexas.gov/Building-and-Development/Issued-Construction-Permits/3syk-w9eu)). The same feed covers the city's ETJ and several neighboring cities that share permitting.
2. Permit records carry TCAD property IDs, so they join to parcels without address matching.
3. Austin Energy is on [Base's service list](https://www.basepowercompany.com/pricing.md), while co-op areas elsewhere in the county give the eligibility gate a real test.

Other big Texas cities are weaker bets for a 1.5-day build. A permit-data vendor reports that Houston stopped publishing permit activity reports on 2025-12-01 and that Dallas's open permit feed stops at December 2019 ([source](https://apify.com/oldbie/PermitScraper1)). Verify both in M0 before relying on them.

**Second county (M3): Harris.** It adds CenterPoint territory, the LZ\_HOUSTON pricing zone, and Hurricane Beryl outage history. Its permit features stay null with the reason "no public feed".

### Owners

| Person | Domain | Reviews tickets | Human tickets |
| --- | --- | --- | --- |
| P1 — Grid & Outage | Outage exposure, grid value, territory gate | EAGLE-I, ERCOT, and territory pipelines | Utility crosswalk, load-zone table, address-checker test |
| P2 — Codes, Permits & Installability | Permit signals, permitting-authority facts, flood flag | Permit, FEMA, and backtest pipelines | Permit hand labels, authority facts, channel recommendations |
| P3 — Household & Demand | Parcel universe, household fit, medical need | Parcel, TIGER, ACS, and emPOWER pipelines | TCAD spot checks, T0 parcel field inventory |
| P4 — Orchestrator operator | Runs the orchestrator session; owns schema, platform, and web | All S, D, and W tickets; every merge decision on a blocked ticket | T0 accounts and projects; gate demos |

### Schedule

| When | Milestone | Gate demo (5 min) |
| --- | --- | --- |
| Day 1 09:00–09:30 | T0: register accounts, start big downloads | Every access item in the M0 checklist is green or has a named owner |
| Day 1 09:30–10:30 | M0 Walking skeleton | Travis outage hours from EAGLE-I on screen, with a link to the source file |
| Day 1 10:30–13:00 | M1 First ranked list, one county | Map of Travis block groups plus top 50 homes, each traceable to a parcel and permit rows |
| Day 1 13:45–16:30 | M2 Gate + need signals | Ineligible parcels drop out; weight sliders re-rank live |
| Day 1 16:30–19:00 | M3 Second county + grid value | Travis vs Harris ranked on one map; ERCOT spread shown in $/MWh |
| Day 2 09:00–11:15 | M4 Installability + backtest | Permitting-authority panel; the ice-storm backtest result is shown, whatever it says |
| Day 2 11:15–13:00 | M5 Go-to-market readout | Ranked export with reason codes; readout run in the app itself |

Buffer: lunch on Day 1 (13:00–13:45) is the only slack. If a milestone overruns by more than 30 minutes, cut scope inside it. Never skip its acceptance test.

## Architecture: Vercel + Python pipelines + Supabase

Two Vercel projects from one repo, both connected to one Supabase project. The Next.js web app reads Supabase; the Python pipelines app writes to it on a schedule. Every tracer bullet is verified on a Vercel preview URL, not on a laptop.

| Piece | Runs on | Tech | Talks to |
| --- | --- | --- | --- |
| Web app | Vercel project `web` | Next.js (App Router), MapLibre GL JS | Supabase, server-side only, through views in the `api` schema |
| Pipelines | Vercel project `pipelines` (Python runtime) | FastAPI app, one endpoint per source, triggered by Vercel Cron | Supabase Postgres (pooled connection) and Storage |
| Database | Supabase, Pro plan | Postgres + PostGIS; schemas `ops`, `core`, `api` | — |
| Raw files | Supabase Storage, private bucket `raw` | Objects stored unchanged, keyed by source, date, and SHA-256 | — |
| Schema | `supabase/migrations/` | Supabase CLI (`supabase db push`) | — |
| Agents and tickets | `.claude/agents/`, `tickets/` | Claude Code | GitHub → Vercel preview deploys |

**Data flow**

1. Vercel Cron (or the orchestrator, for backfills) calls `pipelines /cron/<source>`.
2. The pipeline downloads the source and uploads the raw file unchanged to Storage.
3. It writes an `ops.source_manifest` row: URL, retrieval time, SHA-256, bytes, rows, and runner.
4. It loads the `core` tables, then records an `ops.pipeline_runs` row.
5. The web app reads only `api` views. Every view row carries its `source_id`s, so provenance is enforced in the database, in one place.

**Connection.** Install Supabase from the [Vercel Marketplace](https://docs.vercel.com/marketplace/supabase) on both Vercel projects. It syncs these environment variables:

- `POSTGRES_URL` and `POSTGRES_URL_NON_POOLING`
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`

**Security rules**

- Row-level security is on for every table, with no anon policies.
- The web app queries Supabase only from server components and route handlers, using the service-role key. No `NEXT_PUBLIC_` key is ever used for data.
- Pipelines write through `POSTGRES_URL`.
- Cron endpoints reject any request without the `CRON_SECRET` bearer token.

**Vercel limits that shape the pipelines.** Python functions allow a 500 MB bundle. Maximum duration is 300 s on Hobby and 800 s on Pro, with a 30-minute extended maximum in beta; memory is 2 GB on Hobby and 4 GB on Pro ([limits](https://vercel.com/docs/functions/limitations), [Python runtime](https://vercel.com/docs/functions/runtimes/python)). So:

- Use **Vercel Pro**.
- **Every backfill is chunked.** Each call processes one page range (parcels, permits) or one streamed file (EAGLE-I year), saves its cursor in `ops.pipeline_runs`, and returns. The next call resumes from the cursor.
- **Fallback:** if a single file cannot finish inside one function call, the orchestrator runs the same entrypoint from the CLI (`python -m pipelines.run <source> --backfill`). It writes the same tables and marks `runner = cli` in the manifest.

**Schedules** (in `pipelines/vercel.json`)

- Daily: Austin permits, ERCOT prices.
- Monthly: emPOWER.
- Backfill only: parcels, TIGER, EAGLE-I, ACS, FEMA, territories.

**Repo layout**

```text
web/                    Next.js app (Vercel project "web")
pipelines/              FastAPI app (Vercel project "pipelines")
  sources/<name>.py     one module per dataset: fetch → raw → manifest → load
  transforms/*.sql      core tables, scores, api views
supabase/migrations/    schema contract, owned by schema tickets only
tickets/M0 … M5/        one markdown file per ticket
.claude/agents/         subagent definitions (Sonnet 5)
checks/                 human check logs
scripts/                no_mock_check.py, dag.py
```

**Google Solar API.** A web route handler, `/api/solar/[prop_id]`, calls it on demand for the one home being viewed. It returns the response live and never stores it, because Google's terms limit caching.

## Orchestrator and subagents

One Claude Code session is the orchestrator. It reads a milestone's ticket files, orders them by dependency, and hands each ready ticket to a Sonnet 5 subagent working in its own git worktree. It merges only work that passes acceptance, one wave at a time. The orchestrator never writes application code itself.

**How a milestone runs**

1. **Build the graph.** The orchestrator runs `scripts/dag.py tickets/Mn/`. The script builds the graph from each ticket's `depends_on` and prints the waves. It fails on a cycle, or on two tickets in the same wave whose `owns` paths overlap.
2. **Dispatch a wave.** Wave *k* is every ticket whose dependencies are already merged. The orchestrator spawns one subagent per ticket, in parallel. Claude Code allows 20 concurrent subagents by default; no wave here exceeds 7.
3. **Build the ticket.** Each subagent works in `isolation: worktree`, edits only its `owns` paths, runs its own acceptance commands, and reports back: branch, files changed, command output.
4. **Verify and merge.** A `verifier` subagent re-runs that ticket's acceptance on the branch.
   - Pass: the orchestrator squash-merges it to `main`.
   - First fail: the orchestrator resumes the same subagent once, with the failure output.
   - Second fail: the ticket is marked blocked and its reviewer is pinged.
5. **Merge before the next wave.** Worktree subagents branch from the default branch, not from the orchestrator's `HEAD` ([Claude Code docs](https://code.claude.com/docs/en/sub-agents)). So wave *k*+1 starts only after wave *k* is on `main`.
6. **Land the tracer bullet.** The milestone's last ticket, V, deploys a Vercel preview and runs the milestone acceptance end to end. Then the team runs the 5-minute gate demo.

**Why tickets build independently: contracts come first.** Wave 1 of every milestone is a schema ticket: migrations plus the `api` view definitions. When needed, a platform ticket joins it. Later tickets depend only on those contracts, never on code from a ticket in the same wave.

Web tickets test against the real views. Before pipelines load anything, a page must render the honest "not loaded" state; the V ticket then checks real numbers. No ticket may fake data to unblock itself.

**Human tickets.** Tickets with IDs ending in `H` are done by people: hand labels, spot checks, the utility crosswalk. They sit in the same graph. A person closes one by committing `checks/<ticket-id>.md`, and the orchestrator waits for that file.

**Subagent roster.** All roster agents are pinned to `model: claude-sonnet-5` in `.claude/agents/`.

| Agent | Builds | Tools | Isolation |
| --- | --- | --- | --- |
| `schema-dev` | Migrations, `api` views, SQL scoring functions, RLS | Read, Write, Edit, Bash, Grep, Glob | worktree |
| `pipeline-dev` | One `pipelines/sources/<name>.py` module, its cron route, its tests | Read, Write, Edit, Bash, Grep, Glob | worktree |
| `web-dev` | Next.js pages, components, route handlers | Read, Write, Edit, Bash, Grep, Glob | worktree |
| `platform-dev` | Scaffold, `vercel.json`, CI, environment variable names, deploys | Read, Write, Edit, Bash, Grep, Glob | worktree |
| `verifier` | Nothing: runs acceptance, deploys previews, runs read-only queries | Read, Grep, Glob, Bash | none |

**Example subagent file:** `.claude/agents/pipeline-dev.md`

```markdown
---
name: pipeline-dev
description: Builds one pipeline ticket end to end. Use for tickets with agent pipeline-dev.
tools: Read, Write, Edit, Bash, Grep, Glob
model: claude-sonnet-5
isolation: worktree
maxTurns: 80
---
You build exactly one ticket. Read the ticket file you are given first.
Edit only paths listed under owns. Files under contract_in are read-only.
Never generate synthetic, sample, mock, or placeholder data, including in tests.
If a source fails to download, stop and report it. Do not substitute values.
Build the thinnest slice that fills the contract_out tables, then run every Acceptance command.
Return: branch name, files changed, last 40 lines of each Acceptance command.
```

**Orchestrator file:** `.claude/agents/orchestrator.md`. Start it with `claude --agent orchestrator`, then say `Run milestone M1`.

```markdown
---
name: orchestrator
description: Runs one milestone's ticket graph wave by wave.
tools: Agent(schema-dev, pipeline-dev, web-dev, platform-dev, verifier), Read, Bash, Grep, Glob
---
1. Run python scripts/dag.py tickets/<milestone>/ and stop on any error.
2. For each wave, spawn one subagent per ticket in parallel, passing only the ticket path.
   Skip H tickets; wait until checks/<id>.md exists on main.
3. For each result, spawn verifier on its branch. Squash-merge passing branches to main.
   Resume a failed subagent once with the failure output; after a second failure, mark it blocked.
4. Start the next wave only after every ticket in this wave is merged or blocked.
5. After the last wave, spawn verifier with the milestone's V ticket.
6. Report a table: ticket, status, branch, acceptance summary. Never edit application code.
```

**Ticket file format:** `tickets/M1/M1-P3.md`

```markdown
---
id: M1-P3
milestone: M1
title: Austin permits pipeline and classifier
agent: pipeline-dev
depends_on: [M1-S1]
owns: [pipelines/sources/austin_permits.py, pipelines/tests/test_austin_permits.py]
contract_in: [supabase/migrations/0101_m1.sql]
contract_out: [core.permits, core.permit_labels]
reviewer: P2
---
## Goal
Load the last 36 months of Austin issued permits and label backup-intent work.
## Acceptance
- pytest pipelines/tests/test_austin_permits.py
- python -m pipelines.check manifest --source austin_permits
- python -m pipelines.check rows --table core.permits --min 1
```

**Model pinning.** The roster files pin Sonnet 5. To keep any built-in subagent the orchestrator might call on Sonnet 5 as well, add `CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-5` and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` to the `env` block of `.claude/settings.json`. The orchestrator session itself runs on whatever model you choose.

## Milestones as ticket graphs

Each milestone is one tracer bullet, split into tickets the orchestrator runs wave by wave. Wave 1 sets the contract, the middle waves fill it with real data in parallel, and the last wave lands the bullet on a Vercel preview.

**Ticket ID letters**

- **S:** schema contract (`schema-dev`)
- **D:** platform (`platform-dev`)
- **P:** pipeline (`pipeline-dev`)
- **W:** web (`web-dev`)
- **H:** human
- **V:** verification (`verifier`)

**No shared files inside a wave.** M0-D1 makes the pipelines app auto-register `/cron/<name>` for every module in `pipelines/sources/`. Next.js routes are file-based. Each milestone has exactly one migration file, owned by its S ticket. So parallel tickets only ever add their own files.

### T0 — Access and setup (humans, Day 1 09:00–09:30)

- [ ] P4: create the GitHub repo with `main` as default, then commit `.claude/agents/`, `tickets/`, and `scripts/dag.py` (written in the orchestrator session)
- [ ] P4: on Vercel Pro, create projects `web` (root `web/`) and `pipelines` (root `pipelines/`)
- [ ] P4: add Supabase (Pro) from the Vercel Marketplace to both projects; set `CRON_SECRET` on `pipelines`
- [ ] P1: get an ERCOT Public API key ([developer.ercot.com](https://developer.ercot.com/applications/pubapi/relnotes/)) and add it to `pipelines`
- [ ] P3: add a Google Solar API key to `web` and a Census API key to `pipelines`
- [ ] P3: open the [TxGIO parcel REST layer](https://feature.geographic.texas.gov/arcgis/rest/services/Parcels/stratmap_land_parcels_48_most_recent/MapServer/0) and record the real field names in `checks/T0.md`; M1-S1 builds on them
- [ ] P2: check whether the Houston and Dallas permit feeds are live and record the result in `checks/T0.md`

### M0 — Walking skeleton (09:30–10:30)

**Bullet:** Travis County's 2024 customer-hours without power, from EAGLE-I, shown on the deployed preview with a link to its raw file.

| ID | Wave | Agent | Ticket | Depends on | Produces |
| --- | --- | --- | --- | --- | --- |
| M0-D1 | 1 | platform-dev | Scaffold `web/` (Next.js) and `pipelines/` (FastAPI with auto-registered cron routes, `CRON_SECRET` check); CI runs the no-mock scan and tests; `.env.example` holds variable names only | — | Two deployable projects |
| M0-S1 | 1 | schema-dev | Migration 0001: PostGIS; schemas `ops`, `core`, `api`; `ops.source_manifest`, `ops.pipeline_runs`, `core.outage_county_year`, `api.county_outage`; RLS on; private `raw` bucket | — | Schema contract |
| M0-P1 | 2 | pipeline-dev | EAGLE-I 2024: stream the file, keep Texas rows, store raw, write manifest, aggregate to county-year | D1, S1 | `core.outage_county_year` |
| M0-W1 | 2 | web-dev | Home page card for FIPS 48453 plus provenance drawer, with a "not loaded" state | D1, S1 | `/` page |
| M0-V1 | 3 | verifier | Deploy both previews, call `/cron/eaglei`, run acceptance | P1, W1 | `checks/M0-V1.md` |

**Acceptance (M0-V1)**

- [ ] The manifest SHA-256 matches the Storage object
- [ ] The number on the preview equals the verifier's own recomputation from the raw file
- [ ] A cron call without `CRON_SECRET` gets 401
- [ ] The no-mock scan passes

### M1 — First ranked list, one county (10:30–13:00)

**Bullet:** a map of Travis block groups plus the top 50 homes, ranked on backup-intent permits, on the preview.

| ID | Wave | Agent | Ticket | Depends on | Produces |
| --- | --- | --- | --- | --- | --- |
| M1-S1 | 1 | schema-dev | Migration 0101: `core.parcels`, `core.block_groups`, `core.permits`, `core.permit_labels`, `ops.label_queue`; score v0 function; `api.blockgroup_scores`, `api.top_homes`, `api.home_detail` | M0-V1 | Schema contract |
| M1-P1 | 2 | pipeline-dev | TxGIO parcels for Travis, paged 2,000 at a time with a cursor; single-family filter and owner-occupied proxy | S1 | `core.parcels` |
| M1-P2 | 2 | pipeline-dev | TIGER block groups for Texas | S1 | `core.block_groups` |
| M1-P3 | 2 | pipeline-dev | Austin permits, last 36 months, plus rules classifier; joined to parcels by TCAD ID | S1 | `core.permits`, `core.permit_labels` |
| M1-W1 | 2 | web-dev | Choropleth, top-50 table, and `/home/[prop_id]` showing the home's permit rows | S1 | Pages |
| M1-H1 | 3 | P2 (human) | Hand-label 100 permits the pipeline sampled into `ops.label_queue` | P3 | `checks/M1-H1.md` |
| M1-H2 | 3 | P3 (human) | Check 5 random top-50 homes against their TCAD pages | P1, P3, W1 | `checks/M1-H2.md` |
| M1-V1 | 4 | verifier | Deploy, run acceptance | all above | `checks/M1-V1.md` |

**Acceptance (M1-V1)**

- [ ] The permit-to-parcel join rate is shown; the check fails below 80%
- [ ] Classifier precision for battery and generator, computed from M1-H1's labels, is shown in the app
- [ ] Every top-50 row opens its parcel and permit source rows

### M2 — Eligibility gate and need signals (13:45–16:30)

**Bullet:** ineligible homes drop out with counted reasons, need signals join, and weight sliders re-rank live.

| ID | Wave | Agent | Ticket | Depends on | Produces |
| --- | --- | --- | --- | --- | --- |
| M2-S1 | 1 | schema-dev | Migration 0201: territories, Base service areas, utility crosswalk, ACS, emPOWER, ZCTA, flood tables; gate columns; score v1 with weights and reason codes; `api.gate_counts` | M1-V1 | Schema contract |
| M2-P1 | 2 | pipeline-dev | Electric retail service territories from the GeoParquet mirror | S1 | `core.territories` |
| M2-P2 | 2 | pipeline-dev | Snapshot Base's `pricing.md` and parse the utility names it lists | S1 | `core.base_service_areas` |
| M2-P3 | 2 | pipeline-dev | ACS 5-year by block group: tenure, age 65+, electric heating | S1 | `core.acs_bg` |
| M2-P4 | 2 | pipeline-dev | emPOWER by ZIP (REST layer, or a person's downloaded table, uploaded unchanged and checksummed) plus TIGER ZCTAs | S1 | `core.empower_zip`, `core.zcta` |
| M2-P5 | 2 | pipeline-dev | FEMA flood zones for Travis | S1 | `core.flood_zones` |
| M2-W1 | 2 | web-dev | Gate reason counts and weight sliders calling `api.top_homes(weights)` | S1 | UI |
| M2-H1 | 3 | P1 (human) | Utility crosswalk CSV: each row pairs the polygon's name with Base's name and cites both sources | P1, P2 | `data/manual/utility_crosswalk.csv` |
| M2-P6 | 4 | pipeline-dev | Load the crosswalk (manifested) and apply the territory gate | H1 | Gated homes |
| M2-H2 | 5 | P1 (human) | Enter 5 included and 5 excluded addresses into Base's address checker | P6, W1 | `checks/M2-H2.md` |
| M2-V1 | 6 | verifier | Deploy, run acceptance | all above | `checks/M2-V1.md` |

**Acceptance (M2-V1)**

- [ ] Gate reason counts are shown
- [ ] ACS values for 3 block groups match data.census.gov
- [ ] M2-H2 shows 10 agreements, or each disagreement is logged with its address and reason
- [ ] Moving a slider re-ranks without any pipeline run

### M3 — Second county and grid value (16:30–19:00)

**Bullet:** Travis and Harris ranked on one map, with ERCOT spreads in $/MWh.

| ID | Wave | Agent | Ticket | Depends on | Produces |
| --- | --- | --- | --- | --- | --- |
| M3-S1 | 1 | schema-dev | Migration 0301: ERCOT price and grid-value tables, county-to-load-zone table, longest-event and Beryl-peak outage metrics, renormalized score, `api.signals_used` | M2-V1 | Schema contract |
| M3-H1 | 1 | P1 (human) | County-to-load-zone CSV (Austin Energy → LZ\_AEN, CenterPoint → LZ\_HOUSTON) with ERCOT citations | — | `data/manual/county_loadzone.csv` |
| M3-P1 | 2 | pipeline-dev | ERCOT NP6-905-CD for LZ\_AEN and LZ\_HOUSTON, trailing 12 months, plus a daily incremental | S1 | `core.ercot_spp`, `core.grid_value_lz` |
| M3-P2 | 2 | pipeline-dev | Add Harris to `pipelines/config/counties.yaml`; run the parcel backfill | S1 | Harris parcels |
| M3-P3 | 2 | pipeline-dev | EAGLE-I metrics for Harris, including the July 2024 Beryl window | S1 | Outage metrics |
| M3-P4 | 2 | pipeline-dev | Load the county-to-load-zone CSV | S1, H1 | `core.county_loadzone` |
| M3-W1 | 2 | web-dev | Two-county map, "signals used" chips, $/MWh display, and "permits: not available (no public feed)" for Harris | S1 | UI |
| M3-V1 | 3 | verifier | Deploy, run acceptance | all above | `checks/M3-V1.md` |

**Acceptance (M3-V1)**

- [ ] One day's spread, recomputed by hand from the raw ERCOT file, matches the app to the cent
- [ ] Harris Beryl peak customers out matches the raw EAGLE-I rows
- [ ] No Harris home shows a permit value

### M4 — Installability and backtest (Day 2 09:00–11:15)

**Bullet:** a permitting-authority panel with sourced facts, plus the ice-storm backtest result shown in the app.

| ID | Wave | Agent | Ticket | Depends on | Produces |
| --- | --- | --- | --- | --- | --- |
| M4-S1 | 1 | schema-dev | Migration 0401: `core.ahj_facts`, `core.ess_permits`, `core.backtest_result`, `api.ahj_panel`, `api.backtest` | M3-V1 | Schema contract |
| M4-H1 | 1 | P2 (human) | Authority facts CSV: authority, fact, value, source URL, retrieval date (adopted code editions, TDLR NEC) | — | `data/manual/ahj_facts.csv` |
| M4-P1 | 2 | pipeline-dev | Load authority facts; compute energy-storage permit count, median days to issue, and contractors | S1, H1 | `core.ahj_facts`, `core.ess_permits` |
| M4-P2 | 2 | pipeline-dev | Austin permit history since 2010, then the backtest job: features before 2023-01-01, outcome Mar 2023–Feb 2024 | S1 | `core.backtest_result` |
| M4-P3 | 2 | pipeline-dev | ERCOT LZ\_NORTH (config only), so the Oncor area is one line away | S1 | LZ\_NORTH prices |
| M4-W1 | 2 | web-dev | Authority panel and backtest panel | S1 | UI |
| M4-V1 | 3 | verifier | Deploy, run acceptance | all above | `checks/M4-V1.md` |

**Acceptance (M4-V1)**

- [ ] A test asserts that the latest date in the backtest features is before 2023-01-01
- [ ] Backtest n, Spearman correlation, and top- vs bottom-decile lift are shown, whatever they are
- [ ] Every authority fact opens its source

### M5 — Go-to-market readout and production (11:15–13:00)

**Bullet:** the ranked export and the story, served from the production URL.

| ID | Wave | Agent | Ticket | Depends on | Produces |
| --- | --- | --- | --- | --- | --- |
| M5-S1 | 1 | schema-dev | Migration 0501: `api.export_rows` (reason codes, source IDs, weights, pipeline run IDs) and `api.segments` | M4-V1 | Schema contract |
| M5-H1 | 1 | P2 (human) | Channel recommendation per segment, labeled as the team's recommendation | — | `web/content/channels.md` |
| M5-W1 | 2 | web-dev | `/api/export` CSV route and segment view | S1, H1 | UI + export |
| M5-D1 | 3 | platform-dev | Promote both projects to production, turn on cron schedules, write the README, tag the release | W1 | Production URLs |
| M5-V1 | 4 | verifier | Run acceptance on production | D1 | `checks/M5-V1.md` |

**Acceptance (M5-V1)**

- [ ] Two exports with no pipeline run between them are byte-identical
- [ ] Every export row lists the pipeline run IDs it came from
- [ ] The readout runs live on the production URL

## Dataset catalog

Fourteen core sources, all public or free with an account, in milestone order. Links marked † are standard portal URLs not re-opened for this spec; confirm each one works during T0.

| Dataset | Gives | Granularity | Access | Owner | Used in |
| --- | --- | --- | --- | --- | --- |
| [EAGLE-I outages 2014–2024](https://figshare.com/articles/dataset/The_Environment_for_Analysis_of_Geo-Located_Energy_Information_s_Recorded_Electricity_Outages_2014-2022/24237376) · [2025 file](https://www.osti.gov/biblio/3012826) | Customers without power; covers Uri 2021, Feb 2023 ice storm, Beryl 2024 | County, every 15 min | CSV download, one file per year | P1 | M0 |
| [Austin Issued Construction Permits](https://data.austintexas.gov/Building-and-Development/Issued-Construction-Permits/3syk-w9eu) · [since-2010 history](https://data.austintexas.gov/Building-and-Development/Construction-Permits-Issued-since-2010/d792-2sc3) | Generator, battery, solar, panel, and EV permits; TCAD IDs; dates | Address / parcel | Socrata API, no key needed | P2 | M1, M4 |
| [TxGIO StratMap Land Parcels](https://www.geographic.texas.gov/stratmap/land-parcels.html) · [DataHub](https://data.geographic.texas.gov/?s=land+parcels&pg=1) · [REST service](https://feature.geographic.texas.gov/arcgis/rest/services/Parcels/stratmap_land_parcels_48_most_recent/MapServer/0) | Parcel boundaries, owner and situs addresses, values, land use | Parcel | Per-county download; refreshed roughly yearly | P3 | M1, M3 |
| [Census TIGER/Line block groups](https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html) † | Block-group polygons for the map and joins | Block group | Shapefile | P4 | M1 |
| [ERCOT real-time prices NP6-905-CD](https://www.ercot.com/mp/data-products/data-product-details?id=NP6-905-CD) · [day-ahead NP4-190-CD](https://data.ercot.com/data-product-archive/NP4-190-CD) · [API notes](https://developer.ercot.com/applications/pubapi/relnotes/) · [gridstatus examples](https://opensource.gridstatus.io/en/latest/Examples/ercot_api/ERCOT%20API%20Examples.html) | Settlement point prices for load zones and hubs | Load zone, 15 min | ERCOT Public API (free account + key) or the `gridstatus` Python library | P1 | M1, M3, M4 |
| Electric retail service territories: [GeoParquet mirror](https://data.source.coop/seerai/hifld/electric-retail-service-territories/README.md) · [FeatureServer mirror](https://maps.nccs.nasa.gov/mapping/rest/services/hifld_open/energy/FeatureServer/26) | Utility and co-op boundaries | Polygon | GeoParquet or ArcGIS REST | P1 | M2 |
| [Base service areas](https://www.basepowercompany.com/pricing.md) · [site index](https://www.basepowercompany.com/llms.txt) | Utilities Base serves today | Utility | Markdown page; snapshot it with a checksum | P1 | M2 |
| [Census ACS 5-year API](https://api.census.gov/data.html) † | Tenure, age 65+, heating fuel, income | Block group | REST API (free key) | P3 | M2 |
| [HHS emPOWER Map](https://empowermap.hhs.gov/) · [about](https://empowerprogram.hhs.gov/about-empowermap.html) | Electricity-dependent Medicare beneficiaries | ZIP, monthly | Table download from the map | P3 | M2 |
| [FEMA National Flood Hazard Layer](https://www.fema.gov/flood-maps/national-flood-hazard-layer) † | Flood zones | Polygon | Download or web service | P2 | M2 |
| [Google Maps Solar API](https://developers.google.com/maps/documentation/solar/overview) † | Roof segments and solar potential for one building | Building, on demand | API key; per-request, no bulk storage | P3 | M2 detail page |
| [NFPA 855](https://www.nfpa.org/product/nfpa-855-standard/p0855code) · [2026 edition changes](https://www.energy-storage.news/nfpa-855-2026-edition-updates-and-what-they-mean-for-energy-storage-projects/) · [residential limits summary](https://www.mayfield.energy/technical-articles/fire-codes-and-nfpa-855-for-energy-storage-systems/) | Energy-storage siting and size rules | Standard | NFPA free-access reading | P2 | M4 |
| [TDLR electrical compliance guide](https://www.tdlr.texas.gov/ELECTRICIANS/compliance-guide.htm) | Statewide NEC edition in force | State | Web page | P2 | M4 |
| [NREL End-Use Load Profiles](https://data.openei.org/submissions/4520) · [AWS registry](https://registry.opendata.aws/nrel-pds-building-stock/) | Modeled home electricity use by building type | County / building type | S3 Parquet | P3 | Stretch: backup-hours estimate |

Stretch sources, only if a milestone finishes early: [Microsoft US building footprints](https://github.com/microsoft/USBuildingFootprints) †, [NOAA Storm Events](https://www.ncei.noaa.gov/stormevents/) †, and [EIA-861 utility reliability](https://www.eia.gov/electricity/data/eia861/) †.

## Scoring logic

Homes pass three gates, then get a weighted average of percentile ranks across whichever real signals exist for them. Every score ships with its top three reasons.

**Gates.** A home failing any gate is excluded, and the reason is counted.

1. **In a Base-served territory.** The parcel centroid falls inside a utility polygon on Base's service list (M2).
2. **Single-family residential,** from the parcel land-use code (M1).
3. **Likely owner-occupied.** Proxy: situs address equals mailing address. Swap in the TCAD homestead flag if the appraisal export is obtained (M1).

**Signals**

| Signal | Definition | Level | Source | Added in |
| --- | --- | --- | --- | --- |
| Backup intent | Generator + battery permits in the last 36 months per 1,000 single-family homes | Block group | Austin permits | M1 |
| Outage exposure | The home's distributor reliability: SAIDI (minutes without power per customer per year, with major event days) and SAIFI, latest EIA-861 year; assigned via the service-territory polygon containing the parcel. EAGLE-I county data, normalized per customer (e.g. Travis 2025 ≈ 3.8 h), adds event detail (longest event, Beryl peak). Never show a county total as a home's value. | Distributor (per home) + county | EIA-861, EAGLE-I | M2, M3 |
| Medical need | Electricity-dependent beneficiaries per 1,000 Medicare beneficiaries | ZIP → block group | HHS emPOWER | M2 |
| Older residents | Share of population aged 65+ | Block group | ACS | M2 |
| Winter load | Share of homes heated by electricity | Block group | ACS | M2 |
| Grid value | Trailing-12-month mean daily spread: top-4-hour minus bottom-4-hour average price | Load zone | ERCOT | M3 |
| Installability | Outside a FEMA flood zone; median days to issue an energy-storage permit | Parcel / permitting authority | FEMA, Austin permits | M2, M4 |

**Formula.** For home *h*: *p*ᵢ(*h*) is its percentile rank (0–1) on signal *i* among all gated homes, and *A*(*h*) is the set of signals available for that home.

```latex
\text{score}(h) = \frac{\sum_{i \in A(h)} w_i \, p_i(h)}{\sum_{i \in A(h)} w_i}
```

- **Weights** default to equal and are exposed as sliders. Every export records the weights used.
- **Reason codes** are the three signals with the largest *w*ᵢ × *p*ᵢ(*h*).
- **County-level signals** (outage) and **load-zone signals** (grid value) are identical for every home in the same county or zone. They only separate homes once M3 adds a second county, and the UI says so.
- **Left out on purpose:** conversion probability, acquisition cost, and customer margin. Base's internal data isn't public, and this build does not invent it.

## Real-data verification and definition of done

CI on every pull request and every V ticket run seven automated checks; any miss fails the ticket. Human checks are logged with a name, time, and result.

**Automated checks**

1. **Manifest integrity.** Every object in the Storage `raw` bucket has an `ops.source_manifest` row, and its recomputed SHA-256 matches.
2. **Provenance completeness.** Every non-null value in an `api` view has a `source_id` that resolves to a manifest row.
3. **No-mock scan.** `scripts/no_mock_check.py` fails on any of these in `pipelines/`, `web/`, or `supabase/`:
   - fake-data libraries (Faker, Mimesis);
   - `random` or `np.random` in pipeline code;
   - literal record arrays longer than 5 rows in code or tests;
   - files whose names contain mock, fake, dummy, or sample.
4. **Test fixtures are real.** Fixtures must be byte slices of raw files, with the source object and byte range recorded.
5. **Row reconciliation.** Rows loaded equal rows in the raw file, minus logged filters. Each filter's drop count is stored in `ops.pipeline_runs`.
6. **No zero-filling.** A lint rule rejects `COALESCE(x, 0)` and `fillna(0)` on signal columns. Missing stays null with a reason code.
7. **Freshness.** The UI shows each source's last successful run from `ops.pipeline_runs`, with a badge when a source is past its refresh cycle: permits 7 days, ERCOT 1 day, others per publisher.

**Human checks.** These are the H tickets and the spot checks inside each V ticket. Each is logged in `checks/<ticket-id>.md`, and the orchestrator won't start the next wave until that file is on `main`.

**Instruction block for coding agents.** Every roster subagent file carries this block. `CLAUDE.md` repeats it, so any built-in subagent gets it too:

```markdown
Never generate synthetic, sample, mock, or placeholder data, including in tests.
Only load data that comes from a raw file with an ops.source_manifest row.
If a needed source is missing or fails to download, stop and report it. Do not substitute values.
Edit only your ticket's owns paths. Build the thinnest slice that fills its contract_out, then run its Acceptance commands.
```

**Definition of done for the sprint**

- [ ] M5-V1 passes on the production URLs
- [ ] A fresh clone deploys to new Vercel previews using only the Marketplace-synced variables, the three API keys, and `CRON_SECRET`
- [ ] Travis and Harris are ranked, with gate counts, weight sliders, and a provenance drawer on every number
- [ ] The ice-storm backtest result is shown in the app
- [ ] The export carries reason codes, weights, source IDs, and pipeline run IDs
- [ ] Every ticket is merged, or blocked with a reason in `checks/`
- [ ] Every open question in "Risks, access gotchas, and out of scope" is answered in `checks/` or listed in the README

## Risks, access gotchas, and out of scope

The biggest risks are data access in the first hour and code interpretation on Day 2. Both have a fallback that keeps the real-data rule intact.

| Risk | Effect | Fallback |
| --- | --- | --- |
| A backfill outlives one Vercel function call (800 s max on Pro) | Partial load | Cursor-chunked backfills; the same entrypoint runs from the CLI and is marked `runner = cli` |
| Parallel tickets collide | Merge conflicts or a broken contract | `dag.py` rejects overlapping `owns` paths within a wave; only S tickets touch migrations |
| Parallel pipeline tickets share one Supabase database | One ticket overwrites another's tables | Each ticket writes only its `contract_out` tables; the verifier checks that other tables' row counts didn't change |
| Subagent usage | Usage limits hit mid-milestone | Subagent requests count toward the same plan limits as the main session; waves are capped at 7 tickets |
| ERCOT API account or key is delayed | No grid-value signal | Register at T0; use the `gridstatus` library or ERCOT's report files for the same product IDs |
| Original HIFLD Open portal retired; mirrors may lag | Wrong eligibility gate | Use the mirrors in the catalog; M2-H2's address-checker test catches mismatches |
| EAGLE-I is county-level only | Outage can't rank homes within a county | Label it in the UI; don't scrape utility outage maps unless their terms allow it |
| TxGIO fields vary by county ("as-is" from appraisal districts) | Owner-occupied proxy or land-use filter may fail | T0 field inventory; switch to the TCAD export if needed |
| Permit keyword classifier mislabels records | Noisy backup-intent signal | M1-H1 hand labels, with precision shown in the app |
| Houston and Dallas permit feeds (vendor-reported gaps) | No permit signal outside Austin | Verify at T0; Harris shows permits as unavailable, not zero |
| Code limits vs Base Core unit size | Installability misjudged | Treat as evidence, not a gate: see below |
| Google Maps terms | Terms violation | Solar API on demand only, no storage |
| Using the export for outreach | Do-Not-Call / TCPA exposure | The export is for territory planning; legal review before any household contact |

**Code interpretation.** Published summaries of IRC R328 and NFPA 855 put the location caps at 80 kWh in garages, accessory structures and outdoors, and 40 kWh in utility closets or storage spaces ([Mayfield](https://www.mayfield.energy/technical-articles/fire-codes-and-nfpa-855-for-energy-storage-systems/)). The 2026 edition of NFPA 855 makes a hazard mitigation analysis the default for most installations ([Energy-Storage.News](https://www.energy-storage.news/nfpa-855-2026-edition-updates-and-what-they-mean-for-energy-storage-projects/)).

Base Core ships as a 39.2 kWh unit or a 78.4 kWh pair ([pv magazine](https://pv-magazine-usa.com/2026/08/04/base-power-launches-39-2-kwh-u-s-made-base-core-home-battery-secures-1-billion-in-new-funding/)). How each permitting authority treats the per-unit limit is an evidence question. So M4 uses the energy-storage permits Austin has actually issued, not a rule written into the gate.

**Electrical code.** TDLR has made the 2023 NEC the statewide minimum since September 1, 2023. Its guide notes that some unincorporated-area work needs no permit ([TDLR compliance guide](https://www.tdlr.texas.gov/ELECTRICIANS/compliance-guide.htm)). State law has TDLR adopt a revised NEC every three years ([TDLR board agenda](https://www.tdlr.texas.gov/electricians/agendas/elecagenda041023.htm)), so check whether the 2026 NEC is now in force.

**Out of scope for this sprint**

- Illinois / ComEd.
- Conversion, acquisition-cost, or margin models.
- Door-level outreach lists for sales.
- Scraping Houston's permit portal or utility outage maps.
- Counties beyond Travis and Harris. The Oncor area is prepared in M4 but not loaded.

**Open questions**

- [ ] Does the TxGIO Travis layer include land-use code and mailing address fields? (T0)
- [ ] Can the TCAD appraisal export with homestead flags be obtained in time? (M1)
- [ ] Does emPOWER expose a REST layer the pipeline can query, or does P3 download the table by hand? (M2)
- [ ] Do the territory polygon names map cleanly onto Base's list (Austin Energy, CenterPoint, Oncor)? (M2)
- [ ] Does Base Power appear as a contractor on Austin energy-storage permits, and under which permit type? (M4)
- [ ] Has TDLR begun adopting the 2026 NEC? (M4)
