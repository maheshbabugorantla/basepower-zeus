"use client";

import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { decideIntro, readIntroFlag, writeIntroFlag } from "../../lib/introFlag";
import { releaseIntroCover } from "../../lib/introBootScript";

// Mounted once in the root layout. On a first visit (see introFlag.ts) it
// loads the reel lazily and sends the visitor to the ranking screen under it;
// every other visit it renders nothing and loads nothing. Server render: null.

const IntroReel = dynamic(() => import("./IntroReel"), { ssr: false });

export interface IntroGateProps {
  /** where the reel lands */
  landing?: string;
  /** move to `landing` under the reel (off for the dev preview harness) */
  navigate?: boolean;
  /** play regardless of the stored flag (dev preview harness); reduced motion still wins */
  force?: boolean;
}

export function IntroGate({ landing = "/ranking", navigate = true, force = false }: IntroGateProps) {
  const [playing, setPlaying] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const decision = decideIntro({
      search: force ? "?intro" : window.location.search,
      stored: readIntroFlag(),
      reducedMotion,
    });
    if (!decision.play) {
      releaseIntroCover();
      return;
    }
    writeIntroFlag();
    document.documentElement.dataset.zeusIntro = "playing";
    setPlaying(true);
    // Land on the ranking screen while the reel's opening scenes cover the
    // page, so the live page is loaded and settled before the reel reveals it.
    // Replacing (not pushing) also drops ?intro, so a reload does not replay.
    if (navigate && (window.location.pathname !== landing || window.location.search !== "")) {
      router.replace(landing);
    }
    // decided once per page load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function finish() {
    delete document.documentElement.dataset.zeusIntro;
    releaseIntroCover();
    setPlaying(false);
    if (navigate && window.location.pathname !== landing) router.replace(landing);
    document.getElementById("main")?.focus({ preventScroll: true });
  }

  if (!playing) return null;
  return <IntroReel onDone={finish} pathname={pathname} />;
}
