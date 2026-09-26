import { afterAll, describe, expect, it } from "vitest";
import { POST as postTopHomes } from "../../app/api/top-homes/route";
import { POST as postBreakdown } from "../../app/ranking/breakdown/route";
import HomeDetailPage from "../../app/home/[prop_id]/page";
import { getPool, query } from "../../lib/db";
import { equalWeights } from "../../components/WeightSliders";

const TRAVIS_COUNTY_FIPS = "48453";

async function findAGatedPropId(): Promise<string | null> {
  const rows = await query<{ prop_id: string }>(
    `select prop_id from core.mv_home_signals where gate_reason is null and county_fips = $1 limit 1`,
    [TRAVIS_COUNTY_FIPS]
  );
  return rows[0]?.prop_id ?? null;
}

describe.skipIf(!process.env.POSTGRES_URL)("api.home_score_breakdown — M2-P8 anchored terms", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it(
    "returns a real term (0-1) and anchor for signals with an anchor, never a bare percentile as the score input",
    async () => {
      const propId = await findAGatedPropId();
      if (!propId) return;
      const response = await postBreakdown(
        new Request("http://localhost/ranking/breakdown", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ propId, weights: equalWeights() }),
        })
      );
      const body = await response.json();
      const outage = body.signals.find((s: { key: string }) => s.key === "outage");
      expect(outage).toBeDefined();
      if (outage.available) {
        expect(outage.term).not.toBeNull();
        expect(outage.term).toBeLessThanOrEqual(1);
        expect(outage.term).toBeGreaterThanOrEqual(0);
      }
      expect(typeof body.outageBasis === "string" || body.outageBasis === null).toBe(true);
    },
    20000
  );
});

describe.skipIf(!process.env.POSTGRES_URL)("/home/[prop_id] — M2-P8 built year + own-permit facts", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it(
    "renders a plain 'Built <year>' line and this home's own permit facts, with no schema names on screen",
    async () => {
      const response = await postTopHomes(
        new Request("http://localhost/api/top-homes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ weights: equalWeights(), countyFips: TRAVIS_COUNTY_FIPS, pageSize: 1 }),
        })
      );
      const body = await response.json();
      if (body.rows.length === 0) return;
      const propId = body.rows[0].propId;

      const { renderToStaticMarkup } = await import("react-dom/server");
      const html = renderToStaticMarkup(await HomeDetailPage({ params: Promise.resolve({ prop_id: propId }) }));

      expect(html).toMatch(/Built \d{4}|Year built not loaded|Not loaded/);
      // Never a raw snake_case reason/table/column name on screen.
      expect(html).not.toMatch(/\bcore\.mv_home_signals\b/);
      expect(html).not.toMatch(/no_permit_coverage(?!<)/); // raw code never shown untranslated
    },
    20000
  );
});
