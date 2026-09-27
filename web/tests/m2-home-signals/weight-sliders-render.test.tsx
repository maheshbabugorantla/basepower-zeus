import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WeightSliders, equalWeights, SIGNAL_LABELS } from "../../components/WeightSliders";

// M2-P8: WeightSliders now renders 10 sliders, plus "Evidence-based
// defaults" alongside "Reset to equal". No DB needed — this only
// exercises the component's own markup.
//
// Redesign (2026-09-27): regrouped from 3 plain headings into PRODUCT.md's
// four signal families (outage exposure / grid value / installability /
// household fit) — the same family each signal's chip/meter already uses.

describe("WeightSliders (M2-P8, redesign grouping)", () => {
  const html = renderToStaticMarkup(
    <WeightSliders weights={equalWeights()} onChange={() => {}} onReset={() => {}} defaultWeights={null} />
  );

  it("renders the 4 signal-family headings", () => {
    expect(html).toContain("Outage exposure");
    expect(html).toContain("Grid value");
    expect(html).toContain("Installability");
    expect(html).toContain("Household fit");
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
