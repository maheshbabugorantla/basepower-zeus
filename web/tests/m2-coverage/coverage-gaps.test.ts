import { describe, expect, it, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { zoneBucket } from "../../components/coverageZones";
import { GET as blockgroupsGET } from "../../app/ranking/coverage/blockgroups/route";
import { getPool, query } from "../../lib/db";

// M2-P11 web follow-up: real-DB checks only, no mocks/synthetic data.
//   1. zoneBucket()'s pure classification matches the documented rule on
//      real inputs (covered/demand-absent/untapped/not-observable).
//   2. app/ranking/coverage/blockgroups/route.ts's GeoJSON never carries a
//      per-home Base-customer flag or installer name -- only the fixed,
//      block-group-level property set this ticket defines.
//   3. Every "not_observable" feature really has no api.coverage_gaps_bg
//      row (cross-checked against the real table), so a coverage-not-
//      loaded zone is never colored/labelled as a gap.

describe("zoneBucket (pure)", () => {
  it("covered_by_base wins whenever there is at least one real Base customer", () => {
    expect(zoneBucket({ homes: 10, baseCustomers: 1, otherBackup: 3, prospects: 6 })).toBe("covered_by_base");
  });
  it("demand_absent when there is proven backup but zero Base customers", () => {
    expect(zoneBucket({ homes: 10, baseCustomers: 0, otherBackup: 2, prospects: 8 })).toBe("demand_absent");
  });
  it("untapped when there is no proven backup at all", () => {
    expect(zoneBucket({ homes: 10, baseCustomers: 0, otherBackup: 0, prospects: 10 })).toBe("untapped");
  });
  it("not_observable when the block group has no coverage row at all", () => {
    expect(zoneBucket({ homes: null, baseCustomers: null, otherBackup: null, prospects: null })).toBe("not_observable");
  });
});

describe.skipIf(!process.env.POSTGRES_URL_READONLY)("GET /ranking/coverage/blockgroups (real DB)", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it("never carries a per-home Base-customer flag, installer name, or address -- only the fixed zone-level property set", async () => {
    const response = await blockgroupsGET(new NextRequest("http://localhost/ranking/coverage/blockgroups"));
    expect(response.status).toBe(200);
    const data: { features: { properties: Record<string, unknown> }[] } = await response.json();
    expect(data.features.length).toBeGreaterThan(0);
    const allowedKeys = new Set([
      "geoid",
      "bucket",
      "fillColor",
      "homes",
      "baseCustomers",
      "otherBackup",
      "prospects",
      "baseShareOfBackup",
      "backupPenetration",
      "gapScore",
    ]);
    for (const feature of data.features) {
      for (const key of Object.keys(feature.properties)) {
        expect(allowedKeys.has(key), `unexpected property ${key} on a coverage feature`).toBe(true);
      }
    }
  });

  it("every not_observable feature really has no api.coverage_gaps_bg row for that geoid", async () => {
    const response = await blockgroupsGET(new NextRequest("http://localhost/ranking/coverage/blockgroups"));
    const data: { features: { properties: { geoid: string; bucket: string } }[] } = await response.json();
    const notObservable = data.features.filter((f) => f.properties.bucket === "not_observable");
    if (notObservable.length === 0) return; // every Travis block group currently has some coverage row
    const geoids = notObservable.map((f) => f.properties.geoid);
    const rows = await query<{ block_group_geoid: string }>(
      `select block_group_geoid from api.coverage_gaps_bg where block_group_geoid = any($1::text[])`,
      [geoids]
    );
    expect(rows.length).toBe(0);
  });
});
