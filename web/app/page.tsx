import Link from "next/link";
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
import { getCountiesWithScoredHomes } from "../lib/counties.server";
import { COUNTY_CANDIDATES, resolveCounty } from "../lib/counties";
import { StormRecordPanel, type StormRecordCounty } from "../components/StormRecordPanel";

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
      // Perf follow-up: was a live `select distinct county_fips,
      // territory_eia_id from core.mv_home_signals` (measured 1.4s x21 on
      // zeus_web_ro -- a full scan+distinct over every gated home).
      // api.county_territories (0303b) is the same distinct pair,
      // precomputed once per refresh.
      `with present as (
         select county_fips, territory_eia_id
         from api.county_territories
         where county_fips = any($1::text[])
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

async function getGateCounts(countyFips: string): Promise<GateCounts | null> {
  try {
    const rows = await query<GateCountsRow>(
      `select
         pgc.total_parcels,
         pgc.single_family_count,
         pgc.homestead_count,
         (select sum(home_count) from api.gate_counts where county_fips = $1) as gated_count,
         s.source, s.url, s.retrieved_at, s.sha256, s.storage_key, s.runner,
         s.latest_run_id, s.latest_run_rows_in, s.latest_run_rows_loaded
       from api.parcel_gate_counts pgc
       left join api.sources s on s.source_id = pgc.source_ids[1]
       where pgc.county_fips = $1`,
      [countyFips]
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

interface TopHomesCount {
  passedCount: number | null;
  /** M-utility-gate: homes that ARE ranked/scored but not yet confirmed
   * Base-servable (Williamson today) -- read separately so the Overview
   * can say why the count is 0/low instead of the generic "ranking not
   * available" (which would wrongly imply the pipeline hasn't run). */
  utilityNotConfirmedCount: number | null;
}

async function getTopHomesCount(countyFips: string): Promise<TopHomesCount> {
  try {
    const rows = await query<{ reason: string; n: string | number | null }>(
      `select reason, home_count as n from api.gate_counts
       where county_fips = $1 and reason in ('passed', 'utility_not_confirmed')`,
      [countyFips]
    );
    const byReason = new Map(rows.map((r) => [r.reason, r.n === null ? null : Number(r.n)]));
    return {
      passedCount: byReason.get("passed") ?? null,
      utilityNotConfirmedCount: byReason.get("utility_not_confirmed") ?? null,
    };
  } catch (err) {
    console.error("page: failed to load ranked home count", err);
    return { passedCount: null, utilityNotConfirmedCount: null };
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

async function getSourcesLoadedCount(): Promise<number | null> {
  try {
    const rows = await query<{ n: string | number }>(`select count(*) as n from api.sources`);
    return rows[0] ? Number(rows[0].n) : 0;
  } catch (err) {
    console.error("page: failed to load api.sources count", err);
    return null;
  }
}

export default async function HomePage({
  // Optional (default {}) so existing tests that render HomePage() with
  // no args (pre-dating this county-scoping change) keep compiling and
  // get Travis/the first available county, exactly as before.
  searchParams = Promise.resolve({}),
}: {
  searchParams?: Promise<{ county?: string }>;
} = {}) {
  const [{ county: requestedCounty }, scoredCounties] = await Promise.all([
    searchParams,
    getCountiesWithScoredHomes(),
  ]);
  const county = resolveCounty(requestedCounty, scoredCounties);
  const scoredCountyFips = scoredCounties.map((c) => c.fips);
  const [distributors, countyContext, gateCounts, topHomesCount, sourcesLoadedCount, permitTimeline, stormRecords] =
    await Promise.all([
      getDistributorReliability(scoredCountyFips),
      getCountyOutageContext(),
      getGateCounts(county.fips),
      getTopHomesCount(county.fips),
      getSourcesLoadedCount(),
      getPermitTimelineByQuarter(),
      getStormRecords(scoredCountyFips),
    ]);

  const outageData: OutageSummaryData = { distributors, countyContext };

  return (
    <div style={{ display: "grid", gap: "var(--space-6)", maxWidth: "1000px" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
        <h1
          style={{
            fontFamily: "var(--type-title-font-family)",
            fontSize: "var(--type-title-font-size)",
            fontWeight: "var(--type-title-font-weight)",
            margin: 0,
          }}
        >
          Overview
        </h1>
        <p style={{ color: "var(--theme-ink-muted)", margin: 0, maxWidth: "70ch" }}>
          Real public data on Texas homes ({scoredCounties.map((c) => c.name).join(", ")}{" "}
          {scoredCounties.length > 1 ? "Counties" : "County"} so far), gated to owner-occupied
          single-family parcels, scored for Base Power outreach. Ranking readiness below is for{" "}
          {county.name} County.
        </p>
      </div>

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
          Ranking readiness -- {county.name} County
        </h2>
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
              // A real 0-with-utility-not-confirmed-homes county
              // (Williamson) renders the explanatory MissingState below
              // instead of a bare "0 homes" -- that reads as "ranking
              // hasn't run" when actually every home there IS ranked,
              // just not yet confirmed Base-servable.
              value={
                topHomesCount.passedCount === 0 && (topHomesCount.utilityNotConfirmedCount ?? 0) > 0
                  ? null
                  : topHomesCount.passedCount === null
                    ? null
                    : topHomesCount.passedCount.toLocaleString()
              }
              unit="homes"
              missingReason={
                topHomesCount.passedCount === 0 && (topHomesCount.utilityNotConfirmedCount ?? 0) > 0
                  ? `${(topHomesCount.utilityNotConfirmedCount ?? 0).toLocaleString()} homes are ranked but not yet confirmed Base-servable -- check the address with the utility`
                  : "Ranking not available right now"
              }
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

      <p style={{ margin: 0 }}>
        <Link href="/sources#how-leads-are-prioritized">How leads are prioritized &amp; the model&rsquo;s accuracy check →</Link>
      </p>

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
