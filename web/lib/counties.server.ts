import "server-only";
import { query } from "./db";
import { COUNTY_CANDIDATES, DEFAULT_COUNTY, type CountyOption } from "./counties";

/**
 * Which of COUNTY_CANDIDATES actually has at least one scored home right
 * now, via a primary-key-indexed existence probe against
 * api.home_propensity (M4-P4) rather than a full scan. Always returns at
 * least Travis even on a query failure (fail toward the county that has
 * been live the longest, never an empty switcher).
 */
export async function getCountiesWithScoredHomes(): Promise<CountyOption[]> {
  try {
    const rows = await query<{ fips: string }>(
      `select fips from unnest($1::text[]) as fips
       where exists (select 1 from api.home_propensity hp where hp.county_fips = fips)`,
      [COUNTY_CANDIDATES.map((c) => c.fips)]
    );
    const withHomes = new Set(rows.map((r) => r.fips));
    const options = COUNTY_CANDIDATES.filter((c) => withHomes.has(c.fips));
    return options.length > 0 ? options : [DEFAULT_COUNTY];
  } catch (err) {
    console.error("counties: failed to probe api.home_propensity", err);
    return [DEFAULT_COUNTY];
  }
}
