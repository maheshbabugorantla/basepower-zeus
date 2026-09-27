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
      // provisional spot (the popover's own size is unknown until it shows);
      // it is never wider than 320 px (components.css), so clamp to that
      const maxWidth = 320;
      popoverEl.style.position = "fixed";
      popoverEl.style.top = `${rect.bottom + margin}px`;
      popoverEl.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - maxWidth - margin))}px`;
    }

    // Once open, measure the real box: keep it inside the viewport, and flip
    // it above its trigger when there is no room below (a figure near the
    // bottom or right edge otherwise renders a clipped or squeezed popover).
    function onToggle(event: Event) {
      const newState = (event as unknown as { newState?: string }).newState;
      if (newState !== "open" || !triggerEl || !popoverEl) return;
      const margin = 8;
      const t = triggerEl.getBoundingClientRect();
      const p = popoverEl.getBoundingClientRect();
      const left = Math.max(margin, Math.min(t.left, window.innerWidth - p.width - margin));
      const below = t.bottom + margin;
      const top = below + p.height > window.innerHeight - margin ? Math.max(margin, t.top - margin - p.height) : below;
      popoverEl.style.left = `${left}px`;
      popoverEl.style.top = `${top}px`;
    }

    popoverEl.addEventListener("beforetoggle", onBeforeToggle);
    popoverEl.addEventListener("toggle", onToggle);
    return () => {
      popoverEl.removeEventListener("beforetoggle", onBeforeToggle);
      popoverEl.removeEventListener("toggle", onToggle);
    };
  }, [triggerId, popoverId]);

  return null;
}
