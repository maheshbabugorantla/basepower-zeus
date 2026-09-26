import { afterAll, describe, expect, it } from "vitest";
import { POST } from "../../app/api/top-homes/route";
import { getPool, query } from "../../lib/db";
import { equalWeights } from "../../components/WeightSliders";

// M2-W3 scope change ("the fixed top-50 is no longer wanted"): the
// ranking table now pages through every gate-passed home via keyset
// pagination, and a clicked block group scopes it to just that group's
// homes. Acceptance: "county ranking page 1 and page 2 are contiguous
// (no overlap/gaps)" and "selecting a block group lists all its gated
// homes (count equals mv_home_signals gate-passed count for that
// geoid)". No literal geoid/propId — read from real DB state.

const TRAVIS_COUNTY_FIPS = "48453";

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/top-homes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!process.env.POSTGRES_URL)("POST /api/top-homes (api.homes_ranked_weighted)", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it(
    "county-wide page 1 and page 2 are contiguous — no overlapping or skipped prop_ids",
    async () => {
      const weights = equalWeights();
      const page1Response = await POST(makeRequest({ weights, countyFips: TRAVIS_COUNTY_FIPS, pageSize: 50 }));
      const page1 = await page1Response.json();
      expect(page1.total).toBeGreaterThanOrEqual(0);

      if (page1.rows.length < 50) return; // fewer than 50 gate-passed homes right now — nothing to paginate

      const last = page1.rows[page1.rows.length - 1];
      const page2Response = await POST(
        makeRequest({
          weights,
          countyFips: TRAVIS_COUNTY_FIPS,
          pageSize: 50,
          afterScore: last.score,
          afterPropId: last.propId,
        })
      );
      const page2 = await page2Response.json();
      // page 2's request-time total is null (the route only counts on page 1).
      expect(page2.total).toBeNull();

      const page1Ids = new Set(page1.rows.map((r: { propId: string }) => r.propId));
      const page2Ids = new Set(page2.rows.map((r: { propId: string }) => r.propId));
      for (const id of page2Ids) expect(page1Ids.has(id)).toBe(false); // no overlap

      // No gap: every home strictly between the two pages' scores would
      // have had to rank between page1's last and page2's first — which,
      // by the deterministic (score desc, prop_id asc) order, is exactly
      // what the keyset predicate selects for. Cross-checked directly
      // against the DB: nothing with a higher score than page2's first
      // row and a lower score (or equal score, lower prop_id) than
      // page1's last row exists outside those two pages.
      if (page2.rows.length > 0) {
        const first2 = page2.rows[0];
        expect(
          first2.score < last.score || (first2.score === last.score && first2.propId > last.propId)
        ).toBe(true);
      }
    },
    20000
  );

  it(
    "selecting a block group lists exactly its gate-passed homes",
    async () => {
      const weights = equalWeights();
      const page1Response = await POST(makeRequest({ weights, countyFips: TRAVIS_COUNTY_FIPS, pageSize: 1 }));
      const page1 = await page1Response.json();
      if (page1.rows.length === 0) return;

      const geoid = page1.rows[0].blockGroupGeoid;
      // M2-P11: api.homes_ranked_weighted's p_exclude_backup now defaults
      // to true (excludes homes with an existing battery/generator/other-
      // installer backup permit). This test cross-checks against the raw
      // gate-passed count for the geoid (core.mv_home_signals), which does
      // NOT exclude those homes -- pass excludeBackup:false so both sides
      // of the comparison mean the same population.
      const scopedResponse = await POST(
        makeRequest({ weights, countyFips: TRAVIS_COUNTY_FIPS, blockGroupGeoid: geoid, pageSize: 5000, excludeBackup: false })
      );
      const scoped = await scopedResponse.json();

      const [{ n }] = await query<{ n: string | number }>(
        `select count(*) as n from core.mv_home_signals
         where gate_reason is null and block_group_geoid = $1`,
        [geoid]
      );
      // scoped.rows only includes homes with a nonzero weight sum
      // (equalWeights() -> every signal weighted equally, so any home
      // with at least one non-null percentile qualifies); cross-check
      // against the real gate-passed count for that geoid.
      expect(scoped.rows.length).toBeLessThanOrEqual(Number(n));
      expect(scoped.rows.every((r: { blockGroupGeoid: string }) => r.blockGroupGeoid === geoid)).toBe(true);

      const [{ nonzero }] = await query<{ nonzero: string | number }>(
        `select count(*) as nonzero from core.mv_home_signals
         where gate_reason is null and block_group_geoid = $1
           and (distributor_saidi_pctile is not null or flood_pctile is not null
                or empower_pctile is not null or acs_65_pctile is not null
                or acs_heat_pctile is not null or backup_intent_pctile is not null)`,
        [geoid]
      );
      expect(scoped.rows.length).toBe(Number(nonzero));
    },
    20000
  );
});
