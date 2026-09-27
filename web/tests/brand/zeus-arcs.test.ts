import { describe, expect, it } from "vitest";
import { ZEUS_BADGE, arcPath, burst, zig } from "../../lib/zeusArcs";

// Deterministic PRNG so the geometry checks are repeatable. This drives the
// shape of decorative lightning only; it produces no data values.
function seeded(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

describe("zig", () => {
  it("keeps both endpoints and doubles the segment count per level", () => {
    const pts = zig([0, 0], [100, 0], 0.2, 3, seeded(1));
    expect(pts).toHaveLength(2 ** 3 + 1);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[pts.length - 1]).toEqual([100, 0]);
  });
});

describe("burst", () => {
  it("starts every tip arc at a visible end of the bolt", () => {
    const arcs = burst(ZEUS_BADGE, "strike", seeded(7));
    const starts = arcs.map((a) => a.pts[0]);
    const atTip = starts.filter((p) => p === ZEUS_BADGE.tipA || p === ZEUS_BADGE.tipB);
    expect(atTip.length).toBeGreaterThanOrEqual(6); // three off each tip in a strike
  });

  it("gives a strike more arcs than a flicker", () => {
    expect(burst(ZEUS_BADGE, "strike", seeded(3)).length).toBeGreaterThan(burst(ZEUS_BADGE, "flicker", seeded(3)).length);
  });

  it("emits arcs whose life starts at max and is positive", () => {
    for (const a of burst(ZEUS_BADGE, "flicker", seeded(11))) {
      expect(a.life).toBe(a.max);
      expect(a.life).toBeGreaterThan(0);
    }
  });
});

describe("arcPath", () => {
  it("writes a move then line commands", () => {
    expect(arcPath([[1, 2], [3, 4], [5, 6]])).toBe("M1.0 2.0L3.0 4.0L5.0 6.0");
  });
});
