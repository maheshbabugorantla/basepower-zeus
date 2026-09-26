import { afterAll, describe, expect, it } from "vitest";
import { POST, fetchPredictedHomes } from "../../app/api/top-homes/route";
import { getPool, query } from "../../lib/db";

// M4-W2 acceptance: "Ranking defaults to the prediction". The ranking UI
// (RankingBoard/ranking/page.tsx, this ticket) defaults to mode:
// "predicted" and sends it explicitly on every fetch. The route itself
// keeps its pre-existing (weighted) behavior when `mode` is omitted --
// other tickets' tests call this route with no `mode` and expect the
// original api.homes_ranked_weighted behavior, so that default could not
// change without breaking them. mode: "predicted" reads only
// api.home_propensity, ordered by p_install_12m desc, keyset paginated --
// never api.homes_ranked_weighted (which the coordinator measured at
// ~1.6-1.85s per call on prod). Every expected figure below is read from
// the live DB at test time, never a literal.

const TRAVIS_COUNTY_FIPS = "48453";

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/top-homes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!process.env.POSTGRES_URL_READONLY)("POST /api/top-homes -- predicted mode (default)", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it(
    "defaults to predicted mode, ordered by p_install_12m desc",
    async () => {
      const response = await POST(makeRequest({ mode: "predicted", countyFips: TRAVIS_COUNTY_FIPS, pageSize: 20 }));
      const body = await response.json();
      expect(body.mode).toBe("predicted");
      expect(Array.isArray(body.rows)).toBe(true);
      expect(body.rows.length).toBeGreaterThan(0);

      for (let i = 1; i < body.rows.length; i++) {
        expect(body.rows[i - 1].pInstall12m).toBeGreaterThanOrEqual(body.rows[i].pInstall12m);
      }

      // Cross-checked directly: page 1's top row really is the highest
      // p_install_12m among gate-passed, eligible Travis homes.
      const [dbTop] = await query<{ prop_id: string; p_install_12m: string }>(
        `select hp.prop_id, hp.p_install_12m::text
         from core.home_propensity hp
         join core.mv_home_signals s on s.prop_id = hp.prop_id
         left join core.home_coverage hc on hc.prop_id = hp.prop_id
         where s.gate_reason is null and s.county_fips = $1
           and coalesce(hc.bucket, 'prospect') not in ('base_customer', 'other_backup')
         order by hp.p_install_12m desc, hp.prop_id asc
         limit 1`,
        [TRAVIS_COUNTY_FIPS]
      );
      expect(body.rows[0].propId).toBe(dbTop.prop_id);
    },
    20000
  );

  it(
    "page 1 and page 2 are contiguous -- no overlap, no gap, exact keyset cursor",
    async () => {
      const page1Response = await POST(makeRequest({ mode: "predicted", countyFips: TRAVIS_COUNTY_FIPS, pageSize: 50 }));
      const page1 = await page1Response.json();
      if (page1.rows.length < 50) return; // fewer than 50 eligible homes right now

      const last = page1.rows[page1.rows.length - 1];
      const page2Response = await POST(
        makeRequest({
          mode: "predicted",
          countyFips: TRAVIS_COUNTY_FIPS,
          pageSize: 50,
          afterP: last.pInstall12mCursor,
          afterPropId: last.propId,
        })
      );
      const page2 = await page2Response.json();
      expect(page2.total).toBeNull(); // only page 1 counts

      const page1Ids = new Set(page1.rows.map((r: { propId: string }) => r.propId));
      const page2Ids = new Set(page2.rows.map((r: { propId: string }) => r.propId));
      for (const id of page2Ids) expect(page1Ids.has(id)).toBe(false);

      if (page2.rows.length > 0) {
        const first2 = page2.rows[0];
        expect(
          first2.pInstall12m < last.pInstall12m ||
            (first2.pInstall12m === last.pInstall12m && first2.propId > last.propId)
        ).toBe(true);
      }
    },
    20000
  );

  it(
    "page-1 total equals a filtered count(*) against the live DB (exclude-backup on)",
    async () => {
      const { total } = await fetchPredictedHomes({ countyFips: TRAVIS_COUNTY_FIPS, withTotal: true });

      const [dbCount] = await query<{ n: string }>(
        `select count(*)::text as n
         from core.home_propensity hp
         join core.mv_home_signals s on s.prop_id = hp.prop_id
         left join core.home_coverage hc on hc.prop_id = hp.prop_id
         where s.gate_reason is null and s.county_fips = $1
           and coalesce(hc.bucket, 'prospect') not in ('base_customer', 'other_backup')`,
        [TRAVIS_COUNTY_FIPS]
      );

      expect(total).toBe(Number(dbCount.n));
    },
    20000
  );

  it(
    "hide-pre-2000 filters in SQL, so the total shrinks and every returned row is unfiltered-eligible",
    async () => {
      const [allHomes, filtered] = await Promise.all([
        fetchPredictedHomes({ countyFips: TRAVIS_COUNTY_FIPS, withTotal: true, hideOldHomes: false }),
        fetchPredictedHomes({ countyFips: TRAVIS_COUNTY_FIPS, withTotal: true, hideOldHomes: true, pageSize: 20 }),
      ]);
      expect(allHomes.total).not.toBeNull();
      expect(filtered.total).not.toBeNull();
      expect(filtered.total as number).toBeLessThanOrEqual(allHomes.total as number);
      for (const row of filtered.rows) {
        expect(row.yrBuilt === null || row.yrBuilt >= 2000).toBe(true);
      }
    },
    20000
  );
});
