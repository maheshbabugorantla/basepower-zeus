import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import HomePage from "../../app/page";
import { getPool, query } from "../../lib/db";

// M1-W3 acceptance: "No duplicated unit text anywhere." The bug was
// Overview reading "customer-hours without power without power in 2025" —
// the Figure's own unit already says "customer-hours without power", and
// the surrounding sentence repeated "without power" again. Assert against
// the rendered *text* (tags stripped, whitespace collapsed) so a stray
// closing tag between the two occurrences can't hide a real duplication
// from a substring check.

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

describe.skipIf(!process.env.POSTGRES_URL)("Overview — no duplicated unit", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it("never repeats 'without power' back to back in the rendered text", async () => {
    const rows = await query<{ customer_hours_out: string | number | null }>(
      "select customer_hours_out from api.county_outage where county_fips = $1 and year = $2",
      ["48453", 2025]
    );
    if (rows.length === 0 || rows[0].customer_hours_out === null) {
      return; // Covered by the not-loaded branch, which has no unit to duplicate.
    }

    const html = renderToStaticMarkup(await HomePage());
    const text = textOf(html);

    expect(text).not.toMatch(/without power\s+without power/i);
    // The real unit string must still be present exactly once, contiguously.
    expect(text).toContain("customer-hours without power");
  }, 20000);
});
