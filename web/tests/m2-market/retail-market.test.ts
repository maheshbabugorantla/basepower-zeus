import { afterAll, describe, expect, it } from "vitest";
import { getPool, query } from "../../lib/db";
import { GateCounts } from "../../components/GateCounts";

// M2-W4 acceptance: regulated vs deregulated market per home
// (api.retail_market, api.gate_counts_by_market — 0206_retail_market.sql),
// exercised against the real, already-backfilled Supabase state. Skipped
// entirely without POSTGRES_URL_READONLY (the web app's real login,
// migration 0210) configured.

describe.skipIf(!process.env.POSTGRES_URL_READONLY)("api.retail_market / api.gate_counts_by_market", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it("connects as the read-only role and returns real rows for both views", async () => {
    const [whoRows, oncorRows, austinRows, marketCounts] = await Promise.all([
      query<{ current_user: string }>("select current_user"),
      query<{ eia_utility_number: string; retail_market: string; plain_language: string }>(
        "select eia_utility_number, retail_market, plain_language from api.retail_market where eia_utility_number = $1",
        ["44372"]
      ),
      query<{ eia_utility_number: string; retail_market: string; plain_language: string }>(
        "select eia_utility_number, retail_market, plain_language from api.retail_market where eia_utility_number = $1",
        ["1015"]
      ),
      query<{ market: string; reason: string; home_count: string | number }>(
        "select market, reason, home_count from api.gate_counts_by_market"
      ),
    ]);

    expect(whoRows[0].current_user).toBe("zeus_web_ro");

    // Real, cited rows loaded from data/manual/retail_market.csv — never
    // a placeholder value.
    expect(oncorRows[0]?.retail_market).toBe("deregulated");
    expect(austinRows[0]?.retail_market).toBe("not_deregulated");
    expect(oncorRows[0]?.plain_language).toBeTruthy();
    expect(austinRows[0]?.plain_language).toBeTruthy();

    // The "Can Base serve this home?" split by market has real counts —
    // never zero rows once core.retail_market and core.mv_home_signals
    // both have data.
    expect(marketCounts.length).toBeGreaterThan(0);
    for (const row of marketCounts) {
      expect(Number(row.home_count)).toBeGreaterThan(0);
    }
  });

  it("both queries run well under the 50 ms per-request budget", async () => {
    const [retailMarketPlan, gateCountsPlan] = await Promise.all([
      query<{ "QUERY PLAN": [{ "Execution Time": number }] }>(
        `explain (analyze, format json) select * from api.retail_market where eia_utility_number = $1`,
        ["44372"]
      ),
      query<{ "QUERY PLAN": [{ "Execution Time": number }] }>(
        `explain (analyze, format json) select * from api.gate_counts_by_market`
      ),
    ]);
    const retailMarketMs = retailMarketPlan[0]["QUERY PLAN"][0]["Execution Time"];
    const gateCountsMs = gateCountsPlan[0]["QUERY PLAN"][0]["Execution Time"];
    expect(retailMarketMs).toBeLessThan(50);
    expect(gateCountsMs).toBeLessThan(50);
  });
});

describe("GateCounts (structural, market split)", () => {
  it("never breaks the funnel render for the existing not-loaded / structural states", async () => {
    // GateCounts' <MarketSplit> is an async Server Component rendered
    // inside a <Suspense> boundary so it works in the real Next.js app
    // (which awaits async Server Components); react-dom/server's
    // renderToStaticMarkup (used here and by web/tests/m2/gate-counts.
    // test.tsx) cannot await it and renders the Suspense fallback (null)
    // instead — this proves that fallback never breaks the existing
    // funnel/legend output, which is exactly what m2/gate-counts.test.tsx
    // already asserts on.
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(
      GateCounts({
        rows: [
          { reason: "passed", homeCount: 100 },
          { reason: "territory_not_base_served", homeCount: 25 },
        ],
      })
    );
    expect(html).toContain("gate-funnel");
    expect(html).toContain("100");
    expect(html).toContain("25");
  });
});
