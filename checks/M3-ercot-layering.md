# Layering ERCOT/grid data into Base Power Zeus — analysis

Sources mined: our tickets/M0–M5 (via `tickets_data.py`), CLAUDE.md real-data rule, the
sibling repo `BasePower_Deep_Tech_Hackathon_Sep_25_2026` itself — `SPEC.md`-derived
implementation-spec artifact, `pipelines/ercot_pull/README.md` + `datasets.py` (actual
code, most authoritative), and `milestones/02,04,12,16,17,19,20,21,22.md` — plus five
data artifacts with real pulled ERCOT data (Data Atlas, Three Layers, Outage Targeting
Preview, Seventeen Hours). Two of the three remaining artifacts — the "Base Power and
ERCOT primer" and the "Texas outage check: one-page spec" — were Claude Docs artifacts;
a follow-up pass (this analysis went through two independent research passes that were
merged) fetched them via the Claude Docs connector rather than a plain artifact read,
and they turned out to carry the single most important correction to this whole
analysis (see the note right after this paragraph, and §D item 1). The third,
"Texas outage targeting mockup," is a Design-canvas artifact (`.dc.html` artboard
files behind a different connector) and was not fetched — UI-layout content, lower
priority for a data-layering question; read it first if a future session scopes the
exact screens for a grid-value or service-tier panel.

**The single most important correction, from the primer (`B8nUUnqyjnh1nWGfM7Udu5`),
not otherwise visible in the sibling repo's code:** Base's own service-tier table gates
which homes its ERCOT/VPP economics even apply to. Base is a licensed Texas retail
electric provider (REP) that owns the battery and trades the fleet in ERCOT's markets —
but only where it *is* the REP:

| Territory type | Example utilities | What Base sells |
|---|---|---|
| Deregulated TDU | CenterPoint, Oncor, AEP Texas Central/North, TNMP | Energy + backup — full grid-value economics apply |
| Co-op | GVEC, CoServ, Farmers EC | Through the co-op (Base owns batteries, co-op pays for exclusive access) |
| Municipal / regulated | **Austin Energy**, El Paso Electric | **Backup only, no energy plan** — Base cannot capture wholesale/VPP value here at all |
| Not listed | — | Not served yet |

A home under Austin Energy — most of Travis County, our only county through M2 — gets
**no grid-value economics from Base's side**, regardless of what LZ_AEN's price spread
looks like. The spread is still a real, citable ERCOT number, but attributing "grid
value" to those homes' scores implies value Base cannot realize there. Harris County
(CenterPoint, deregulated) is the opposite case: full economics apply. This is the
concrete, sourced form of the task's "grid value to Base vs. outage need to the
homeowner" distinction, and it is treated as load-bearing (not optional) in §D item 1
below — everything else in this analysis (price-spike hours, ancillary services,
weather zones, retail competitiveness) is secondary to it.

Also from the primer: ERCOT's **RTC+B** market redesign went live **2025-12-05**
(ancillary services now co-optimize with energy in the same real-time run). Any
trailing-12-month ancillary-service window (§D item 3 below) will, from 2026-09
onward, always straddle this boundary and must report pre/post separately rather than
blending — the market mechanism itself changed, not just prices.

**Important scope correction:** only ONE ERCOT dataset is actually implemented in the
sibling repo's code — `rt_spp_load_zones` (prices, milestone 04, status "done").
Milestones 17 (weather history), 20 (stress forecast) and 21 (supply-side
demand/wind/solar) are **specs only, status "ready", not yet built** — useful as design
intent, not as evidence of a working pipeline. Treat their datasets as "worth
considering," not "proven to work."

## A. Inventory

| Dataset | Product/endpoint | Granularity | Resolution | History | Access | Notes |
|---|---|---|---|---|---|---|
| ERCOT RT Settlement Point Prices | **NP6-905-CD** `spp_node_zone_hub`, `settlementPointType=LZ` (confirmed against live sibling code, `pipelines/ercot_pull/README.md`/`datasets.py`) | 8 load zones (LZ_AEN, LZ_CPS, LZ_HOUSTON, LZ_LCRA, LZ_NORTH, LZ_RAYBN, LZ_SOUTH, LZ_WEST) | 15-min (SCED intervals; DST days have 92–100 intervals) | **API queryable history starts operating day 2023-12-11** (confirmed by the sibling's own code comment, not the report metadata's `archiveDuration`/first-run date, which is unrelated — a deeper zipped-CSV archive at `/archive/np6-905-cd` may reach further but was never read) | Public API, `ERCOT_USERNAME`/`ERCOT_PASSWORD` (B2C ROPC token flow at `ercotb2c.b2clogin.com`) + `Ocp-Apim-Subscription-Key` header; rate limit ~30 req/min (not hard-measured), sibling throttles to 1 call/2.1s | **Already our M3-P1** exactly (same product ID, same filter trap — `LZEW` energy-weighted type returns the same 8 zone names with different prices, must filter by type not name — and same auth). Adding LZ_CPS, LZ_RAYBN, LZ_SOUTH, LZ_WEST is a `load_zones.yaml` line each, no code change. ERCOT's API has hung 10+ min on at least one occasion (2026-09-25); size our timeouts and gate our smoke tests accordingly. |
| ERCOT DAM Settlement Point Prices | NP4-190-CD | Load zone/hub/node | Hourly, day-ahead | Public API | Public API, credentialed | Not in our tickets, not implemented in the sibling repo either (design-intent only). Alternative/complement to RT SPP; not required for M3's spread metric. |
| ERCOT DAM Ancillary Service Plan / Clearing Prices for Capacity | requirement quantities: NP4-33-CD; clearing prices: NP4-188-CD (daily DAM) / NP4-181-ER (historical) | ERCOT-wide (not zonal) | Daily-ahead, by AS product (RegUp, RegDown, RRS, ECRS, Non-Spin) | Public API / historical files | Public, credentialed | **Not in our tickets, not in sibling repo either** (sibling's M21 "supply-side" spec covers demand/wind/solar, not ancillary prices). This is the actual VPP/ancillary-services revenue signal (what a battery earns providing frequency response), but it is ERCOT-wide, not zonal — it doesn't vary by home or county, so it can't rank homes. Best used as an Overview context line, never a score term. |
| Weather per load zone / weather zone (Open-Meteo archive, no key) | sibling's unbuilt milestone **17** design: hourly temp/wind/solar per load zone, joined to price to build a price-by-temperature curve; milestone **20** (also unbuilt) projects tomorrow's stress from the forecast | load zone / weather zone | hourly | Open-Meteo's historical archive, effectively unlimited free history | Public, no key | **Not in our tickets, not implemented anywhere yet** (design spec only). This is the direct answer to "weather-zone extreme-heat/freeze hours" the task asked about — a real, free, no-credential source. Worth adding to our own M3 as a new ticket (see D). |
| ERCOT EEA / conservation alerts, Grid Conditions | No single stable report ID found (not NP-numbered like prices); published as advisories/watches/EEA notices and via the Grid Conditions dashboard | ERCOT-wide | Event-based | Public, ercot.com/live grid conditions page, historical incident reports | Public, no credential for the dashboard; historical compilation is manual | Not in our tickets or the sibling repo. Genuine gap: a count of EEA/conservation hours per year is a real, citable grid-stress signal, but again ERCOT-wide — same "context line, not a score term" treatment as ancillary services, unless a home's load zone can be shown to have a locational scarcity signal (see price-spike-hours signal below, which is zonal and better suited). |
| ERCOT county↔load-zone crosswalk | manual, cited to ERCOT | County | Static | Manual CSV | Already **M3-H1** (done): Austin Energy→LZ_AEN, Travis co-ops→LZ_LCRA, Harris/CenterPoint→LZ_HOUSTON, LZ_NORTH reserved for Oncor (M4-P3, config only). |
| Sibling: `zip_score.earn_pct` / `earn_per_battery_year` | Derived, not an ERCOT product | ZIP | — | N/A (computed) | **RED FLAG** — see B below. |
| Sibling: retail plan comparison (offer count, fixed/variable/TOU counts, median cents/kWh) | Power to Choose data (not explicitly named as a report ID in what was recovered, but the "Three Layers" artifact carries `offers`, `median_cents`, `fixed`/`variable`/`tou` counts per ZIP) | ZIP | Snapshot | Public web (Power to Choose), scrape/manual, no credential | Not in our tickets. Genuine gap and a legitimate real-data signal: real advertised plan prices, distinct from wholesale ERCOT prices, and distinct from our existing municipal-vs-deregulated binary (M2-W4). |
| EAGLE-I county outage | Already ours (M0-P1, M2-P7, M3-P3) | County | 15-min → county-year | N/A | figshare, credential-free | Confirmed identical source and identical customer-hours formula to the sibling's `2.1 County outage history`. No new information here; corroborates our existing pipeline. |

Grid-value formula corroboration: sibling's `avg_daily_spread(load_zone) = mean over
days of (max price − min price)` trailing 12 months matches our **M3-S1/M3-P1**'s
"trailing-12-month mean daily spread (top-4-hour minus bottom-4-hour average price)"
almost exactly (max−min vs top4−bottom4 avg — ours is a steadier estimator, less noisy
to a single extreme interval). The "Outage Targeting Preview" artifact's real computed
zone spreads (Nov 2025, $/MWh): LZ_AEN 126.23, LZ_CPS 123.67, LZ_HOUSTON 94.91,
LZ_LCRA 119.50, LZ_NORTH 90.74, LZ_RAYBN 83.33, LZ_SOUTH 104.14, LZ_WEST 115.04 — real
numbers, no invented dollars, safe to use as-is under our real-data rule.

The "Seventeen Hours" artifact (Houston LZ_HOUSTON daily price series, Jun 2024–Sep
2026) shows the story a mean daily spread partly hides: a handful of days each year
carry nearly all the price signal (Aug 2024 peak $4,855/MWh; Nov 2024 $3,493; Apr 2025
$3,860; May 2025 $2,250; Jun/Jul 2025 $1,600–1,750/MWh). This suggests a second, cheap
signal worth adding to M3: **hours per year above a fixed real-price threshold** (a
scarcity/arbitrage-opportunity count), which is a genuinely different piece of
information from the mean daily spread and stays a pure $/MWh statistic (real ERCOT
prices only, still anchored not percentiled).

## B. Gap analysis vs our M2–M5 tickets, and conflicts with our decisions

**Already planned, matches sibling research:**
- ERCOT RT SPP by load zone (M3-P1) — same product, same auth, same zone set (subset of 8).
- Grid value = trailing price spread (M3-S1/M3-P1) — same formula family, real $/MWh, no invented dollars. Good.
- County↔load-zone mapping (M3-H1, done) — matches sibling's utility→load_zone YAML idea, done with citations.
- Retail market deregulated-vs-municipal (M2-W4) — sibling has an equivalent utility.yaml `base_status`/`kind` field, but ours is more rigorous (cited per-utility CSV with verbatim quotes, not a hand-typed YAML guess).
- Ancillary services and EEA/conservation exposure — **not planned anywhere in M2–M5** (see gap below).

**Conflicts with our decisions (must NOT be imported):**
1. **Percentiles everywhere.** The sibling's entire scoring layer (`outage_pct`,
   `owner_pct`, `earn_pct`, `zone_spread` ranked across zones) is percentile-based —
   exactly the approach our M2-P8 ticket explicitly discarded ("percentiles discarded
   magnitude... score terms are anchored absolute scales, not percentiles" — user
   decision). Any ERCOT/grid signal we add must follow M2-P8's anchor pattern
   (`value / anchor(90th percentile of the real distribution), capped at 1`), never a
   cross-zone or cross-home percentile rank.
2. **Made-up dollars.** The "Outage Targeting Preview" data model carries a field
   `earn_per_battery_year` (values 294, 323, 384, 392 — dollars per battery per year)
   computed from `avg_daily_spread` by an unstated conversion (an assumed battery
   capacity/cycle-efficiency multiplier). This is exactly what CLAUDE.md bans: **"No
   made-up dollars. Base's internal numbers are not public and are left out of the
   score. The only dollar values shown are ERCOT market prices."** `avg_daily_spread`
   in $/MWh is a real ERCOT market price and is fine to show; a derived "$/battery/year
   Base would earn" is not. Notably, **the sibling repo reached the same conclusion
   independently**: its own milestone 19 ("savings-model", unbuilt, status "ready")
   states in its acceptance criteria: *"The existing `$/battery/year` estimate on the
   ZIP page is replaced by this model, and the milestone records the change to that
   earlier decision."* Their planned fix still discloses assumptions (battery size,
   cycles/day, round-trip efficiency, rate archetype) and is explicit that the figure
   is not a forecast — better practice than a silent number, but it is still an
   assumption-driven estimate, not a real ERCOT price, so it still would not pass our
   real-data rule even with the assumptions shown. **Do not import
   `earn_per_battery_year`, nor the M19-style assumption-labelled savings model.** Show
   the $/MWh spread itself, labelled as a market statistic, and stop there.
3. The sibling's `zip_score` table computes the weighted score with SQL percentile
   arithmetic at query time — same "don't materialize the weighted score, compute at
   request time" pattern we already use in M2-S1/`api.top_homes(weights)`. This part is
   fine to keep as an implementation pattern; only the percentile inputs are the problem.

**Missing (genuine gaps, worth adding):**
- Ancillary services capacity clearing prices (NP4-33-CD / NP4-181-ER) — ERCOT-wide
  context only, not a per-home signal.
- EEA/conservation event count — ERCOT-wide context only, not a per-home signal, and
  no stable historical report ID was confirmed; would need a manual compiled list
  (like `data/manual/ahj_facts.csv`) with each event's date and ERCOT source citation.
- Price-spike-hours count (a scarcity signal distinct from mean daily spread) — zonal,
  real $/MWh threshold, could be a genuine second score term for M3.
- Real advertised retail-plan competitiveness (Power to Choose offer counts / median
  cents-per-kWh) at ZIP/utility level — a genuinely new, real, citable dataset not
  currently in our tickets; complements (does not replace) M2-W4's deregulated/municipal
  binary with an intensity measure ("how competitive is this market", not just "is there
  a market").

## C. Signal design

For each worthwhile dataset: the signal, its geography, its anchored formula, and its
placement.

1. **Grid value / battery arbitrage opportunity** (already M3-S1/M3-P1's spread) —
   keep as designed: `spread / anchor(90th percentile of spread across all 8 load
   zones)`, capped at 1. Geography: home → county (M3-H1 crosswalk) → load zone. This is
   "grid value to Base" (VPP economics), distinct from outage need — M3-W1 already plans
   to label it separately with `$/MWh` provenance; keep that separation explicit in the
   UI (a "Grid value" chip next to, never merged with, "Outage exposure").

2. **Price-spike-hours (scarcity) signal** (new) — `hours_per_year(spot price >
   $X/MWh)` for the home's load zone, trailing 12 months, `$X` fixed at a round number
   (e.g. $200/MWh, chosen and documented, not tuned to make homes look good). Anchored
   as `hours / anchor(90th percentile of that count across the 8 zones)`, capped at 1.
   Same geography as grid value. This is a second, cheap, real-data VPP-economics term
   that doesn't require any new pipeline beyond what M3-P1 already loads (it's a
   different aggregate over the same `core.ercot_spp` rows). Placement: score term
   (small weight, like flood — a genuine home-independent zone signal) or, if M3-P8-style
   "near-constant" concerns apply within a load zone (all Travis-Austin homes share one
   number), treat it like M2-P8 treated flood: never a "top signal," but still counted.

3. **Ancillary services capacity prices** — ERCOT-wide, not zonal, so it cannot
   distinguish homes or counties. Display-only: an Overview panel line ("ERCOT-wide
   average ancillary-service capacity clearing price for Regulation Up was $X/MW in
   <year>, source: NP4-181-ER") with provenance. Never a score term (no locational
   information to rank on).

4. **EEA/conservation event exposure** — same treatment as ancillary services:
   ERCOT-wide, display-only context ("ERCOT declared N Energy Emergency Alerts in
   2025"), sourced to a manually compiled, cited list (like `ahj_facts.csv`). Never a
   score term unless/until ERCOT publishes zone- or weather-zone-level dispatch data
   (it doesn't, publicly, at fine grain).

5. **Retail-plan competitiveness (Power to Choose)** — home → utility → ZIP. Two real,
   non-dollar-invented signals: `offer_count` (number of competing retail plans) and
   `median_price_cents_per_kwh` (real advertised price). Anchored: `offer_count /
   anchor(90th percentile across Texas deregulated ZIPs)`, capped at 1. This is a
   "can Base actually compete here" signal, complementary to M2-W4's binary
   deregulated/municipal flag — display as an added line on the existing retail-market
   panel, or a small new score term under "market competitiveness," not folded into
   outage need.

Distinguishing "grid value to Base" vs "outage need to the homeowner": our existing
architecture already keeps these as separate score terms (M2-P8's distributor SAIDI is
outage need; M3's ERCOT spread is grid value) — the new signals above (#2, #5) extend
the "grid value / market" family, not the "outage need" family. Keep them visually and
architecturally separate in `api.home_score_breakdown` and in the UI (two labelled
groups of chips, not one mixed list), consistent with the pattern M3-W1 already
describes ("signals-used chips" + a distinct "Grid value" component).

## D. Milestone plan

**No new milestone is warranted.** Everything worthwhile fits inside M3 (which already
owns "ERCOT prices, grid value, load zones, outage metrics") as additional tickets, plus
one small M2 addition. This keeps the tracer-bullet rule: each addition still touches
pipeline → DB → api → web, sized for one fresh agent.

1. **Gate the grid-value term by Base's own service tier — load-bearing, not
   optional.** Extend `core.grid_value_lz` (M3-S1) with `base_capture`
   (`'full'|'backup_only'|'partner'`), joined in M3-P1 from `core.retail_market`
   (already loaded by M2-W4) via the home's territory EIA number, per the primer's
   service-tier table above (deregulated TDU → `full`; co-op → `partner`;
   municipal/regulated such as Austin Energy → `backup_only`). `GridValue.tsx` (M3-W1)
   renders "not available — Base sells backup only here, no VPP economics" instead of a
   spread number for `backup_only` homes, never a number and never zero. Without this,
   the grid-value score term silently attributes VPP value to Austin Energy homes —
   most of Travis, our only county through M2 — that Base cannot realize it at. The
   outage/SAIDI signal (M2-P7/P8) is unaffected and still applies to every home; only
   the grid-value term is gated. Acceptance: every Austin Energy home's grid-value
   term reads the not-available state with that reason, never a spread number or a 0;
   a Harris (CenterPoint) home's grid-value term is unaffected.

2. **M3-P1 (existing, otherwise no change beyond the `base_capture` join above).** Its
   scope (LZ_AEN, LZ_HOUSTON, LZ_LCRA, config-driven) is correct and matches the
   sibling's real numbers closely. Confirm in its acceptance that `core.ercot_spp`
   stores raw 15-min prices (not just the derived spread), since the new M3-P5 ticket
   below reads the same raw rows for a different aggregate.

3. **New ticket M3-P5 — "Price-spike-hours grid-value term."**
   - Blocked by: M3-P1.
   - Owns: `supabase/migrations/0302_price_spike_hours.sql`, `pipelines/sources/ercot_spikes.py` (or a SQL view over `core.ercot_spp` — likely no new pipeline needed, just a migration adding `core.grid_spike_hours_lz` computed from the already-loaded `core.ercot_spp`), `pipelines/tests/test_ercot_spikes.py`.
   - What to build: `hours_per_year(price > $200/MWh)` per load zone, trailing 12 months, from the rows M3-P1 already loaded (no new download or manifest — reuses M3-P1's manifested source). Anchored term (value / 90th-percentile anchor across the 8 zones, capped at 1), wired into `api.home_score_breakdown` alongside the existing grid-value/spread term, with its own weight and reason code.
   - Acceptance: threshold and anchor are documented and fixed before computing (no threshold-shopping); a day recomputed by hand from `core.ercot_spp` matches the app; contributions still sum to score ±0.001; request-time query < 1 s.

4. **New ticket M3-P6 — "ERCOT ancillary-service and EEA context (display-only)."**
   - Blocked by: M3-S1.
   - Owns: `data/manual/ercot_context.csv` (ancillary-service capacity clearing prices by year from NP4-181-ER/NP4-33-CD, and a cited list of EEA/conservation-alert dates/levels compiled by hand from ERCOT's public advisories), `pipelines/sources/ercot_context.py` (loads the manual CSV like `retail_market.csv`/`ahj_facts.csv` — manifested, cited, no invented numbers), `supabase/migrations/0303_ercot_context.sql` (`core.ercot_context`, `api.ercot_context`), `web/components/GridContextPanel.tsx` (Overview-panel addition, not the ranking or home page — this is ERCOT-wide, never a per-home value).
   - What to build: a small Overview panel stating, with provenance per row, the latest year's ancillary-service capacity clearing price(s) and the count of EEA declarations, explicitly labelled "ERCOT-wide, not specific to this home."
   - Acceptance: every row cites an ERCOT source URL and retrieval date; the UI never attaches this to a home or block group; no score term reads from `core.ercot_context`.

5. **New ticket M3-P7 — "Weather-zone extreme-hours term (Open-Meteo, no key)."**
   - Blocked by: M3-H1 (needs the county→zone crosswalk pattern; uses weather zones, a
     separate ERCOT geography from load zones, so also needs a small manual weather-zone
     crosswalk CSV cited to ERCOT's own weather-zone map).
   - Owns: `pipelines/sources/weather_zone_hours.py`, `pipelines/tests/test_weather_zone_hours.py`, `pipelines/tests/fixtures/weather_zone_hours/`, `supabase/migrations/0304_weather_extremes.sql` (`core.weather_zone_hours`), `data/manual/weather_zone_crosswalk.csv`.
   - What to build: pull hourly temperature per ERCOT weather zone from Open-Meteo's
     historical archive API (no key required — confirmed free/no-credential in the
     sibling's unbuilt M17 design, not yet implemented anywhere, so this would be new
     code for us, not a port). Compute `extreme_heat_hours_per_year` (hours ≥ a fixed
     real threshold, e.g. 100°F) and `extreme_freeze_hours_per_year` (hours ≤ 32°F) per
     weather zone, trailing 12 months. Anchored terms (value / 90th-percentile anchor
     across weather zones, capped at 1) — this is a genuine outage-need-adjacent signal
     (extreme weather correlates with grid stress and home vulnerability), distinct from
     the ERCOT price signals, so keep it grouped with outage-need context, not grid
     value.
   - Acceptance: a day's hours recomputed by hand from the raw Open-Meteo pull matches
     the app; weather-zone→county mapping is cited; contributions still sum to score
     ±0.001; every value is a real measured hour count, never a forecast (M3-P7 pulls
     only historical archive data, not the sibling's forecast milestone M20's forward
     projection — a forecast is not a "real, downloaded, manifested source" under our
     rule at the time it's shown, since it will keep changing).

6. **New ticket M2-P11 — "Retail-plan competitiveness (Power to Choose)."** (Lives in
   M2 alongside M2-W4/P9/P10 rather than M3, since it extends the retail-market work
   that's already in M2 and doesn't need ERCOT price data.)
   - Blocked by: M2-W4.
   - Owns: `pipelines/sources/retail_plans.py`, `pipelines/tests/test_retail_plans.py`, `supabase/migrations/0217_retail_plans.sql` (`core.retail_plans_zip`), `web/components/RetailMarketPanel.tsx` (extend, not replace, M2-W4's component), `web/app/home/[prop_id]/`.
   - What to build: snapshot Power to Choose (or its public API if one exists — verify at build time; if API-only with a rate limit, a periodic snapshot like `base_service_areas.py`'s pricing.md snapshot is fine) for the home's ZIP: `offer_count`, `median_price_cents_per_kwh`, min/max advertised price. Anchored offer-count term (value / 90th-percentile anchor across deregulated Texas ZIPs, capped at 1) added as a small new score term under "market competitiveness"; municipal/co-op ZIPs get null with reason "no retail market" (not zero). Real cents/kWh numbers, sourced — these are allowed dollar-adjacent figures because they are Power to Choose's own published real advertised prices, not an estimate of what Base would earn.
   - Acceptance: offer counts for 3 sample ZIPs match a direct look at Power to Choose; municipal ZIPs (Austin Energy) show null with reason, never zero; contributions still sum to score ±0.001.

7. **M3-W1 (existing, minor addition).** Add the price-spike-hours chip, the
   weather-zone extreme-hours line, and the ancillary/EEA context link into the same
   "signals-used chips" + "Grid value" UI it's already building — no separate ticket
   needed, just extend M3-W1's scope note to mention the new M3-P5/M3-P7 terms.

8. **Explicitly reject:** importing the sibling's `earn_pct`/`earn_per_battery_year`,
   its cross-zone/cross-home percentile ranking, and its Apify competitor-scraping idea
   (M13 in the sibling) — none of these fit the real-data rule or our anchored-score
   decision, and competitor-installer counts don't map to ERCOT/grid value at all.

## E. Risks

- **Vercel Hobby 300 s function limit.** M3-P5 reuses M3-P1's already-loaded
  `core.ercot_spp` rows (15-min intervals × 8 zones × ~2 years ≈ 650K rows per the
  sibling's real pull) — an aggregate query over rows already in Postgres, not a new
  bulk download, so it fits well inside 300 s. No new large-file backfill risk.
- **Supabase Small disk-IO budget.** Loading all 8 load zones' full 15-min history
  (not just 3) would roughly 2.7× the row count `core.ercot_spp` already carries.
  Recommend loading only the zones our counties actually use (LZ_AEN, LZ_HOUSTON,
  LZ_LCRA, plus LZ_NORTH when M4 adds Oncor) rather than all 8, to keep index and
  storage costs bounded — matches M3-P1's config-driven design already.
- **ERCOT API limits/credentials.** `ERCOT_USERNAME`/`ERCOT_PASSWORD`/
  `ERCOT_SUBSCRIPTION_KEY` are already provisioned and verified (T0-H2). Ancillary
  service and DAM products use the same Public API auth, so M3-P6's manual CSV
  approach only needs occasional, low-volume pulls (yearly capacity-price files), well
  under any rate limit.
- **Real-data rule.** The EEA/conservation list has no single ERCOT bulk-download
  endpoint confirmed; it must be compiled by hand from ERCOT's public advisory
  archive, one row per event with a source URL — exactly the `ahj_facts.csv` pattern,
  not a scrape. If ERCOT's advisory archive turns out to be paywalled or
  credential-gated beyond the Public API, M3-P6 should be reported as blocked rather
  than substituting an estimate (per CLAUDE.md: "If a needed source is missing or
  fails to download, stop and report it. Do not substitute values.").
- **Nothing here can be shown without inventing dollars, if:** any ticket tries to
  convert a $/MWh spread or ancillary-service clearing price into a "$/year a battery
  would earn a homeowner" or "$/year Base would earn." That conversion requires
  battery kWh, round-trip efficiency, and a dispatch/cycling assumption that has no
  public source — it must stay out of the score and out of the UI, exactly as
  CLAUDE.md already states. The sibling repo's `earn_per_battery_year` field is the
  concrete example of what NOT to import.
- **Grid-value/service-tier gating is new scope, not free.** Adding `base_capture` to
  M3-S1/M3-P1/M3-W1 (§D item 1) is the single most important correction in this
  analysis but does add a join against `core.retail_market` (already loaded, low
  marginal cost) and a third UI rendering state ("not-available-here-by-design," not
  just "value" vs. "not loaded") to `GridValue.tsx`. Confirm it doesn't quietly break
  M3-W1's existing acceptance criteria around Harris permits' "not available" state,
  which already uses a similar pattern and should be reused, not reinvented.
- **RTC+B market-design boundary (2025-12-05).** M3-P6's ancillary-service window (and
  any trailing-12-month ERCOT pull generally) will, from 2026-09 onward, always
  straddle this boundary. It is not wrong per se for the energy-price spread (prices
  are continuous through the change), but for ancillary-service clearing prices
  specifically the market mechanism itself changed (AS now co-optimizes with energy in
  the same real-time run), so M3-P6 must report pre/post 2025-12-05 separately rather
  than blending into one figure.

## Summary of D (milestone plan) — ≤ 40 lines

No new milestone. All additions fit inside the existing M3 ("ERCOT prices, grid value,
load zones, outage metrics") plus one M2 addition, each a thin pipeline→DB→api→web
slice:

1. **Gate the grid-value term by Base's own service tier (load-bearing, not
   optional).** Base's ERCOT primer confirms Base only captures wholesale/VPP
   economics where it is the retail electric provider: full economics in deregulated
   TDU territory (CenterPoint/Oncor/AEP/TNMP → Harris), partial via co-op deals, and
   **none** in municipal/regulated territory such as **Austin Energy — most of Travis
   County, our only county through M2**. Add `base_capture`
   (`'full'|'backup_only'|'partner'`) to `core.grid_value_lz` (M3-S1), join it from the
   already-loaded `core.retail_market` in M3-P1, and render "not available — Base
   sells backup only here, no VPP economics" instead of a spread number on
   `GridValue.tsx` (M3-W1) for backup-only homes. Without this, the grid-value score
   term would silently imply value Base cannot realize at most currently-scored homes
   — the clearest concrete form of the task's "grid value to Base" vs. "outage need to
   the homeowner" split.

2. **M3-P1 (existing, plus the `base_capture` join above)** — otherwise already
   matches prior research's ERCOT NP6-905-CD pull, auth, and grid-value formula almost
   exactly. No other changes needed.

3. **New M3-P5 — "Price-spike-hours grid-value term."** Blocked by M3-P1. Reuses
   `core.ercot_spp` rows already loaded (no new download). Adds
   `hours_per_year(price > fixed $/MWh threshold)` per load zone as a second, anchored
   (not percentile) grid-value score term. Owns a small migration + SQL/test, wires
   into `api.home_score_breakdown`.

4. **New M3-P6 — "ERCOT ancillary-service and EEA context (display-only)."** Blocked
   by M3-S1. A manually compiled, cited CSV (ancillary-service capacity clearing prices
   + EEA/conservation-alert dates), loaded like `ahj_facts.csv`. Shown only on an
   Overview context panel, ERCOT-wide, never attached to a home or used as a score
   term (no locational data exists publicly at that grain).

5. **New M3-P7 — "Weather-zone extreme-hours term (Open-Meteo, no key)."** Blocked by
   M3-H1. Real, free, no-credential hourly weather per weather zone; extreme-heat and
   extreme-freeze hour counts, anchored score terms grouped with outage-need context
   (not grid value). This is new code for us — the sibling's equivalent milestone (17)
   is an unbuilt spec, not working code, but the Open-Meteo source and no-key access are
   confirmed by that spec.

6. **New M2-P11 — "Retail-plan competitiveness (Power to Choose)."** Blocked by
   M2-W4. Real advertised offer counts and cents/kWh per ZIP, anchored score term
   under "market competitiveness," extends the existing deregulated/municipal panel.
   Municipal/co-op areas get null-with-reason, not zero.

7. **M3-W1 (minor extension)** — add the new spike-hours chip, the weather-zone
   extreme-hours line, and the ancillary/EEA context link to its existing
   "signals-used chips" + "Grid value" UI; no separate ticket.

8. **Explicitly do NOT import:** the sibling's percentile-based scoring, its
   `earn_per_battery_year` (a made-up per-battery dollar estimate — the single biggest
   real-data-rule violation found), or its Apify competitor-scraper idea.

Rationale: the sibling research validates our M3-P1 grid-value approach almost
exactly (same ERCOT product, similar spread formula, real numbers that corroborate
ours), surfaces two genuine, cheap, real-data gaps (price-spike hours; ERCOT-wide
ancillary/EEA context) worth adding as small M3 tickets, and one M2-adjacent gap
(retail-plan competitiveness) — while its scoring layer (percentiles everywhere, and
an invented per-battery dollar figure) is exactly what our M2-P8 and CLAUDE.md
decisions already ruled out, so none of that layer should be ported.
