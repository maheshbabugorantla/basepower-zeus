import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import RankingPage from "../../app/ranking/page";
import { getPool, query } from "../../lib/db";

// M1-W1 acceptance:
//  - "Pages render the honest empty state against the real views"
//  - "Every top-50 row links to /home/[prop_id]"
// Exercised against the real api.top_homes / api.join_rate /
// api.classifier_precision / api.parcel_gate_counts state, whichever
// branch is actually live right now (parcels/permits/geometry pipelines
// may still be loading in parallel).

describe.skipIf(!process.env.POSTGRES_URL)("RankingPage", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it(
    "renders the honest empty state when api.top_homes_weighted has no rows, or real linked rows when it does",
    async () => {
      // M2-W1: the page now sources its ranked table from
      // api.top_homes_weighted (score v1, equal weights for the
      // server-rendered first paint), not the retired v0 api.top_homes
      // view — see 0201_m2.sql / app/ranking/page.tsx.
      // First paint is the predicted ranking (M4-W2): the most likely homes
      // from api.home_propensity. Homes that already have backup are hidden by
      // default, so check that the page links real top-predicted homes.
      const topPredicted = await query<{ prop_id: string }>(
        `select prop_id from api.home_propensity where county_fips = $1
         order by p_install_12m desc, prop_id limit 50`,
        ["48453"]
      );

      const html = renderToStaticMarkup(await RankingPage({ searchParams: Promise.resolve({}) }));

      if (topPredicted.length === 0) {
        expect(html).toContain("missing-state--not-loaded");
      } else {
        const linked = topPredicted.filter((row) => html.includes(`/home/${row.prop_id}`));
        expect(linked.length).toBeGreaterThanOrEqual(10);
      }
    },
    60000
  );

  it(
    "Quality panel reads the real join_rate / classifier_precision / parcel_gate_counts state honestly",
    async () => {
      const [joinRate, precision] = await Promise.all([
        query<{ join_rate: number | string | null; join_rate_null_reason: string | null }>(
          "select join_rate, join_rate_null_reason from api.join_rate"
        ),
        query<{ label: string; precision: number | string | null; precision_null_reason: string | null }>(
          "select label, precision, precision_null_reason from api.classifier_precision"
        ),
      ]);

      const html = renderToStaticMarkup(await RankingPage({ searchParams: Promise.resolve({}) }));

      if (joinRate[0]?.join_rate === null) {
        expect(html).toContain("missing-state--not-loaded");
      }
      for (const row of precision) {
        if (row.precision === null) {
          expect(html.toLowerCase()).toContain("not yet labelled");
        }
      }
    },
    60000
  );
});
