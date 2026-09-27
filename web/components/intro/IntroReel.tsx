"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./IntroReel.module.css";
import { ZeusLogo } from "../brand/ZeusLogo";
import { INTRO_ASSETS } from "../../lib/introArt";
import { releaseIntroCover } from "../../lib/introBootScript";
import { emitIntroCue, onIntroStageReady } from "../../lib/introBus";
import { countedStages, formatCount, stormPhrases, type IntroFacts } from "../../lib/introFacts";
import { MAX_STAGE_WAIT_MS, REEL_MS, T, cuesBetween, easeOutExpo, seg } from "../../lib/introTimeline";
import { VH, VW, canvasBlur, canvasLift, canvasOpacity, drawStreetScenes, tint, type SceneArt } from "./streetScenes";

// The first-visit intro reel (A, with B's funnel and source popover and C's
// badge sting). Scenes 1-2 are drawn here; from the dissolve on, the stage is
// the live ranking page underneath, which answers cues raised on introBus.
// Every figure comes from /api/intro-facts at run time.

export interface IntroReelProps {
  onDone: (reason: "finished" | "skipped" | "error") => void;
  /** current route, so the reel can notice the landing page has taken over */
  pathname: string | null;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`intro asset failed: ${src}`));
    img.src = src;
  });
}

async function loadArt(): Promise<SceneArt> {
  const [streetInk, streetGold, porchInk, porchGold] = await Promise.all([
    loadImage(INTRO_ASSETS.streetInk),
    loadImage(INTRO_ASSETS.streetGold),
    loadImage(INTRO_ASSETS.porchInk),
    loadImage(INTRO_ASSETS.porchGold),
  ]);
  return {
    streetDay: tint(streetInk, "#1e3a25"),
    streetNight: tint(streetInk, "#cfc9b8"),
    streetGold: tint(streetGold, "#f7c33c"),
    porchInk: tint(porchInk, "#0b0f13"),
    porchGold: tint(porchGold, "#ffcf4a"),
  };
}

async function loadFacts(): Promise<IntroFacts | null> {
  try {
    const r = await fetch("/api/intro-facts", { cache: "no-store" });
    return r.ok ? ((await r.json()) as IntroFacts) : null;
  } catch {
    return null;
  }
}

export default function IntroReel({ onDone }: IntroReelProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const funnelRef = useRef<HTMLDivElement | null>(null);
  const countRef = useRef<HTMLSpanElement | null>(null);
  const captionRef = useRef<HTMLParagraphElement | null>(null);
  const stingRef = useRef<HTMLDivElement | null>(null);
  const skipRef = useRef<HTMLButtonElement | null>(null);
  const [facts, setFacts] = useState<IntroFacts | null>(null);
  const [stingOn, setStingOn] = useState(false);
  const [captionText, setCaptionText] = useState("");
  const done = useRef(false);
  const finishRef = useRef<(reason: "finished" | "skipped" | "error") => void>(() => {});
  const stingOnRef = useRef(false);

  const stages = facts ? countedStages(facts.funnel) : [];

  useEffect(() => {
    skipRef.current?.focus({ preventScroll: true });
    let raf = 0;
    let cancelled = false;
    let art: SceneArt | null = null;
    let lines: string[] = [];
    let sub: string | null = null;
    let factsLocal: IntroFacts | null = null;
    let stageReady = false;
    let t = 0;
    let held = 0;
    let last = 0;
    let wall = 0;
    let painted = false;
    let caption = "";
    const stopReady = onIntroStageReady(() => {
      stageReady = true;
    });

    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    function size() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
    }
    size();
    window.addEventListener("resize", size);

    function setCaption(next: string) {
      if (next !== caption) {
        caption = next;
        setCaptionText(next);
      }
    }

    function frame(now: number) {
      if (cancelled) return;
      const dt = last ? Math.min(64, now - last) : 0;
      last = now;
      if (!document.hidden) {
        wall += dt;
        const prev = t;
        // hold on the porch until the live page reports ready (bounded)
        const wantsToCross = t + dt >= T.dissolveStart && prev < T.dissolveStart;
        if (wantsToCross && !stageReady && held < MAX_STAGE_WAIT_MS) {
          held += dt;
          t = T.dissolveStart - 1;
        } else {
          t += dt;
        }
        for (const cue of cuesBetween(prev, t)) emitIntroCue(cue);
        if (t >= T.waveStart && t <= T.waveEnd + 50) emitIntroCue("wave", seg(t, T.waveStart, T.waveEnd));
        render(t);
      }
      if (t >= REEL_MS) {
        finish("finished");
        return;
      }
      raf = requestAnimationFrame(frame);
    }

    function render(time: number) {
      const W = canvas.width;
      const H = canvas.height;
      // cover-fit the 1600x900 design space onto the viewport
      const k = Math.max(W / VW, H / VH);
      if (time < T.dissolveEnd && art) {
        ctx.setTransform(k, 0, 0, k, (W - VW * k) / 2, (H - VH * k) / 2);
        drawStreetScenes(ctx, art, time, lines, sub, wall);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (!painted) {
          painted = true;
          rootRef.current?.setAttribute("data-painted", "true");
          releaseIntroCover();
        }
      } else if (time >= T.dissolveEnd) {
        ctx.clearRect(0, 0, W, H);
      }
      canvas.style.opacity = String(canvasOpacity(time));
      const blur = canvasBlur(time);
      canvas.style.filter = blur > 0.05 ? `blur(${blur.toFixed(1)}px)` : "none";
      canvas.style.transform = `scale(${canvasLift(time).toFixed(4)})`;

      // funnel counter over the live map
      const f = funnelRef.current;
      if (f && factsLocal) {
        const st = countedStages(factsLocal.funnel);
        const inA = easeOutExpo(seg(time, T.funnelIn, T.funnelIn + 350));
        const outA = 1 - seg(time, T.funnelOut - 300, T.funnelOut);
        f.style.opacity = st.length ? String(inA * outA) : "0";
        f.style.transform = `translateY(calc(-50% + ${((1 - inA) * 12).toFixed(1)}px))`;
        if (st.length) {
          const span = (T.funnelOut - 500 - T.funnelIn) / Math.max(1, st.length);
          const pos = Math.max(0, (time - T.funnelIn) / span);
          const idx = Math.min(st.length - 1, Math.floor(pos));
          const from = idx > 0 ? st[idx - 1].count : st[0].count;
          const to = st[idx].count;
          const k2 = easeOutExpo(Math.min(1, (pos - idx) * 1.6));
          if (countRef.current) countRef.current.textContent = formatCount(from + (to - from) * k2);
          f.querySelectorAll<HTMLElement>("[data-rung]").forEach((el, i) => {
            el.dataset.active = String(i === idx);
            const fill = el.querySelector<HTMLElement>("[data-fill]");
            if (fill) {
              const grow = easeOutExpo(Math.min(1, Math.max(0, (pos - i) * 1.6)));
              fill.style.transform = `scaleX(${((st[i].count / st[0].count) * grow).toFixed(4)})`;
            }
          });
        }
      }

      // captions over the live page
      const cap = captionRef.current;
      if (cap) {
        let a = 0;
        if (time >= T.glideStart && time < T.provenanceOpen - 100) {
          setCaption("Ranked by how likely each home is to add backup, with the reason on the row.");
          a = seg(time, T.glideStart + 200, T.glideStart + 500) * (1 - seg(time, T.provenanceOpen - 400, T.provenanceOpen - 100));
        } else if (time >= T.provenanceOpen && time < T.stingIn) {
          setCaption("Every number opens the file it came from.");
          a = seg(time, T.provenanceOpen + 100, T.provenanceOpen + 400) * (1 - seg(time, T.stingIn - 300, T.stingIn));
        }
        cap.style.opacity = String(a);
      }

      // the sting
      const sting = stingRef.current;
      if (sting) {
        if (time >= T.stingIn - 50 && !stingOnRef.current) {
          stingOnRef.current = true;
          setStingOn(true);
        }
        const a = easeOutExpo(seg(time, T.stingIn, T.stingIn + 300)) * (1 - seg(time, T.stingOut, T.end));
        sting.style.opacity = String(a);
      }
    }

    function finish(reason: "finished" | "skipped" | "error") {
      if (done.current) return;
      done.current = true;
      cancelled = true;
      cancelAnimationFrame(raf);
      if (reason !== "finished") emitIntroCue("restore");
      onDone(reason);
    }
    finishRef.current = finish;

    Promise.all([loadArt(), loadFacts(), document.fonts?.ready ?? Promise.resolve()])
      .then(([a, fcts]) => {
        if (cancelled) return;
        art = a;
        factsLocal = fcts;
        setFacts(fcts);
        lines = stormPhrases(fcts?.storm ?? null);
        sub = lines.length && fcts?.storm ? `${fcts.storm.countyName} County's longest outage since 2024 · EAGLE-I` : null;
        raf = requestAnimationFrame(frame);
      })
      .catch(() => finish("error"));

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        finish("skipped");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stopReady();
      window.removeEventListener("resize", size);
      window.removeEventListener("keydown", onKey);
    };
    // runs once for the life of the reel
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={rootRef}
      className={styles.reel}
      role="dialog"
      aria-modal="true"
      aria-label="Base Power Zeus introduction"
      onPointerDown={(e) => {
        if (e.target === skipRef.current) return;
        finishRef.current("skipped");
      }}
    >
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />

      <div ref={funnelRef} className={styles.funnel} aria-hidden="true">
        <span ref={countRef} className={styles.funnelCount}>
          {stages.length ? formatCount(stages[0].count) : ""}
        </span>
        <span className={styles.funnelUnit}>
          {facts ? `${facts.countyName} County homes, narrowed to the ones Base can serve` : ""}
        </span>
        <ol className={styles.ladder}>
          {stages.map((s, i) => (
            <li key={s.key} className={styles.rung} data-rung="" data-active={i === 0 ? "true" : "false"} data-last={i === stages.length - 1 ? "true" : "false"}>
              <span>{s.label}</span>
              <span>{formatCount(s.count)}</span>
              <span className={styles.rungBar}>
                <span className={styles.rungFill} data-fill="" />
              </span>
            </li>
          ))}
        </ol>
        <p className={styles.funnelSource}>Appraisal rolls, utility service areas and EIA-861 · as on the Overview</p>
      </div>

      <p ref={captionRef} className={styles.caption} aria-live="polite">
        {captionText}
      </p>

      <div ref={stingRef} className={styles.sting} aria-hidden={!stingOn}>
        {stingOn ? <ZeusLogo size="lg" motion="loop" /> : null}
        <p className={styles.tagline}>Know which door to knock next.</p>
      </div>

      <button
        ref={skipRef}
        type="button"
        className={styles.skip}
        onClick={(e) => {
          e.stopPropagation();
          finishRef.current("skipped");
        }}
      >
        Skip intro
      </button>
    </div>
  );
}
