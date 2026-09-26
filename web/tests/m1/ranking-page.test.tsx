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
      // First paint uses the evidence-based defaults (api.default_weights).
      const defaults = await query<{ signal_key: string; weight: string | number }>(
        `select signal_key, weight from api.default_weights`
      );
      const weights = Object.fromEntries(defaults.map((d) => [d.signal_key, Number(d.weight)]));
      const topHomes = await query<{ prop_id: string }>(
        `select prop_id from api.homes_ranked_weighted($1::jsonb, $2::text, null, null, null, 10)`,
        [JSON.stringify(weights), "48453"]
      );

      const html = renderToStaticMarkup(await RankingPage());

      if (topHomes.length === 0) {
        expect(html).toContain("missing-state--not-loaded");
        expect(html).toContain("Not loaded");
      } else {
        for (const row of topHomes) {
          expect(html).toContain(`/home/${row.prop_id}`);
        }
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

      const html = renderToStaticMarkup(await RankingPage());

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
