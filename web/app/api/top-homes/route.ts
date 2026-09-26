import { NextResponse } from "next/server";
import { query } from "../../../lib/db";
import type { TopHomeRow } from "../../../components/TopHomesTable";

// M2-W1: live re-ranking for the Ranking screen's weight sliders. Calls
// api.top_homes_weighted(weights jsonb, county_fips text) — score v1,
// defined in supabase/migrations/0201_m2.sql — instead of the old v0
// api.top_homes view. Never materialized: every request recomputes the
// weighted mean over core.mv_home_signals at request time, so moving a
// slider re-ranks without any pipeline run.
//
// force-dynamic + Cache-Control: no-store — the underlying signals refresh
// on their own schedule (core.refresh_all_scores(), M2-P* pipelines), and
// a re-rank must always reflect the live view state, never a cached one.

export const dynamic = "force-dynamic";

// The exact keys api.top_homes_weighted(weights jsonb, ...) reads (see
// 0201_m2.sql's function comment). A key not present in the object falls
// through to a CASE ... ELSE 0 in the SQL function, so a request need not
// supply every key.
export const SIGNAL_KEYS = [
  "outage",
  "flood",
  "empower",
  "age65",
  "electric_heat",
  "backup_intent",
] as const;

export type SignalKey = (typeof SIGNAL_KEYS)[number];

const TRAVIS_COUNTY_FIPS = "48453";

interface TopHomesWeightedDbRow {
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
}

function toNumberOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

export function mapWeightedRow(row: TopHomesWeightedDbRow): TopHomeRow {
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

export async function POST(request: Request) {
  let body: { weights?: unknown; countyFips?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const weights = sanitizeWeights(body.weights);
  const countyFips = typeof body.countyFips === "string" && body.countyFips.length > 0
    ? body.countyFips
    : TRAVIS_COUNTY_FIPS;

  const rows = await query<TopHomesWeightedDbRow>(
    `select * from api.top_homes_weighted($1::jsonb, $2::text)`,
    [JSON.stringify(weights), countyFips]
  );

  return NextResponse.json(
    { rows: rows.map(mapWeightedRow), weights },
    { headers: { "Cache-Control": "no-store" } }
  );
}
