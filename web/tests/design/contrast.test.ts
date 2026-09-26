import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// WCAG 2.2 contrast check for ink/ink-muted on canvas/surface, in both
// themes. Computed from the *effective* values in tokens.css after
// resolving var() references, separately for the light block (:root) and
// the dark block (:root[data-theme="dark"]) — not read directly from
// DESIGN.md's dark-* keys, so a mis-wired dark reassignment in tokens.css
// would actually fail this test.

function tokensCssText(): string {
  return readFileSync(fileURLToPath(new URL("../../styles/tokens.css", import.meta.url)), "utf8");
}

function parseCssVars(cssText: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /--([a-z0-9-]+):\s*([^;]+);/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cssText)) !== null) out.set(m[1], m[2].trim());
  return out;
}

/** Resolve `var(--x)` chains against a flat variable map, to a literal value. */
function resolveVar(value: string, vars: Map<string, string>, depth = 0): string {
  if (depth > 10) throw new Error(`var() resolution too deep for "${value}"`);
  const m = value.trim().match(/^var\(--([a-z0-9-]+)\)$/i);
  if (!m) return value.trim();
  const next = vars.get(m[1]);
  if (next === undefined) throw new Error(`Unresolved var(--${m[1]})`);
  return resolveVar(next, vars, depth + 1);
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return [r, g, b];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const srgb = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

function contrastRatio(hexA: string, hexB: string): number {
  const lA = relativeLuminance(hexToRgb(hexA));
  const lB = relativeLuminance(hexToRgb(hexB));
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

// Extract just the declarations inside a specific block, given a selector
// regex marking its opening `{`. Assumes tokens.css has no nested braces
// inside a block other than the outer pair (true for this file).
function extractBlock(cssText: string, openSelectorRe: RegExp): string {
  const m = openSelectorRe.exec(cssText);
  if (!m) throw new Error(`Selector not found: ${openSelectorRe}`);
  const start = m.index + m[0].length;
  const end = cssText.indexOf("}", start);
  return cssText.slice(start, end);
}

describe("WCAG AA contrast (computed from tokens.css, not DESIGN.md directly)", () => {
  const cssText = tokensCssText();

  const rootVars = parseCssVars(extractBlock(cssText, /:root\s*\{/));
  const darkOverrideVars = parseCssVars(
    extractBlock(cssText, /:root\[data-theme=["']dark["']\]\s*\{/)
  );

  // Light theme: dark overrides are absent, so semantic vars resolve
  // straight through the :root block.
  const lightVars = rootVars;
  // Dark theme: the explicit override block reassigns the semantic vars;
  // merge it over the base :root block the way the cascade would.
  const darkVars = new Map([...rootVars, ...darkOverrideVars]);

  function resolvedHex(themeVars: Map<string, string>, name: string): string {
    const raw = themeVars.get(name);
    if (raw === undefined) throw new Error(`--${name} not found`);
    return resolveVar(raw, themeVars);
  }

  const pairs: Array<[string, string, string]> = [
    ["theme-ink", "theme-canvas", "ink on canvas"],
    ["theme-ink", "theme-surface", "ink on surface"],
    ["theme-ink-muted", "theme-canvas", "ink-muted on canvas"],
    ["theme-ink-muted", "theme-surface", "ink-muted on surface"],
  ];

  for (const theme of ["light", "dark"] as const) {
    const vars = theme === "light" ? lightVars : darkVars;

    describe(`${theme} theme`, () => {
      for (const [fg, bg, label] of pairs) {
        it(`${label} meets WCAG AA (>= 4.5:1)`, () => {
          const ratio = contrastRatio(resolvedHex(vars, fg), resolvedHex(vars, bg));
          expect(ratio).toBeGreaterThanOrEqual(4.5);
        });
      }
    });
  }
});
