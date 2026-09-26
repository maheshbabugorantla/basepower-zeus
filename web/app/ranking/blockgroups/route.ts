import { NextRequest, NextResponse } from "next/server";
import { query } from "../../../lib/db";
import { COUNTY_CANDIDATES, DEFAULT_COUNTY } from "../../../lib/counties";

// M1-W1: serves the Travis block-group polygons for BlockGroupMap's
// choropleth. 0203_perf_precompute.sql (M2 perf) replaced the two live
// queries this route used to run (core.block_groups joined in
// application code with api.blockgroup_scores, geometry simplified via a
// live ST_SimplifyPreserveTopology on every request — ~451 ms for 766
// Travis polygons) with one read of api.blockgroup_geojson, a thin view
// over core.mv_blockgroup_geojson: the join and the simplification
// (same tolerance, still in degrees since these are EPSG:4326 polygons,
// topology-preserving so adjacent block-group borders never develop gaps
// or overlaps) now happen once per pipeline refresh, not once per
// request.
//
// force-dynamic: pipelines refresh core.mv_blockgroup_geojson
// concurrently while this route is live, so it must never be statically
// cached — every request reflects the current materialized state.

export const dynamic = "force-dynamic";

interface BlockGroupGeoJSONRow {
  geoid: string;
  county_fips: string | null;
  geometry: string;
  score: number | string | null;
  score_null_reason: string | null;
  rate_per_1000: number | string | null;
  homes_gated: number | string | null;
}

function toNumberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

// M3-W1: county-driven — accepts ?county=<fips>, validated against the
// same small candidate list the switcher uses (never an arbitrary
// caller-supplied fips passed straight to a query, even though it's
// already parameterized).
export async function GET(request: NextRequest) {
  const requested = request.nextUrl.searchParams.get("county");
  const countyFips =
    COUNTY_CANDIDATES.find((c) => c.fips === requested)?.fips ?? DEFAULT_COUNTY.fips;

  const rows = await query<BlockGroupGeoJSONRow>(
    `select geoid, county_fips, geometry, score, score_null_reason, rate_per_1000, homes_gated
     from api.blockgroup_geojson
     where county_fips = $1`,
    [countyFips]
  );

  const features = rows.map((row) => ({
    type: "Feature" as const,
    geometry: JSON.parse(row.geometry),
    properties: {
      geoid: row.geoid,
      county_fips: row.county_fips,
      score: toNumberOrNull(row.score),
      score_null_reason: row.score_null_reason,
      rate_per_1000: toNumberOrNull(row.rate_per_1000),
      homes_gated: toNumberOrNull(row.homes_gated),
    },
  }));

  return NextResponse.json(
    {
      type: "FeatureCollection" as const,
      features,
    },
    {
      headers: {
        // Real-time correctness over caching: geometry/score pipelines run
        // concurrently with the app being live.
        "Cache-Control": "no-store",
      },
    }
  );
}
