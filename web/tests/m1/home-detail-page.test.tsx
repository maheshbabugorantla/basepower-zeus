import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import HomeDetailPage from "../../app/home/[prop_id]/page";
import { getPool, query } from "../../lib/db";

// M1-W1 acceptance: "Pages render the honest empty state against the real
// views." Also enforces the product rule (updated by M2-P8): the COUNTY
// TOTAL customer-hours figure (api.county_outage) never appears on a home
// page -- only the per-home outage-minutes figure (SAIDI or the EAGLE-I
// county proxy, both attributed via outage_basis) is allowed.

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
    "never shows the county-total customer-hours figure on a home page, for a real loaded home if one exists",
    async () => {
      const rows = await query<{ prop_id: string }>("select prop_id from api.home_detail limit 1");
      if (rows.length === 0) return; // nothing loaded yet — covered by the empty-state test above.

      const html = renderToStaticMarkup(
        await HomeDetailPage({ params: Promise.resolve({ prop_id: rows[0].prop_id }) })
      );
      // M2-P8 legitimately shows a per-home outage-minutes figure now
      // (SAIDI or the EAGLE-I county proxy) -- "outage" itself is allowed.
      // Only the raw county TOTAL customer-hours figure stays banned.
      expect(html.toLowerCase()).not.toContain("customer-hours");
    },
    20000
  );
});
