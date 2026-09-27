// Inline <head> script for the root layout. It runs before first paint and,
// when the reel will play, covers the page with the reel's night ground so
// the visitor never sees a flash of the page the reel is about to cover.
// The cover is removed by IntroReel once its first frame is on screen, or by
// the script's own safety timer if the reel's code never arrives, so the page
// can never be trapped behind it.
//
// It must implement exactly the rules in introFlag.ts (tested against them in
// tests/intro/intro-boot-script.test.ts). It carries no data, only the rules.

import { INTRO_STORAGE_KEY } from "./introFlag";

export const INTRO_PENDING_CLASS = "zeus-intro-pending";
export const INTRO_COVER_ID = "zeus-intro-cover";
/** the reel's ground colour, the same night tone the canvas paints first */
export const INTRO_COVER_COLOR = "#121110";
/** remove the cover if the reel has not taken over by then */
export const INTRO_COVER_TIMEOUT_MS = 6000;

export const INTRO_BOOT_SCRIPT = `(function () {
  try {
    var params = new URLSearchParams(window.location.search);
    var intro = params.get("intro");
    if (intro === "0") return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (intro === null) {
      var stored;
      try { stored = window.localStorage.getItem(${JSON.stringify(INTRO_STORAGE_KEY)}); } catch (e) { return; }
      if (stored === "1") return;
    }
    var root = document.documentElement;
    root.classList.add(${JSON.stringify(INTRO_PENDING_CLASS)});
    var style = document.createElement("style");
    style.id = ${JSON.stringify(INTRO_COVER_ID)};
    style.textContent = "html.${INTRO_PENDING_CLASS}::after{content:'';position:fixed;inset:0;z-index:300;background:${INTRO_COVER_COLOR}}";
    document.head.appendChild(style);
    window.setTimeout(function () {
      root.classList.remove(${JSON.stringify(INTRO_PENDING_CLASS)});
    }, ${INTRO_COVER_TIMEOUT_MS});
  } catch (e) {}
})();`;

/** Called by the reel once its first frame is painted (and on every exit path). */
export function releaseIntroCover(): void {
  document.documentElement.classList.remove(INTRO_PENDING_CLASS);
}
