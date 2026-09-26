import { query } from "../lib/db";
import { Panel } from "../components/ui/Panel";
import { MissingState } from "../components/ui/MissingState";
import type { ProvenancePopoverProps } from "../components/ui/ProvenancePopover";
import {
  OutageSummary,
  type CountyOutageContext,
  type DistributorReliabilityRow,
  type OutageSummaryData,
} from "../components/OutageSummary";
import { StatRow, StatList } from "../components/ui/StatRow";
import { PermitTimelinePanel, type PermitQuarterRow } from "../components/PermitTimelinePanel";
import { PredictionProof, type ModelCardData } from "../components/PredictionProof";
import { getCountiesWithScoredHomes } from "../lib/counties.server";
import { COUNTY_CANDIDATES } from "../lib/counties";
import { StormRecordPanel, type StormRecordCounty } from "../components/StormRecordPanel";
import { DecisionHeader } from "../components/DecisionHeader";
import { getMarketRows, formatExpected } from "../lib/audiences.server";

// M0-W1: server component. `force-dynamic` is required, not decorative —
// this page must query api.county_outage at request time (the EAGLE-I
// backfill can land while the app is live), never bake a value in at
// build time.
//
// M1-W3 fix #4: Overview was "one sentence in a narrow column on an empty
// page." A real overview needs several headline facts, each with its own
// unit and provenance, and links into Ranking and Sources — never a hero
// stat-card grid (DESIGN.md §6 Don't).
export const dynamic = "force-dynamic";

const TRAVIS_COUNTY_FIPS = "48453";
const TRAVIS_COUNTY_NAME = "Travis";
const OUTAGE_YEAR = 2025;

// M2-W-fix (user feedback): the county-wide EAGLE-I total ("2,439,878.25
// customer-hours") is a Travis-wide sum across every customer, not a
// per-home figure — no single home experiences it, so it must never be the
// Overview headline (DESIGN.md's Unit Rule + the real-data rule's "missing
// is a state, not a zero" spirit both point the same way: don't let a
// technically-real number imply something false at the wrong altitude).
// The headline is now each Base-served distributor's own EIA-861 SAIDI
// (minutes without power per customer per year) — a real per-customer
// figure — for the distributors actually present among gate-passed Travis
// homes (ground-truthed against core.mv_home_signals: Austin Energy and
// Oncor). CenterPoint is Base-served too but serves Harris, not Travis, so
// it is listed but marked as arriving once Harris loads, never faked with
// a Travis figure. This eia_id/base_name pairing used to be a small,
// fixed candidate array (documented in supabase/migrations/0201_m2.sql's
// core.territories comment) -- M3-W1 replaces that fixed list with a
// data-driven one: whatever distributor(s) actually cover a gate-passed
// home in a county that has scored homes, discovered from
// core.mv_home_signals itself (indexed on county_fips/territory_eia_id,
// migration 0208), never a candidate list chosen ahead of what loaded.

interface DistributorReliabilityDbRow {
  base_name: string;
  eia_id: string;
  county_fips: string;
  distributor_name: string | null;
  year: number | null;
  saidi_incl_major: string | number | null;
  saidi_incl_major_null_reason: string | null;
  early_release: boolean | null;
  source: string | null;
  url: string | null;
  retrieved_at: string | Date | null;
  sha256: string | null;
  storage_key: string | null;
  runner: "cron" | "cli" | null;
  latest_run_id: string | null;
  latest_run_rows_in: number | null;
  latest_run_rows_loaded: number | null;
}

/**
 * Per-distributor EIA-861 reliability (SAIDI incl. major events), latest
 * year first, for every distributor that actually covers a gate-passed
 * home in one of `countyFipsList` -- discovered live, not a fixed
 * candidate array. `distinct` is over an already-indexed pair of columns
 * on the materialized core.mv_home_signals, not a live spatial join.
 */
async function getDistributorReliability(
  countyFipsList: string[]
): Promise<DistributorReliabilityRow[]> {
  try {
    const rows = await query<DistributorReliabilityDbRow>(
      `with present as (
         select distinct county_fips, territory_eia_id
         from core.mv_home_signals
         where county_fips = any($1::text[]) and territory_eia_id is not null
       )
       select
         cw.base_name,
         t.eia_id,
         p.county_fips,
         ur.utility_name as distributor_name,
         ur.year,
         ur.saidi_incl_major,
         ur.saidi_incl_major_null_reason,
         ur.early_release,
         s.source, s.url, s.retrieved_at, s.sha256, s.storage_key, s.runner,
         s.latest_run_id, s.latest_run_rows_in, s.latest_run_rows_loaded
       from present p
       join core.territories t on t.eia_id::text = p.territory_eia_id
       join core.utility_crosswalk cw on cw.eia_utility_number = t.eia_id
       left join lateral (
         select r.utility_name, r.year, r.saidi_incl_major,
                r.saidi_incl_major_null_reason, r.early_release, r.source_id
         from core.utility_reliability r
         where r.eia_id = t.eia_id
         order by r.year desc
         limit 1
       ) ur on true
       left join api.sources s on s.source_id = ur.source_id
       order by p.county_fips, cw.base_name`,
      [countyFipsList]
    );

    const countyNameByFips = new Map(COUNTY_CANDIDATES.map((c) => [c.fips, c.name]));

    return rows.map((row) => {
      const hasSource =
        row.source !== null &&
        row.url !== null &&
        row.retrieved_at !== null &&
        row.sha256 !== null &&
        row.storage_key !== null &&
        row.runner !== null;

      return {
        baseName: row.base_name,
        county: countyNameByFips.get(row.county_fips) ?? row.county_fips,
        inLoadedCounty: true,
        year: row.year,
        saidiInclMajor: row.saidi_incl_major === null ? null : Number(row.saidi_incl_major),
        earlyRelease: row.early_release ?? false,
        source: hasSource
          ? {
              dataset: row.source as string,
              url: row.url as string,
              retrievedAt:
                row.retrieved_at instanceof Date
                  ? row.retrieved_at.toISOString()
                  : (row.retrieved_at as string),
              sha256: row.sha256 as string,
              runId: row.latest_run_id ?? "none",
              runner: row.runner as "cron" | "cli",
              rowsIn: row.latest_run_rows_in,
              rowsLoaded: row.latest_run_rows_loaded,
              rawFileHref: `/storage/${row.storage_key}`,
            }
          : null,
      };
    });
  } catch (err) {
    console.error("page: failed to load core.utility_reliability", err);
    return [];
  }
}

interface CountyOutageDbRow {
  customer_hours_out: string | number | null;
  customer_hours_out_null_reason: string | null;
  hours_per_customer: string | number | null;
  hours_per_customer_null_reason: string | null;
  source: string | null;
  url: string | null;
  retrieved_at: string | Date | null;
  sha256: string | null;
  storage_key: string | null;
  runner: "cron" | "cli" | null;
  latest_run_id: string | null;
  latest_run_rows_in: number | null;
  latest_run_rows_loaded: number | null;
}

/**
 * County-level EAGLE-I context for the muted secondary line — a
 * per-customer average (hours_per_customer), never the raw county-wide
 * customer_hours_out total (see the module comment above `TRAVIS_COUNTY_FIPS`).
 */
async function getCountyOutageContext(): Promise<CountyOutageContext | null> {
  const rows = await query<CountyOutageDbRow>(
    `select
       co.customer_hours_out,
       co.customer_hours_out_null_reason,
       co.hours_per_customer,
       co.hours_per_customer_null_reason,
       s.source,
       s.url,
       s.retrieved_at,
       s.sha256,
       s.storage_key,
       s.runner,
       s.latest_run_id,
       s.latest_run_rows_in,
       s.latest_run_rows_loaded
     from api.county_outage co
     left join api.sources s on s.source_id = co.source_ids[1]
     where co.county_fips = $1 and co.year = $2
     limit 1`,
    [TRAVIS_COUNTY_FIPS, OUTAGE_YEAR]
  );

  if (rows.length === 0) return null;
  const row = rows[0];

  const hasSource =
    row.source !== null &&
    row.url !== null &&
    row.retrieved_at !== null &&
    row.sha256 !== null &&
    row.storage_key !== null &&
    row.runner !== null;

  return {
    countyName: TRAVIS_COUNTY_NAME,
    year: OUTAGE_YEAR,
    hoursPerCustomer:
      row.hours_per_customer === null ? null : Number(row.hours_per_customer),
    hoursPerCustomerNullReason: row.hours_per_customer_null_reason,
    customerHoursOut:
      row.customer_hours_out === null ? null : Number(row.customer_hours_out),
    customerHoursOutNullReason: row.customer_hours_out_null_reason,
    source: hasSource
      ? {
          dataset: row.source as string,
          url: row.url as string,
          retrievedAt:
            row.retrieved_at instanceof Date
              ? row.retrieved_at.toISOString()
              : (row.retrieved_at as string),
          sha256: row.sha256 as string,
          runId: row.latest_run_id ?? "none",
          runner: row.runner as "cron" | "cli",
          rowsIn: row.latest_run_rows_in,
          rowsLoaded: row.latest_run_rows_loaded,
          rawFileHref: `/storage/${row.storage_key}`,
        }
      : null,
  };
}

interface OutageMetricDbRow {
  county_fips: string;
  metric: string;
  value: string | number | null;
  value_null_reason: string | null;
  source_ids: string[];
}

/**
 * api.outage_metrics_county (M3-P3) for every county with scored homes --
 * the longest continuous outage event (>=1% of the county's estimated
 * customers out at once -- eaglei_metrics.py's MAJOR_EVENT_MIN_SHARE, a
 * team threshold, not ERCOT's or EAGLE-I's own) and the July 2024
 * Hurricane Beryl peak. A county absent from the table (pipeline hasn't
 * run for it yet) is left out of the returned list entirely -- never a
 * zero-filled row.
 */
async function getStormRecords(countyFipsList: string[]): Promise<StormRecordCounty[]> {
  try {
    const rows = await query<OutageMetricDbRow>(
      `select county_fips, metric, value, value_null_reason, source_ids
       from api.outage_metrics_county
       where county_fips = any($1::text[])`,
      [countyFipsList]
    );
    const countyNameByFips = new Map(COUNTY_CANDIDATES.map((c) => [c.fips, c.name]));
    const byCounty = new Map<string, Map<string, OutageMetricDbRow>>();
    for (const row of rows) {
      if (!byCounty.has(row.county_fips)) byCounty.set(row.county_fips, new Map());
      byCounty.get(row.county_fips)!.set(row.metric, row);
    }

    const toNum = (r: OutageMetricDbRow | undefined): number | null =>
      r && r.value !== null ? Number(r.value) : null;

    return Array.from(byCounty.entries()).map(([fips, metrics]) => ({
      countyFips: fips,
      countyName: countyNameByFips.get(fips) ?? fips,
      longestEventHours: toNum(metrics.get("longest_event_hours")),
      longestEventPeakCustomers: toNum(metrics.get("longest_event_peak_customers")),
      longestEventStartEpoch: toNum(metrics.get("longest_event_start_epoch")),
      longestEventEndEpoch: toNum(metrics.get("longest_event_end_epoch")),
      berylPeakCustomers: toNum(metrics.get("beryl_2024_07_peak_customers")),
      berylPeakShare: toNum(metrics.get("beryl_2024_07_peak_share")),
    }));
  } catch (err) {
    console.error("page: failed to load api.outage_metrics_county", err);
    return [];
  }
}

interface GateCountsRow {
  total_parcels: string | number;
  single_family_count: string | number;
  homestead_count: string | number;
  gated_count: string | number | null;
  source: string | null;
  url: string | null;
  retrieved_at: string | Date | null;
  sha256: string | null;
  storage_key: string | null;
  runner: "cron" | "cli" | null;
  latest_run_id: string | null;
  latest_run_rows_in: number | null;
  latest_run_rows_loaded: number | null;
}

interface GateCounts {
  totalParcels: number;
  singleFamilyCount: number;
  homesteadCount: number;
  /**
   * M2-W1 perf fix: this used to run its own live
   * `count(*) from core.parcels where (single-family) and hs_exempt='T'`
   * subquery on every Overview request — a full scan of core.parcels
   * (441,961 rows), duplicating work app/ranking/page.tsx's funnel ran
   * too. A live incident (statement-timeout cascades under concurrent
   * load) showed this doesn't scale. Read instead from api.gate_counts
   * (0201_m2.sql, built on the materialized core.mv_home_signals): the
   * sum of every reason's home_count is exactly the single-family +
   * homestead + parcel-geometry population core.mv_home_block_group (the
   * M1 gate) contains, since core.mv_home_signals has one row per home in
   * that population regardless of the M2 territory-gate outcome.
   */
  gatedCount: number | null;
  source: (Omit<ProvenancePopoverProps, "children" | "id">) | null;
}

async function getGateCounts(): Promise<GateCounts | null> {
  try {
    const rows = await query<GateCountsRow>(
      `select
         pgc.total_parcels,
         pgc.single_family_count,
         pgc.homestead_count,
         (select sum(home_count) from api.gate_counts) as gated_count,
         s.source, s.url, s.retrieved_at, s.sha256, s.storage_key, s.runner,
         s.latest_run_id, s.latest_run_rows_in, s.latest_run_rows_loaded
       from api.parcel_gate_counts pgc
       left join api.sources s on s.source_id = pgc.source_ids[1]`
    );
    const row = rows[0];
    if (!row) return null;

    const hasSource =
      row.source !== null &&
      row.url !== null &&
      row.retrieved_at !== null &&
      row.sha256 !== null &&
      row.storage_key !== null &&
      row.runner !== null;

    return {
      totalParcels: Number(row.total_parcels),
      singleFamilyCount: Number(row.single_family_count),
      homesteadCount: Number(row.homestead_count),
      gatedCount: row.gated_count === null ? null : Number(row.gated_count),
      source: hasSource
        ? {
            dataset: row.source as string,
            url: row.url as string,
            retrievedAt:
              row.retrieved_at instanceof Date ? row.retrieved_at.toISOString() : (row.retrieved_at as string),
            sha256: row.sha256 as string,
            runId: row.latest_run_id ?? "none",
            runner: row.runner as "cron" | "cli",
            rowsIn: row.latest_run_rows_in,
            rowsLoaded: row.latest_run_rows_loaded,
            rawFileHref: `/storage/${row.storage_key}`,
          }
        : null,
    };
  } catch (err) {
    console.error("page: failed to load api.parcel_gate_counts", err);
    return null;
  }
}

async function getTopHomesCount(): Promise<number | null> {
  try {
    const rows = await query<{ n: string | number | null }>(
      `select home_count as n from api.gate_counts where reason = 'passed'`
    );
    return rows[0] && rows[0].n !== null ? Number(rows[0].n) : null;
  } catch (err) {
    console.error("page: failed to load ranked home count", err);
    return null;
  }
}

interface PermitQuarterDbRow {
  period: string;
  is_base_power: boolean;
  n: string | number;
  median_days: string | number | null;
  p90_days: string | number | null;
}

/** M2-P9: "Time to permit a home battery in Austin" -- api.permit_path_stats,
 * period_type='quarter', jurisdiction='ALL', label='battery'. Pivots the
 * two is_base_power rows per quarter into one row per quarter (Other
 * installers / Base Power side by side). */
async function getPermitTimelineByQuarter(): Promise<PermitQuarterRow[]> {
  try {
    const rows = await query<PermitQuarterDbRow>(
      `select period, is_base_power, n, median_days, p90_days
       from api.permit_path_stats
       where jurisdiction = 'ALL' and label = 'battery' and period_type = 'quarter'
       order by period`
    );
    const byPeriod = new Map<string, PermitQuarterRow>();
    for (const row of rows) {
      const existing = byPeriod.get(row.period) ?? {
        period: row.period,
        otherMedianDays: null,
        otherP90Days: null,
        otherN: 0,
        baseMedianDays: null,
        baseP90Days: null,
        baseN: 0,
      };
      if (row.is_base_power) {
        existing.baseMedianDays = row.median_days === null ? null : Number(row.median_days);
        existing.baseP90Days = row.p90_days === null ? null : Number(row.p90_days);
        existing.baseN = Number(row.n);
      } else {
        existing.otherMedianDays = row.median_days === null ? null : Number(row.median_days);
        existing.otherP90Days = row.p90_days === null ? null : Number(row.p90_days);
        existing.otherN = Number(row.n);
      }
      byPeriod.set(row.period, existing);
    }
    return Array.from(byPeriod.values()).sort((a, b) => a.period.localeCompare(b.period));
  } catch (err) {
    console.error("page: failed to load api.permit_path_stats", err);
    return [];
  }
}

interface ModelCardDbRow {
  model_version: string;
  algorithm: string;
  auc_oot: string | number | null;
  pr_auc_oot: string | number | null;
  top_decile_lift_oot: string | number | null;
  calibration: { decile: number; n: number; predicted_mean_p: number; observed_rate: number }[] | null;
  n_test: number | null;
  n_positive_test: number | null;
  notes: string | null;
}

function toNum(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

/** M4-W2: api.model_card -- every number the "How we know it works" panel shows. */
async function getModelCard(): Promise<ModelCardData | null> {
  try {
    const rows = await query<ModelCardDbRow>(
      `select model_version, algorithm, auc_oot, pr_auc_oot, top_decile_lift_oot, calibration, n_test, n_positive_test, notes
       from api.model_card
       order by trained_through desc, model_version desc
       limit 1`
    );
    const row = rows[0];
    if (!row) return null;
    return {
      modelVersion: row.model_version,
      algorithm: row.algorithm,
      aucOot: toNum(row.auc_oot),
      prAucOot: toNum(row.pr_auc_oot),
      topDecileLiftOot: toNum(row.top_decile_lift_oot),
      calibration: row.calibration
        ? row.calibration.map((c) => ({
            decile: c.decile,
            n: c.n,
            predictedMeanP: c.predicted_mean_p,
            observedRate: c.observed_rate,
          }))
        : null,
      nTest: row.n_test,
      nPositiveTest: row.n_positive_test,
      notes: row.notes,
    };
  } catch (err) {
    console.error("page: failed to load api.model_card", err);
    return null;
  }
}

async function getSourcesLoadedCount(): Promise<number | null> {
  try {
    const rows = await query<{ n: string | number }>(`select count(*) as n from api.sources`);
    return rows[0] ? Number(rows[0].n) : 0;
  } catch (err) {
    console.error("page: failed to load api.sources count", err);
    return null;
  }
}

export default async function HomePage() {
  const scoredCounties = await getCountiesWithScoredHomes();
  const scoredCountyFips = scoredCounties.map((c) => c.fips);
  const [distributors, countyContext, gateCounts, topHomesCount, sourcesLoadedCount, permitTimeline, modelCard, stormRecords] =
    await Promise.all([
      getDistributorReliability(scoredCountyFips),
      getCountyOutageContext(),
      getGateCounts(),
      getTopHomesCount(),
      getSourcesLoadedCount(),
      getPermitTimelineByQuarter(),
      getModelCard(),
      getStormRecords(scoredCountyFips),
    ]);

  const outageData: OutageSummaryData = { distributors, countyContext };

  // GTM P0: one row per scored county -- homes Base can serve and the
  // model's expected adopters (sum of calibrated 12-month likelihoods).
  const marketRows = await getMarketRows(scoredCountyFips);
  const namedMarkets = (marketRows ?? [])
    .map((r) => ({ ...r, name: scoredCounties.find((c) => c.fips === r.countyFips)?.name ?? r.countyFips }))
    .sort((a, b) => b.expectedAdopters - a.expectedAdopters);
  const marketTotals = namedMarkets.reduce(
    (acc, r) => ({ homes: acc.homes + r.homes, expected: acc.expected + r.expectedAdopters }),
    { homes: 0, expected: 0 }
  );
  const topMarket = namedMarkets.length > 1 ? namedMarkets[0] : null;

  return (
    <div style={{ display: "grid", gap: "var(--space-6)", maxWidth: "1000px" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <DecisionHeader
          question="Where should Base focus outreach next?"
          answer={
            marketRows && marketRows.length > 0 ? (
              <>
                The model expects {formatExpected(marketTotals.expected)} of{" "}
                {marketTotals.homes.toLocaleString("en-US")} homes Base can serve to add backup power in the next 12
                months.
                {topMarket ? (
                  <>
                    {" "}
                    {topMarket.name} has the most: {formatExpected(topMarket.expectedAdopters)}.
                  </>
                ) : null}
              </>
            ) : (
              "Model likelihoods are not loaded yet, so markets can't be compared."
            )
          }
          evidence={{ href: "#model-proof", label: "how we know the model works" }}
          next={{ href: "/ranking", label: "See neighborhoods" }}
        />
        <p style={{ color: "var(--theme-ink-muted)", margin: 0, maxWidth: "70ch" }}>
          Real public data on Texas homes ({scoredCounties.map((c) => c.name).join(", ")}{" "}
          {scoredCounties.length > 1 ? "Counties" : "County"} so far), gated to owner-occupied
          single-family parcels, scored for Base Power outreach.
        </p>
      </div>

      <Panel data-testid="markets-panel">
        <h2
          style={{
            fontFamily: "var(--type-heading-font-family)",
            fontSize: "var(--type-heading-font-size)",
            fontWeight: "var(--type-heading-font-weight)",
            marginTop: 0,
          }}
        >
          Markets compared
        </h2>
        {marketRows === null ? (
          <MissingState variant="not-loaded" reason="Model likelihoods not loaded yet" />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th scope="col">County</th>
                  <th scope="col" style={{ textAlign: "right" }}>Homes Base can serve</th>
                  <th scope="col" style={{ textAlign: "right" }}>Expected to add backup in 12 months</th>
                  <th scope="col" style={{ textAlign: "right" }}>Per 1,000 homes</th>
                  <th scope="col">Open</th>
                </tr>
              </thead>
              <tbody>
                {namedMarkets.map((m) => (
                  <tr key={m.countyFips}>
                    <td>{m.name}</td>
                    <td style={{ textAlign: "right", fontFamily: "var(--type-data-font-family)" }}>
                      {m.homes.toLocaleString("en-US")}
                    </td>
                    <td style={{ textAlign: "right", fontFamily: "var(--type-data-font-family)" }}>
                      {formatExpected(m.expectedAdopters)}
                    </td>
                    <td style={{ textAlign: "right", fontFamily: "var(--type-data-font-family)" }}>
                      {m.homes > 0 ? ((m.expectedAdopters / m.homes) * 1000).toFixed(1) : "not available"}
                    </td>
                    <td>
                      <a href={`/ranking?county=${m.countyFips}`}>Neighborhoods</a>
                      {" · "}
                      <a href={`/audiences?county=${m.countyFips}`}>Audiences</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ margin: "var(--space-3) 0 0 0", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
          Expected adopters are a model estimate: the sum of each home&rsquo;s calibrated likelihood of adding battery or
          generator backup in the next 12 months. Outside Austin, the model extrapolates from Austin installs because no
          other city publishes a permit feed.
        </p>
      </Panel>

      <Panel>
        <h2
          style={{
            fontFamily: "var(--type-heading-font-family)",
            fontSize: "var(--type-heading-font-size)",
            fontWeight: "var(--type-heading-font-weight)",
            marginTop: 0,
          }}
        >
          Outage exposure
        </h2>
        <OutageSummary data={outageData} />
      </Panel>

      <Panel>
        <h2
          style={{
            fontFamily: "var(--type-heading-font-family)",
            fontSize: "var(--type-heading-font-size)",
            fontWeight: "var(--type-heading-font-weight)",
            marginTop: 0,
          }}
        >
          Storm record
        </h2>
        <StormRecordPanel counties={stormRecords} />
      </Panel>

      <Panel>
        <h2
          style={{
            fontFamily: "var(--type-heading-font-family)",
            fontSize: "var(--type-heading-font-size)",
            fontWeight: "var(--type-heading-font-weight)",
            marginTop: 0,
          }}
        >
          Ranking readiness
        </h2>
        {scoredCounties.length > 1 ? (
          <p style={{ margin: "0 0 var(--space-2) 0", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
            Combined across every loaded county ({scoredCounties.map((c) => c.name).join(", ")}) -- not yet split by
            county.
          </p>
        ) : null}
        {gateCounts === null ? (
          <MissingState variant="not-loaded" reason="County parcel records not loaded yet" />
        ) : (
          <StatList>
            <StatRow
              id="overview-total-parcels"
              label="Parcels on the appraisal rolls loaded so far"
              value={gateCounts.totalParcels.toLocaleString()}
              unit="parcels"
              source={gateCounts.source}
            />
            <StatRow
              id="overview-single-family"
              label="Single-family homes"
              value={gateCounts.singleFamilyCount.toLocaleString()}
              unit="parcels"
              source={gateCounts.source}
            />
            <StatRow
              id="overview-homestead"
              label="Homestead (owner-occupied)"
              value={gateCounts.homesteadCount.toLocaleString()}
              unit="parcels"
              source={gateCounts.source}
            />
            <StatRow
              id="overview-gated"
              label="Owner-occupied single-family homes with a mapped lot"
              value={gateCounts.gatedCount === null ? "not loaded" : gateCounts.gatedCount.toLocaleString()}
              unit="homes"
              source={gateCounts.source}
              linkHref="/ranking"
              linkLabel="Who Base can serve"
            />
            <StatRow
              id="overview-top-homes"
              label="Homes ranked (Base can serve them)"
              value={topHomesCount === null ? null : topHomesCount.toLocaleString()}
              unit="homes"
              missingReason="Ranking not available right now"
              linkHref="/ranking"
              linkLabel="See table & map"
            />
          </StatList>
        )}
      </Panel>

      <Panel>
        <h2
          style={{
            fontFamily: "var(--type-heading-font-family)",
            fontSize: "var(--type-heading-font-size)",
            fontWeight: "var(--type-heading-font-weight)",
            marginTop: 0,
          }}
        >
          Time to permit a home battery in Austin
        </h2>
        <p style={{ margin: "0 0 var(--space-3) 0", color: "var(--theme-ink-muted)", maxWidth: "70ch" }}>
          Days from application to issue for a City of Austin (Austin Energy) battery permit, by quarter --
          other installers vs. Base Power&rsquo;s own permits.
        </p>
        <PermitTimelinePanel rows={permitTimeline} />
      </Panel>

      <Panel>
        <h2
          style={{
            fontFamily: "var(--type-heading-font-family)",
            fontSize: "var(--type-heading-font-size)",
            fontWeight: "var(--type-heading-font-weight)",
            marginTop: 0,
          }}
        >
          How we know it works
        </h2>
        <span id="model-proof" />
        <PredictionProof modelCard={modelCard} />
      </Panel>

      <Panel>
        <h2
          style={{
            fontFamily: "var(--type-heading-font-family)",
            fontSize: "var(--type-heading-font-size)",
            fontWeight: "var(--type-heading-font-weight)",
            marginTop: 0,
          }}
        >
          Provenance
        </h2>
        <StatList>
          <StatRow
            id="overview-sources-loaded"
            label="Source files loaded"
            value={sourcesLoadedCount}
            unit="files"
            missingReason="Source list not available right now"
            linkHref="/sources"
            linkLabel="Full manifest"
          />
        </StatList>
        <p style={{ margin: "var(--space-3) 0 0 0", maxWidth: "70ch", color: "var(--theme-ink-muted)" }}>
          Every number on screen traces to one of them, with retrieval time and SHA-256.
        </p>
      </Panel>
    </div>
  );
}
