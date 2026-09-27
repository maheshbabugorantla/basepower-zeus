import type { CSSProperties } from "react";
import { ZEUS_BADGE } from "../../lib/zeusArcs";

// The Zeus brand mark: an engraved fist gripping a gold thunderbolt inside a
// sunburst roundel over transmission towers. Two stacked layers (ink, bolt)
// are CSS masks over static SVGs in /public/brand, so the mark is cached,
// adds nothing to page HTML, and takes its colors from theme tokens
// (--theme-brand-mark-ink / --theme-brand-mark-bolt). Server-safe: it renders
// fully without JavaScript; ZeusArcs only adds motion on top.
//
// Two tiers share one viewBox: "sm" (simplified trace, ~35 KB) for anything up
// to 96 px tall, "full" (every engraved line, ~800 KB) for hero use only.

export interface ZeusMarkProps {
  /** rendered height in px; width follows the badge's aspect ratio */
  height: number;
  tier?: "sm" | "full";
  className?: string;
  style?: CSSProperties;
}

export function ZeusMark({ height, tier, className, style }: ZeusMarkProps) {
  const t = tier ?? (height <= 96 ? "sm" : "full");
  const width = Math.round((height * ZEUS_BADGE.w) / ZEUS_BADGE.h);
  return (
    <span
      aria-hidden="true"
      className={["zeus-mark", className].filter(Boolean).join(" ")}
      style={{ width, height, ...style }}
    >
      <span className="zeus-mark__layer zeus-mark__ink" style={{ ["--zeus-layer" as string]: `url(/brand/zeus-badge-ink-${t}.svg)` }} />
      <span className="zeus-mark__layer zeus-mark__bolt" style={{ ["--zeus-layer" as string]: `url(/brand/zeus-badge-bolt-${t}.svg)` }} />
    </span>
  );
}
