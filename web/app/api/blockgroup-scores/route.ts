import { NextResponse } from "next/server";
import { query } from "../../../lib/db";
import { sanitizeWeights, TRAVIS_COUNTY_FIPS, type SignalKey } from "../top-homes/route";

// M2-W3: map-sync route. Calls api.blockgroup_scores_weighted(weights,
// county_fips) — supabase/migrations/0205_map_sync.sql — every time
// BlockGroupMap's own debounced weight-change effect fires (same 250ms
// debounce shape RankingBoard already uses for /api/top-homes), so the
// choropleth recolors with EXACTLY the weights the table just re-ranked
// with. Geometry itself keeps coming from api.blockgroup_geojson
// (0203_perf_precompute.sql, unchanged) — this route returns scores only,
// applied client-side via maplibre feature-state.
//
// force-dynamic + no-store: the underlying core.mv_home_signals refreshes
// on its own schedule; every request must reflect the live state.

export const dynamic = "force-dynamic";

interface BlockGroupScoreDbRow {
  block_group_geoid: string;
  score: string | number;
  homes_scored: string | number;
}

export async function POST(request: Request) {
  let body: { weights?: unknown; countyFips?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const weights: Record<SignalKey, number> = sanitizeWeights(body.weights);
  const countyFips = typeof body.countyFips === "string" && body.countyFips.length > 0
    ? body.countyFips
    : TRAVIS_COUNTY_FIPS;

  const rows = await query<BlockGroupScoreDbRow>(
    `select block_group_geoid, score, homes_scored from api.blockgroup_scores_weighted($1::jsonb, $2::text)`,
    [JSON.stringify(weights), countyFips]
  );

  return NextResponse.json(
    {
      scores: rows.map((row) => ({
        geoid: row.block_group_geoid,
        score: Number(row.score),
        homesScored: Number(row.homes_scored),
      })),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
