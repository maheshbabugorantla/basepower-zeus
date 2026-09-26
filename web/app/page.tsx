import Link from "next/link";
import { query } from "../lib/db";
import { Panel } from "../components/ui/Panel";
import { Figure } from "../components/ui/Figure";
import { MissingState } from "../components/ui/MissingState";
import { OutageSummary, type OutageSummaryData } from "../components/OutageSummary";

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
}

async function getGateCounts(): Promise<GateCountsRow | null> {
  try {
    const rows = await query<GateCountsRow>(
      `select total_parcels, single_family_count, homestead_count from api.parcel_gate_counts`
    );
    return rows[0] ?? null;
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
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <p style={{ margin: 0, maxWidth: "70ch" }}>
            {gateCounts === null ? (
              <MissingState variant="not-loaded" reason="core.parcels has no rows yet" />
            ) : (
              <>
                Of <Figure value={Number(gateCounts.total_parcels).toLocaleString()} unit="parcels" /> in
                Travis County, <Figure value={Number(gateCounts.single_family_count).toLocaleString()} unit="are single-family" /> and{" "}
                <Figure value={Number(gateCounts.homestead_count).toLocaleString()} unit="are homestead" /> (independent
                gates — see the Ranking funnel for their intersection).
              </>
            )}
          </p>
          <p style={{ margin: 0, maxWidth: "70ch" }}>
            {topHomesCount === null ? (
              <MissingState variant="not-loaded" reason="api.top_homes could not be read" />
            ) : (
              <>
                <Figure value={topHomesCount} unit="homes currently ranked" /> — see the full{" "}
                <Link href="/ranking">Ranking</Link> screen for the eligibility funnel, map and
                top-homes table.
              </>
            )}
          </p>
        </div>
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
        <p style={{ margin: 0, maxWidth: "70ch" }}>
          {sourcesLoadedCount === null ? (
            <MissingState variant="not-loaded" reason="api.sources could not be read" />
          ) : (
            <>
              <Figure value={sourcesLoadedCount} unit="source files loaded" /> so far. Every number on
              screen traces to one of them — see <Link href="/sources">Sources</Link> for the full
              manifest with retrieval time and SHA-256.
            </>
          )}
        </p>
      </Panel>
    </div>
  );
}
