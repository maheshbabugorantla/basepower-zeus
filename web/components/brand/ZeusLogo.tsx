"use client";

import Link from "next/link";
import { useState } from "react";
import { ZeusMark } from "./ZeusMark";
import { ZeusArcs } from "./ZeusArcs";
import { ZEUS_BADGE, ZEUS_BADGE_ICON } from "../../lib/zeusArcs";

// The Zeus lockup: the transmission-badge mark plus ZEUS set in Cinzel.
// The accessible name is the product name, "Base Power Zeus".
//
//   size "sm": top bar (32 px mark). Strikes once per session, crackles on
//              hover or keyboard focus.
//   size "lg": hero / intro sting (full-detail mark), continuous current.

const SIZES = {
  // top bar: grows with the window (36 px at 1440 wide, ~42 at 2000, 56 at 3000+)
  sm: { mark: "clamp(36px, 1.4vw + 14px, 56px)", word: "clamp(20px, 0.7vw + 10px, 30px)", gap: "clamp(8px, 0.4vw, 12px)", weight: 1.15 },
  md: { mark: 64, word: 34, gap: 12, weight: 1.4 },
  lg: { mark: 220, word: 96, gap: 28, weight: 1.8 },
} as const;

export interface ZeusLogoProps {
  size?: keyof typeof SIZES;
  /** wrap the lockup in a link (the top bar links home) */
  href?: string;
  motion?: "hover" | "loop" | "none";
  strikeKey?: number;
}

export function ZeusLogo({ size = "sm", href, motion = size === "lg" ? "loop" : "hover", strikeKey }: ZeusLogoProps) {
  const [active, setActive] = useState(false);
  const s = SIZES[size];
  const body = (
    <>
      <span className="zeus-logo__markwrap" style={{ height: s.mark }}>
        <ZeusMark height={s.mark} tier={size === "lg" ? "full" : "icon"} />
        {motion !== "none" ? (
          <ZeusArcs
            mode={motion}
            active={active}
            weight={s.weight}
            strikeKey={strikeKey}
            geometry={size === "lg" ? ZEUS_BADGE : ZEUS_BADGE_ICON}
          />
        ) : null}
      </span>
      <span className="zeus-logo__word" style={{ fontSize: s.word }}>
        ZEUS
      </span>
    </>
  );
  const common = {
    className: `zeus-logo zeus-logo--${size}`,
    style: { gap: s.gap },
    "aria-label": "Base Power Zeus",
    onPointerEnter: () => setActive(true),
    onPointerLeave: () => setActive(false),
    onFocus: () => setActive(true),
    onBlur: () => setActive(false),
  };
  return href ? (
    <Link href={href} {...common}>
      {body}
    </Link>
  ) : (
    <span role="img" {...common}>
      {body}
    </span>
  );
}
