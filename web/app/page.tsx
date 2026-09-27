import type { ReactNode } from "react";
import Link from "next/link";
import { query } from "../lib/db";
import { MissingState } from "../components/ui/MissingState";
import type {
  CountyOutageContext,
  DistributorReliabilityRow,
  OutageSourceProvenance,
} from "../components/OutageSummary";
import { OutageBars } from "../components/OutageBars";
import { ProvenancePopover } from "../components/ui/ProvenancePopover";
import { StaleBadge } from "../components/ui/Badge";
import { getCountiesWithScoredHomes } from "../lib/counties.server";
import { COUNTY_CANDIDATES, type CountyOption } from "../lib/counties";
import { StormRecordPanel, type StormRecordCounty } from "../components/StormRecordPanel";

// M0-W1: server component. `force-dynamic` is required, not decorative —
// this page must query api.county_outage at request time (the EAGLE-I
// backfill can land while the app is live), never bake a value in at
// build time.
//
// Redesign (Mock C, 2026-09-27 user decision): Overview is TERRITORY-WIDE
// -- it covers every county getCountiesWithScoredHomes() returns and
// ignores `?county=` entirely (the county switcher is hidden on this
// route, see components/TopBar.tsx). A 2x2 grid at viewport height:
// outage exposure by distributor (grouped by county, deduped within
// each), the three-county storm record, one ranking-readiness row per
// county, and permits/model figures for the one jurisdiction that
// actually has permit data loaded (City of Austin/Travis).
export const dynamic = "force-dynamic";

const OUTAGE_YEAR = 2025;

// Confirmed live via `select distinct jurisdiction from
// api.permit_path_stats` (2026-09-27): every jurisdiction row is an
// Austin-area ETJ/full-purpose variant, plus the pre-aggregated 'ALL'.
// No Harris or Williamson jurisdiction has ever been loaded (City of
// Austin permits are the only public permit feed this app has a
// pipeline for -- PRODUCT.md). This is a record of that confirmed DB
// state, not a guess -- a county absent from this map renders the
// MissingState below, never a fabricated figure.
const COUNTY_PERMIT_JURISDICTION: Record<string, string> = {
  "48453": "ALL", // Travis -> City of Austin
};

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
 * candidate array. One row per (county_fips, territory_eia_id) pair (the
 * view's own PK), so a distributor covering two counties (e.g. Bluebonnet
 * in both Travis and Williamson) legitimately appears once per county --
 * OutageSummary groups by county and never repeats a distributor WITHIN
 * one county's own group (the critique's dedupe bug).
 */
async function getDistributorReliability(countyFipsList: string[]): Promise<DistributorReliabilityRow[]> {
  try {
    const rows = await query<DistributorReliabilityDbRow>(
      `with present as (
         select distinct county_fips, territory_eia_id
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
  county_fips: string;
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
 * County-level EAGLE-I context (hours_per_customer, never the raw
 * county-wide customer_hours_out total) -- one row per scored county,
 * queried once for the whole territory.
 */
async function getCountyOutageContexts(countyFipsList: string[]): Promise<CountyOutageContext[]> {
  try {
    const rows = await query<CountyOutageDbRow>(
      `select
         co.county_fips,
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
       where co.county_fips = any($1::text[]) and co.year = $2`,
      [countyFipsList, OUTAGE_YEAR]
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
        countyName: countyNameByFips.get(row.county_fips) ?? row.county_fips,
        year: OUTAGE_YEAR,
        hoursPerCustomer: row.hours_per_customer === null ? null : Number(row.hours_per_customer),
        hoursPerCustomerNullReason: row.hours_per_customer_null_reason,
        customerHoursOut: row.customer_hours_out === null ? null : Number(row.customer_hours_out),
        customerHoursOutNullReason: row.customer_hours_out_null_reason,
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
    });
  } catch (err) {
    console.error("page: failed to load api.county_outage", err);
    return [];
  }
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

interface ReadinessRow {
  county: CountyOption;
  /** true when the county's loader kept single-family homesteads only (the
   * roll has no non-single-family and no non-homestead parcel at all), so
   * "parcels" and "single-family" were never counted separately */
  prefilteredRoll: boolean;
  totalParcels: number | null;
  singleFamilyCount: number | null;
  homesteadCount: number | null;
  gatedCount: number | null;
  passedCount: number | null;
  utilityNotConfirmedCount: number | null;
}

interface GateCountsDbRow {
  total_parcels: string | number;
  single_family_count: string | number;
  not_single_family_count: string | number;
  homestead_count: string | number;
  not_homestead_count: string | number;
  gated_count: string | number | null;
}

async function getReadinessRow(county: CountyOption): Promise<ReadinessRow> {
  try {
    const [gateRows, topHomesRows] = await Promise.all([
      query<GateCountsDbRow>(
        `select
           pgc.total_parcels,
           pgc.single_family_count,
           pgc.not_single_family_count,
           pgc.homestead_count,
           pgc.not_homestead_count,
           (select sum(home_count) from api.gate_counts where county_fips = $1) as gated_count
         from api.parcel_gate_counts pgc
         where pgc.county_fips = $1`,
        [county.fips]
      ),
      query<{ reason: string; n: string | number | null }>(
        `select reason, home_count as n from api.gate_counts
         where county_fips = $1 and reason in ('passed', 'utility_not_confirmed')`,
        [county.fips]
      ),
    ]);
    const gateRow = gateRows[0];
    const byReason = new Map(topHomesRows.map((r) => [r.reason, r.n === null ? null : Number(r.n)]));
    const prefilteredRoll =
      !!gateRow && Number(gateRow.not_single_family_count) === 0 && Number(gateRow.not_homestead_count) === 0;
    return {
      county,
      prefilteredRoll,
      totalParcels: gateRow ? Number(gateRow.total_parcels) : null,
      singleFamilyCount: gateRow ? Number(gateRow.single_family_count) : null,
      homesteadCount: gateRow ? Number(gateRow.homestead_count) : null,
      gatedCount: gateRow?.gated_count == null ? null : Number(gateRow.gated_count),
      passedCount: byReason.get("passed") ?? null,
      utilityNotConfirmedCount: byReason.get("utility_not_confirmed") ?? null,
    };
  } catch (err) {
    console.error(`page: failed to load readiness row for ${county.fips}`, err);
    return {
      county,
      prefilteredRoll: false,
      totalParcels: null,
      singleFamilyCount: null,
      homesteadCount: null,
      gatedCount: null,
      passedCount: null,
      utilityNotConfirmedCount: null,
    };
  }
}

interface PermitStatsDbRow {
  n: string | number;
  median_days: string | number | null;
  p90_days: string | number | null;
  share_never_finished: string | number | null;
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

interface PermitStats {
  n: number;
  medianDays: number | null;
  p90Days: number | null;
  shareNeverFinished: number | null;
  source: OutageSourceProvenance | null;
}

/** City of Austin battery permits since Texas SB 1252 took effect, all
 * installers other than Base -- the same api.permit_path_stats row the
 * home record's permit path quotes (period_type 'sb1252', period
 * 'after_sb1252'), so both pages state identical figures. The latest
 * calendar quarter is still in progress, so its never-finished share
 * would read artificially low; the SB 1252 period is complete enough to
 * state. */
async function getPermitStats(jurisdiction: string): Promise<PermitStats | null> {
  try {
    const rows = await query<PermitStatsDbRow>(
      `select p.n, p.median_days, p.p90_days, p.share_never_finished,
              s.source, s.url, s.retrieved_at, s.sha256, s.storage_key, s.runner,
              s.latest_run_id, s.latest_run_rows_in, s.latest_run_rows_loaded
       from api.permit_path_stats p
       left join api.sources s on s.source_id = p.source_id
       where p.jurisdiction = $1 and p.label = 'battery' and p.period_type = 'sb1252'
             and p.period = 'after_sb1252' and p.is_base_power = false`,
      [jurisdiction]
    );
    const r = rows[0];
    if (!r) return null;
    const num = (v: string | number | null) => (v === null ? null : Number(v));
    const hasSource =
      r.source !== null && r.url !== null && r.retrieved_at !== null && r.sha256 !== null && r.storage_key !== null && r.runner !== null;
    return {
      n: Number(r.n),
      medianDays: num(r.median_days),
      p90Days: num(r.p90_days),
      shareNeverFinished: num(r.share_never_finished),
      source: hasSource
        ? {
            dataset: r.source as string,
            url: r.url as string,
            retrievedAt: r.retrieved_at instanceof Date ? r.retrieved_at.toISOString() : (r.retrieved_at as string),
            sha256: r.sha256 as string,
            runId: r.latest_run_id ?? "none",
            runner: r.runner as "cron" | "cli",
            rowsIn: r.latest_run_rows_in,
            rowsLoaded: r.latest_run_rows_loaded,
            rawFileHref: `/storage/${r.storage_key}`,
          }
        : null,
    };
  } catch (err) {
    console.error("page: failed to load api.permit_path_stats", err);
    return null;
  }
}

/** Days to at most one decimal, never a float artefact (66.7000000000001). */
function formatDays(d: number): string {
  return Number.isInteger(d) ? d.toLocaleString() : (Math.round(d * 10) / 10).toLocaleString();
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

/** "Texas, at a glance" / "Travis, Harris and Williamson, at a glance" --
 * built from the real, currently-scored county list, never hand-typed. */
function formatCountyListTitle(names: string[]): string {
  if (names.length === 0) return "Texas, at a glance";
  if (names.length === 1) return `${names[0]} County, at a glance`;
  if (names.length === 2) return `${names[0]} and ${names[1]} Counties, at a glance`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} Counties, at a glance`;
}

function Sourced({ id, source, children }: { id: string; source: OutageSourceProvenance | null; children: ReactNode }) {
  if (!source) return <>{children}</>;
  return (
    <ProvenancePopover
      id={id}
      dataset={source.dataset}
      url={source.url}
      retrievedAt={source.retrievedAt}
      sha256={source.sha256}
      runId={source.runId}
      runner={source.runner}
      rowsIn={source.rowsIn}
      rowsLoaded={source.rowsLoaded}
      rawFileHref={source.rawFileHref}
    >
      {children}
    </ProvenancePopover>
  );
}

const PREFILTERED_REASON = "The appraisal loader keeps single-family homesteads only";

export default async function HomePage() {
  const scoredCounties = await getCountiesWithScoredHomes();
  const scoredCountyFips = scoredCounties.map((c) => c.fips);

  const permitCountiesWithData = scoredCounties.filter((c) => COUNTY_PERMIT_JURISDICTION[c.fips]);
  const permitCountiesWithoutData = scoredCounties.filter((c) => !COUNTY_PERMIT_JURISDICTION[c.fips]);

  const [distributors, countyContexts, sourcesLoadedCount, stormRecords, readinessRows, permitStats] = await Promise.all([
    getDistributorReliability(scoredCountyFips),
    getCountyOutageContexts(scoredCountyFips),
    getSourcesLoadedCount(),
    getStormRecords(scoredCountyFips),
    Promise.all(scoredCounties.map((c) => getReadinessRow(c))),
    permitCountiesWithData[0] ? getPermitStats(COUNTY_PERMIT_JURISDICTION[permitCountiesWithData[0].fips]) : Promise.resolve(null),
  ]);

  const totalRanked = readinessRows.reduce((sum, r) => sum + (r.passedCount ?? 0), 0);
  const showsEarlyRelease = distributors.some((d) => d.year === OUTAGE_YEAR && d.earlyRelease);
  const prefilteredCounties = readinessRows.filter((r) => r.prefilteredRoll).map((r) => r.county.name);
  const notLoadedCell = (
    <MissingState className="missing-state--compact" variant="not-loaded" reason={PREFILTERED_REASON} title={PREFILTERED_REASON} />
  );

  return (
    <div className="overview-page">
      <div className="ov-head">
        <h1 className="ov-head__title">{formatCountyListTitle(scoredCounties.map((c) => c.name))}</h1>
        <span className="ov-head__sub">
          Real public data on owner-occupied single-family homes · {totalRanked.toLocaleString()} ranked for Base
          outreach
        </span>
      </div>

      <div className="ov-grid">
        <section className="ov-panel ov-panel--outage" aria-labelledby="ov-outage-h">
          <div className="ov-panel__head">
            <h2 id="ov-outage-h">Outage exposure by distributor</h2>
            {showsEarlyRelease ? <StaleBadge>{OUTAGE_YEAR} early release, not fully edited</StaleBadge> : null}
          </div>
          <p className="ov-panel__sub">
            Bars show minutes without power per customer in {OUTAGE_YEAR} (SAIDI, incl. major events), EIA-861. EAGLE-I county
            context is a county-wide average across every customer, not a per-home figure.
          </p>
          <OutageBars distributors={distributors} countyContexts={countyContexts} year={OUTAGE_YEAR} />
          <div className="ov-panel__go">
            <Link href="/ranking">See which homes rank highest →</Link>
          </div>
        </section>

        <section className="ov-panel" aria-labelledby="ov-storm-h">
          <div className="ov-panel__head">
            <h2 id="ov-storm-h">Storm record</h2>
          </div>
          <StormRecordPanel counties={stormRecords} />
        </section>

        <section className="ov-panel" aria-labelledby="ov-ready-h">
          <div className="ov-panel__head">
            <h2 id="ov-ready-h">Ranking readiness</h2>
          </div>
          <p className="ov-panel__sub">How many parcels make it into the ranked list, by county.</p>
          <div className="readiness-grid" role="table" aria-label="Ranking readiness by county">
            <div className="readiness-grid__row readiness-grid__row--head" role="row">
              <div role="columnheader">County</div>
              <div role="columnheader">Parcels</div>
              <div role="columnheader">Single-family</div>
              <div role="columnheader">Homestead</div>
              <div role="columnheader">Mapped lot</div>
              <div role="columnheader">Ranked</div>
            </div>
            {readinessRows.map((r) => (
              <div className="readiness-grid__row" role="row" key={r.county.fips}>
                <div role="cell" className="readiness-grid__county">
                  {r.county.name}
                </div>
                <div role="cell">
                  {r.prefilteredRoll ? notLoadedCell : r.totalParcels === null ? <MissingState className="missing-state--compact" variant="not-loaded" reason="Not loaded" /> : r.totalParcels.toLocaleString()}
                </div>
                <div role="cell">
                  {r.prefilteredRoll ? notLoadedCell : r.singleFamilyCount === null ? <MissingState className="missing-state--compact" variant="not-loaded" reason="Not loaded" /> : r.singleFamilyCount.toLocaleString()}
                </div>
                <div role="cell">
                  {r.homesteadCount === null ? <MissingState className="missing-state--compact" variant="not-loaded" reason="Not loaded" /> : r.homesteadCount.toLocaleString()}
                </div>
                <div role="cell">
                  {r.gatedCount === null ? <MissingState className="missing-state--compact" variant="not-loaded" reason="Not loaded" /> : r.gatedCount.toLocaleString()}
                </div>
                <div role="cell">
                  {r.passedCount === null ? (
                    <MissingState className="missing-state--compact" variant="not-loaded" reason="Ranking not available right now" />
                  ) : (
                    <Link href={`/ranking?county=${r.county.fips}`}>{r.passedCount.toLocaleString()} →</Link>
                  )}
                </div>
              </div>
            ))}
          </div>
          {prefilteredCounties.length > 0 ? (
            <p className="ov-panel__note">
              Not loaded for {prefilteredCounties.join(" and ")}: {PREFILTERED_REASON.toLowerCase()}.
            </p>
          ) : null}
        </section>

        <section className="ov-panel" aria-labelledby="ov-permit-h">
          <div className="ov-panel__head">
            <h2 id="ov-permit-h">Battery permits, City of Austin</h2>
          </div>
          {permitStats === null ? (
            <MissingState variant="not-loaded" reason="City of Austin permit figures not loaded yet" />
          ) : (
            <>
              <div className="ov-figs">
                <div>
                  {permitStats.medianDays === null ? (
                    <MissingState className="missing-state--inline" variant="not-available" reason="Not published" />
                  ) : (
                    <Sourced id="ov-permit-median" source={permitStats.source}>
                      <span className="ov-fig ov-fig--lg">{formatDays(permitStats.medianDays)}</span>
                      <span className="ov-unit"> days</span>
                    </Sourced>
                  )}
                  <div className="ov-figs__label">typical time to issue</div>
                </div>
                <div>
                  {permitStats.p90Days === null ? (
                    <MissingState className="missing-state--inline" variant="not-available" reason="Not published" />
                  ) : (
                    <Sourced id="ov-permit-p90" source={permitStats.source}>
                      <span className="ov-fig ov-fig--lg">{formatDays(permitStats.p90Days)}+</span>
                      <span className="ov-unit"> days</span>
                    </Sourced>
                  )}
                  <div className="ov-figs__label">slowest 10 %</div>
                </div>
                <div>
                  {permitStats.shareNeverFinished === null ? (
                    <MissingState className="missing-state--inline" variant="not-available" reason="Not published" />
                  ) : (
                    <Sourced id="ov-permit-never" source={permitStats.source}>
                      <span className="ov-fig ov-fig--lg">{(Math.round(permitStats.shareNeverFinished * 1000) / 10).toLocaleString()}</span>
                      <span className="ov-unit"> %</span>
                    </Sourced>
                  )}
                  <div className="ov-figs__label">never finish</div>
                </div>
              </div>
              <p className="ov-panel__note">
                Since Texas SB 1252 took effect · {permitStats.n.toLocaleString()} permits by installers other than Base
                {permitCountiesWithData[0] ? ` · ${permitCountiesWithData[0].name} County` : ""}
              </p>
            </>
          )}
          {permitCountiesWithoutData.length > 0 ? (
            <p className="ov-panel__missing">
              <MissingState
                className="missing-state--inline"
                variant="not-available"
                reason={`${permitCountiesWithoutData.map((c) => c.name).join(" and ")} permit records are not a loaded public source`}
              />
            </p>
          ) : null}
          <div className="ov-panel__go">
            <Link href="/sources">How every figure is sourced →</Link>
          </div>
        </section>
      </div>

      <div className="overview-prov">
        <span>
          <strong>{sourcesLoadedCount ?? "—"}</strong> source files loaded
        </span>
        <span>Every figure on screen opens its source file</span>
        <Link href="/sources">Sources →</Link>
      </div>
    </div>
  );
}
