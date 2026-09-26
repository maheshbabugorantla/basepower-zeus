"use client";

import { useEffect } from "react";

// Positions the native-popover-API popover next to its trigger. The
// `popover` attribute already puts the element in the top layer, so it is
// never clipped by a scroll/overflow container by construction — this
// island only computes *where* to place it, listening to the standard
// `beforetoggle` event the browser fires on a popover element BEFORE it
// becomes visible (unlike `toggle`, which fires after — using it would
// show the popover in the wrong place for one frame).

export function ProvenancePopoverAnchor({
  triggerId,
  popoverId,
}: {
  triggerId: string;
  popoverId: string;
}) {
  useEffect(() => {
    const popoverEl: HTMLElement | null = document.getElementById(popoverId);
    const triggerEl: HTMLElement | null = document.getElementById(triggerId);
    if (!popoverEl || !triggerEl) return;

    function onBeforeToggle(event: Event) {
      // ToggleEvent isn't in every TS DOM lib version yet; read newState defensively.
      const newState = (event as unknown as { newState?: string }).newState;
      if (newState !== "open") return;
      if (!triggerEl || !popoverEl) return;

      const rect = triggerEl.getBoundingClientRect();
      const margin = 8;
      popoverEl.style.position = "fixed";
      popoverEl.style.top = `${rect.bottom + margin}px`;
      popoverEl.style.left = `${Math.max(margin, rect.left)}px`;
    }

    popoverEl.addEventListener("beforetoggle", onBeforeToggle);
    return () => popoverEl.removeEventListener("beforetoggle", onBeforeToggle);
  }, [triggerId, popoverId]);

  return null;
}
