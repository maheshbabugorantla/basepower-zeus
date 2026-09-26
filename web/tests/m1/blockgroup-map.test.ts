import { describe, expect, it } from "vitest";
import {
  SCORE_RAMP,
  SCORED_FILTER,
  UNSCORED_FILTER,
  scoreRampColor,
} from "../../components/BlockGroupMap";

// M1-W1 acceptance: "Unscored block groups are hatched, not colored as low
// scores." These are the pure, DOM-free building blocks BlockGroupMap uses
// to decide fill vs. hatch — checkable without a browser/WebGL context.

describe("BlockGroupMap score/hatch logic", () => {
  it("never maps a null-ish score into the color ramp — the scored filter excludes null", () => {
    expect(SCORED_FILTER).toEqual(["!=", ["get", "score"], null]);
    expect(UNSCORED_FILTER).toEqual(["==", ["get", "score"], null]);
  });

  it("maps the lowest score bucket to the lightest ramp step (never confused with hatch grey)", () => {
    const color = scoreRampColor(0);
    expect(color).toBe(SCORE_RAMP[0]);
    expect(SCORE_RAMP).toContain(color);
  });

  it("maps the highest score to the darkest ramp step", () => {
    expect(scoreRampColor(1)).toBe(SCORE_RAMP[SCORE_RAMP.length - 1]);
  });

  it("is monotonic across the ramp (higher score never yields an earlier/lighter step)", () => {
    const steps = [0, 0.25, 0.5, 0.75, 0.99].map(scoreRampColor);
    const indices = steps.map((c) => SCORE_RAMP.indexOf(c));
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThanOrEqual(indices[i - 1]);
    }
  });
});
