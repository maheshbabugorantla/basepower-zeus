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

// M2-P8b: the 10 weight keys api.homes_ranked_weighted / api.top_homes_weighted
// / api.blockgroup_scores_weighted / api.home_score_breakdown all read
// (0212_home_signals_build.sql / 0212b_home_signals_swap.sql /
// 0212c_home_signals_perf.sql). A key not present in the object falls
// through to a CASE ... ELSE 0 in the SQL function, so a request need not
// supply every key.
export const SIGNAL_KEYS = [
  "outage",
  "home_value",
  "backup_intent",
  "age65",
  "home_permits",
  "electric_heat",
  "empower",
  "owner_65",
  "installability",
  "flood",
  // M2-web-followup (P9/P10): three new weight keys api.homes_ranked_weighted
  // / api.home_score_breakdown now read (0216_scoring_pass.sql).
  "income_100k",
  "age_35_64",
  "permit_risk",
] as const;

export type SignalKey = (typeof SIGNAL_KEYS)[number];

export const TRAVIS_COUNTY_FIPS = "48453";
export const PAGE_SIZE = 50;
// M2-P8: "Hide homes built before 2000" (team choice, not a Base rule) —
// same cutoff the installability term itself uses.
export const HIDE_OLD_HOMES_CUTOFF_YEAR = 2000;

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
  owner_65: boolean | null;
  home_solar: boolean | null;
  home_ev: boolean | null;
  home_generator: boolean | null;
  home_panel_upgrade: boolean | null;
  home_battery: boolean | null;
  home_battery_permit_date: string | Date | null;
  permit_null_reason: string | null;
  yr_built: number | null;
  living_area: string | number | null;
  outage_minutes: string | number | null;
  outage_year: number | null;
  outage_basis: string | null;
  outage_source_ids: string[] | null;
  home_value_term: string | number | null;
  installability_term: string | number | null;
  income_100k_share: string | number | null;
  age_35_64_share: string | number | null;
  permit_path: string | null;
  permit_risk_term: string | number | null;
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
    ownerIs65: row.owner_65,
    homeSolar: row.home_solar,
    homeEv: row.home_ev,
    homeGenerator: row.home_generator,
    homePanelUpgrade: row.home_panel_upgrade,
    homeBattery: row.home_battery,
    homeBatteryPermitDate: row.home_battery_permit_date ? String(row.home_battery_permit_date) : null,
    permitNullReason: row.permit_null_reason,
    yrBuilt: row.yr_built,
    livingArea: toNumberOrNull(row.living_area),
    outageMinutes: toNumberOrNull(row.outage_minutes),
    outageYear: row.outage_year,
    outageBasis: row.outage_basis,
    outageSourceIds: row.outage_source_ids ?? [],
    homeValueTerm: toNumberOrNull(row.home_value_term),
    installabilityTerm: toNumberOrNull(row.installability_term),
    income100kShare: toNumberOrNull(row.income_100k_share),
    age3564Share: toNumberOrNull(row.age_35_64_share),
    permitPath: row.permit_path,
    permitRiskTerm: toNumberOrNull(row.permit_risk_term),
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
  mode?: unknown;
  weights?: unknown;
  countyFips?: unknown;
  blockGroupGeoid?: unknown;
  situsCity?: unknown;
  situsZip?: unknown;
  afterScore?: unknown;
  afterPropId?: unknown;
  afterP?: unknown;
  pageSize?: unknown;
  hideOldHomes?: unknown;
  excludeBackup?: unknown;
  minDecile?: unknown;
  maxDecile?: unknown;
}

// ---------------------------------------------------------------------------
// M4-W2: predicted mode -- the ranking default. Reads only
// core.home_propensity (never api.homes_ranked_weighted /
// api.homes_ranked_weighted_count, which recompute percentiles across all
// ~155k gated homes on every call, ~1.6-1.85s measured on prod). Joined by
// primary key only: core.mv_home_signals (gate/county/block-group/
// yr_built), core.parcels (situs fields), core.parcel_geoms (centroid),
// core.home_coverage (exclude-backup bucket) -- the identical
// exclude-backup predicate api.homes_ranked_weighted uses (0217_anchor_
// cte.sql), copied verbatim so "hide homes that already have backup"
// means the same thing in both ranking modes.
// ---------------------------------------------------------------------------

export interface PropensityReason {
  feature: string;
  direction: "raises" | "lowers";
  value: number | null;
}

export interface PredictedHomeRow {
  propId: string;
  situsNum: string | null;
  situsStreet: string | null;
  situsCity: string | null;
  situsZip: string | null;
  marketValue: number | null;
  blockGroupGeoid: string;
  countyFips: string | null;
  pInstall12m: number;
  /** Exact-precision text of p_install_12m, for the next page's keyset cursor only -- never for display (Number() on it would round the boundary value and could repeat/skip a row). */
  pInstall12mCursor: string;
  relativeToCounty: number | null;
  decile: number | null;
  reasons: PropensityReason[];
  extrapolatedFrom: string | null;
  yrBuilt: number | null;
  lon: number | null;
  lat: number | null;
  /** core.mv_home_signals.gate_reason -- null/'passed'/'utility_not_confirmed' for a ranked row. */
  gateReason: string | null;
  /** core.mv_home_signals.territory_null_reason -- non-null means utility service is still fail-open/unconfirmed. */
  territoryNullReason: string | null;
  /** core.home_coverage.bucket -- 'base_customer'/'other_backup' when this home already has backup. */
  coverageBucket: string | null;
}

interface PredictedHomeDbRow {
  prop_id: string;
  p_install_12m: string;
  relative_to_county: string | number | null;
  decile: number | null;
  reasons: PropensityReason[] | null;
  extrapolated_from: string | null;
  geo_id: string | null;
  situs_num: string | null;
  situs_street: string | null;
  situs_city: string | null;
  situs_zip: string | null;
  market_value: string | number | null;
  block_group_geoid: string | null;
  county_fips: string | null;
  yr_built: number | null;
  lon: string | number | null;
  lat: string | number | null;
  gate_reason: string | null;
  territory_null_reason: string | null;
  coverage_bucket: string | null;
}

function mapPredictedRow(row: PredictedHomeDbRow): PredictedHomeRow {
  return {
    propId: row.prop_id,
    situsNum: row.situs_num,
    situsStreet: row.situs_street,
    situsCity: row.situs_city,
    situsZip: row.situs_zip,
    marketValue: toNumberOrNull(row.market_value),
    blockGroupGeoid: row.block_group_geoid ?? "",
    countyFips: row.county_fips,
    pInstall12m: Number(row.p_install_12m),
    pInstall12mCursor: row.p_install_12m,
    relativeToCounty: toNumberOrNull(row.relative_to_county),
    decile: row.decile,
    reasons: row.reasons ?? [],
    extrapolatedFrom: row.extrapolated_from,
    yrBuilt: row.yr_built,
    lon: toNumberOrNull(row.lon),
    lat: toNumberOrNull(row.lat),
    gateReason: row.gate_reason,
    territoryNullReason: row.territory_null_reason,
    coverageBucket: row.coverage_bucket,
  };
}

/**
 * Predicted-mode page + (optionally) total. Every filter mirrors
 * api.homes_ranked_weighted's own WHERE clause exactly (gate_reason,
 * county, block group, exclude-backup, yr_built) so switching ranking
 * modes never changes which homes are eligible -- only their order.
 * yr_built is filtered in SQL (not post-fetch), so a full page always
 * comes back and the total is exact.
 */
export async function fetchPredictedHomes(params: {
  countyFips: string;
  blockGroupGeoid?: string | null;
  situsCity?: string | null;
  situsZip?: string | null;
  afterP?: string | null;
  afterPropId?: string | null;
  pageSize?: number;
  withTotal?: boolean;
  hideOldHomes?: boolean;
  excludeBackup?: boolean;
  /** core.home_propensity.decile lower/upper bound (inclusive), for the
   * lead-list's "Priority tier" filter -- both null means every tier. */
  minDecile?: number | null;
  maxDecile?: number | null;
}): Promise<{ rows: PredictedHomeRow[]; total: number | null }> {
  const {
    countyFips,
    blockGroupGeoid = null,
    situsCity = null,
    situsZip = null,
    afterP = null,
    afterPropId = null,
    pageSize = PAGE_SIZE,
    withTotal = false,
    hideOldHomes = false,
    excludeBackup = true,
    minDecile = null,
    maxDecile = null,
  } = params;

  // Coordinator perf fix: core.home_propensity carries its own county_fips
  // (0303b backfill, indexed county_fips/p_install_12m/prop_id) and only
  // ever holds gated homes (M4-P4 trains/scores the gated population
  // only), so the primary predicate no longer needs core.mv_home_signals
  // at all. mv_home_signals (s) is joined only when a predicate or a
  // returned column actually needs it (block group / pre-2000 filter);
  // core.parcels (pc) only when a city/ZIP filter or the page's own situs
  // display columns need it. The count query never joins pc/s unless one
  // of those filters is active, and never joins core.parcel_geoms at all
  // (lon/lat are page-only).
  const needsSignals = blockGroupGeoid !== null || hideOldHomes;
  const needsParcelsForFilter = situsCity !== null || situsZip !== null;

  function buildFrom(opts: { forPage: boolean }): string {
    const parts = ["from core.home_propensity hp"];
    if (needsSignals || opts.forPage) parts.push("join core.mv_home_signals s on s.prop_id = hp.prop_id");
    if (needsParcelsForFilter || opts.forPage) parts.push("join core.parcels pc on pc.prop_id = hp.prop_id");
    if (opts.forPage) parts.push("left join core.parcel_geoms pg on pg.prop_id = hp.prop_id");
    parts.push("left join core.home_coverage hc on hc.prop_id = hp.prop_id");
    return parts.join("\n    ");
  }

  function buildWhere(): string {
    // $2/$3/$4 (block group / city / ZIP) are fixed slots regardless of
    // which filters are active (see baseParams' own comment below), but a
    // placeholder that never appears anywhere in the final SQL text makes
    // Postgres's extended query protocol fail with "could not determine
    // data type of parameter $N" -- or, once none of $2-$4 appear at all,
    // "bind message supplies N parameters, but prepared statement
    // requires 1". These three no-op, always-true casts pin every
    // placeholder's type and keep it referenced even when its filter is
    // inactive, without requiring the join that filter's real predicate needs.
    const clauses = [
      "hp.county_fips = $1",
      "($2::text is null or true)",
      "($3::text is null or true)",
      "($4::text is null or true)",
    ];
    if (blockGroupGeoid !== null) clauses.push("s.block_group_geoid = $2");
    if (excludeBackup) clauses.push("coalesce(hc.bucket, 'prospect') not in ('base_customer', 'other_backup')");
    if (hideOldHomes) clauses.push(`(s.yr_built is null or s.yr_built >= ${HIDE_OLD_HOMES_CUTOFF_YEAR})`);
    if (situsCity !== null) clauses.push(situsCity === "" ? "pc.situs_city is null" : "pc.situs_city = $3");
    if (situsZip !== null) clauses.push(situsZip === "" ? "pc.situs_zip is null" : "pc.situs_zip = $4");
    clauses.push("($5::int is null or hp.decile >= $5::int)");
    clauses.push("($6::int is null or hp.decile <= $6::int)");
    return clauses.join("\n      and ");
  }

  const baseParams: unknown[] = [countyFips];
  // Positional params are fixed slots ($1 county, $2 block group, $3
  // city, $4 zip, $5 min decile, $6 max decile) regardless of which
  // predicates are active, so the cursor/limit params below always start
  // at $7 -- simpler than renumbering per filter combination.
  baseParams[1] = blockGroupGeoid;
  baseParams[2] = situsCity;
  baseParams[3] = situsZip;
  baseParams[4] = minDecile;
  baseParams[5] = maxDecile;

  const pageSql = `
    select hp.prop_id, hp.p_install_12m::text as p_install_12m, hp.relative_to_county, hp.decile, hp.reasons, hp.extrapolated_from,
           pc.geo_id, pc.situs_num, pc.situs_street, pc.situs_city, pc.situs_zip, pc.market_value,
           s.block_group_geoid, s.county_fips, s.yr_built, s.gate_reason, s.territory_null_reason,
           hc.bucket as coverage_bucket,
           extensions.ST_X(pg.centroid) as lon, extensions.ST_Y(pg.centroid) as lat
    ${buildFrom({ forPage: true })}
    where ${buildWhere()}
      and (
        $7::numeric is null
        or hp.p_install_12m < $7::numeric
        or (hp.p_install_12m = $7::numeric and hp.prop_id > $8::text)
      )
    order by hp.p_install_12m desc, hp.prop_id asc
    limit $9
  `;

  const countSql = `select count(*) as total ${buildFrom({ forPage: false })} where ${buildWhere()}`;

  const [rows, totalRows] = await Promise.all([
    query<PredictedHomeDbRow>(pageSql, [...baseParams, afterP, afterPropId, pageSize]),
    withTotal ? query<{ total: string | number }>(countSql, baseParams) : Promise.resolve(null),
  ]);

  return {
    rows: rows.map(mapPredictedRow),
    total: totalRows ? Number(totalRows[0].total) : null,
  };
}

/**
 * Shared by the route handler and app/ranking/page.tsx's server-render
 * first paint, so both go through exactly one query shape.
 *
 * `hideOldHomes` (M2-P8, "Hide homes built before 2000" — a team choice,
 * not a Base rule) is applied here on `yr_built`, a column
 * api.homes_ranked_weighted already returns on every row — never a
 * second, request-time query against core.parcels or any other table.
 * A home with yr_built unknown is kept (unproven old, not hidden). Since
 * the filter runs after the SQL function's own LIMIT, a filtered page can
 * come back short; the total row count is reported as unknown (null)
 * whenever the filter is active, rather than the unfiltered figure.
 */
export async function fetchRankedHomes(params: {
  weights: Record<SignalKey, number>;
  countyFips: string;
  blockGroupGeoid?: string | null;
  /** Cascading drill-down (city/ZIP/block-group) -- passed straight through
   * to api.homes_ranked_weighted[_count]'s trailing p_situs_city/
   * p_situs_zip params (added alongside p_block_group_geoid; default null =
   * no filter, so an older deployed function without them is unaffected). */
  situsCity?: string | null;
  situsZip?: string | null;
  afterScore?: number | null;
  afterPropId?: string | null;
  pageSize?: number;
  /** Also fetch the total row count for this filter (page 1 only, per the
   * M2-W3 scope note — never once per page). */
  withTotal?: boolean;
  hideOldHomes?: boolean;
  /** M2-P11 "Hide homes that already have backup" ranking toggle -- passed
   * straight through to api.homes_ranked_weighted's p_exclude_backup,
   * which defaults to true itself. Default true here too, so a caller
   * that omits it gets the same "excluded by default" behavior as the SQL
   * function. */
  excludeBackup?: boolean;
}): Promise<{ rows: TopHomeRow[]; total: number | null }> {
  const {
    weights,
    countyFips,
    blockGroupGeoid = null,
    situsCity = null,
    situsZip = null,
    afterScore = null,
    afterPropId = null,
    pageSize = PAGE_SIZE,
    withTotal = false,
    hideOldHomes = false,
    excludeBackup = true,
  } = params;

  const weightsJson = JSON.stringify(weights);

  // Verified against the landed 0303b migration: api.homes_ranked_weighted
  // [_count]'s p_situs_city/p_situs_zip use `coalesce(t.situs_city, '') =
  // p_situs_city`, so "" (this route's own null-bucket sentinel) matches
  // the null-city/null-ZIP homes correctly -- no client-side coercion needed.
  const [rows, totalRows] = await Promise.all([
    query<HomesRankedWeightedDbRow>(
      `select * from api.homes_ranked_weighted($1::jsonb, $2::text, $3::text, $4::numeric, $5::text, $6::int, $7::boolean, $8::text, $9::text)`,
      [weightsJson, countyFips, blockGroupGeoid, afterScore, afterPropId, pageSize, excludeBackup, situsCity, situsZip]
    ),
    withTotal
      ? query<{ total: string | number }>(
          `select api.homes_ranked_weighted_count($1::jsonb, $2::text, $3::text, $4::boolean, $5::text, $6::text) as total`,
          [weightsJson, countyFips, blockGroupGeoid, excludeBackup, situsCity, situsZip]
        )
      : Promise.resolve(null),
  ]);

  let mapped = rows.map(mapWeightedRow);
  if (hideOldHomes) {
    mapped = mapped.filter((r) => r.yrBuilt === null || r.yrBuilt >= HIDE_OLD_HOMES_CUTOFF_YEAR);
  }

  return {
    rows: mapped,
    total: hideOldHomes ? null : totalRows ? Number(totalRows[0].total) : null,
  };
}

export async function POST(request: Request) {
  let body: RankedRequestBody = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const countyFips = typeof body.countyFips === "string" && body.countyFips.length > 0
    ? body.countyFips
    : TRAVIS_COUNTY_FIPS;
  const blockGroupGeoid = typeof body.blockGroupGeoid === "string" && body.blockGroupGeoid.length > 0
    ? body.blockGroupGeoid
    : null;
  // Cascading drill-down (item 3): an empty string means "filter to the
  // no-city/no-ZIP bucket" (a real, distinct selection); a missing/non-
  // string value means "no filter at all" -- see fetchPredictedHomes'
  // own comment for the same convention.
  const situsCity = typeof body.situsCity === "string" ? body.situsCity : null;
  const situsZip = typeof body.situsZip === "string" ? body.situsZip : null;
  const afterPropId = typeof body.afterPropId === "string" && body.afterPropId.length > 0
    ? body.afterPropId
    : null;
  const pageSize = typeof body.pageSize === "number" && Number.isFinite(body.pageSize) && body.pageSize > 0
    ? Math.floor(body.pageSize)
    : PAGE_SIZE;
  const hideOldHomes = body.hideOldHomes === true;
  // M2-P11: "Hide homes that already have backup" -- default ON (true),
  // same as api.homes_ranked_weighted's own p_exclude_backup default;
  // only an explicit `false` turns it off.
  const excludeBackup = body.excludeBackup !== false;
  const minDecile = typeof body.minDecile === "number" && Number.isFinite(body.minDecile) ? body.minDecile : null;
  const maxDecile = typeof body.maxDecile === "number" && Number.isFinite(body.maxDecile) ? body.maxDecile : null;

  // M4-W2: the ranking UI's default is predicted, but every pre-existing
  // caller of this route (RankingBoard's own weighted-mode fetch, and
  // other tickets' tests) never sends `mode` and expects the original
  // weighted behavior -- so the route's own default stays "weighted";
  // only an explicit mode: "predicted" (RankingBoard's fetchPredictedPage,
  // and the ranking page's default UI state) takes this branch.
  if (body.mode === "predicted") {
    const afterP = typeof body.afterP === "string" && body.afterP.length > 0 ? body.afterP : null;
    const withTotal = afterP === null && afterPropId === null;
    const { rows, total } = await fetchPredictedHomes({
      countyFips,
      blockGroupGeoid,
      situsCity,
      situsZip,
      afterP,
      afterPropId,
      pageSize,
      withTotal,
      hideOldHomes,
      excludeBackup,
      minDecile,
      maxDecile,
    });
    return NextResponse.json(
      { mode: "predicted", rows, total },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  const weights = sanitizeWeights(body.weights);
  const afterScore = typeof body.afterScore === "number" && Number.isFinite(body.afterScore)
    ? body.afterScore
    : null;
  // Page 1 (no keyset cursor yet) also returns the total row count for
  // this filter — the route recomputes it whenever weights/selection
  // change (a fresh page-1 request), never on Next/Previous.
  const withTotal = afterScore === null && afterPropId === null;

  const { rows, total } = await fetchRankedHomes({
    weights,
    countyFips,
    blockGroupGeoid,
    situsCity,
    situsZip,
    afterScore,
    afterPropId,
    pageSize,
    withTotal,
    hideOldHomes,
    excludeBackup,
  });

  return NextResponse.json(
    { mode: "weighted", rows, weights, total },
    { headers: { "Cache-Control": "no-store" } }
  );
}
