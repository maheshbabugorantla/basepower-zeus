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
// a Travis figure. This eia_id/base_name pairing is a small, fixed list of
// real EIA-861 utility identifiers (documented in
// supabase/migrations/0201_m2.sql's core.territories comment), not
// fabricated data — the query below still reads every value (SAIDI, year,
// early_release, provenance) live from core.utility_reliability.
const DISTRIBUTOR_CANDIDATES: { baseName: string; eiaId: string; county: string }[] = [
  { baseName: "Austin Energy", eiaId: "1015", county: TRAVIS_COUNTY_NAME },
  { baseName: "Oncor", eiaId: "44372", county: TRAVIS_COUNTY_NAME },
  { baseName: "CenterPoint Energy", eiaId: "8901", county: "Harris" },
];

interface DistributorReliabilityDbRow {
  base_name: string;
  eia_id: string;
  distributor_name: string | null;
  year: number | null;
  saidi_incl_major: string | number | null;
  saidi_incl_major_null_reason: string | null;
  early_release: boolean | null;
  in_loaded_county: boolean;
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
 * year first, for the Base-served distributors in DISTRIBUTOR_CANDIDATES.
 * `in_loaded_county` is an index probe on precomputed per-home territory
 * (core.mv_home_signals, index from migration 0208) — no request-time
 * spatial join — so a distributor with no loaded homes in the county
 * (CenterPoint/Harris, currently)
 * is reported as such instead of being silently included or excluded.
 */
async function getDistributorReliability(): Promise<DistributorReliabilityRow[]> {
  try {
    const eiaIds = DISTRIBUTOR_CANDIDATES.map((d) => d.eiaId);
    const rows = await query<DistributorReliabilityDbRow>(
      `select
         cw.base_name,
         t.eia_id,
         ur.utility_name as distributor_name,
         ur.year,
         ur.saidi_incl_major,
         ur.saidi_incl_major_null_reason,
         ur.early_release,
         exists (
           select 1 from core.mv_home_signals h
           where h.county_fips = $1
             and h.territory_eia_id = t.eia_id::text
         ) as in_loaded_county,
         s.source, s.url, s.retrieved_at, s.sha256, s.storage_key, s.runner,
         s.latest_run_id, s.latest_run_rows_in, s.latest_run_rows_loaded
       from core.utility_crosswalk cw
       join core.territories t on t.eia_id = cw.eia_utility_number
       left join lateral (
         select r.utility_name, r.year, r.saidi_incl_major,
                r.saidi_incl_major_null_reason, r.early_release, r.source_id
         from core.utility_reliability r
         where r.eia_id = t.eia_id
         order by r.year desc
         limit 1
       ) ur on true
       left join api.sources s on s.source_id = ur.source_id
       where cw.eia_utility_number = any($2::text[])`,
      [TRAVIS_COUNTY_FIPS, eiaIds]
    );

    const byEiaId = new Map(rows.map((r) => [r.eia_id, r]));

    return DISTRIBUTOR_CANDIDATES.map((candidate) => {
      const row = byEiaId.get(candidate.eiaId);
      if (!row) {
        return {
          baseName: candidate.baseName,
          county: candidate.county,
          inLoadedCounty: false,
          year: null,
          saidiInclMajor: null,
          earlyRelease: false,
          source: null,
        };
      }

      const hasSource =
        row.source !== null &&
        row.url !== null &&
        row.retrieved_at !== null &&
        row.sha256 !== null &&
        row.storage_key !== null &&
        row.runner !== null;

      return {
        baseName: candidate.baseName,
        county: candidate.county,
        inLoadedCounty: row.in_loaded_county,
        year: row.year,
        saidiInclMajor:
          row.saidi_incl_major === null ? null : Number(row.saidi_incl_major),
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
    return DISTRIBUTOR_CANDIDATES.map((candidate) => ({
      baseName: candidate.baseName,
      county: candidate.county,
      inLoadedCounty: false,
      year: null,
      saidiInclMajor: null,
      earlyRelease: false,
      source: null,
    }));
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
  const [distributors, countyContext, gateCounts, topHomesCount, sourcesLoadedCount] =
    await Promise.all([
      getDistributorReliability(),
      getCountyOutageContext(),
      getGateCounts(),
      getTopHomesCount(),
      getSourcesLoadedCount(),
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
          Ranking readiness
        </h2>
        {gateCounts === null ? (
          <MissingState variant="not-loaded" reason="County parcel records not loaded yet" />
        ) : (
          <StatList>
            <StatRow
              id="overview-total-parcels"
              label="Parcels on the Travis County roll"
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
