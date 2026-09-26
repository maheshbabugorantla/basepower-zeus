import { NextResponse } from "next/server";
import { query } from "../../../lib/db";

// M1-W1: serves the Travis block-group polygons for BlockGroupMap's
// choropleth, joined in application code with api.blockgroup_scores (the
// only source of the score itself — core.block_groups has no score
// column). Geometry is simplified in SQL (ST_SimplifyPreserveTopology, a
// tolerance in degrees since these are EPSG:4326 polygons) so the payload
// stays small; topology-preserving means adjacent block-group borders
// never develop gaps or overlaps from the simplification.
//
// force-dynamic: parcels/geometry pipelines may still be filling
// core.block_groups while this route is live, so it must never be
// statically cached — every request reflects the current table contents.

export const dynamic = "force-dynamic";

const TRAVIS_COUNTY_FIPS = "48453";
const SIMPLIFY_TOLERANCE_DEGREES = 0.0001; // ~11m at this latitude

interface BlockGroupGeomRow {
  geoid: string;
  county_fips: string | null;
  geometry: string;
}

interface BlockGroupScoreRow {
  block_group_geoid: string;
  score: number | string | null;
  score_null_reason: string | null;
  rate_per_1000: number | string | null;
  homes_gated: number | string | null;
}

function toNumberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

export async function GET() {
  const [geomRows, scoreRows] = await Promise.all([
    query<BlockGroupGeomRow>(
      `select
         geoid,
         county_fips,
         extensions.ST_AsGeoJSON(
           extensions.ST_SimplifyPreserveTopology(geom, $2)
         ) as geometry
       from core.block_groups
       where county_fips = $1`,
      [TRAVIS_COUNTY_FIPS, SIMPLIFY_TOLERANCE_DEGREES]
    ),
    query<BlockGroupScoreRow>(
      `select block_group_geoid, score, score_null_reason, rate_per_1000, homes_gated
       from api.blockgroup_scores
       where county_fips = $1`,
      [TRAVIS_COUNTY_FIPS]
    ),
  ]);

  const scoreByGeoid = new Map(scoreRows.map((row) => [row.block_group_geoid, row]));

  const features = geomRows.map((row) => {
    const scoreRow = scoreByGeoid.get(row.geoid);
    return {
      type: "Feature" as const,
      geometry: JSON.parse(row.geometry),
      properties: {
        geoid: row.geoid,
        county_fips: row.county_fips,
        score: toNumberOrNull(scoreRow?.score ?? null),
        score_null_reason:
          scoreRow?.score_null_reason ??
          (scoreRow ? null : "block_group_not_in_score_view"),
        rate_per_1000: toNumberOrNull(scoreRow?.rate_per_1000 ?? null),
        homes_gated: toNumberOrNull(scoreRow?.homes_gated ?? null),
      },
    };
  });

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
