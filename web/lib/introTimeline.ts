// The intro reel's timeline, in milliseconds from the first frame.
//
// Scenes 1-2 are drawn on the reel's canvas (the engraved street and porch).
// From the dissolve on, the reel is the live /ranking page underneath: the
// reel only raises cues on the intro bus (introBus.ts) that the page answers,
// plus its own small overlays (the funnel counter, captions, the sting).

export const T = {
  streetIn: 0,
  stormStart: 250,
  strike: 960,
  windowsOut: 1080,
  streetOut: 2300,
  porchIn: 2300,
  porchCaption: 2700,
  dissolveStart: 3700,
  dissolveEnd: 4600,
  funnelIn: 4300,
  funnelOut: 6100,
  waveStart: 4300,
  waveEnd: 6000,
  glideStart: 6100,
  glideEnd: 7300,
  provenanceOpen: 7500,
  provenanceClose: 8600,
  stingIn: 8800,
  restore: 9000,
  stingOut: 9700,
  end: 10300,
} as const;

export const REEL_MS = T.end;

/** longest the reel will hold on the porch waiting for the live page to settle */
export const MAX_STAGE_WAIT_MS = 5000;

/** fraction 0..1 of t between a and b */
export function seg(t: number, a: number, b: number): number {
  if (b <= a) return t >= b ? 1 : 0;
  return Math.min(1, Math.max(0, (t - a) / (b - a)));
}

/** exponential ease-out (DESIGN.md: ease-out, no bounce) */
export function easeOutExpo(x: number): number {
  return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x);
}

export function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export type IntroCue =
  | "live" // the canvas has started dissolving; the live page is the stage from here
  | "wave" // payload: progress 0..1 of the priority wavefront
  | "glide" // camera glide to rank 1, rail slides in, rank 1 expands
  | "provenance-open"
  | "provenance-close"
  | "restore"; // return the page to its normal first-load state, behind the sting

/** Discrete cues the reel raises once each, in order. */
export const CUES: ReadonlyArray<{ at: number; cue: Exclude<IntroCue, "wave"> }> = [
  { at: T.dissolveStart, cue: "live" },
  { at: T.glideStart, cue: "glide" },
  { at: T.provenanceOpen, cue: "provenance-open" },
  { at: T.provenanceClose, cue: "provenance-close" },
  { at: T.restore, cue: "restore" },
];

/** Cues whose time has passed between two frames (prev exclusive, now inclusive). */
export function cuesBetween(prev: number, now: number): Array<Exclude<IntroCue, "wave">> {
  return CUES.filter((c) => c.at > prev && c.at <= now).map((c) => c.cue);
}
