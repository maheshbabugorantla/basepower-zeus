import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import HomePage from "../../app/page";
import { getPool, query } from "../../lib/db";

// M0-W1 acceptance criteria, exercised against the *real* Supabase views
// (api.county_outage / api.sources) — never a mocked/fabricated row. This
// suite is skipped entirely (not passed silently) when POSTGRES_URL isn't
// set, exactly like tests/design/provenance-popover.test.tsx.
//
// Updated for the M2-W outage-exposure fix (user feedback): the Overview
// headline is no longer the county-wide EAGLE-I total ("2,439,878.25
// customer-hours") — see web/tests/m2-overview/outage-exposure.test.tsx
// for that. This suite now covers only the county-context line's
// per-customer figure (api.county_outage.hours_per_customer), which is
// what these DB-shape assertions were actually protecting.
//
// The EAGLE-I backfill (M0-P1) may be running concurrently, so both branches
// below are real, expected outcomes of this same page, not alternates to
// choose between: whichever branch matches the live api.county_outage
// state for Travis 2025 is asserted.

describe.skipIf(!process.env.POSTGRES_URL)("HomePage — Travis 2025 county outage context", () => {
  afterAll(async () => {
    await getPool().end();
  });

  // Both tests below pass an explicit 20s timeout (matching every other
  // real-DB test in this repo) — the default 5s vitest timeout is tight
  // enough that a cold connection to the Supabase transaction pooler
  // occasionally trips it (a flaky-timeout problem, not a
  // query-correctness one).
  it("renders 'not loaded' when Travis 2025 has no row (or a null hours_per_customer) in api.county_outage", async () => {
    const rows = await query<{
      hours_per_customer: string | number | null;
    }>(
      "select hours_per_customer from api.county_outage where county_fips = $1 and year = $2",
      ["48453", 2025]
    );

    const isMissing = rows.length === 0 || rows[0].hours_per_customer === null;
    if (!isMissing) {
      // A real row has already loaded in this environment — the "figure
      // present" branch below covers that case instead.
      return;
    }

    const html = renderToStaticMarkup(await HomePage());
    expect(html).toContain("Not loaded");
    expect(html).toContain('data-state="not-loaded"');
    expect(html).toContain("County context (EAGLE-I)");
  }, 20000);

  it("renders the real per-customer figure (equal to the DB value) and a popover with the real manifest SHA, when a Travis 2025 row exists", async () => {
    const rows = await query<{
      hours_per_customer: string | number | null;
    }>(
      "select hours_per_customer from api.county_outage where county_fips = $1 and year = $2",
      ["48453", 2025]
    );

    if (rows.length === 0 || rows[0].hours_per_customer === null) {
      // Not loaded yet in this environment — covered by the test above.
      return;
    }

    const expectedValue = Number(rows[0].hours_per_customer).toFixed(1);

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
    expect(html).toContain("h without power per customer");
    expect(html).toContain("County context (EAGLE-I)");
    // Figure is wrapped in the real provenance trigger button.
    expect(html).toMatch(/<button[^>]*class="provenance-trigger"[^>]*>/);

    const sha = sourceRows[0]?.sha256;
    if (sha) {
      expect(html).toContain(sha.slice(0, 12));
    }
  }, 20000);
});
