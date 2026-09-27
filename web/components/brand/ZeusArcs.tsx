"use client";

import { useEffect, useRef } from "react";
import { ZEUS_BADGE, arcPath, burst, type Arc, type MarkGeometry } from "../../lib/zeusArcs";

// Live current off the Zeus mark's thunderbolt, drawn as SVG strokes in the
// mark's own viewBox and laid over it.
//
//   mode "hover": one strike on first load (once per browser session), then
//                 a crackle only while `active` (hover or keyboard focus).
//   mode "loop":  continuous crackle with a strike every ~3-4.5 s (hero, intro).
//
// Stops entirely under prefers-reduced-motion. The loop pauses while the mark
// is offscreen or the tab is hidden (requestAnimationFrame already stops in
// hidden tabs; IntersectionObserver covers offscreen).

export interface ZeusArcsProps {
  mode: "hover" | "loop";
  active?: boolean;
  /** stroke width multiplier: 1 for the top bar, ~2.5 for a hero */
  weight?: number;
  /** which cut of the badge the arcs sit on (icon cut in the top bar) */
  geometry?: MarkGeometry;
  /** increments to fire a strike on demand */
  strikeKey?: number;
}

const SESSION_KEY = "zeus-mark-struck";

export function ZeusArcs({ mode, active = false, weight = 1, strikeKey = 0, geometry = ZEUS_BADGE }: ZeusArcsProps) {
  const gRef = useRef<SVGGElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const state = useRef({
    arcs: [] as Arc[],
    raf: 0,
    nextFlicker: 0,
    nextStrike: 0,
    active,
    visible: true,
    reduce: false,
    lastStrikeKey: strikeKey,
  });

  // keep the latest `active` visible to the animation loop
  useEffect(() => {
    state.current.active = active;
    if (active) start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    const s = state.current;
    s.reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (s.reduce) return;

    if (mode === "hover") {
      let struck = false;
      try {
        struck = window.sessionStorage.getItem(SESSION_KEY) === "1";
        window.sessionStorage.setItem(SESSION_KEY, "1");
      } catch {
        // storage blocked: strike on every load, which is harmless
      }
      if (!struck) strike();
    } else {
      strike();
    }

    let io: IntersectionObserver | null = null;
    if (mode === "loop" && svgRef.current && "IntersectionObserver" in window) {
      io = new IntersectionObserver(([e]) => {
        s.visible = e.isIntersecting;
        if (s.visible) start();
      });
      io.observe(svgRef.current);
    }
    return () => {
      cancelAnimationFrame(s.raf);
      s.raf = 0;
      io?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    const s = state.current;
    if (strikeKey !== s.lastStrikeKey) {
      s.lastStrikeKey = strikeKey;
      if (!s.reduce) strike();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strikeKey]);

  function strike() {
    const s = state.current;
    s.arcs.push(...burst(geometry, "strike"));
    s.nextStrike = performance.now() + 3000 + Math.random() * 1500;
    svgRef.current?.parentElement?.classList.add("zeus-logo--striking");
    window.setTimeout(() => svgRef.current?.parentElement?.classList.remove("zeus-logo--striking"), 260);
    start();
  }

  function start() {
    const s = state.current;
    if (s.reduce || s.raf) return;
    s.raf = requestAnimationFrame(frame);
  }

  function frame(now: number) {
    const s = state.current;
    const crackling = mode === "loop" ? s.visible : s.active;
    if (crackling && now > s.nextFlicker) {
      s.arcs.push(...burst(geometry, "flicker"));
      s.nextFlicker = now + 60 + Math.random() * 60;
    }
    if (mode === "loop" && s.visible && now > s.nextStrike) strike();

    for (const a of s.arcs) a.life -= 1;
    s.arcs = s.arcs.filter((a) => a.life > 0);
    draw();

    if (s.arcs.length > 0 || crackling) {
      s.raf = requestAnimationFrame(frame);
    } else {
      s.raf = 0;
    }
  }

  function draw() {
    const g = gRef.current;
    if (!g) return;
    const s = state.current;
    let html = "";
    for (const a of s.arcs) {
      const f = Math.max(0, a.life / a.max);
      const d = arcPath(a.pts);
      html +=
        `<path d="${d}" class="zeus-arcs__glow" style="opacity:${(0.45 * f).toFixed(3)};stroke-width:${(4.5 * a.width * weight).toFixed(2)}px"/>` +
        `<path d="${d}" class="zeus-arcs__core" style="opacity:${f.toFixed(3)};stroke-width:${(1.1 * a.width * weight).toFixed(2)}px"/>`;
    }
    g.innerHTML = html;
  }

  return (
    <svg
      ref={svgRef}
      className="zeus-arcs"
      viewBox={`0 0 ${geometry.w} ${geometry.h}`}
      aria-hidden="true"
      focusable="false"
    >
      <g ref={gRef} />
    </svg>
  );
}
