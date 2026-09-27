import Link from "next/link";
import { query } from "../../lib/db";
import { RankingBoard } from "./RankingBoard";
import type { GateCountRow } from "../../components/GateCounts";
import type { TopHomeRow } from "../../components/TopHomesTable";
import { fetchRankedHomes, fetchPredictedHomes, SIGNAL_KEYS, type SignalKey, type PredictedHomeRow } from "../api/top-homes/route";
import { getCountiesWithScoredHomes } from "../../lib/counties.server";
import { resolveCounty } from "../../lib/counties";
import type { GeoRollupRow } from "../../lib/geoRollup";
import { decileRangeForTier, type PriorityTierKey } from "../../lib/priorityTier";

// M1-W1: MapLibre choropleth of Travis block groups (api.blockgroup_scores,
// via the app/ranking/blockgroups route handler) + top-50 table
// (api.top_homes) + Quality panel (api.join_rate, api.classifier_precision,
// api.parcel_gate_counts). force-dynamic: parcels/permits/geometry
// pipelines may be loading concurrently, so every request must reflect
// the live view state, never a build-time snapshot.
//
// M3-W1: the ranking table, map and funnel now all follow the top bar's
// `?county=` county switcher (data-driven — only a county with scored
// homes is selectable, see lib/counties.server.ts). The Quality panel's
// permit-join-rate/classifier-precision figures stay Travis-specific
// (the only city permit feed loaded, per PRODUCT.md) regardless of the
// selected county — they are not re-labelled per county, since they are
// never county-scoped data in the first place.

export const dynamic = "force-dynamic";

const TRAVIS_COUNTY_FIPS = "48453";

// Equal-weight fallback across every signal api.top_homes_weighted
// supports, used only if api.default_weights can't be read (M2-P8: the
// evidence-based defaults are the real starting point now).
const EQUAL_WEIGHTS_FALLBACK = 5;

interface DefaultWeightRow {
  signal_key: string;
  weight: string | number;
  basis: string;
}

/** api.default_weights (M2-P8, core.default_weights — a 2026-09-26
 * time-split study on real Austin permits; see checks/M2-P8-ranking-
 * evidence.md). Read server-side so the first paint already ranks by the
 * team's evidence-based defaults, not equal weights. Falls back to
 * equal=5 for every key only if the view can't be read at all. */
async function getDefaultWeights(): Promise<Record<SignalKey, number>> {
  const fallback = {} as Record<SignalKey, number>;
  for (const key of SIGNAL_KEYS) fallback[key] = EQUAL_WEIGHTS_FALLBACK;
  try {
    const rows = await query<DefaultWeightRow>(`select signal_key, weight, basis from api.default_weights`);
    const out = { ...fallback };
    for (const row of rows) {
      if ((SIGNAL_KEYS as readonly string[]).includes(row.signal_key)) {
        out[row.signal_key as SignalKey] = Number(row.weight);
      }
    }
    return out;
  } catch (err) {
    console.error("ranking: failed to load api.default_weights, falling back to equal weights", err);
    return fallback;
  }
}


// M4-W2: predicted mode is the ranking default -- server-rendered so the
// first paint already shows it, never a client round trip after
// hydration. Reads only api.home_propensity (core.home_propensity, PK
// joins), never api.homes_ranked_weighted_count (measured ~1.85s on prod
// scoring all ~155k homes) -- see fetchPredictedHomes' own comment.
async function getPredictedHomes(
  countyFips: string,
  filters: {
    city?: string | null;
    zip?: string | null;
    blockGroupGeoid?: string | null;
    hideOldHomes?: boolean;
    excludeBackup?: boolean;
    tier?: PriorityTierKey | "all";
  } = {}
): Promise<{ rows: PredictedHomeRow[]; total: number | null }> {
  const [minDecile, maxDecile] = decileRangeForTier(filters.tier ?? "all");
  return fetchPredictedHomes({
    countyFips,
    situsCity: filters.city ?? null,
    situsZip: filters.zip ?? null,
    blockGroupGeoid: filters.blockGroupGeoid ?? null,
    hideOldHomes: filters.hideOldHomes ?? false,
    excludeBackup: filters.excludeBackup ?? true,
    minDecile,
    maxDecile,
    withTotal: true,
  });
}

async function getTopHomes(weights: Record<SignalKey, number>): Promise<{ rows: TopHomeRow[]; total: number }> {
  // M2-W1/M2-P8: score v2 (api.homes_ranked_weighted, 0212*.sql).
  // Server-rendered with the evidence-based default weights, page 1, no
  // block-group selection, so the first paint (no JS, or before
  // hydration) matches WeightSliders'/RankingBoard's default state;
  // every re-rank/page/selection change after that goes through
  // /api/top-homes.
  const { rows, total } = await fetchRankedHomes({
    weights,
    countyFips: TRAVIS_COUNTY_FIPS,
    withTotal: true,
  });
  return { rows, total: total ?? 0 };
}
// getTopHomes is unused by this ticket's server render (RankingBoard's
// weighted mode is always fetched client-side, see RankingPage below);
// kept only because RankingBoard's props require *some* initial value
// and other tickets may wire it back in.

async function getGateCounts(countyFips: string): Promise<GateCountRow[]> {
  try {
    const rows = await query<{ reason: string; home_count: string | number }>(
      `select reason, home_count from api.gate_counts where county_fips = $1 order by home_count desc`,
      [countyFips]
    );
    return rows.map((row) => ({ reason: row.reason, homeCount: Number(row.home_count) }));
  } catch (err) {
    console.error("ranking: failed to load api.gate_counts", err);
    return [];
  }
}

interface GeoRollupDbRow {
  county_fips: string;
  situs_city: string | null;
  situs_zip: string | null;
  block_group_geoid: string;
  home_count: string | number;
  avg_p: string | number | null;
  max_p: string | number | null;
  top10_count: string | number;
}

/** M-drilldown: api.home_geo_rollup (core.mv_home_geo_rollup, 0303) --
 * one precomputed row per (city, ZIP, block group) in the county, read
 * once per /ranking request and cascaded client-side into the City ->
 * ZIP -> Neighborhood dropdowns (see lib/geoRollup.ts).
 *
 * Layout-review item 5 ("dropdown counts must match the list") tried a
 * live equivalent of this aggregation, joining core.home_propensity/
 * core.mv_home_signals/core.parcels/core.home_coverage and excluding
 * backup homes to match the list exactly -- that query timed out against
 * the live DB (statement timeout, confirmed by the test suite) because
 * this view exists precisely to avoid that per-request full-population
 * scan. Reverted to the precomputed view; the dropdown-count mismatch
 * when "Hide homes that already have backup" is on is a real, known gap
 * (documented here rather than re-introducing a second explanatory
 * paragraph on the page) that needs a DB-side fix (a backup-aware
 * column on the view itself), not a per-request recompute. */
async function getGeoRollup(countyFips: string): Promise<GeoRollupRow[]> {
  try {
    const rows = await query<GeoRollupDbRow>(
      `select county_fips, situs_city, situs_zip, block_group_geoid, home_count, avg_p, max_p, top10_count
       from api.home_geo_rollup
       where county_fips = $1`,
      [countyFips]
    );
    return rows.map((r) => ({
      countyFips: r.county_fips,
      situsCity: r.situs_city,
      situsZip: r.situs_zip,
      blockGroupGeoid: r.block_group_geoid ?? "",
      homeCount: Number(r.home_count),
      avgP: r.avg_p === null ? null : Number(r.avg_p),
      maxP: r.max_p === null ? null : Number(r.max_p),
      top10Count: Number(r.top10_count),
    }));
  } catch (err) {
    console.error("ranking: failed to load api.home_geo_rollup", err);
    return [];
  }
}

// M-urlstate (item 4): the ranking screen's mode/weights/backup/pre2000/
// county/city/zip/bg all live in the URL (RankingBoard syncs them via
// window.history.replaceState) so a reload -- or the CSV export, which
// forwards the current url's params -- reproduces exactly what's on
// screen. This reads the same params on first paint so the server render
// already matches instead of always defaulting to predicted/no-filter.
function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function RankingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [rawParams, availableCounties] = await Promise.all([searchParams, getCountiesWithScoredHomes()]);
  const county = resolveCounty(rawParams.county, availableCounties);

  const initialMode: "predicted" | "weighted" = firstParam(rawParams.mode) === "weighted" ? "weighted" : "predicted";
  const initialCity = firstParam(rawParams.city) ?? null;
  const initialZip = firstParam(rawParams.zip) ?? null;
  const initialBlockGroupGeoid = firstParam(rawParams.bg) ?? null;
  const initialHideOldHomes = firstParam(rawParams.pre2000) === "hide";
  const initialHideExistingBackup = firstParam(rawParams.backup) !== "show";
  const rawTier = firstParam(rawParams.tier);
  const initialTier: PriorityTierKey | "all" =
    rawTier === "top" || rawTier === "high" || rawTier === "medium" || rawTier === "low" ? rawTier : "all";

  const defaultWeights = await getDefaultWeights();
  const urlWeights: Record<SignalKey, number> = { ...defaultWeights };
  let anyWeightOnUrl = false;
  for (const key of SIGNAL_KEYS) {
    const raw = firstParam(rawParams[`w_${key}`]);
    const n = raw !== undefined ? Number(raw) : NaN;
    if (Number.isFinite(n) && n >= 0) {
      urlWeights[key] = n;
      anyWeightOnUrl = true;
    }
  }
  const initialWeights = anyWeightOnUrl ? urlWeights : defaultWeights;

  // M4-W2 perf: predicted mode is cheap (api.home_propensity, PK joins),
  // so it's always fetched for the first paint. Weighted mode
  // (api.homes_ranked_weighted[_count], ~1.6-1.85s scoring every gated
  // home) is only fetched server-side when the URL actually asks for it
  // -- otherwise RankingBoard's own client effect fetches it the first
  // time a visitor switches to it, exactly as before this ticket.
  const [predictedHomes, weightedHomes, gateCounts, geoRollup] = await Promise.all([
    getPredictedHomes(county.fips, { city: initialCity, zip: initialZip, blockGroupGeoid: initialBlockGroupGeoid, hideOldHomes: initialHideOldHomes, excludeBackup: initialHideExistingBackup, tier: initialTier }),
    initialMode === "weighted"
      ? fetchRankedHomes({
          weights: initialWeights,
          countyFips: county.fips,
          blockGroupGeoid: initialBlockGroupGeoid,
          situsCity: initialCity,
          situsZip: initialZip,
          hideOldHomes: initialHideOldHomes,
          excludeBackup: initialHideExistingBackup,
          withTotal: true,
        })
      : Promise.resolve({ rows: [] as TopHomeRow[], total: 0 }),
    getGateCounts(county.fips),
    getGeoRollup(county.fips),
  ]);
  const { rows: predictedRows, total: predictedTotal } = predictedHomes;
  // Coordinator's layout fix, corrected: one workspace, not a 3-panel
  // dashboard. gateTotalHomes (sum of api.gate_counts across every
  // reason) IS the eligible population -- owner-occupied, single-family,
  // mapped lot. The other three numbers are read straight off their own
  // gate_counts reasons, never derived by subtraction -- "not served"
  // must mean territory_not_base_served specifically, and every
  // unresolved/fail-open reason (utility_not_confirmed and the CCN-
  // mapping codes) is its own "needs verification" bucket, not folded
  // into either "serves" or "not served". Never claim "Base can't serve
  // any home here" unless passed is actually 0 -- a fail-open reason
  // (this county's territory data still loading) is not the same claim.
  const gateTotalHomes = gateCounts.reduce((sum, r) => sum + r.homeCount, 0);
  const gateServableHomes = gateCounts.find((r) => r.reason === "passed")?.homeCount ?? 0;
  const gateNotServedHomes = gateCounts.find((r) => r.reason === "territory_not_base_served")?.homeCount ?? 0;
  const NEEDS_VERIFICATION_REASONS = new Set([
    "utility_not_confirmed",
    "multiply_certificated",
    "no_ccn_match",
    "ccn_holder_unmapped",
  ]);
  const gateNeedsVerificationHomes = gateCounts
    .filter((r) => NEEDS_VERIFICATION_REASONS.has(r.reason))
    .reduce((sum, r) => sum + r.homeCount, 0);

  // Perf follow-up (0303b): api.gate_counts / api.parcel_gate_counts /
  // api.gate_counts_by_market now all carry county_fips, so every count
  // panel below is scoped to the selected county -- no more "combined
  // across every loaded county" caveat.
  // Layout-review fix: "How far to trust this list" (QualityPanel) is
  // methodology, not a lead-list concern -- moved to /sources under "How
  // leads are prioritized" (it rendered BEFORE the map and list on
  // phone, the worst possible position for a rep who opened this page
  // Redesign (Mock A): the old h1 "Lead list" + two paragraphs above the
  // board become the rail's own header -- one question, one real status
  // line built from the same api.gate_counts numbers as before (no
  // "dashboard of panels above the fold" survives; RankingBoard now owns
  // the whole viewport-height workspace).
  const questionText = `Which ${county.name} homes should Base knock next?`;
  const statusLine =
    gateServableHomes === 0 ? (
      <>
        {gateTotalHomes.toLocaleString()} eligible homes · Base can&rsquo;t confirm service for any home here yet ·{" "}
        <Link href="/sources#how-leads-are-prioritized">how the ranking works →</Link>
      </>
    ) : (
      <>
        {gateTotalHomes.toLocaleString()} eligible homes · Base serves {gateServableHomes.toLocaleString()}
        {gateNeedsVerificationHomes > 0 ? ` · ${gateNeedsVerificationHomes.toLocaleString()} need a utility check` : ""}
        {gateNotServedHomes > 0 ? ` · ${gateNotServedHomes.toLocaleString()} not served` : ""} ·{" "}
        <Link href="/sources#how-leads-are-prioritized">how the ranking works →</Link>
      </>
    );

  return (
    <div className="ranking-page">
      <RankingBoard
        key={county.fips}
        rows={weightedHomes.rows}
        initialTotal={weightedHomes.total ?? 0}
        questionText={questionText}
        statusLine={statusLine}
        defaultWeights={defaultWeights}
        predictedRows={predictedRows}
        predictedTotal={predictedTotal}
        countyName={county.name}
        countyFips={county.fips}
        geoRollup={geoRollup}
        initialMode={initialMode}
        initialWeights={initialWeights}
        initialCity={initialCity}
        initialZip={initialZip}
        initialBlockGroupGeoid={initialBlockGroupGeoid}
        initialHideOldHomes={initialHideOldHomes}
        initialHideExistingBackup={initialHideExistingBackup}
        initialTier={initialTier}
      />
    </div>
  );
}
