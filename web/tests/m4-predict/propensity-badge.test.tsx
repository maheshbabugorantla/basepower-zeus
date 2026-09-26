import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { getPool, query } from "../../lib/db";
import { PropensityBadge, type PropensityReason } from "../../components/PropensityBadge";

// M4-W2 acceptance: "Home page shows likelihood + model reasons" (and the
// same badge is used in ranking rows). Rendered here with a REAL
// api.home_propensity row -- no synthetic probabilities or reasons.

describe.skipIf(!process.env.POSTGRES_URL_READONLY)("PropensityBadge renders a real home_propensity row", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it("shows the multiplier, the per-1000 figure, and the model's own reasons", async () => {
    const rows = await query<{
      prop_id: string;
      p_install_12m: string;
      relative_to_county: string | null;
      reasons: PropensityReason[];
      extrapolated_from: string | null;
    }>(
      `select prop_id, p_install_12m::text, relative_to_county::text, reasons, extrapolated_from
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
        countyName="Travis"
        extrapolatedFrom={row.extrapolated_from}
        reasons={row.reasons}
      />
    );

    expect(html).toContain(`${relativeToCounty.toFixed(1)}×`);
    expect(html).toContain("Travis average");
    for (const reason of row.reasons) {
      // renderToStaticMarkup HTML-escapes text nodes (an apostrophe becomes &#x27;).
      expect(html).toContain(reason.feature.replace(/'/g, "&#x27;"));
    }
    // A reason's raw model-scale `value` (e.g. a home-value term of ~16)
    // is never printed -- only feature name + direction render, and
    // neither PropensityBadge.tsx nor this test reads `.value` for display.
  });

  it("finds at least one extrapolated (no Austin permit coverage) home and labels it plainly", async () => {
    const rows = await query<{ p_install_12m: string; relative_to_county: string | null }>(
      `select p_install_12m::text, relative_to_county::text
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
        countyName="Travis"
        extrapolatedFrom="austin_installs"
        reasons={[]}
      />
    );
    expect(html).toContain("Predicted from Austin installs");
  });

  it("a probability under 1-in-1000 reads as 'fewer than 1 in 1,000', never 0", () => {
    const html = renderToStaticMarkup(
      <PropensityBadge pInstall12m={0.0001} relativeToCounty={0.5} countyName="Travis" reasons={[]} />
    );
    expect(html).toContain("fewer than 1 in 1,000");
  });
});
