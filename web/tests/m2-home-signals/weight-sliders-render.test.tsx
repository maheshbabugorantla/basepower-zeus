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

describe("WeightSliders (M2-P8, 2026-09-27 labels and grouping)", () => {
  const html = renderToStaticMarkup(
    <WeightSliders weights={equalWeights()} onChange={() => {}} onReset={() => {}} defaultWeights={null} />
  );

  it("renders the 4 group headings", () => {
    for (const heading of ["Outages", "Adoption", "Installation", "Household"]) {
      expect(html).toContain(heading);
    }
    expect(html).not.toContain("Grid value");
  });

  it("shows one number per slider: its share of the score, never the raw 0-10 setting", () => {
    // equal weights: 13 sliders at 5 each -> 5/65 = 7.7% each
    expect(html.match(/7\.7%<\/span> of score/g)?.length).toBe(13);
    // the old "5 · 7.7%" pattern read as a range
    expect(html).not.toMatch(/>\s*5\s*<\/span>\s*·/);
    expect(html).not.toContain(" · ");
    // the 0-10 setting is still announced to screen readers
    expect(html).toContain('aria-valuetext="5 of 10, 7.7 percent of the team score"');
  });

  it("renders a slider for all 13 signals with their plain-language labels", () => {
    for (const label of Object.values(SIGNAL_LABELS)) {
      expect(html, `missing label "${label}"`).toContain(label);
    }
    // 13 range inputs, one per signal (M2-web-followup added income_100k/
    // age_35_64/permit_risk to the original 10).
    expect(html.match(/type="range"/g)?.length).toBe(13);
  });

  it("says Off (not 0 or 0%) for a signal the team turned off", () => {
    const off = renderToStaticMarkup(
      <WeightSliders weights={{ ...equalWeights(), outage: 0 }} onChange={() => {}} onReset={() => {}} defaultWeights={null} />
    );
    expect(off).toContain('data-testid="weight-share-outage"><span class="weight-share__off">Off</span>');
    expect(off).toContain('aria-valuetext="Off"');
  });

  it("renders both the evidence-based-defaults and reset-to-equal actions", () => {
    expect(html).toContain("Use study defaults");
    expect(html).toContain("Set all equal");
    expect(html).toContain("How the study defaults were chosen");
  });

  it("never shows a schema/table name on screen", () => {
    expect(html).not.toMatch(/\bcore\.|\bapi\.|mv_home_signals|prop_id|geoid/i);
  });
});
