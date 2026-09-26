import { afterAll, describe, expect, it } from "vitest";
import { getPool } from "../../lib/db";
import { getCountiesWithScoredHomes } from "../../lib/counties.server";
import { COUNTY_CANDIDATES, resolveCounty } from "../../lib/counties";

// M3-W1 acceptance: the county switcher is data-driven, not a fixed
// enabled/disabled pair. Exercised against the real, already-loaded
// Supabase state (api.home_propensity) -- never a hand-typed county list.

describe.skipIf(!process.env.POSTGRES_URL_READONLY)("getCountiesWithScoredHomes", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it("returns only counties from COUNTY_CANDIDATES that actually have a scored home, always including Travis", async () => {
    const counties = await getCountiesWithScoredHomes();

    expect(counties.length).toBeGreaterThan(0);
    for (const c of counties) {
      expect(COUNTY_CANDIDATES.map((cc) => cc.fips)).toContain(c.fips);
    }
    expect(counties.map((c) => c.fips)).toContain("48453");
  }, 20000);

  it("resolveCounty falls back to the first available county for an unknown/missing ?county= value", async () => {
    const counties = await getCountiesWithScoredHomes();
    expect(resolveCounty("48999", counties).fips).toBe(counties[0].fips);
    expect(resolveCounty(undefined, counties).fips).toBe(counties[0].fips);
    // A real, currently-available county round-trips.
    const real = counties[counties.length - 1];
    expect(resolveCounty(real.fips, counties).fips).toBe(real.fips);
  }, 20000);
});
