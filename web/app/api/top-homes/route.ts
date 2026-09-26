import { NextResponse } from "next/server";
import { query } from "../../../lib/db";
import type { TopHomeRow } from "../../../components/TopHomesTable";

// M2-W1: live re-ranking for the Ranking screen's weight sliders.
//
// M2-W3 scope change: the table is no longer a fixed top-50. With no
// block group selected it pages through EVERY gate-passed county home
// (keyset pagination, 50/page); with a block group selected it pages
// through every gate-passed home in just that block group. Both paths
// call api.homes_ranked_weighted(weights, county_fips, block_group_geoid,
// after_score, after_prop_id, page_size) — supabase/migrations/
// 0205_map_sync.sql — a keyset-paginated, block-group-filterable sibling
// of api.top_homes_weighted with the identical score terms/flood-
// direction fix (0204_flood_direction.sql), plus the parcel centroid
// (core.parcel_geoms) so the same row drives the map dots too. On page 1
// (no afterScore/afterPropId) the route also calls
// api.homes_ranked_weighted_count once, so "Showing 1-50 of N" doesn't
// re-count on every Next/Previous click.
//
// force-dynamic + Cache-Control: no-store — the underlying signals refresh
// on their own schedule (core.refresh_all_scores(), M2-P* pipelines), and
// a re-rank must always reflect the live view state, never a cached one.

export const dynamic = "force-dynamic";

// The exact keys api.homes_ranked_weighted(weights jsonb, ...) reads (see
// 0201_m2.sql's api.top_homes_weighted function comment — same keys). A
// key not present in the object falls through to a CASE ... ELSE 0 in
// the SQL function, so a request need not supply every key.
export const SIGNAL_KEYS = [
  "outage",
  "flood",
  "empower",
  "age65",
  "electric_heat",
  "backup_intent",
] as const;

export type SignalKey = (typeof SIGNAL_KEYS)[number];

export const TRAVIS_COUNTY_FIPS = "48453";
export const PAGE_SIZE = 50;

interface HomesRankedWeightedDbRow {
  prop_id: string;
  geo_id: string | null;
  situs_num: string | null;
  situs_street: string | null;
  situs_city: string | null;
  situs_zip: string | null;
  market_value: string | number | null;
  block_group_geoid: string | null;
  county_fips: string | null;
  score: string | number | null;
  reasons: string[] | null;
  territory_eia_id: string | null;
  distributor_name: string | null;
  distributor_saidi: string | number | null;
  distributor_saidi_year: number | null;
  distributor_saidi_early_release: boolean | null;
  flood_flag: boolean | null;
  empower_rate: string | number | null;
  acs_pct_65_plus: string | number | null;
  acs_pct_electric_heat: string | number | null;
  backup_intent_rate: string | number | null;
  source_ids: string[] | null;
  lon: string | number | null;
  lat: string | number | null;
}

function toNumberOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

export function mapWeightedRow(row: HomesRankedWeightedDbRow): TopHomeRow {
  return {
    propId: row.prop_id,
    situsNum: row.situs_num,
    situsStreet: row.situs_street,
    situsCity: row.situs_city,
    situsZip: row.situs_zip,
    marketValue: toNumberOrNull(row.market_value),
    blockGroupGeoid: row.block_group_geoid ?? "",
    countyFips: row.county_fips,
    score: toNumberOrNull(row.score),
    reasons: row.reasons ?? [],
    distributorName: row.distributor_name,
    distributorSaidi: toNumberOrNull(row.distributor_saidi),
    distributorSaidiYear: row.distributor_saidi_year,
    distributorSaidiEarlyRelease: row.distributor_saidi_early_release,
    floodFlag: row.flood_flag,
    empowerRate: toNumberOrNull(row.empower_rate),
    acsPct65Plus: toNumberOrNull(row.acs_pct_65_plus),
    acsPctElectricHeat: toNumberOrNull(row.acs_pct_electric_heat),
    backupIntentRate: toNumberOrNull(row.backup_intent_rate),
    lon: toNumberOrNull(row.lon),
    lat: toNumberOrNull(row.lat),
  };
}

/** Only positive, finite numeric weights for the exact keys the SQL function reads. */
export function sanitizeWeights(input: unknown): Record<SignalKey, number> {
  const out = {} as Record<SignalKey, number>;
  if (!input || typeof input !== "object") return out;
  const record = input as Record<string, unknown>;
  for (const key of SIGNAL_KEYS) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      out[key] = value;
    }
  }
  return out;
}

interface RankedRequestBody {
  weights?: unknown;
  countyFips?: unknown;
  blockGroupGeoid?: unknown;
  afterScore?: unknown;
  afterPropId?: unknown;
  pageSize?: unknown;
}

/**
 * Shared by the route handler and app/ranking/page.tsx's server-render
 * first paint, so both go through exactly one query shape.
 */
export async function fetchRankedHomes(params: {
  weights: Record<SignalKey, number>;
  countyFips: string;
  blockGroupGeoid?: string | null;
  afterScore?: number | null;
  afterPropId?: string | null;
  pageSize?: number;
  /** Also fetch the total row count for this filter (page 1 only, per the
   * M2-W3 scope note — never once per page). */
  withTotal?: boolean;
}): Promise<{ rows: TopHomeRow[]; total: number | null }> {
  const {
    weights,
    countyFips,
    blockGroupGeoid = null,
    afterScore = null,
    afterPropId = null,
    pageSize = PAGE_SIZE,
    withTotal = false,
  } = params;

  const weightsJson = JSON.stringify(weights);

  const [rows, totalRows] = await Promise.all([
    query<HomesRankedWeightedDbRow>(
      `select * from api.homes_ranked_weighted($1::jsonb, $2::text, $3::text, $4::numeric, $5::text, $6::int)`,
      [weightsJson, countyFips, blockGroupGeoid, afterScore, afterPropId, pageSize]
    ),
    withTotal
      ? query<{ total: string | number }>(
          `select api.homes_ranked_weighted_count($1::jsonb, $2::text, $3::text) as total`,
          [weightsJson, countyFips, blockGroupGeoid]
        )
      : Promise.resolve(null),
  ]);

  return {
    rows: rows.map(mapWeightedRow),
    total: totalRows ? Number(totalRows[0].total) : null,
  };
}

export async function POST(request: Request) {
  let body: RankedRequestBody = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const weights = sanitizeWeights(body.weights);
  const countyFips = typeof body.countyFips === "string" && body.countyFips.length > 0
    ? body.countyFips
    : TRAVIS_COUNTY_FIPS;
  const blockGroupGeoid = typeof body.blockGroupGeoid === "string" && body.blockGroupGeoid.length > 0
    ? body.blockGroupGeoid
    : null;
  const afterScore = typeof body.afterScore === "number" && Number.isFinite(body.afterScore)
    ? body.afterScore
    : null;
  const afterPropId = typeof body.afterPropId === "string" && body.afterPropId.length > 0
    ? body.afterPropId
    : null;
  const pageSize = typeof body.pageSize === "number" && Number.isFinite(body.pageSize) && body.pageSize > 0
    ? Math.floor(body.pageSize)
    : PAGE_SIZE;
  // Page 1 (no keyset cursor yet) also returns the total row count for
  // this filter — the route recomputes it whenever weights/selection
  // change (a fresh page-1 request), never on Next/Previous.
  const withTotal = afterScore === null && afterPropId === null;

  const { rows, total } = await fetchRankedHomes({
    weights,
    countyFips,
    blockGroupGeoid,
    afterScore,
    afterPropId,
    pageSize,
    withTotal,
  });

  return NextResponse.json(
    { rows, weights, total },
    { headers: { "Cache-Control": "no-store" } }
  );
}
