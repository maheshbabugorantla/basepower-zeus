import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WeightSliders, equalWeights, SIGNAL_LABELS } from "../../components/WeightSliders";

// M2-P8: WeightSliders now renders 10 sliders under 3 plain headings,
// plus "Evidence-based defaults" alongside "Reset to equal". No DB
// needed — this only exercises the component's own markup.

describe("WeightSliders (M2-P8)", () => {
  const html = renderToStaticMarkup(
    <WeightSliders weights={equalWeights()} onChange={() => {}} onReset={() => {}} defaultWeights={null} />
  );

  it("renders the 3 group headings from the ticket", () => {
    expect(html).toContain("Outage &amp; grid");
    expect(html).toContain("This home");
    expect(html).toContain("Neighborhood");
  });

  it("renders a slider for all 13 signals with their plain-language labels", () => {
    for (const label of Object.values(SIGNAL_LABELS)) {
      expect(html, `missing label "${label}"`).toContain(label);
    }
    // 13 range inputs, one per signal (M2-web-followup added income_100k/
    // age_35_64/permit_risk to the original 10).
    expect(html.match(/type="range"/g)?.length).toBe(13);
  });

  it("renders both the evidence-based-defaults and reset-to-equal actions", () => {
    expect(html).toContain("Evidence-based defaults");
    expect(html).toContain("Reset to equal");
    expect(html).toContain("How defaults were chosen");
  });

  it("never shows a schema/table name on screen", () => {
    expect(html).not.toMatch(/\bcore\.|\bapi\.|mv_home_signals|prop_id|geoid/i);
  });
});
