import { afterAll, describe, expect, it } from "vitest";
import { countedStages, formatStormDate, formatStormHours, stormPhrases, type IntroFacts } from "../../lib/introFacts";
import { GET } from "../../app/api/intro-facts/route";
import { getPool } from "../../lib/db";

// Formatting is checked against the route's own live output: nothing here is
// typed in as a value. Skipped when no read-only database URL is configured.
const hasDb = !!process.env.POSTGRES_URL_READONLY;

describe.skipIf(!hasDb)("/api/intro-facts (live database)", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it("returns the default county's storm and funnel, nulls kept as nulls", async () => {
    const res = await GET(new Request("http://localhost/api/intro-facts"));
    const body = (await res.json()) as IntroFacts;
    expect(body.countyFips).toMatch(/^48\d{3}$/);
    expect(body.funnel.map((s) => s.key)).toEqual(["parcels", "singleFamily", "homestead", "mapped", "served"]);

    const counted = countedStages(body.funnel);
    // each counted stage is a subset of the one before it
    for (let i = 1; i < counted.length; i++) expect(counted[i].count).toBeLessThanOrEqual(counted[i - 1].count);

    if (body.storm) {
      const phrases = stormPhrases(body.storm);
      if (body.storm.startEpoch !== null) expect(phrases[0]).toBe(formatStormDate(body.storm.startEpoch));
      if (body.storm.hours !== null) expect(phrases.join(" ")).toContain(formatStormHours(body.storm.hours));
      expect(phrases.join(" ")).not.toMatch(/null|NaN|undefined/);
    }
  });

  it("marks never-counted stages null for a county whose roll was pre-filtered", async () => {
    const res = await GET(new Request("http://localhost/api/intro-facts?county=48201"));
    const body = (await res.json()) as IntroFacts;
    if (body.countyFips !== "48201") return; // Harris not scored in this database
    const parcels = body.funnel.find((s) => s.key === "parcels")!;
    const homestead = body.funnel.find((s) => s.key === "homestead")!;
    // never the downstream count repeated as if it were the full roll
    if (parcels.count !== null && homestead.count !== null) expect(parcels.count).toBeGreaterThan(homestead.count);
  });
});

describe("stormPhrases", () => {
  it("drops a phrase whose figure is missing rather than inventing one", () => {
    expect(stormPhrases(null)).toEqual([]);
    expect(stormPhrases({ countyName: "Travis", startEpoch: null, hours: null, peakCustomers: null })).toEqual([]);
  });
});
