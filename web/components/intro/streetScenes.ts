// Canvas drawing for the reel's two engraved scenes: the street at dusk as a
// storm front rolls over it (windows go dark house by house until one stays
// lit), then that house's porch at night with the battery light breathing.
// Ported from the approved reel A. Coordinates are a 1600x900 design space
// that the caller maps onto the viewport with a cover fit.

import {
  DARK_ORDER,
  LIT_HOUSE,
  PORCH,
  PORCH_BATTERY_LIGHT,
  STREET,
  STREET_HOUSES,
} from "../../lib/introArt";
import { T, easeInOutCubic, easeOutExpo, seg } from "../../lib/introTimeline";

export const VW = 1600;
export const VH = 900;

export interface SceneArt {
  streetDay: HTMLCanvasElement;
  streetNight: HTMLCanvasElement;
  streetGold: HTMLCanvasElement;
  porchInk: HTMLCanvasElement;
  porchGold: HTMLCanvasElement;
}

type Pt = [number, number];

/** deterministic PRNG: the lightning's shape only, never a value shown to anyone */
export function prng(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function zig(a: Pt, b: Pt, rough: number, depth: number, R: () => number): Pt[] {
  let pts: Pt[] = [a, b];
  let off = Math.hypot(b[0] - a[0], b[1] - a[1]) * rough;
  for (let d = 0; d < depth; d++) {
    const nx: Pt[] = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const L = Math.hypot(dx, dy) || 1;
      const k = (R() - 0.5) * 2 * off;
      nx.push([(p[0] + q[0]) / 2 - (dy / L) * k, (p[1] + q[1]) / 2 + (dx / L) * k], q);
    }
    pts = nx;
    off *= 0.55;
  }
  return pts;
}

function strokePts(ctx: CanvasRenderingContext2D, pts: Pt[]) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}

/** gold lightning: a wide soft glow and a bright core, added light */
function bolt(ctx: CanvasRenderingContext2D, pts: Pt[], w: number, a: number) {
  if (a <= 0.01) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = `rgba(247,195,60,${0.16 * a})`;
  ctx.lineWidth = w * 9;
  strokePts(ctx, pts);
  ctx.strokeStyle = `rgba(247,195,60,${0.45 * a})`;
  ctx.lineWidth = w * 3;
  strokePts(ctx, pts);
  ctx.globalAlpha = a;
  ctx.strokeStyle = "#fff3c9";
  ctx.lineWidth = w;
  strokePts(ctx, pts);
  ctx.restore();
}

function branchy(a: Pt, b: Pt, R: () => number): Array<{ pts: Pt[]; w: number }> {
  const main = zig(a, b, 0.18, 7, R);
  const out = [{ pts: main, w: 1 }];
  for (let i = 0; i < 4; i++) {
    const j = 6 + Math.floor(R() * (main.length - 12));
    const p = main[j];
    const q = main[Math.min(j + 4, main.length - 1)];
    const ang = Math.atan2(q[1] - p[1], q[0] - p[0]) + (R() < 0.5 ? -1 : 1) * (0.3 + R() * 0.7);
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) * (0.12 + R() * 0.25);
    out.push({ pts: zig(p, [p[0] + Math.cos(ang) * L, p[1] + Math.sin(ang) * L], 0.25, 5, R), w: 0.5 });
  }
  return out;
}

/** colour an alpha-mask image */
export function tint(img: HTMLImageElement, color: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const x = c.getContext("2d")!;
  x.drawImage(img, 0, 0);
  x.globalCompositeOperation = "source-in";
  x.fillStyle = color;
  x.fillRect(0, 0, c.width, c.height);
  return c;
}

function drawWindows(ctx: CanvasRenderingContext2D, art: SceneArt, sc: number, ox: number, oy: number, t: number, night: boolean) {
  STREET_HOUSES.forEach((house, h) => {
    const off = h === LIT_HOUSE ? 0 : seg(t, T.windowsOut + DARK_ORDER[h] * 150, T.windowsOut + 70 + DARK_ORDER[h] * 150);
    const on = night ? 1 - off : 1;
    if (on <= 0) return;
    for (const [bx, by, bw, bh] of house) {
      ctx.save();
      ctx.globalAlpha = on;
      if (night) {
        ctx.shadowColor = "rgba(255,196,70,.95)";
        ctx.shadowBlur = 22;
      }
      ctx.drawImage(art.streetGold, bx, by, bw, bh, ox + bx * sc, oy + by * sc, bw * sc, bh * sc);
      ctx.restore();
    }
  });
}

function caption(ctx: CanvasRenderingContext2D, lines: string[], sub: string | null, a: number, rise: number, safe: { left: number; bottom: number }) {
  if (a <= 0 || lines.length === 0) return;
  ctx.save();
  let x = Math.max(88, safe.left);
  const y = VH - 96 - safe.bottom + rise;
  // the dark band follows the caption, wherever the cover-fit puts it
  const top = y - 150;
  const g = ctx.createLinearGradient(0, top, 0, y + 90);
  g.addColorStop(0, "rgba(10,10,11,0)");
  g.addColorStop(0.55, "rgba(10,10,11,.66)");
  g.addColorStop(1, "rgba(10,10,11,.82)");
  ctx.globalAlpha = a;
  ctx.fillStyle = g;
  ctx.fillRect(0, top, VW, VH - top + 10);
  ctx.fillStyle = "#f0eeeb";
  ctx.textBaseline = "alphabetic";
  lines.forEach((s, i) => {
    ctx.font = `${i === 0 ? 600 : 500} 30px Geist, ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(s, x, y);
    x += ctx.measureText(s).width + 34;
  });
  if (sub) {
    ctx.font = "400 17px Geist, ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = "#c9c4b6";
    ctx.fillText(sub, Math.max(88, safe.left), y + 36);
  }
  ctx.restore();
}

/**
 * Draw scenes 1-2 at time t (ms). Returns the canvas opacity the caller should
 * apply for the dissolve into the live page (1 until T.dissolveStart).
 */
export function drawStreetScenes(
  ctx: CanvasRenderingContext2D,
  art: SceneArt,
  t: number,
  stormLines: string[],
  stormSub: string | null,
  /** wall-clock ms: keeps the battery light breathing while the reel holds on the porch */
  wall: number,
  /** caption inset in design units, clear of whatever the cover-fit crops */
  safe: { left: number; bottom: number } = { left: 88, bottom: 0 }
): void {
  ctx.fillStyle = "#121110";
  ctx.fillRect(0, 0, VW, VH);

  /* scene 1: the street, the storm front, the windows going dark */
  if (t < T.streetOut + 150) {
    const push = 1 + 0.07 * easeOutExpo(seg(t, 0, T.streetOut));
    const sc = (VW / STREET.w) * 1.14 * push;
    const lit = STREET_HOUSES[LIT_HOUSE];
    const last = lit[lit.length - 1];
    const fx = (lit[0][0] + last[0] + last[2]) / 2;
    const fy = 460;
    const ox = Math.min(0, Math.max(VW - STREET.w * sc, VW / 2 - fx * sc));
    const oy = VH * 0.62 - fy * sc;
    const wipe = easeInOutCubic(seg(t, T.stormStart, 1350));
    const edge = zig([0, -40], [0, VH + 40], 0.08, 5, prng(7));
    const bx = -160 + (VW + 320) * wipe;

    ctx.fillStyle = "#e9e5da";
    ctx.fillRect(0, 0, VW, VH);
    drawWindows(ctx, art, sc, ox, oy, t, false);
    ctx.drawImage(art.streetDay, ox, oy, STREET.w * sc, STREET.h * sc);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-10, -10);
    for (const p of edge) ctx.lineTo(bx + p[0] + p[1] * 0.18 - 80, p[1]);
    ctx.lineTo(-10, VH + 10);
    ctx.closePath();
    ctx.clip();
    ctx.fillStyle = "#15171a";
    ctx.fillRect(0, 0, VW, VH);
    drawWindows(ctx, art, sc, ox, oy, t, true);
    ctx.globalAlpha = 0.92;
    ctx.drawImage(art.streetNight, ox, oy, STREET.w * sc, STREET.h * sc);
    ctx.restore();

    ctx.save();
    const g = ctx.createLinearGradient(bx - 200, 0, bx + 220, 0);
    g.addColorStop(0, "rgba(10,10,12,0)");
    g.addColorStop(0.45, "rgba(10,10,12,.55)");
    g.addColorStop(1, "rgba(10,10,12,0)");
    ctx.fillStyle = g;
    ctx.globalAlpha = Math.sin(Math.PI * wipe);
    ctx.fillRect(bx - 200, 0, 420, VH);
    ctx.restore();

    const st = seg(t, T.strike, T.strike + 300);
    if (st > 0 && st < 1) {
      const x0 = VW * 0.34;
      for (const a of branchy([x0, -20], [x0 + 70, oy + 430 * sc], prng(11 + Math.floor(t / 60)))) bolt(ctx, a.pts, 3.2 * a.w, 1 - st);
      ctx.fillStyle = `rgba(255,236,170,${0.22 * (1 - st)})`;
      ctx.fillRect(0, 0, VW, VH);
    }

    const ca = seg(t, 500, 900) * (1 - seg(t, 2150, 2400));
    caption(ctx, stormLines, stormSub, ca, (1 - easeOutExpo(seg(t, 500, 1000))) * 10, safe);
    if (t > T.streetOut) {
      ctx.fillStyle = `rgba(0,0,0,${seg(t, T.streetOut, T.streetOut + 150)})`;
      ctx.fillRect(0, 0, VW, VH);
    }
  }

  /* scene 2: the porch that kept its lights */
  if (t >= T.porchIn) {
    const push = 1 + 0.06 * easeOutExpo(seg(t, T.porchIn, T.dissolveStart));
    const sc = (VW / PORCH.w) * 1.08 * push;
    const w = PORCH.w * sc;
    const h = PORCH.h * sc;
    const ox = (VW - w) / 2;
    const oy = (VH - h) / 2;
    ctx.save();
    ctx.globalAlpha = seg(t, T.porchIn, T.porchIn + 220);
    ctx.fillStyle = "#8f979e";
    ctx.fillRect(ox, oy, w, h);
    ctx.save();
    ctx.shadowColor = "rgba(255,200,70,.85)";
    ctx.shadowBlur = 38;
    ctx.drawImage(art.porchGold, ox, oy, w, h);
    ctx.restore();
    ctx.drawImage(art.porchGold, ox, oy, w, h);
    ctx.drawImage(art.porchInk, ox, oy, w, h);
    const [lx, ly, lw, lh] = PORCH_BATTERY_LIGHT;
    const pulse = 0.5 + 0.5 * Math.sin((wall / 700) * Math.PI * 2 - Math.PI / 2);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const cx = ox + (lx + lw / 2) * sc;
    const cy = oy + (ly + lh / 2) * sc;
    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, 46 * sc);
    rg.addColorStop(0, `rgba(255,214,90,${0.9 * pulse})`);
    rg.addColorStop(1, "rgba(255,214,90,0)");
    ctx.fillStyle = rg;
    ctx.fillRect(cx - 60 * sc, cy - 60 * sc, 120 * sc, 120 * sc);
    ctx.restore();
    const vg = ctx.createRadialGradient(VW / 2, VH / 2, VH * 0.35, VW / 2, VH / 2, VH * 0.95);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,.7)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, VW, VH);
    ctx.restore();

    const ca = seg(t, T.porchCaption, T.porchCaption + 300) * (1 - seg(t, 3500, T.dissolveStart));
    if (ca > 0) {
      ctx.save();
      ctx.globalAlpha = ca;
      const py = VH - 90 - safe.bottom;
      const pg = ctx.createLinearGradient(0, py - 130, 0, py + 70);
      pg.addColorStop(0, "rgba(0,0,0,0)");
      pg.addColorStop(1, "rgba(0,0,0,.6)");
      ctx.fillStyle = pg;
      ctx.fillRect(0, py - 130, VW, VH - py + 140);
      ctx.fillStyle = "#f0eeeb";
      ctx.font = "500 34px Geist, ui-sans-serif, system-ui, sans-serif";
      ctx.fillText("One home had a battery.", Math.max(88, safe.left), VH - 90 - safe.bottom + (1 - easeOutExpo(seg(t, T.porchCaption, T.porchCaption + 500))) * 10);
      ctx.restore();
    }
  }
}

/** canvas opacity during the dissolve into the live page */
export function canvasOpacity(t: number): number {
  return 1 - easeInOutCubic(seg(t, T.dissolveStart, T.dissolveEnd));
}

/** canvas blur (px) during the dissolve: the porch softens as the camera lifts off it */
export function canvasBlur(t: number): number {
  return 12 * easeInOutCubic(seg(t, T.dissolveStart, T.dissolveEnd));
}

/** the camera pushes through the porch as it dissolves: 1 -> 1.08 (never
 * shrinks, so no hard canvas edge ever shows over the page) */
export function canvasLift(t: number): number {
  return 1 + 0.08 * easeInOutCubic(seg(t, T.dissolveStart, T.dissolveEnd));
}
