import type { CSSProperties } from "react";
import { ZEUS_BADGE, ZEUS_BADGE_ICON } from "../../lib/zeusArcs";

// The Zeus brand mark: an engraved fist gripping a gold thunderbolt inside a
// sunburst roundel over transmission towers. Two stacked layers (ink, bolt)
// are CSS masks over static SVGs in /public/brand, so the mark is cached,
// adds nothing to page HTML, and takes its colors from theme tokens
// (--theme-brand-mark-ink / --theme-brand-mark-bolt). Server-safe: it renders
// fully without JavaScript; ZeusArcs only adds motion on top.
//
// Tiers: "icon" is a separately drawn bold cut of the same badge (heavy lines,
// ~26 KB gzipped) so the fist stays crisp in the top bar at 32-64 px; "full"
// (every engraved line, ~800 KB) is for hero and intro use; "sm" is a
// simplified trace of the full engraving kept for mid sizes. The icon cut has
// its own viewBox, so pair it with ZEUS_BADGE_ICON geometry for the arcs.

export interface ZeusMarkProps {
  /** rendered height: px number, or any CSS length (e.g. a clamp()); width
   * follows the badge's aspect ratio */
  height: number | string;
  tier?: "icon" | "sm" | "full";
  className?: string;
  style?: CSSProperties;
}

export function ZeusMark({ height, tier, className, style }: ZeusMarkProps) {
  const t = tier ?? (typeof height === "number" && height > 96 ? "full" : "icon");
  const g = t === "icon" ? ZEUS_BADGE_ICON : ZEUS_BADGE;
  return (
    <span
      aria-hidden="true"
      className={["zeus-mark", className].filter(Boolean).join(" ")}
      style={{ height, aspectRatio: `${g.w} / ${g.h}`, ...style }}
    >
      <span className="zeus-mark__layer zeus-mark__ink" style={{ ["--zeus-layer" as string]: `url(/brand/zeus-badge-ink-${t}.svg)` }} />
      <span className="zeus-mark__layer zeus-mark__bolt" style={{ ["--zeus-layer" as string]: `url(/brand/zeus-badge-bolt-${t}.svg)` }} />
    </span>
  );
}
