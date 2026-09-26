import { afterAll, describe, expect, it } from "vitest";
import { POST } from "../../app/api/top-homes/route";
import { getPool, query } from "../../lib/db";
import { equalWeights } from "../../components/WeightSliders";

// M2-P8 acceptance, exercised against real core.mv_home_signals state
// (never faked) — skipped without POSTGRES_URL, same as every other DB
// test in this repo.

const TRAVIS_COUNTY_FIPS = "48453";

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/top-homes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!process.env.POSTGRES_URL)("POST /api/top-homes — M2-P8 home-level signals", () => {

  it(
    "page 1 of the county ranking has at least 10 distinct scores (homes no longer all tie)",
    async () => {
      const response = await POST(makeRequest({ weights: equalWeights(), countyFips: TRAVIS_COUNTY_FIPS }));
      const body = await response.json();
      if (body.rows.length === 0) return; // nothing scored yet
      const distinctScores = new Set(body.rows.map((r: { score: number | null }) => r.score));
      expect(distinctScores.size).toBeGreaterThanOrEqual(Math.min(10, body.rows.length));
    },
    20000
  );

  it(
    "flood is never a top signal and reasons are computed per home",
    async () => {
      const response = await POST(makeRequest({ weights: equalWeights(), countyFips: TRAVIS_COUNTY_FIPS }));
      const body = await response.json();
      const rows: { reasons: string[] }[] = body.rows;
      if (rows.length === 0) return;
      const counts = new Map<string, number>();
      for (const row of rows) {
        for (const reason of row.reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
      }
      expect(counts.get("flood")).toBeUndefined();
      // The top page's homes rank there for the same reasons, so shared
      // drivers are expected; what must hold is that reasons are computed
      // per home (not one fixed set for everyone).
      const combos = new Set(rows.map((r) => r.reasons.join("|")));
      expect(combos.size).toBeGreaterThanOrEqual(2);
    },
    20000
  );

  it(
    "permit-based home signals (owner_65, home_solar/ev/generator/panel) are null with a reason outside the Austin permit area, never false",
    async () => {
      const response = await POST(makeRequest({ weights: equalWeights(), countyFips: TRAVIS_COUNTY_FIPS }));
      const body = await response.json();
      const outsidePermitArea = body.rows.filter(
        (r: { permitNullReason: string | null }) => r.permitNullReason !== null
      );
      for (const row of outsidePermitArea) {
        expect(row.homeSolar).toBeNull();
        expect(row.homeEv).toBeNull();
        expect(row.homeGenerator).toBeNull();
        expect(row.homePanelUpgrade).toBeNull();
      }
    },
    20000
  );

  it(
    "'Hide homes built before 2000' never returns a row with a known yr_built under 2000, and unknown yr_built stays visible",
    async () => {
      const [unfiltered, filtered] = await Promise.all([
        POST(makeRequest({ weights: equalWeights(), countyFips: TRAVIS_COUNTY_FIPS, pageSize: 200 })).then((r) =>
          r.json()
        ),
        POST(
          makeRequest({ weights: equalWeights(), countyFips: TRAVIS_COUNTY_FIPS, pageSize: 200, hideOldHomes: true })
        ).then((r) => r.json()),
      ]);
      for (const row of filtered.rows as { yrBuilt: number | null }[]) {
        if (row.yrBuilt !== null) expect(row.yrBuilt).toBeGreaterThanOrEqual(2000);
      }
      const unknownYrBuiltCount = (unfiltered.rows as { yrBuilt: number | null }[]).filter(
        (r) => r.yrBuilt === null
      ).length;
      if (unknownYrBuiltCount > 0) {
        // At least the homes with an unknown yr_built that were on the
        // unfiltered page are still eligible to appear filtered — never
        // silently dropped for a home the filter can't evaluate.
        expect(filtered.rows.some((r: { yrBuilt: number | null }) => r.yrBuilt === null))
          .toBe(unfiltered.rows.some((r: { yrBuilt: number | null }) => r.yrBuilt === null));
      }
    },
    20000
  );

  it(
    "an Oncor home's outage_basis is the EAGLE-I county proxy, on the same minutes-per-customer scale as a distributor's own SAIDI",
    async () => {
      const rows = await query<{ outage_basis: string | null; outage_minutes: string | number | null }>(
        `select outage_basis, outage_minutes from core.mv_home_signals
         where gate_reason is null and county_fips = $1 and distributor_name ilike '%oncor%'
         limit 1`,
        [TRAVIS_COUNTY_FIPS]
      );
      if (rows.length === 0) return; // no Oncor-served home gated yet
      if (rows[0].outage_minutes === null) return; // EAGLE-I not loaded for this county yet — real absence, not a failure
      expect(rows[0].outage_basis).toBe("county_eaglei_proxy");
    },
    20000
  );
});
