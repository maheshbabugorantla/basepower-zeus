import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import HomeDetailPage from "../../app/home/[prop_id]/page";
import { getPool, query } from "../../lib/db";

// M2-W1 acceptance: "home page outage line never contains 'customer-hours'"
// — a home's outage exposure is its distributor's SAIDI (minutes without
// power per customer per year), never the county-level customer-hours
// total shown on Overview (api.county_outage). Checked two ways: a static
// check of the page source (so it never regresses even without a DB), and
// a live render against a real gated Travis home when POSTGRES_URL is set.

describe("home detail page source (static)", () => {
  it("never renders the county-level unit 'customer-hours' on a home's own outage line", () => {
    const source = readFileSync(
      new URL("../../app/home/[prop_id]/page.tsx", import.meta.url),
      "utf8"
    );
    // Strip `//` line comments (which legitimately explain, in prose,
    // *why* the county-level customer-hours figure is never shown here)
    // before checking — only rendered JSX text/strings must avoid it.
    const withoutLineComments = source
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    expect(withoutLineComments).not.toMatch(/customer-hours/i);
  });
});

describe.skipIf(!process.env.POSTGRES_URL)("HomeDetailPage outage line (live)", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it(
    "renders a real gated home's outage line without the word 'customer-hours'",
    async () => {
      const rows = await query<{ prop_id: string }>(
        `select prop_id from core.mv_home_signals where gate_reason is null limit 1`
      );
      if (rows.length === 0) return; // no gated home yet — nothing to assert against real data

      const html = renderToStaticMarkup(
        await HomeDetailPage({ params: Promise.resolve({ prop_id: rows[0].prop_id }) })
      );
      expect(html.toLowerCase()).not.toContain("customer-hours");
    },
    20000
  );
});
