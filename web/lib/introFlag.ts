// Whether the first-visit intro reel plays. Pure, so the rules are testable
// and the inline boot script (introBootScript.ts) can be checked against them.
//
//   ?intro=0          never plays, never redirects (verification scripts)
//   reduced motion    never plays
//   ?intro (any other value, or bare)   replays
//   first visit       plays once; the flag is written when the reel starts
//   storage blocked   does not play (it could not remember it had played,
//                     so it would replay on every page load)

export const INTRO_STORAGE_KEY = "zeus-intro-seen";

export type IntroReason = "bypass" | "reduced-motion" | "replay" | "seen" | "storage-blocked" | "first-visit";

export interface IntroInputs {
  /** location.search, with or without the leading "?" */
  search: string;
  /** the stored flag: "1" when seen, null when never set, undefined when storage threw */
  stored: string | null | undefined;
  reducedMotion: boolean;
}

export interface IntroDecision {
  play: boolean;
  reason: IntroReason;
}

export function decideIntro({ search, stored, reducedMotion }: IntroInputs): IntroDecision {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const intro = params.get("intro");
  if (intro === "0") return { play: false, reason: "bypass" };
  if (reducedMotion) return { play: false, reason: "reduced-motion" };
  if (intro !== null) return { play: true, reason: "replay" };
  if (stored === undefined) return { play: false, reason: "storage-blocked" };
  if (stored === "1") return { play: false, reason: "seen" };
  return { play: true, reason: "first-visit" };
}

/** Read the stored flag without throwing. */
export function readIntroFlag(): string | null | undefined {
  try {
    return window.localStorage.getItem(INTRO_STORAGE_KEY);
  } catch {
    return undefined;
  }
}

export function writeIntroFlag(): void {
  try {
    window.localStorage.setItem(INTRO_STORAGE_KEY, "1");
  } catch {
    // storage blocked: decideIntro already refuses to play in that case
  }
}
