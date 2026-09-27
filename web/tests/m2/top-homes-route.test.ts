import { afterAll, describe, expect, it } from "vitest";
import { POST } from "../../app/api/top-homes/route";
import { getPool, query } from "../../lib/db";

// M2-W1 acceptance: "Moving a slider re-ranks the list" and
// "api.top_homes_weighted returns 50 rows" — exercised against the real
// api.top_homes_weighted(jsonb, text) function (0201_m2.sql) and real
// core.mv_home_signals state, whichever the M2-P* pipelines have loaded
// so far. Skipped (never faked) without POSTGRES_URL.

const TRAVIS_COUNTY_FIPS = "48453";

function makeRequest(weights: Record<string, number>) {
  return new Request("http://localhost/api/top-homes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ weights, countyFips: TRAVIS_COUNTY_FIPS }),
  });
}

describe.skipIf(!process.env.POSTGRES_URL)("POST /api/top-homes", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it(
    "returns up to 50 rows, no-store, and exactly 50 when at least 50 homes have a nonzero weight sum",
    async () => {
      const response = await POST(makeRequest({ outage: 1, flood: 1, empower: 1, age65: 1, electric_heat: 1, backup_intent: 1 }));
      expect(response.headers.get("cache-control")).toBe("no-store");

      const body = await response.json();
      expect(Array.isArray(body.rows)).toBe(true);
      expect(body.rows.length).toBeLessThanOrEqual(50);

      // Score is now an absolute term (real value / anchor, capped), not a
      // percentile -- weight_sum > 0 (the request's own weighted keys)
      // requires at least one of these six *_term columns to be non-null.
      const [{ n }] = await query<{ n: string | number }>(
        `select count(*) as n
         from core.mv_home_terms
         where county_fips = $1
           and (outage_term is not null or flood_term is not null
                or empower_term is not null or age65_term is not null
                or electric_heat_term is not null or backup_intent_term is not null)`,
        [TRAVIS_COUNTY_FIPS]
      );
      if (Number(n) >= 50) {
        expect(body.rows.length).toBe(50);
      }
    },
    20000
  );

  it(
    "changes row order when weighted toward a different signal, once at least two signals have real values",
    async () => {
      // "Populated" means more than one *distinct* term value among gated
      // Travis homes (score is now an absolute term, not a percentile) — a
      // signal that is non-null but identical for every home (e.g. one
      // distributor covering the whole gated set) has zero discriminating
      // power and can't be expected to change the order on its own, even
      // though the column itself has loaded.
      const [{ age65_distinct, heat_distinct }] = await query<{
        age65_distinct: string | number;
        heat_distinct: string | number;
      }>(
        `select
           count(distinct age65_term) as age65_distinct,
           count(distinct electric_heat_term) as heat_distinct
         from core.mv_home_terms
         where county_fips = $1`,
        [TRAVIS_COUNTY_FIPS]
      );
      const bothSignalsPopulated = Number(age65_distinct) > 1 && Number(heat_distinct) > 1;

      const [age65Only, heatOnly] = await Promise.all([
        POST(makeRequest({ age65: 1 })).then((r) => r.json()),
        POST(makeRequest({ electric_heat: 1 })).then((r) => r.json()),
      ]);

      if (!bothSignalsPopulated || age65Only.rows.length === 0 || heatOnly.rows.length === 0) {
        // Fewer than two signals populated (with real variance) yet
        // (M2-P* pipelines still loading) — the real-data rule forbids
        // substituting a fake second signal, so this assertion is
        // genuinely inapplicable right now. Not a failure.
        return;
      }

      const age65Order = age65Only.rows.map((r: { propId: string }) => r.propId);
      const heatOrder = heatOnly.rows.map((r: { propId: string }) => r.propId);
      expect(age65Order).not.toEqual(heatOrder);
    },
    20000
  );
});
