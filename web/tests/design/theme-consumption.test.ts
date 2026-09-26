import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guard against regressing the dark-mode fix: any component that sits on
// a theme-aware surface (a panel, a table cell, the provenance popover)
// must read the semantic --theme-* variables, not a fixed --color-*
// value, or its text/borders go near-invisible in dark mode. Only
// self-contained components that own their own fixed background too
// (chip, its .chip__scope, buttons, badges, MissingState, the popover's
// copy button) are allowed to use the fixed tokens directly.

const ALLOWED_FIXED_INK_MUTED_CONTEXT = /\.chip__scope\s*\{[^}]*var\(--color-ink-muted\)/;

function componentsCssPath(): string {
  return fileURLToPath(new URL("../../styles/components.css", import.meta.url));
}

function uiDir(): string {
  return fileURLToPath(new URL("../../components/ui", import.meta.url));
}

describe("theme-aware surfaces don't leak fixed light-mode colors", () => {
  it("components.css only uses the fixed --color-ink-muted inside .chip__scope", () => {
    const css = readFileSync(componentsCssPath(), "utf8");
    // .chip__scope is the one component allowed to use the fixed token
    // directly (it sits on the chip's own fixed white background, not on
    // a theme-aware surface) — assert it's the *only* occurrence.
    const occurrences = css.split("var(--color-ink-muted)").length - 1;
    expect(occurrences, "var(--color-ink-muted) should appear exactly once in components.css").toBe(1);
    expect(ALLOWED_FIXED_INK_MUTED_CONTEXT.test(css)).toBe(true);
  });

  it("no web/components/ui/*.tsx file reads the fixed --color-ink-muted", () => {
    const dir = uiDir();
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".tsx")) continue;
      const text = readFileSync(join(dir, file), "utf8");
      expect(text.includes("var(--color-ink-muted)"), `${file} should use --theme-ink-muted, not the fixed --color-ink-muted`).toBe(false);
    }
  });

  it("Panel does not pin its background to the fixed light --color-surface / --component-panel-background-color", () => {
    const panel = readFileSync(join(uiDir(), "Panel.tsx"), "utf8");
    expect(panel.includes("var(--component-panel-background-color)")).toBe(false);
    expect(panel.includes("var(--theme-surface)")).toBe(true);
  });

  it("the provenance popover box and table borders use --theme-divider, not the fixed --color-divider", () => {
    const css = readFileSync(componentsCssPath(), "utf8");
    const popoverBlockMatch = css.match(/\[popover\]\.provenance-popover\s*\{[^}]*\}/);
    expect(popoverBlockMatch, "expected to find the .provenance-popover rule block").not.toBeNull();
    expect(popoverBlockMatch![0].includes("var(--theme-divider)")).toBe(true);
    expect(popoverBlockMatch![0].includes("var(--color-divider)")).toBe(false);

    const thBlockMatch = css.match(/\.data-table th\s*\{[^}]*\}/);
    expect(thBlockMatch, "expected to find the .data-table th rule block").not.toBeNull();
    expect(thBlockMatch![0].includes("var(--theme-divider)")).toBe(true);
    expect(thBlockMatch![0].includes("var(--theme-ink-muted)")).toBe(true);
  });
});
