# Base Power Zeus

> Built during the **Base Power Deep Tech Hackathon** (Austin, TX, September 2026) by [Mahesh Babu Gorantla](https://github.com/maheshbabugorantla), [Sreedhar Reddy Arolla](https://github.com/sreedhararolla), [Pranay Dheeru](https://github.com/pranaydheeru) & [Pranav Narahari](https://github.com/pnav1023).

![Zeus: an engraved fist gripping a gold thunderbolt inside a sunburst roundel over transmission towers, beside the ZEUS wordmark](docs/media/zeus-hero.png)

**Know which door to knock next.** Zeus ranks Texas homes for Base Power outreach by how likely each one is to add home backup power, and shows the reason on every row. Every number on screen opens the public file it came from, and missing data says so instead of being guessed.

- **Live app:** https://base-power-zeus.vercel.app
- **Repo:** https://github.com/maheshbabugorantla/basepower-zeus
- **Now ranking:** 1,057,261 owner-occupied single-family homes across Travis, Harris and Williamson Counties (Overview page)

The app opens on a map of real census block groups shaded by how many top-priority homes each holds, beside a ranked list of homes. Rank 1 opens in place with:
- a plain-English case for the knock, built from that home's strongest real signals
- the source of each highlighted figure: dataset, retrieval time, SHA-256 and the raw file
- the signal meters behind the ranking, in plain units ("About 9 in 100 nearby homes added backup", "Built 2024")
- links to the full home record, the home on the map, and all 12 signals

![Zeus demo: the intro reel, rank 1's case and its source, Team priorities, a ZIP camera glide, a home record, and the Overview](docs/media/zeus-demo.gif)

Full-quality recording: [`docs/media/zeus-demo.mp4`](docs/media/zeus-demo.mp4) (55 s, 1440×900, recorded live against https://base-power-zeus.vercel.app with Playwright, starting at `/?intro`).

## What it does, and for whom

Two audiences use the same screen:

- **A Base growth or territory analyst at a desk** deciding which neighborhoods and homes to approach next, and why. The home record, the signal breakdown and the Sources page reward a close look.
- **A room watching a projector for five minutes.** The first visit plays a short intro reel (about 11 seconds) that ends on the live ranking, and the ranked list, the map and the case sentence read from across the room.

| Page | What it answers |
|---|---|
| **Ranking** | Which homes in this county are most likely to add backup, and why. Map and list on one screen, rank 1 expanded, camera glides to any city, ZIP or neighborhood. |
| **Home record** | Everything about one home under its address, in tabs: Summary (the case, six meters, six facts, recent permits, priority, a "before you knock" checklist), Signals, Permits, Parcel & solar, Sources. |
| **Overview** | The territory at a glance: outage minutes by utility, the storm record, how many parcels reach the ranked list per county, and battery permit times. |
| **Sources** | How leads are prioritized, the model's accuracy check, spot checks on the data, and every downloaded file with its fingerprint. |

## Quick start

Prerequisites: Node 24, Python 3.12 ([uv](https://docs.astral.sh/uv/) recommended), a Supabase project with PostGIS, and the Vercel CLI for deploys.

```bash
git clone https://github.com/maheshbabugorantla/basepower-zeus.git && cd basepower-zeus

# 1. Secrets: names are in .env.example; keep the filled-in .env untracked
cp .env.example .env

# 2. Database: apply every migration in order (session pooler, one transaction each)
for f in supabase/migrations/*.sql; do python3 scripts/apply_sql.py "$f"; done

# 3. Pipelines: load a source, then check it
cd pipelines
python3 -m pipelines.run parcels --backfill            # any module in pipelines/sources/ (parcels writes source tcad_export)
python3 -m pipelines.check manifest --source tcad_export
python3 -m pipelines.check provenance                  # every api.* view carries source ids
python3 -m pipelines.run refresh_scores                # rebuild the score views in dependency order
python3 -m models score                                # fit and write core.home_propensity
cd ..

# 4. Web app
cd web && npm ci && npm run dev                        # http://localhost:3000
```

Useful URLs while developing:

| URL | What it does |
|---|---|
| `/?intro` | Replays the intro reel (it otherwise plays once per browser) |
| `/?intro=0` | Skips the reel and the redirect; use it in every test and screenshot script |
| `/ranking?county=48201` | Ranking for Harris County (`48453` Travis, `48491` Williamson) |
| `/ranking?mode=weighted` | Opens in Team priorities |

## Tech stack & architecture

| Layer | Tech |
|---|---|
| Data pipeline | Python 3.12 on Vercel (FastAPI crons, `maxDuration` 300 s) plus CLI backfills: `httpx`, `psycopg` 3, scikit-learn for the propensity model |
| Database | Supabase Postgres with PostGIS 3.3.7. Schemas `ops` (manifest, runs), `core` (tables, materialized views), `api` (the only thing the web app reads) |
| Raw files | Supabase Storage: every downloaded file kept unchanged, with its URL, retrieval time and SHA-256 in `ops.source_manifest` |
| Web app | Next.js 16 (App Router), React 19, MapLibre GL 6 on OpenFreeMap tiles, deployed on Vercel. Reads through `zeus_web_ro`, a Postgres role with `SELECT`/`EXECUTE` grants only |
| Brand | Engraved transmission-badge mark (two cuts: full engraving and a bold small-size cut), live current drawn in SVG, ZEUS in Cinzel |

```mermaid
flowchart LR
  S["Public sources<br/>CAD rolls, permits, EAGLE-I,<br/>EIA-861, ERCOT, Census, FEMA, PUCT"]
  P["pipelines/ on Vercel<br/>FastAPI crons + CLI backfills"]
  ST[("Supabase Storage<br/>raw files, SHA-256")]
  DB[("Supabase Postgres + PostGIS<br/>ops · core · api")]
  W["web/ Next.js 16 on Vercel<br/>zeus_web_ro, read-only"]
  S -->|download| P
  P -->|raw file, manifested| ST
  P -->|load ops/core,<br/>refresh_all_scores()| DB
  DB -->|SELECT api.*| W
  ST -->|signed link per figure| W
```

Plain-text version:

```
 CAD rolls (TCAD, HCAD, WCAD) ─┐                              ┌─ ops.source_manifest  URL · retrieved_at · sha256 · rows
 Austin permits · permit rules ┤                              ├─ core.*               parcels, permits, signals, block groups
 EAGLE-I · EIA-861 · ERCOT ────┼─► pipelines/sources/*.py ────┼─ core.mv_*            score views, refreshed in dependency order
 Census ACS · TIGER · ZCTA ────┤   download · manifest · load ├─ core.home_propensity model score + decile per home
 FEMA NFHL · emPOWER · PUCT ───┘                              └─ api.*                the web app's only read surface
                                                                     │  zeus_web_ro (read-only)
                                                                     ▼
                                          Next.js on Vercel: Ranking · Home record · Overview · Sources
```

Interactive diagrams, with guided views of the read path, the write path and the offline briefing: [`docs/architecture/`](docs/architecture/README.md) (`system-design.html`, `data-pipeline.html`, `scoring-request-flow.html`).

## How the ranking works

### Two ways to order the list

| Mode | What orders it | Who it is for |
|---|---|---|
| **Likely to add backup** (default) | A model trained on which Austin homes actually added a battery or generator. Reps see the tier and the reasons, never the raw score. | Everyday outreach |
| **Team priorities** | A weighted average of 13 signals, with weights the team sets on sliders. Each slider shows its share of the score, for example "16% of score". | A team testing its own theory of who to call |

### Priority tiers

Homes are split into ten deciles per county by the model's score:

| Tier | Deciles | Meaning |
|---|---|---|
| Top priority | 1 | The county's most likely tenth of homes |
| High | 2–3 | The next fifth |
| Medium | 4–6 | The middle third |
| Low | 7–10 | The lowest four-tenths |

The model (`pipelines/models/`) is a logistic regression, version `m4p4-v1` (`api.model_card`). It learned from Travis County homes as they stood on 2024-07-01 and which of them added backup over the following year, then was tested out of time on the 735 installs after 2025-07-01, which it never saw. On that holdout its accuracy at telling homes apart (AUC) was 0.729, and its top tenth of homes installed backup at 3.12× the average rate. Harris and Williamson predictions use the same model and are not locally validated. The Sources page shows the full calibration table.

### The 13 signals

Each signal becomes a score term: the home's real value divided by a fixed anchor (the 90th percentile of that signal across eligible homes), capped at 1. Terms are never percentile ranks, so a home's term doesn't move when other homes change. A signal with no data is left out of that home's score rather than counted as zero.

| Group | Signals |
|---|---|
| Outages | Outage exposure (the home's utility's minutes without power, EIA-861; EAGLE-I county figure where the utility doesn't report) |
| Adoption | Neighbors installing backup (permits per 1,000 nearby homes, the home's own excluded), own solar/EV/generator permit |
| Installation | Installability (newer home or own panel-upgrade permit), outside flood zone, permit friction (days to issue a City of Austin battery permit) |
| Household | Home value, households earning $100k+, adults 35–64, age 65+, homeowner 65+ (over-65 exemption), medical need (emPOWER), electric heat |

### Every number opens its source

Each highlighted figure in a case sentence, and each value on the home record, is a button. It opens a popover with the dataset, the retrieval time, the SHA-256 (full value on copy), the pipeline run, rows in and loaded, and a link to the raw file in Storage. "Not loaded" means the pipeline hasn't run; "not available" means the publisher doesn't report that figure for this home. Both are written out, and neither is ever shown as 0.

## Datasets & provenance

**All data is real and public. No synthetic, sample or mocked data is used anywhere, including tests.** Every row traces to a downloaded file with an `ops.source_manifest` row. The table lists what `api.sources` holds as of this build.

| Dataset | Publisher (source host) | What it feeds |
|---|---|---|
| 2026 certified appraisal export | Travis Central Appraisal District (`traviscad.org`) | Travis parcels: home value, year built, homestead, over-65 exemption |
| TCAD parcel geometry | Travis County GIS (`gis.traviscountytx.gov`) | Travis parcel outlines and centroids |
| 2026 CAMA real accounts, exemptions, code descriptions | Harris Central Appraisal District (`download.hcad.org`) | Harris parcels, homestead and exemptions |
| HCAD parcel geometry | Harris County GIS (`gis.hctx.net`) | Harris parcel outlines |
| Appraisal export | Williamson Central Appraisal District (`data.wcad.org`) | Williamson parcels |
| Issued permits since 2023-09-26 | City of Austin open data (`data.austintexas.gov`, `3syk-w9eu`) | Battery, generator, solar, EV and panel permits; neighbors adding backup; permit times |
| Austin Energy service area | City of Austin open data (`w5fd-ctq4`) | Austin Energy territory |
| EAGLE-I outage records and county customer counts | Oak Ridge National Laboratory, via figshare | Storm record, county outage context |
| Form EIA-861 reliability (SAIDI) | U.S. Energy Information Administration (`eia.gov`) | Minutes without power per customer, by utility |
| Settlement point prices, load zones | ERCOT public API (`NP6-905-CD`) | Grid value layering (ERCOT market prices are the only dollars besides public appraisals) |
| American Community Survey 2024 5-year, block groups | U.S. Census Bureau (`api.census.gov`) | Age 65+, adults 35–64, households earning $100k+, electric heat, owner and renter counts |
| TIGER 2024 block groups and ZCTAs | U.S. Census Bureau (`www2.census.gov`) | Map geometry, ZIP areas |
| National Flood Hazard Layer | FEMA (`hazards.fema.gov`) | Inside or outside a high-risk flood zone |
| emPOWER | U.S. Department of Health and Human Services (ArcGIS service) | Power-dependent medical devices per Medicare beneficiary, by ZIP |
| Electric retail service territories | HIFLD, via Source Cooperative | Which utility serves a home |
| CCN service areas (IOU, co-op, municipal) | Public Utility Commission of Texas (ArcGIS services) | Utility service areas |
| Pricing and service areas | Base Power (`basepowercompany.com/pricing.md`) | Which utilities Base serves |
| Permit rules, retail market, utility crosswalk, county load zones | Hand-built reference tables in [`data/manual/`](data/manual) | Permit paths, retail choice, EIA IDs, ERCOT load zones |

Spot checks, from the Sources page: 142,097 of 165,972 Austin permits (86%) were tied to a Travis County home; 13 of 14 flagged home-battery permits and 34 of 36 flagged generator permits were confirmed against their full permit text.

## The real-data rule

This repo's non-negotiable rule, enforced in CI:

1. **Traceable.** Every row traces to a downloaded file, recorded with its URL, retrieval time and SHA-256.
2. **Nothing invented.** No synthetic rows, hard-coded sample arrays, placeholder values or seeded fakes in tests. Tests run against byte slices of real files, each with a `.source.json` sidecar naming the source object and byte range.
3. **Missing means empty.** An unloaded feature is null with a reason. Never `COALESCE(x, 0)` or `fillna(0)` on a signal column.
4. **No made-up dollars.** Base's internal numbers are not public and stay out of the score.

## Tests & CI

| Check | Command | What it guards |
|---|---|---|
| No-mock scan | `python3 scripts/no_mock_check.py` | Fake-data libraries, `random`, literal record arrays, zero-filling, fixture sidecars |
| Ticket graph | `python3 scripts/dag.py tickets/<Mn>/` | Wave order, cycles, overlapping `owns` paths |
| Script tests | `python3 -m unittest discover -s scripts/tests` | The checkers themselves |
| Web tests | `cd web && npx vitest run` | 184 tests in 45 files at the time of writing; database suites run when the read-only URL is set |
| Types and build | `cd web && npm run typecheck && npm run build` | The production build |
| Pipeline checks | `python3 -m pipelines.check manifest\|rows\|provenance` | Re-downloads and re-hashes raw files, row counts, source ids on every `api.*` view |

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the scan, the ticket graph, the script tests, the pipeline tests (pytest), and the web typecheck and build on every push to `main`.

## Deployment

Two Vercel projects in team `gorantlasubs-gmailcoms-projects`: `base-power-zeus` (web, linked from `web/`) and `base-power-zeus-pipelines` (linked from `pipelines/`). Deploys go through the CLI, preview first, and only a verified preview is promoted:

```bash
cd web
vercel deploy --scope gorantlasubs-gmailcoms-projects              # preview
vercel promote <preview-url> --scope gorantlasubs-gmailcoms-projects
```

Static assets (the brand mark, the intro reel art, the map worker, icons) ship with the web build under `web/public/` and are served from Vercel's CDN. `/brand`, `/intro` and `/maplibre` carry `Cache-Control: public, max-age=86400, stale-while-revalidate=604800` (`web/next.config.ts`), so browsers reuse them for a day and refresh them in the background for a week. The Hobby plan limits functions to 300 s, so long backfills run from the CLI (`runner='cli'` in `ops.pipeline_runs`).

## Repo layout

```
web/                   Next.js 16 app: app/ routes, components/, lib/, styles/ (tokens.css, components.css), tests/
web/public/brand/      the Zeus mark: full engraving and bold small-size cut, ink and bolt layers
web/public/intro/      intro reel scene art
pipelines/             Python pipelines: app.py (cron routes), pipelines/sources/*.py, models/ (propensity), tests/
supabase/migrations/   schema, views and functions, applied in order with scripts/apply_sql.py
scripts/               no_mock_check.py, dag.py, apply_sql.py
data/manual/           hand-built reference tables, each loaded with a manifest row
docs/architecture/     interactive system, pipeline and scoring diagrams
docs/media/            README hero image and demo recording
tickets/, checks/      milestone tickets and acceptance evidence
DESIGN.md, PRODUCT.md  design system and product brief
```

## Known limitations & next steps

**Limitations**
- **Harris and Williamson rolls are pre-filtered.** Both loaders keep only single-family homestead parcels, so those counties' full parcel and single-family counts show as "Not loaded" on the Overview. Harris also has no year built.
- **Permits are City of Austin only.** Permit signals and permit times exist for Austin; Harris and Williamson show "not a loaded public source".
- **The model is validated in Travis only.** Harris and Williamson scores reuse the Travis model without local validation.
- **EIA-861 2025 figures are an early release**, marked "not fully edited" wherever they appear.
- **Outage exposure is utility-wide.** SAIDI describes a utility's average customer, not a single home.

**Next steps**
1. Load full Harris and Williamson appraisal rolls, and Harris year built.
2. Add permit sources for Houston and Williamson County cities.
3. Validate the model on Harris installs once permits exist there.
4. Refresh EIA-861 when the final 2025 release lands.

## Credits

- Map tiles: [OpenFreeMap](https://openfreemap.org) © [OpenMapTiles](https://openmaptiles.org), data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
- Data publishers are listed in [Datasets & provenance](#datasets--provenance).
- The Zeus mark is original: generated from text-only prompts in an engraving style, traced to vector with [potrace](https://potrace.sourceforge.net/), and recolored to the Zeus palette. No stock art was used as an input.
- Design and UX principles borrowed, not copied, from [Hyperlocal](https://github.com/maheshbabugorantla/hyperlocal).
