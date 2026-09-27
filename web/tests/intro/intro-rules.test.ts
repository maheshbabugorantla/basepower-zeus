import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { decideIntro, INTRO_STORAGE_KEY } from "../../lib/introFlag";
import { INTRO_BOOT_SCRIPT, INTRO_PENDING_CLASS } from "../../lib/introBootScript";
import { CUES, REEL_MS, T, cuesBetween, seg } from "../../lib/introTimeline";

describe("decideIntro", () => {
  const base = { search: "", stored: null as string | null | undefined, reducedMotion: false };
  it("plays on a first visit", () => {
    expect(decideIntro(base)).toEqual({ play: true, reason: "first-visit" });
  });
  it("does not replay once seen", () => {
    expect(decideIntro({ ...base, stored: "1" }).play).toBe(false);
  });
  it("?intro=0 bypasses everything", () => {
    expect(decideIntro({ ...base, search: "?intro=0" })).toEqual({ play: false, reason: "bypass" });
    expect(decideIntro({ ...base, search: "intro=0", stored: null }).play).toBe(false);
  });
  it("?intro replays even after a visit", () => {
    expect(decideIntro({ ...base, search: "?intro", stored: "1" })).toEqual({ play: true, reason: "replay" });
    expect(decideIntro({ ...base, search: "?county=48453&intro=1", stored: "1" }).play).toBe(true);
  });
  it("reduced motion never plays, not even on ?intro", () => {
    expect(decideIntro({ ...base, reducedMotion: true }).play).toBe(false);
    expect(decideIntro({ ...base, search: "?intro", reducedMotion: true }).play).toBe(false);
  });
  it("blocked storage does not play (it could not remember having played)", () => {
    expect(decideIntro({ ...base, stored: undefined })).toEqual({ play: false, reason: "storage-blocked" });
  });
});

/** Run the inline boot script against a minimal browser-shaped sandbox. */
function runBoot(opts: { search: string; stored: string | null | "throw"; reduced: boolean }) {
  const classes = new Set<string>();
  const appended: unknown[] = [];
  const sandbox = {
    URLSearchParams,
    window: {
      location: { search: opts.search },
      matchMedia: () => ({ matches: opts.reduced }),
      localStorage: {
        getItem: (k: string) => {
          if (opts.stored === "throw") throw new Error("blocked");
          return k === INTRO_STORAGE_KEY ? opts.stored : null;
        },
      },
      setTimeout: () => 0,
    },
    document: {
      documentElement: { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } },
      createElement: () => ({}),
      head: { appendChild: (n: unknown) => appended.push(n) },
    },
  };
  vm.runInNewContext(INTRO_BOOT_SCRIPT, sandbox);
  return classes.has(INTRO_PENDING_CLASS);
}

describe("INTRO_BOOT_SCRIPT agrees with decideIntro", () => {
  const cases: Array<{ search: string; stored: string | null | "throw"; reduced: boolean }> = [
    { search: "", stored: null, reduced: false },
    { search: "", stored: "1", reduced: false },
    { search: "?intro=0", stored: null, reduced: false },
    { search: "?intro", stored: "1", reduced: false },
    { search: "", stored: null, reduced: true },
    { search: "", stored: "throw", reduced: false },
  ];
  for (const c of cases) {
    it(`covers the page only when the reel will play (${JSON.stringify(c)})`, () => {
      const expected = decideIntro({
        search: c.search,
        stored: c.stored === "throw" ? undefined : c.stored,
        reducedMotion: c.reduced,
      }).play;
      expect(runBoot(c)).toBe(expected);
    });
  }
});

describe("timeline", () => {
  it("raises every cue exactly once across a full play, in order", () => {
    const seen: string[] = [];
    let prev = -1;
    for (let t = 0; t <= REEL_MS; t += 16) {
      seen.push(...cuesBetween(prev, t));
      prev = t;
    }
    expect(seen).toEqual(CUES.map((c) => c.cue));
  });
  it("keeps the scenes in order and inside the reel", () => {
    expect(T.streetOut).toBeLessThanOrEqual(T.porchIn);
    expect(T.dissolveStart).toBeLessThan(T.dissolveEnd);
    expect(T.funnelIn).toBeGreaterThanOrEqual(T.dissolveStart);
    expect(T.glideStart).toBeGreaterThanOrEqual(T.funnelOut);
    expect(T.provenanceClose).toBeLessThan(T.stingIn);
    expect(T.restore).toBeGreaterThan(T.stingIn); // the page resets behind the sting, never in view
    expect(REEL_MS).toBeLessThanOrEqual(12000);
  });
  it("seg clamps to 0..1", () => {
    expect(seg(-5, 0, 10)).toBe(0);
    expect(seg(5, 0, 10)).toBe(0.5);
    expect(seg(50, 0, 10)).toBe(1);
  });
});
