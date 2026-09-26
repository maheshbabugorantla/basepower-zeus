import Link from "next/link";
import { query } from "../../../lib/db";
import { Panel } from "../../../components/ui/Panel";
import { MissingState } from "../../../components/ui/MissingState";
import { CoverageLegend, CoverageMap } from "../../../components/CoverageGaps";
import type { CoverageBucketCount } from "../../../components/coverageZones";
import { getCountiesWithScoredHomes } from "../../../lib/counties.server";
import { resolveCounty } from "../../../lib/counties";

// M2-P11: "where Base is not yet, but backup demand is proven" -- a
// choropleth of Travis block groups bucketed into 4 zones (see
// components/coverageZones.ts) plus a legend with real HOME-level counts
// (api.coverage_bucket_counts). Never shows a per-home Base-customer flag
// or another installer's name -- only zone-level aggregates.

export const dynamic = "force-dynamic";

interface CoverageBucketDbRow {
  bucket: string;
  home_count: string | number;
}

async function getCoverageBucketCounts(): Promise<CoverageBucketCount[]> {
  try {
    const rows = await query<CoverageBucketDbRow>(`select bucket, home_count from api.coverage_bucket_counts`);
    return rows.map((r) => ({
      bucket: r.bucket as CoverageBucketCount["bucket"],
      homeCount: Number(r.home_count),
    }));
  } catch (err) {
    console.error("ranking/coverage: failed to load api.coverage_bucket_counts", err);
    return [];
  }
}

export default async function CoveragePage({
  searchParams,
}: {
  searchParams: Promise<{ county?: string }>;
}) {
  const [{ county: requestedCounty }, availableCounties, bucketCounts] = await Promise.all([
    searchParams,
    getCountiesWithScoredHomes(),
    getCoverageBucketCounts(),
  ]);
  const county = resolveCounty(requestedCounty, availableCounties);
  const isTravis = county.fips === "48453";

  return (
    <div style={{ display: "grid", gap: "var(--space-4)" }}>
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link href="/ranking">Ranking</Link>
        <span className="breadcrumb__separator" aria-hidden="true">
          /
        </span>
        <span>Coverage gaps</span>
      </nav>

      <div>
        <h1
          style={{
            fontFamily: "var(--type-title-font-family)",
            fontSize: "var(--type-title-font-size)",
            fontWeight: "var(--type-title-font-weight)",
            margin: 0,
          }}
        >
          Where Base isn&rsquo;t yet, but backup demand is proven
        </h1>
        <p style={{ color: "var(--theme-ink-muted)", margin: "var(--space-1) 0 0 0", maxWidth: "80ch" }}>
          {county.name} County block groups, bucketed from the City of Austin permit file joined to the TCAD
          parcel roll -- never a per-address label of who has backup or which installer.
          {!isTravis ? (
            <> No public permit feed covers {county.name} yet, so every block group here shows &ldquo;not observable&rdquo;.</>
          ) : null}
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: "var(--space-6)", alignItems: "start" }}>
        <Panel>
          {bucketCounts.length === 0 && isTravis ? (
            <MissingState variant="not-loaded" reason="Coverage data not loaded yet" />
          ) : (
            <CoverageMap geojsonUrl={`/ranking/coverage/blockgroups?county=${county.fips}`} />
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
            Legend
          </h2>
          {bucketCounts.length === 0 || !isTravis ? (
            <MissingState
              variant="not-available"
              reason={isTravis ? "not_loaded" : "no_public_permit_feed"}
            />
          ) : (
            <CoverageLegend bucketCounts={bucketCounts} />
          )}
          <p style={{ margin: "var(--space-3) 0 0 0", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
            Hover a block group on the map for its zone and counts. &ldquo;Not observable&rdquo; block groups sit
            outside the City of Austin permit area and are never shown as a gap.
          </p>
        </Panel>
      </div>
    </div>
  );
}
