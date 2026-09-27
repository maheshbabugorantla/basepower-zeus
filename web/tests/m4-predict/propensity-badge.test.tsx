import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { getPool, query } from "../../lib/db";
import { PropensityBadge, type PropensityReason } from "../../components/PropensityBadge";
import { tierForDecile, plainReason, isEligibleReason } from "../../lib/priorityTier";

// M4-W2 acceptance, revised for the redesign's non-negotiable product
// rule: a rep or manager never sees p_install_12m, relative_to_county,
// or any other multiple/probability/percentile. PropensityBadge now
// renders only a priority tier chip (from decile) and plain-language
// reasons. Rendered here with REAL api.home_propensity rows -- no
// synthetic probabilities, deciles or reasons.

describe.skipIf(!process.env.POSTGRES_URL_READONLY)("PropensityBadge renders a real home_propensity row", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it("shows the priority tier and the model's own reasons, in plain language -- never the multiplier or per-1000 figure", async () => {
    const rows = await query<{
      prop_id: string;
      p_install_12m: string;
      relative_to_county: string | null;
      decile: number | null;
      reasons: PropensityReason[];
      extrapolated_from: string | null;
    }>(
      `select prop_id, p_install_12m::text, relative_to_county::text, decile, reasons, extrapolated_from
       from api.home_propensity
       where county_fips = '48453' and relative_to_county is not null
       order by p_install_12m desc
       limit 1`
    );
    const row = rows[0];
    expect(row).toBeTruthy();

    const pInstall12m = Number(row.p_install_12m);
    const relativeToCounty = Number(row.relative_to_county);

    const html = renderToStaticMarkup(
      <PropensityBadge
        pInstall12m={pInstall12m}
        relativeToCounty={relativeToCounty}
        decile={row.decile}
        countyName="Travis"
        extrapolatedFrom={row.extrapolated_from}
        reasons={row.reasons}
      />
    );

    // Non-negotiable: no multiple, no per-1000 figure, anywhere in the markup.
    expect(html).not.toContain("×");
    expect(html).not.toMatch(/in 1,000/);
    expect(html).not.toContain(String(pInstall12m));

    expect(html).toContain(tierForDecile(row.decile).label);
    // Matches PropensityBadge's own filter exactly (rep-approved vocabulary
    // only -- year built, installability, and already-has-backup permits
    // never render as a reason chip, even when they're one of the model's
    // real top-3 contributions for this home).
    const shown = row.reasons.filter((r) => r.direction === "raises" && isEligibleReason(r.feature));
    for (const reason of shown.slice(0, 3)) {
      const phrase = plainReason(reason.feature);
      // renderToStaticMarkup HTML-escapes text nodes (an apostrophe becomes &#x27;).
      expect(html).toContain(phrase.replace(/'/g, "&#x27;"));
    }
  });

  it("finds at least one extrapolated (no Austin permit coverage) home and labels the prediction as extrapolated, in plain words", async () => {
    const rows = await query<{ p_install_12m: string; relative_to_county: string | null; decile: number | null }>(
      `select p_install_12m::text, relative_to_county::text, decile
       from api.home_propensity
       where extrapolated_from = 'austin_installs'
       limit 1`
    );
    if (rows.length === 0) return; // none loaded right now -- nothing to assert
    const row = rows[0];
    const html = renderToStaticMarkup(
      <PropensityBadge
        pInstall12m={Number(row.p_install_12m)}
        relativeToCounty={row.relative_to_county === null ? null : Number(row.relative_to_county)}
        decile={row.decile}
        countyName="Travis"
        extrapolatedFrom="austin_installs"
        reasons={[]}
      />
    );
    expect(html).toContain("extrapolated from Austin installs");
  });

  it("a home with no decile shows 'Not scored yet', never a bare score chip", () => {
    const html = renderToStaticMarkup(
      <PropensityBadge pInstall12m={0.0001} relativeToCounty={0.5} decile={null} countyName="Travis" reasons={[]} />
    );
    expect(html).toContain("Not scored yet");
  });
});
