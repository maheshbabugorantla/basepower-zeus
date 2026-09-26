import { afterAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as getHomesCsv } from "../../app/export/homes/route";
import { GET as getCoverageCsv } from "../../app/export/coverage/route";
import { getPool } from "../../lib/db";

// M5-W1 acceptance: "Two exports with no pipeline run between them are
// byte-identical." Every query in both routes orders on a full tiebreak
// (score/p desc, prop_id asc; block_group_geoid asc) and no wall-clock
// value is written into the CSV body (only the filename/first-comment
// row date, which is stable within a UTC day) -- so calling the route
// twice back-to-back, against the live DB, with nothing else writing to
// core.home_propensity / api.homes_ranked_weighted / api.coverage_gaps_bg
// in between, must produce the exact same bytes.

const TRAVIS_COUNTY_FIPS = "48453";

function makeRequest(path: string, params: Record<string, string>) {
  const url = new URL(`http://localhost${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

async function readAll(response: Response): Promise<string> {
  return await response.text();
}

describe.skipIf(!process.env.POSTGRES_URL_READONLY)("CSV export -- byte-identical across calls", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it(
    "ranked-homes predicted mode: two exports back-to-back are byte-identical",
    async () => {
      const req1 = makeRequest("/export/homes", { county: TRAVIS_COUNTY_FIPS, mode: "predicted" });
      const req2 = makeRequest("/export/homes", { county: TRAVIS_COUNTY_FIPS, mode: "predicted" });
      const [body1, body2] = await Promise.all([
        getHomesCsv(req1).then(readAll),
        getHomesCsv(req2).then(readAll),
      ]);
      expect(body1.length).toBeGreaterThan(0);
      expect(body1).toBe(body2);

      const lines = body1.split("\r\n").filter(Boolean);
      expect(lines[0].startsWith("#")).toBe(true);
      expect(lines[1]).toContain("rank");
      expect(lines.length).toBeGreaterThan(2);
    },
    60000
  );

  it(
    "ranked-homes weighted mode: two exports back-to-back are byte-identical",
    async () => {
      const req1 = makeRequest("/export/homes", { county: TRAVIS_COUNTY_FIPS, mode: "weighted" });
      const req2 = makeRequest("/export/homes", { county: TRAVIS_COUNTY_FIPS, mode: "weighted" });
      const [body1, body2] = await Promise.all([
        getHomesCsv(req1).then(readAll),
        getHomesCsv(req2).then(readAll),
      ]);
      expect(body1.length).toBeGreaterThan(0);
      expect(body1).toBe(body2);
    },
    60000
  );

  it(
    "coverage-zones export: two exports back-to-back are byte-identical, no address column",
    async () => {
      const req1 = makeRequest("/export/coverage", { county: TRAVIS_COUNTY_FIPS });
      const req2 = makeRequest("/export/coverage", { county: TRAVIS_COUNTY_FIPS });
      const [body1, body2] = await Promise.all([
        getCoverageCsv(req1).then(readAll),
        getCoverageCsv(req2).then(readAll),
      ]);
      expect(body1.length).toBeGreaterThan(0);
      expect(body1).toBe(body2);

      const lines = body1.split("\r\n").filter(Boolean);
      expect(lines[1]).toBe("zone,homes,base_customers,other_backup,prospects,gap_score");
      expect(body1).not.toMatch(/situs|prop_id/i);
    },
    60000
  );

  it(
    "ranked-homes CSV rank order matches the live DB's own predicted order",
    async () => {
      const req = makeRequest("/export/homes", { county: TRAVIS_COUNTY_FIPS, mode: "predicted" });
      const body = await getHomesCsv(req).then(readAll);
      const lines = body.split("\r\n").filter(Boolean).slice(2); // skip comment + header
      expect(lines.length).toBeGreaterThan(1);
      const likelihoods = lines.map((line) => Number(line.split(",")[5]));
      for (let i = 1; i < likelihoods.length; i++) {
        expect(likelihoods[i - 1]).toBeGreaterThanOrEqual(likelihoods[i]);
      }
    },
    60000
  );
});
