// M3-W1: county metadata shared by client AND server code (no
// "server-only" guard here — components/BlockGroupMap.tsx and
// components/CoverageGaps.tsx are client components that need
// COUNTY_MAP_CENTER at runtime; the actual DB probe lives in
// lib/counties.server.ts). Travis, Harris and Williamson are the only
// three counties any pipeline in this repo has ever loaded
// (core.mv_home_signals) — the fixed candidate LIST is not itself
// invented data, only which of them currently has scored homes is
// determined live (see getCountiesWithScoredHomes).

export interface CountyOption {
  fips: string;
  name: string;
}

export const COUNTY_CANDIDATES: CountyOption[] = [
  { fips: "48453", name: "Travis" },
  { fips: "48201", name: "Harris" },
  { fips: "48491", name: "Williamson" },
];

export const DEFAULT_COUNTY = COUNTY_CANDIDATES[0];

/** Map center + zoom per county, for BlockGroupMap/CoverageMap — real
 * county-seat coordinates (Austin, Houston, Georgetown), not a computed
 * centroid, since the point is just "put the map somewhere inside the
 * county on load," not a precise geometric center. */
export const COUNTY_MAP_CENTER: Record<string, { center: [number, number]; zoom: number }> = {
  "48453": { center: [-97.7431, 30.2672], zoom: 9 }, // Travis (Austin)
  "48201": { center: [-95.3698, 29.7604], zoom: 9 }, // Harris (Houston)
  "48491": { center: [-97.6772, 30.6333], zoom: 10 }, // Williamson (Georgetown)
};

/** Resolve a `?county=` search param against the counties that actually
 * have scored homes — an unknown/missing/not-yet-loaded value silently
 * falls back to Travis rather than 404ing or showing an empty page. */
export function resolveCounty(
  requested: string | string[] | undefined,
  available: CountyOption[]
): CountyOption {
  const wanted = Array.isArray(requested) ? requested[0] : requested;
  const match = available.find((c) => c.fips === wanted);
  return match ?? available[0] ?? DEFAULT_COUNTY;
}
