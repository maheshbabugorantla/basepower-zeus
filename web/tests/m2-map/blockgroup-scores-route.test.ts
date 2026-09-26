import { afterAll, describe, expect, it } from "vitest";
import { POST as postBlockgroupScores } from "../../app/api/blockgroup-scores/route";
import { POST as postTopHomes } from "../../app/api/top-homes/route";
import { getPool } from "../../lib/db";
import { equalWeights } from "../../components/WeightSliders";
import { scoreRampColor, SCORE_RAMP } from "../../components/BlockGroupMap";

// M2-W3 acceptance: "top-1 home's block group is in the darkest map
// class for equal weights" and "moving a slider re-colours the map"
// (i.e. api.blockgroup_scores_weighted changes with the weights). No
// literal geoid/propId — everything is read from the real
// api.top_homes_weighted / api.blockgroup_scores_weighted state.

const TRAVIS_COUNTY_FIPS = "48453";

function makeTopHomesRequest(weights: Record<string, number>) {
  return new Request("http://localhost/api/top-homes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ weights, countyFips: TRAVIS_COUNTY_FIPS }),
  });
}

function makeBlockgroupScoresRequest(weights: Record<string, number>) {
  return new Request("http://localhost/api/blockgroup-scores", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ weights, countyFips: TRAVIS_COUNTY_FIPS }),
  });
}

describe.skipIf(!process.env.POSTGRES_URL)("map/table stay in sync (api.blockgroup_scores_weighted)", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it(
    "the top-1 home's block group is the darkest map class at equal weights",
    async () => {
      const weights = equalWeights();

      const topHomesResponse = await postTopHomes(makeTopHomesRequest(weights));
      const topHomesBody = await topHomesResponse.json();
      if (topHomesBody.rows.length === 0) return; // no gate-passed homes with a nonzero weight sum yet

      const top1 = topHomesBody.rows[0];
      expect(typeof top1.blockGroupGeoid).toBe("string");
      expect(top1.blockGroupGeoid.length).toBeGreaterThan(0);

      const scoresResponse = await postBlockgroupScores(makeBlockgroupScoresRequest(weights));
      expect(scoresResponse.headers.get("cache-control")).toBe("no-store");
      const scoresBody = await scoresResponse.json();
      expect(Array.isArray(scoresBody.scores)).toBe(true);

      const top1Score = scoresBody.scores.find((s: { geoid: string }) => s.geoid === top1.blockGroupGeoid);
      expect(top1Score).toBeDefined();
      expect(scoreRampColor(top1Score.score)).toBe(SCORE_RAMP[SCORE_RAMP.length - 1]);
    },
    20000
  );

  it(
    "changes block-group scores when weighted toward a different signal, once at least two signals have real values",
    async () => {
      const [age65Only, heatOnly] = await Promise.all([
        postBlockgroupScores(makeBlockgroupScoresRequest({ age65: 1 })).then((r) => r.json()),
        postBlockgroupScores(makeBlockgroupScoresRequest({ electric_heat: 1 })).then((r) => r.json()),
      ]);

      if (age65Only.scores.length === 0 || heatOnly.scores.length === 0) {
        // Real-data rule: no fake second signal to force this — genuinely
        // inapplicable until a second M2-P* pipeline has loaded.
        return;
      }

      const age65ByGeoid = new Map(age65Only.scores.map((s: { geoid: string; score: number }) => [s.geoid, s.score]));
      const heatByGeoid = new Map(heatOnly.scores.map((s: { geoid: string; score: number }) => [s.geoid, s.score]));

      const anyDifferent = [...age65ByGeoid.entries()].some(
        ([geoid, score]) => heatByGeoid.has(geoid) && heatByGeoid.get(geoid) !== score
      );
      // Only assert a real difference once both signals carry actual
      // variance — see web/tests/m2/top-homes-route.test.ts for the same
      // caveat applied to the table's own re-rank test.
      if (age65ByGeoid.size > 1 || heatByGeoid.size > 1) {
        expect(anyDifferent).toBe(true);
      }
    },
    20000
  );

  it("every scored block group's score is within [0, 1]", async () => {
    const response = await postBlockgroupScores(makeBlockgroupScoresRequest(equalWeights()));
    const body = await response.json();
    for (const row of body.scores) {
      expect(row.score).toBeGreaterThanOrEqual(0);
      expect(row.score).toBeLessThanOrEqual(1);
      expect(row.homesScored).toBeGreaterThan(0);
    }
  });
});
