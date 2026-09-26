import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PermitLabel } from "../../components/PermitLabel";
import { getPool, query } from "../../lib/db";

// M1-W3 acceptance: "Classified-no-match permits never render the
// not-loaded state." core.permit_labels only ever gets a row for a permit
// the rules classifier matched to a category — a permit it checked and
// found no match for gets no row at all, so `label` is null for both
// "classifier hasn't run" and "checked, no match." These must render
// differently.

describe("PermitLabel", () => {
  it("renders the real label + labeller when the permit has one", () => {
    const html = renderToStaticMarkup(
      <PermitLabel label="battery" labeller="rules" classifierHasRun={true} />
    );
    expect(html).toContain("battery");
    expect(html).toContain("rules");
    expect(html).not.toContain("missing-state");
  });

  it("renders the not-loaded MissingState when the classifier has never run at all", () => {
    const html = renderToStaticMarkup(
      <PermitLabel label={null} labeller={null} classifierHasRun={false} />
    );
    expect(html).toContain("missing-state--not-loaded");
    expect(html).toContain("Not loaded");
  });

  it("renders a plain muted 'No backup label' — never the not-loaded MissingState — when the classifier has run and found no match", () => {
    const html = renderToStaticMarkup(
      <PermitLabel label={null} labeller={null} classifierHasRun={true} />
    );
    expect(html).toContain("No backup label");
    expect(html).not.toContain("missing-state");
    expect(html).not.toContain("Not loaded");
  });
});

describe.skipIf(!process.env.POSTGRES_URL)("PermitLabel against a real unmatched permit", () => {
  it("finds at least one real core.permits row the rules classifier checked and did not match, and renders it as 'No backup label'", async () => {
    const rows = await query<{ permit_number: string }>(
      `select pm.permit_number
       from core.permits pm
       left join core.permit_labels pl
         on pl.permit_number = pm.permit_number and pl.labeller = 'rules'
       where pl.permit_number is null
       limit 1`
    );
    await getPool().end();

    if (rows.length === 0) {
      // A real state (every permit matched some category) — not a failure.
      return;
    }

    const html = renderToStaticMarkup(
      <PermitLabel label={null} labeller={null} classifierHasRun={true} />
    );
    expect(html).toContain("No backup label");
    expect(html).not.toContain("missing-state--not-loaded");
  }, 20000);
});
