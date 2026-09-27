// M-drilldown: pure client+server-safe helpers over api.home_geo_rollup
// (core.mv_home_geo_rollup, 0303) -- one row per (county, situs_city,
// situs_zip, block_group_geoid) with home_count/avg_p/max_p/top10_count.
// No "server-only" guard: RankingBoard (a client component) imports the
// aggregation helpers directly so cascading City -> ZIP -> Neighborhood
// counts/averages can be recomputed client-side from one fetch, without a
// round trip per dropdown level. The fetch itself (api.home_geo_rollup)
// stays server-side, in app/ranking/page.tsx's lib/db.ts query.

export interface GeoRollupRow {
  countyFips: string;
  /** null = the "no city on file" bucket -- a real, distinct group, never dropped. */
  situsCity: string | null;
  situsZip: string | null;
  blockGroupGeoid: string;
  homeCount: number;
  /** Mean of api.home_propensity.p_install_12m across this row's homes (already backup-inclusive -- see RankingBoard's own note on this being a superset of the filtered homes list). Null only if every home lacks a score. */
  avgP: number | null;
  maxP: number | null;
  top10Count: number;
}

export interface GeoBucket {
  /** The value this bucket groups by -- a city name, ZIP, or block-group
   * GEOID. "" (empty string) is the "no value on file" bucket -- a real,
   * distinct group of homes, never dropped -- matching the "" = null-
   * bucket sentinel app/api/top-homes/route.ts's situsCity/situsZip
   * params already use. */
  key: string;
  homeCount: number;
  avgP: number | null;
  maxP: number | null;
  top10Count: number;
}

function combine(rows: GeoRollupRow[]): { homeCount: number; avgP: number | null; maxP: number | null; top10Count: number } {
  let homeCount = 0;
  let top10Count = 0;
  let maxP: number | null = null;
  let weightedSum = 0;
  let weightedCount = 0;
  for (const r of rows) {
    homeCount += r.homeCount;
    top10Count += r.top10Count;
    if (r.maxP !== null) maxP = maxP === null ? r.maxP : Math.max(maxP, r.maxP);
    if (r.avgP !== null) {
      weightedSum += r.avgP * r.homeCount;
      weightedCount += r.homeCount;
    }
  }
  return { homeCount, top10Count, maxP, avgP: weightedCount > 0 ? weightedSum / weightedCount : null };
}

/** Every home_count/top10_count in this county's rollup, summed -- the
 * denominator for "share of homes in the county's top 10%" at any level. */
export function countyTotals(rows: GeoRollupRow[]): { homeCount: number; top10Count: number } {
  const c = combine(rows);
  return { homeCount: c.homeCount, top10Count: c.top10Count };
}

/** Group rows (already filtered to the current city/ZIP selection) by
 * `keyOf`, combining each group's home_count/avg_p/max_p/top10_count.
 * Sorted by home_count desc, then key asc (nulls last) for a stable list. */
export function bucketBy(rows: GeoRollupRow[], keyOf: (row: GeoRollupRow) => string): GeoBucket[] {
  const groups = new Map<string, GeoRollupRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  const buckets: GeoBucket[] = Array.from(groups.entries()).map(([key, groupRows]) => ({
    key,
    ...combine(groupRows),
  }));
  buckets.sort((a, b) => {
    if (b.homeCount !== a.homeCount) return b.homeCount - a.homeCount;
    if (!a.key) return 1;  // null block group (no neighborhood) sorts last; was === "" and crashed on null
    if (!b.key) return -1;
    return a.key.localeCompare(b.key);
  });
  return buckets;
}

/** city/zip: undefined = no filter at this level; "" = the null bucket;
 * any other string = that exact value -- same convention as
 * app/api/top-homes/route.ts's situsCity/situsZip request params. */
export function filterRows(rows: GeoRollupRow[], filters: { city?: string; zip?: string }): GeoRollupRow[] {
  return rows.filter((r) => {
    if (filters.city !== undefined && (r.situsCity ?? "") !== filters.city) return false;
    if (filters.zip !== undefined && (r.situsZip ?? "") !== filters.zip) return false;
    return true;
  });
}
