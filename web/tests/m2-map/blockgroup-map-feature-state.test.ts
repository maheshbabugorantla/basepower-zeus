import { describe, expect, it } from "vitest";
import { scoreFillExpression, SCORE_RAMP } from "../../components/BlockGroupMap";

// M2-W3: the map used to color block groups from the GeoJSON's baked-in
// v0 backup-intent-only score (["get", "score"]) — the exact bug this
// ticket fixes. The fill layer must read the client-set feature-state
// (from api.blockgroup_scores_weighted) instead, never the static
// GeoJSON property, or a weight-slider move would never recolor the map.

describe("BlockGroupMap fill expression reads feature-state, not the static GeoJSON score", () => {
  it("scoreFillExpression's step expression is keyed off feature-state score", () => {
    const expr = scoreFillExpression() as unknown[];
    expect(expr[0]).toBe("step");
    expect(expr[1]).toEqual(["feature-state", "score"]);
  });

  it("every ramp color the expression can output is one of the exported SCORE_RAMP steps", () => {
    const expr = scoreFillExpression() as unknown[];
    const colors = expr.filter((_, i) => i >= 2 && i % 2 === 0);
    for (const color of colors) expect(SCORE_RAMP).toContain(color);
  });
});
