// A tiny typed event bus between the intro reel (in the root layout) and the
// live page it plays over. The reel raises cues; the page (RankingBoard,
// BlockGroupMap) may answer them. When nothing listens, the reel still runs
// and the page is simply shown as it is.

import type { IntroCue } from "./introTimeline";

const EVENT = "zeus-intro";

export interface IntroCueDetail {
  cue: IntroCue;
  /** 0..1, for "wave" */
  progress?: number;
}

export function emitIntroCue(cue: IntroCue, progress?: number): void {
  window.dispatchEvent(new CustomEvent<IntroCueDetail>(EVENT, { detail: { cue, progress } }));
}

export function onIntroCue(handler: (detail: IntroCueDetail) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<IntroCueDetail>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

/** True while a reel is on screen (set by IntroReel), for listeners that mount late. */
export function introActive(): boolean {
  return document.documentElement.dataset.zeusIntro === "playing";
}

// ---- page -> reel: the live stage is loaded and settled -------------------

const READY_EVENT = "zeus-intro-stage-ready";

/** The live page calls this once its first-load state has settled. */
export function emitIntroStageReady(): void {
  document.documentElement.dataset.zeusStage = "ready";
  window.dispatchEvent(new Event(READY_EVENT));
}

/** Resolves when the live page reports ready (immediately if it already has). */
export function onIntroStageReady(handler: () => void): () => void {
  if (document.documentElement.dataset.zeusStage === "ready") {
    handler();
    return () => {};
  }
  const listener = () => handler();
  window.addEventListener(READY_EVENT, listener, { once: true });
  return () => window.removeEventListener(READY_EVENT, listener);
}
