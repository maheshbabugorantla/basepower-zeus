import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import HomePage from "../../app/page";
import { getPool } from "../../lib/db";

// User feedback ticket (M2-W fix): production Overview led with a
// Travis-wide EAGLE-I total ("2,439,878.25 customer-hours") as the
// headline, and said per-home exposure was "arriving in M2" after M2
// shipped. This suite checks both are fixed, against the *real* Supabase
// tables (core.utility_reliability, core.territories,
// core.utility_crosswalk, api.county_outage) — never a mocked value, per
// the repo's real-data rule. No literal figure is asserted here; every
// check is a phrase/shape assertion against whatever the live DB returns.

const webRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("Overview 'arriving in M2' is gone", () => {
  it("the phrase 'arriving in M2' appears nowhere in web/app or web/components", () => {
    const files = [
      ...globSync("app/**/*.{ts,tsx}", { cwd: webRoot }),
      ...globSync("components/**/*.{ts,tsx}", { cwd: webRoot }),
    ];
    expect(files.length).toBeGreaterThan(0);

    const offenders = files.filter((relPath) => {
      const contents = readFileSync(path.join(webRoot, relPath), "utf8");
      return contents.includes("arriving in M2");
    });

    expect(offenders).toEqual([]);
  });
});

describe.skipIf(!process.env.POSTGRES_URL)("Overview — outage exposure panel", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it(
    "leads with per-distributor SAIDI ('minutes without power per customer'), never the county-hours total as the lead",
    async () => {
      const html = renderToStaticMarkup(await HomePage());

      // The real per-customer distributor figure is present.
      expect(html).toContain("minutes without power per customer");

      // The county-wide EAGLE-I total's unit never appears anywhere on the
      // page — it was the headline before this fix, and per the ticket it
      // must not resurface even as a lead phrase.
      expect(html).not.toContain("customer-hours");

      // SAIDI sentences are labelled, never a bare figure.
      expect(html).toContain("SAIDI, incl. major events");
    },
    20000
  );

  it(
    "shows Oncor (a Base-served distributor with no EIA-861 figure) as not-available, not as a zero or a dash",
    async () => {
      const html = renderToStaticMarkup(await HomePage());

      expect(html).toContain("Oncor");
      expect(html).toContain('data-state="not-available"');
      expect(html).toContain("Not reported to EIA-861");
    },
    20000
  );

  it(
    "shows CenterPoint Energy as arriving (Harris not loaded), not with a Travis figure",
    async () => {
      const html = renderToStaticMarkup(await HomePage());

      expect(html).toContain("CenterPoint Energy");
      expect(html).toContain("arriving in M3");
    },
    20000
  );

  it(
    "keeps the EAGLE-I county context as a muted secondary line, per customer, with provenance when loaded",
    async () => {
      const html = renderToStaticMarkup(await HomePage());

      expect(html).toContain("County context (EAGLE-I)");
      // Either the real per-customer figure or an honest not-loaded state —
      // never a literal number asserted here, and never the raw county
      // total standing in for it.
      expect(html).toMatch(/h without power per customer|data-state="not-loaded"/);
    },
    20000
  );
});
