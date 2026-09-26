import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import HomeDetailPage from "../../app/home/[prop_id]/page";
import { getPool, query } from "../../lib/db";

// M1-W1 acceptance: "Pages render the honest empty state against the real
// views." Also enforces the explicit product rule for M1: no outage
// figure (county EAGLE-I customer-hours) ever appears on a home page.

describe.skipIf(!process.env.POSTGRES_URL)("HomeDetailPage", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it(
    "renders the honest 'not loaded' state for a prop_id with no core.parcels row",
    async () => {
      const html = renderToStaticMarkup(
        await HomeDetailPage({ params: Promise.resolve({ prop_id: "does-not-exist-in-tcad" }) })
      );
      expect(html).toContain("missing-state--not-loaded");
      expect(html).toContain("Not loaded");
    },
    20000
  );

  it(
    "never shows customer-hours/outage figures on a home page, for a real loaded home if one exists",
    async () => {
      const rows = await query<{ prop_id: string }>("select prop_id from api.home_detail limit 1");
      if (rows.length === 0) return; // nothing loaded yet — covered by the empty-state test above.

      const html = renderToStaticMarkup(
        await HomeDetailPage({ params: Promise.resolve({ prop_id: rows[0].prop_id }) })
      );
      expect(html.toLowerCase()).not.toContain("customer-hours");
      expect(html.toLowerCase()).not.toContain("outage");
    },
    20000
  );
});
