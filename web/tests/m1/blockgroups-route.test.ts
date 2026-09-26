import { afterAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../../app/ranking/blockgroups/route";
import { getPool, query } from "../../lib/db";

// M1-W1 acceptance: block-group GeoJSON never marks a null-score feature
// with a score, and the map loads with no API key (checked separately —
// the OpenFreeMap style URL requires none, per DESIGN.md/M1-W1's ticket
// text). Exercised against the real core.block_groups / api.blockgroup_scores
// state (skipped without POSTGRES_URL, like every other M1/M0 db test).

describe.skipIf(!process.env.POSTGRES_URL)("GET /ranking/blockgroups", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it("returns a FeatureCollection whose features are never colored (scored) when score is null", async () => {
    // db.ts-backed queries against the real Supabase pooler; other test
    // files' pools can be mid-teardown when the suite runs in parallel, so
    // this is generous rather than tuned to the happy-path latency above.
    const response = await GET(new NextRequest("http://localhost/ranking/blockgroups"));
    const body = await response.json();

    expect(body.type).toBe("FeatureCollection");
    expect(Array.isArray(body.features)).toBe(true);

    for (const feature of body.features) {
      expect(feature.type).toBe("Feature");
      expect(feature.properties).toHaveProperty("geoid");
      expect(feature.properties).toHaveProperty("score");
      if (feature.properties.score === null) {
        // A null score must carry a written reason — never silently absent.
        expect(typeof feature.properties.score_null_reason).toBe("string");
        expect(feature.properties.score_null_reason.length).toBeGreaterThan(0);
      } else {
        expect(typeof feature.properties.score).toBe("number");
      }
    }
  }, 20000);

  it(
    "feature count matches the real Travis row count in core.block_groups",
    async () => {
      const rows = await query<{ count: string }>(
        "select count(*) from core.block_groups where county_fips = $1",
        ["48453"]
      );
      const response = await GET(new NextRequest("http://localhost/ranking/blockgroups"));
      const body = await response.json();
      expect(body.features.length).toBe(Number(rows[0].count));
    },
    20000
  );
});
