import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import HomePage from "../../app/page";
import { getPool, query } from "../../lib/db";

// M0-W1 acceptance criteria, exercised against the *real* Supabase views
// (api.county_outage / api.sources) — never a mocked/fabricated row. This
// suite is skipped entirely (not passed silently) when POSTGRES_URL isn't
// set, exactly like tests/design/provenance-popover.test.tsx.
//
// The EAGLE-I backfill (M0-P1) may be running concurrently, so both branches
// below are real, expected outcomes of this same page, not alternates to
// choose between: whichever branch matches the live api.county_outage
// state for Travis 2025 is asserted.

describe.skipIf(!process.env.POSTGRES_URL)("HomePage — Travis 2025 outage sentence", () => {
  afterAll(async () => {
    await getPool().end();
  });

  // Both tests below pass an explicit 20s timeout (matching every other
  // real-DB test in this repo) — the default 5s vitest timeout is tight
  // enough that a cold connection to the Supabase transaction pooler
  // occasionally trips it (a flaky-timeout problem, not a
  // query-correctness one).
  it("renders 'not loaded' when Travis 2025 has no row (or a null value) in api.county_outage", async () => {
    const rows = await query<{
      customer_hours_out: string | number | null;
      customer_hours_out_null_reason: string | null;
    }>(
      "select customer_hours_out, customer_hours_out_null_reason from api.county_outage where county_fips = $1 and year = $2",
      ["48453", 2025]
    );

    const isMissing = rows.length === 0 || rows[0].customer_hours_out === null;
    if (!isMissing) {
      // A real row has already loaded in this environment — the "figure
      // present" branch below covers that case instead.
      return;
    }

    const html = renderToStaticMarkup(await HomePage());
    expect(html).toContain("Not loaded");
    expect(html).toContain('data-state="not-loaded"');
    // County-level caveat is always present, in either state.
    expect(html).toContain("county-level");
    // Never a literal number, dash, or zero standing in for the missing value.
    expect(html).not.toMatch(/>\s*0\s*customer-hours/);
  }, 20000);

  it("renders the real figure (equal to the DB value) and a popover with the real manifest SHA, when a Travis 2025 row exists", async () => {
    const rows = await query<{
      customer_hours_out: string | number | null;
    }>(
      "select customer_hours_out from api.county_outage where county_fips = $1 and year = $2",
      ["48453", 2025]
    );

    if (rows.length === 0 || rows[0].customer_hours_out === null) {
      // Not loaded yet in this environment — covered by the test above.
      return;
    }

    const expectedValue = Number(rows[0].customer_hours_out).toLocaleString();

    const sourceRows = await query<{ sha256: string | null }>(
      `select s.sha256
       from api.county_outage co
       left join api.sources s on s.source_id = co.source_ids[1]
       where co.county_fips = $1 and co.year = $2
       limit 1`,
      ["48453", 2025]
    );

    const html = renderToStaticMarkup(await HomePage());

    expect(html).toContain(expectedValue);
    expect(html).toContain("customer-hours without power");
    expect(html).toContain("county-level");
    // Figure is wrapped in the real provenance trigger button.
    expect(html).toMatch(/<button[^>]*class="provenance-trigger"[^>]*>/);

    const sha = sourceRows[0]?.sha256;
    if (sha) {
      expect(html).toContain(sha.slice(0, 12));
    }
  }, 20000);
});
