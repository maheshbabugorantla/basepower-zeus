import { query } from "../lib/db";
import { Panel } from "../components/ui/Panel";
import { MissingState } from "../components/ui/MissingState";
import type { ProvenancePopoverProps } from "../components/ui/ProvenancePopover";
import { OutageSummary, type OutageSummaryData } from "../components/OutageSummary";
import { StatRow, StatList } from "../components/ui/StatRow";

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
const OUTAGE_YEAR = 2025;

interface TravisOutageRow {
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

async function getTravis2025Outage(): Promise<OutageSummaryData | null> {
  const rows = await query<TravisOutageRow>(
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
    customerHoursOut:
      row.customer_hours_out === null ? null : Number(row.customer_hours_out),
    nullReason: row.customer_hours_out_null_reason,
    hoursPerCustomer:
      row.hours_per_customer === null ? null : Number(row.hours_per_customer),
    hoursPerCustomerNullReason: row.hours_per_customer_null_reason,
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
    const rows = await query<{ n: string | number }>(`select count(*) as n from api.top_homes`);
    return rows[0] ? Number(rows[0].n) : 0;
  } catch (err) {
    console.error("page: failed to load api.top_homes count", err);
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
  const [travisOutage, gateCounts, topHomesCount, sourcesLoadedCount] = await Promise.all([
    getTravis2025Outage(),
    getGateCounts(),
    getTopHomesCount(),
    getSourcesLoadedCount(),
  ]);

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
          Real public data on Travis County homes, gated to owner-occupied single-family
          parcels, scored for Base Power outreach.
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
        <OutageSummary data={travisOutage} />
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
        {gateCounts === null ? (
          <MissingState variant="not-loaded" reason="core.parcels has no rows yet" />
        ) : (
          <StatList>
            <StatRow
              id="overview-total-parcels"
              label="Residential parcels (Travis County, TCAD)"
              value={gateCounts.totalParcels.toLocaleString()}
              unit="parcels"
              source={gateCounts.source}
            />
            <StatRow
              id="overview-single-family"
              label="Single-family (state code A1)"
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
              label="Gated for ranking (single-family + homestead + parcel geometry)"
              value={gateCounts.gatedCount === null ? "not loaded" : gateCounts.gatedCount.toLocaleString()}
              unit="homes"
              source={gateCounts.source}
              linkHref="/ranking"
              linkLabel="See funnel"
            />
            <StatRow
              id="overview-top-homes"
              label="Homes currently ranked"
              value={topHomesCount === null ? null : topHomesCount}
              unit="homes"
              missingReason="api.top_homes could not be read"
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
          Provenance
        </h2>
        <StatList>
          <StatRow
            id="overview-sources-loaded"
            label="Source files loaded"
            value={sourcesLoadedCount}
            unit="files"
            missingReason="api.sources could not be read"
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
