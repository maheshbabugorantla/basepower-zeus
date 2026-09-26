import { afterAll, describe, expect, it } from "vitest";
import { POST as breakdownPOST } from "../../app/ranking/breakdown/route";
import { GET as homeSummaryGET } from "../../app/api/home-summary/route";
import { POST as topHomesPOST } from "../../app/api/top-homes/route";
import { getPool } from "../../lib/db";
import { equalWeights } from "../../components/WeightSliders";
import { buildTemplateSentence, type BreakdownSignal } from "../../components/ScoreExplainer";

// M2-W5 (github #65): real-DB tests only, no mocks/synthetic data.
//   1. api.home_score_breakdown's contributions sum to the home's real
//      ranked score (±0.001), on 3 real Travis homes.
//   2. A stored, pre-generated summary reads back in < 100ms (primary-key
//      lookup — pipelines/sources/home_summaries.py, run for this
//      ticket, already wrote real rows for these homes).
//   3. A home with no stored summary yet returns summary:null — the
//      "failure/not-generated-yet path returns the template" case —
//      and the deterministic template (built only from real breakdown
//      facts, no LLM) is a real, non-empty, grounded sentence.
//
// The grounding-guard rejection test itself (a real reply + an appended
// number absent from the real facts) lives in
// pipelines/tests/test_home_summaries.py, since the guard only ever runs
// pipeline-side — the web app never calls Gemini.

const TRAVIS_COUNTY_FIPS = "48453";
// The 3 real homes pipelines/sources/home_summaries.py pre-generated a
// summary for as part of this ticket's build (see its TEST_PROP_IDS).
// M2-web-followup: kept in lockstep with pipelines/sources/home_summaries.py's
// TEST_PROP_IDS (refreshed off a data-drift-related failure -- the
// previous 3 homes had aged out of the top 50 at equal weights).
const REAL_HOMES_WITH_STORED_SUMMARY = ["113398", "509880", "713484"];

function breakdownRequest(propId: string, weights: Record<string, number>) {
  return new Request("http://localhost/ranking/breakdown", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ propId, weights }),
  });
}

function homeSummaryRequest(propId: string) {
  return new Request(`http://localhost/api/home-summary?propId=${encodeURIComponent(propId)}`);
}

describe.skipIf(!process.env.POSTGRES_URL_READONLY)("M2-W5 score breakdown + summary read", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it("api.home_score_breakdown's contributions sum to the ranked score on 3 real homes (±0.001)", async () => {
    const weights = equalWeights();
    // M2-web-followup: several sequential round trips against the live
    // Supabase pooler (3 homes x a pageSize-500 rank fetch + a breakdown
    // fetch each) -- vitest's 5000ms default is too tight for that many
    // real network round trips; other real-DB tests in this suite already
    // use an explicit longer timeout (see tests/m2-map).
    const firstPage = await (
      await topHomesPOST(
        new Request("http://localhost/api/top-homes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ weights, countyFips: TRAVIS_COUNTY_FIPS, pageSize: 3 }),
        })
      )
    ).json();
    const homesOnFirstPage: string[] = firstPage.rows.map((r: { propId: string }) => r.propId);
    for (const propId of homesOnFirstPage) {
      const rankedResponse = await topHomesPOST(
        new Request("http://localhost/api/top-homes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ weights, countyFips: TRAVIS_COUNTY_FIPS, pageSize: 500 }),
        })
      );
      const ranked = await rankedResponse.json();
      const rankedRow = ranked.rows.find((r: { propId: string }) => r.propId === propId);
      expect(rankedRow, `expected ${propId} in api.homes_ranked_weighted at equal weights`).toBeTruthy();

      const breakdownResponse = await breakdownPOST(breakdownRequest(propId, weights));
      expect(breakdownResponse.status).toBe(200);
      const { signals }: { signals: BreakdownSignal[] } = await breakdownResponse.json();
      const total = signals.reduce((sum, s) => sum + (s.contribution ?? 0), 0);

      expect(Math.abs(total - rankedRow.score)).toBeLessThanOrEqual(0.001);
    }
  }, 20000);

  it("a home with a pre-generated summary reads back in well under 100ms", async () => {
    const propId = REAL_HOMES_WITH_STORED_SUMMARY[0];
    // Warm the pool once (connection setup shouldn't count against the
    // "cached call" budget), then time a second, genuinely cached call.
    await homeSummaryGET(homeSummaryRequest(propId));

    const start = performance.now();
    const response = await homeSummaryGET(homeSummaryRequest(propId));
    const elapsedMs = performance.now() - start;

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(typeof data.summary).toBe("string");
    expect(data.summary.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(100);
  });

  it("a real gate-passed home with no stored summary yet falls back to a real, grounded template", async () => {
    const weights = equalWeights();
    // The pipeline (pipelines/sources/home_summaries.py) pre-generated a
    // summary only for the top 500 equal-weight homes plus the 3 test
    // homes above. Page past rank 500 (keyset) to reach a real home
    // that's guaranteed NOT pre-generated — never a fabricated prop_id.
    const top500Response = await topHomesPOST(
      new Request("http://localhost/api/top-homes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weights, countyFips: TRAVIS_COUNTY_FIPS, pageSize: 500 }),
      })
    );
    const top500 = await top500Response.json();
    if (top500.rows.length < 500) return; // fewer than 500 gate-passed homes right now — nothing beyond the pre-generated set
    const cursorRow = top500.rows[top500.rows.length - 1];

    const nextPageResponse = await topHomesPOST(
      new Request("http://localhost/api/top-homes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          weights,
          countyFips: TRAVIS_COUNTY_FIPS,
          pageSize: 1,
          afterScore: cursorRow.score,
          afterPropId: cursorRow.propId,
        }),
      })
    );
    const nextPage = await nextPageResponse.json();
    const candidate = nextPage.rows[0];
    if (!candidate) return; // exactly 500 gate-passed homes right now — nothing beyond the pre-generated set

    const summaryResponse = await homeSummaryGET(homeSummaryRequest(candidate.propId));
    const summaryData = await summaryResponse.json();
    expect(summaryData.summary).toBeNull();

    const breakdownResponse = await breakdownPOST(breakdownRequest(candidate.propId, weights));
    const { signals }: { signals: BreakdownSignal[] } = await breakdownResponse.json();
    const template = buildTemplateSentence(signals);
    expect(template.length).toBeGreaterThan(0);

    // The template's top-2 pick matches the real breakdown's top-2
    // contributions by construction (buildTemplateSentence's own sort) —
    // cross-checked here against an independent sort over the same real
    // `signals` array, so the template can never silently drift from the
    // breakdown it was built from.
    const available = signals.filter((s) => s.available && s.contribution !== null);
    const top2 = [...available].sort((a, b) => (b.contribution ?? 0) - (a.contribution ?? 0)).slice(0, 2);
    for (const s of top2) {
      expect(template).toContain(s.label.split(" (")[0]);
    }
  }, 20000);
});
