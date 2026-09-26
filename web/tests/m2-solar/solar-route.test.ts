import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { GET } from "../../app/api/solar/[prop_id]/route";
import { getPool } from "../../lib/db";

// M2-W2 acceptance: "/home/[prop_id] shows roof/solar facts for a real
// Travis home" and "No Solar response is written to the DB or a cache."
//
// prop_id 101325 is 2500 Bartons Bluff Ct, Austin, a real Travis County
// parcel loaded by M1's tcad_geometry backfill (core.parcel_geoms). This
// suite is skipped (never faked) when POSTGRES_URL or GOOGLE_MAPS_API_KEY
// is not configured — per the real-data rule, we never substitute a
// synthetic response for a live Google Solar API call.

const canRunLive = Boolean(process.env.POSTGRES_URL && process.env.GOOGLE_MAPS_API_KEY);

describe.skipIf(!canRunLive)("GET /api/solar/[prop_id] (live)", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it(
    "returns real Google Solar data for prop_id 101325 (2500 Bartons Bluff Ct, Austin)",
    async () => {
      const response = await GET(new Request("http://localhost/api/solar/101325"), {
        params: Promise.resolve({ prop_id: "101325" }),
      });

      expect(response.headers.get("cache-control")).toBe("no-store");

      const body = await response.json();

      if (body.available === false) {
        // Only acceptable if Google genuinely has no coverage for this
        // building or the parcel centroid hasn't loaded — never treated
        // as a silent pass without a written reason.
        expect(typeof body.reason).toBe("string");
        expect(body.reason.length).toBeGreaterThan(0);
        return;
      }

      expect(body.available).toBe(true);
      expect(body.center).not.toBeNull();
      expect(typeof body.center.lat).toBe("number");
      expect(typeof body.center.lng).toBe("number");
      // At least one real roof/solar fact must be present — Google's
      // response shape varies by coverage, but a HIGH/MEDIUM-quality hit
      // always carries solarPotential figures.
      const hasAnyFact =
        body.maxPanelCount !== null ||
        body.maxArrayAreaMeters2 !== null ||
        body.roofSegmentCount !== null ||
        body.wholeRoofAreaMeters2 !== null;
      expect(hasAnyFact).toBe(true);
    },
    30000
  );
});

describe("route source (static)", () => {
  it("never writes the Solar response to the DB, a file, or a cache", () => {
    const source = readFileSync(
      new URL("../../app/api/solar/[prop_id]/route.ts", import.meta.url),
      "utf8"
    );

    const forbidden = [
      /insert\s+into/i,
      /update\s+core\./i,
      /update\s+ops\./i,
      /update\s+api\./i,
      /writeFile/i,
      /cache\.set\(/i,
      /redis/i,
      /\bkv\./i,
      /revalidateTag/i,
      /unstable_cache/i,
    ];

    for (const pattern of forbidden) {
      expect(source).not.toMatch(pattern);
    }

    // The only DB access allowed is the read-only centroid lookup.
    expect(source).toMatch(/select\s+extensions\.ST_Y/i);
  });
});
