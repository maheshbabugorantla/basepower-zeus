// Geometry and arc generation for the Zeus brand mark (the transmission badge).
//
// This is artwork geometry, not data: the points below locate the thunderbolt
// inside public/brand/zeus-badge-*.svg (all tiers share one viewBox), measured
// from the traced bolt layer. ZeusArcs draws procedural lightning from them.

export type Pt = readonly [number, number];

export interface MarkGeometry {
  /** viewBox width/height shared by every zeus-badge-* layer */
  w: number;
  h: number;
  /** the two visible ends of the gold bolt */
  tipA: Pt;
  tipB: Pt;
  /** centroid of the bolt */
  center: Pt;
  /** where the fist covers the bolt (start and end along the bolt axis) */
  grip: readonly [Pt, Pt];
  /** bolt length along its main axis, in viewBox units */
  boltLen: number;
}

export const ZEUS_BADGE: MarkGeometry = {
  w: 1828,
  h: 1690,
  tipA: [179.7, 144.5],
  tipB: [1672.3, 1299.0],
  center: [956.3, 709.7],
  grip: [
    [747.0, 560.7],
    [1176.6, 866.5],
  ],
  boltLen: 1943.3,
};

export interface Arc {
  pts: Pt[];
  /** stroke width multiplier */
  width: number;
  /** frames left, and frames at birth (for fading) */
  life: number;
  max: number;
}

export type Rand = () => number;

/** Midpoint-displacement lightning between a and b. */
export function zig(a: Pt, b: Pt, rough: number, depth: number, rand: Rand): Pt[] {
  let pts: Pt[] = [a, b];
  let off = Math.hypot(b[0] - a[0], b[1] - a[1]) * rough;
  for (let d = 0; d < depth; d++) {
    const next: Pt[] = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const len = Math.hypot(dx, dy) || 1;
      const t = (rand() - 0.5) * 2 * off;
      next.push([(p[0] + q[0]) / 2 + (-dy / len) * t, (p[1] + q[1]) / 2 + (dx / len) * t], q);
    }
    pts = next;
    off *= 0.55;
  }
  return pts;
}

function outward(g: MarkGeometry, tip: Pt, lenFrac: number, spread: number, rand: Rand): [Pt, Pt] {
  const base = Math.atan2(tip[1] - g.center[1], tip[0] - g.center[0]) + (rand() - 0.5) * spread;
  const len = g.boltLen * lenFrac * (0.6 + rand() * 0.6);
  return [tip, [tip[0] + Math.cos(base) * len, tip[1] + Math.sin(base) * len]];
}

function pushArc(out: Arc[], a: Pt, b: Pt, width: number, life: number, branches: number, rand: Rand) {
  const pts = zig(a, b, 0.22, 5, rand);
  out.push({ pts, width, life, max: life });
  for (let i = 0; i < branches; i++) {
    const j = 3 + Math.floor(rand() * Math.max(1, pts.length - 6));
    const p = pts[j];
    const q = pts[Math.min(j + 3, pts.length - 1)];
    const ang = Math.atan2(q[1] - p[1], q[0] - p[0]) + (rand() < 0.5 ? -1 : 1) * (0.35 + rand() * 0.6);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) * (0.18 + rand() * 0.3);
    const e: Pt = [p[0] + Math.cos(ang) * len, p[1] + Math.sin(ang) * len];
    out.push({ pts: zig(p, e, 0.25, 4, rand), width: width * 0.55, life: life * 0.8, max: life * 0.8 });
  }
}

/**
 * One burst of arcs. "flicker" is the small crackle that repeats every
 * ~60-120 ms; "strike" is the big discharge (longer arcs off both tips,
 * crawl along the bolt, sparks off the knuckles).
 */
export function burst(g: MarkGeometry, kind: "flicker" | "strike", rand: Rand = Math.random): Arc[] {
  const big = kind === "strike";
  const out: Arc[] = [];
  for (const tip of [g.tipA, g.tipB]) {
    const n = big ? 3 : rand() < 0.7 ? 1 : 2;
    for (let i = 0; i < n; i++) {
      const [a, b] = outward(g, tip, big ? 0.5 : 0.2, big ? 1.1 : 0.9, rand);
      pushArc(out, a, b, big ? 1.6 : 1, big ? 20 : 7 + rand() * 6, big ? 2 : 1, rand);
    }
  }
  for (let i = 0; i < (big ? 4 : 2); i++) {
    const [s0, s1] = rand() < 0.5 ? [g.tipA, g.grip[0]] : [g.grip[1], g.tipB];
    const u = rand();
    const v = Math.min(1, u + 0.15 + rand() * 0.2);
    const at = (t: number): Pt => [s0[0] + (s1[0] - s0[0]) * t, s0[1] + (s1[1] - s0[1]) * t];
    pushArc(out, at(u), at(v), 0.8, 5 + rand() * 5, 0, rand);
  }
  for (const k of g.grip) {
    if (rand() < (big ? 1 : 0.35)) {
      const [a, b] = outward(g, k, 0.12, 2.4, rand);
      pushArc(out, a, b, 0.7, 6, 0, rand);
    }
  }
  return out;
}

/** SVG path data for one arc. */
export function arcPath(pts: readonly Pt[]): string {
  return pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("");
}
