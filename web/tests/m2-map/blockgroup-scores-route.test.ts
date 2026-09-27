import { afterAll, describe, expect, it } from "vitest";
import { POST as postBlockgroupScores } from "../../app/api/blockgroup-scores/route";
import { POST as postTopHomes } from "../../app/api/top-homes/route";
import { getPool } from "../../lib/db";
import { equalWeights } from "../../components/WeightSliders";
import { scoreRampColor, SCORE_RAMP } from "../../components/BlockGroupMap";

// M2-W3 acceptance: "the top-1 home's block group is one of the scored
// map classes" and "moving a slider re-colours the map" (i.e.
// api.blockgroup_scores_weighted changes with the weights). No literal
// geoid/propId — everything is read from the real api.top_homes_weighted /
// api.blockgroup_scores_weighted state.
//
// M3-P6: api.blockgroup_scores_weighted's score is now an absolute mean
// of every scored home's final_score in the block group (0..1), not a
// percentile rank -- a single standout home no longer guarantees its
// block group lands in the darkest map class (a block group of one
// exceptional home and many weak ones has a low mean). The real
// invariant is only that the top-1 home's own block group is present
// among the scored groups, with a score in [0, 1] and a colour class
// scoreRampColor can actually resolve to one of SCORE_RAMP's buckets.

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
    "the top-1 home's block group is a real, validly-scored map class at equal weights",
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

      // The block group's score is an absolute mean of final_score across
      // every scored home in it (M3-P6), not a percentile rank, so the
      // top-1 individual home's own block group need not be the darkest
      // class -- only that it is a real scored group with a valid score
      // and a resolvable colour class.
      const top1Score = scoresBody.scores.find((s: { geoid: string }) => s.geoid === top1.blockGroupGeoid);
      expect(top1Score).toBeDefined();
      expect(top1Score.score).toBeGreaterThanOrEqual(0);
      expect(top1Score.score).toBeLessThanOrEqual(1);
      expect(SCORE_RAMP).toContain(scoreRampColor(top1Score.score));
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
