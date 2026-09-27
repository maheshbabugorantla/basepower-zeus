import "server-only";
import { query } from "./db";
import { COUNTY_CANDIDATES, DEFAULT_COUNTY, type CountyOption } from "./counties";

/**
 * Which of COUNTY_CANDIDATES has at least one scored home right now, via
 * api.loaded_counties (0303b) -- a tiny precomputed view (core.mv_gate_counts,
 * reason in ('passed', 'utility_not_confirmed')) instead of a per-request
 * existence probe against api.home_propensity. 'utility_not_confirmed' is
 * included deliberately: those homes (Williamson) are still gated in and
 * scored, just not counted as Base-servable yet -- excluding that reason
 * would silently drop a county that is live today. Always returns at
 * least Travis even on a query failure (fail toward the county that has
 * been live the longest, never an empty switcher).
 */
export async function getCountiesWithScoredHomes(): Promise<CountyOption[]> {
  try {
    const rows = await query<{ county_fips: string }>(
      `select county_fips from api.loaded_counties where county_fips = any($1::text[])`,
      [COUNTY_CANDIDATES.map((c) => c.fips)]
    );
    const withHomes = new Set(rows.map((r) => r.county_fips));
    const options = COUNTY_CANDIDATES.filter((c) => withHomes.has(c.fips));
    return options.length > 0 ? options : [DEFAULT_COUNTY];
  } catch (err) {
    console.error("counties: failed to probe api.loaded_counties", err);
    return [DEFAULT_COUNTY];
  }
}
