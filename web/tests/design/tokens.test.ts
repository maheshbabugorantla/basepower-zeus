import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectLeaves, designMdPath, readFrontmatter } from "./parse-design-frontmatter";

// Asserts web/styles/tokens.css matches DESIGN.md's frontmatter 1:1 for the
// four scalar-leaf groups (colors, typography, rounded, spacing): every
// leaf in DESIGN.md has a corresponding CSS custom property with the same
// value, and tokens.css introduces no *scalar color* value that doesn't
// trace back to a DESIGN.md leaf. (The `components` group is intentionally
// out of scope for the strict value-equality walk below: several of its
// leaves are references into the `typography` group, e.g.
// "{typography.label}", which expands to a set of properties rather than a
// single scalar — those are exercised structurally instead, further down.)

function tokensCssPath(): string {
  return fileURLToPath(new URL("../../styles/tokens.css", import.meta.url));
}

function readTokensCss(): string {
  return readFileSync(tokensCssPath(), "utf8");
}

/** Parse `--name: value;` declarations out of a CSS text blob. */
function parseCssVars(cssText: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /--([a-z0-9-]+):\s*([^;]+);/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cssText)) !== null) {
    out.set(m[1], m[2].trim());
  }
  return out;
}

// camelCase -> kebab-case, e.g. fontFamily -> font-family
function kebab(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

describe("design tokens match DESIGN.md frontmatter", () => {
  const frontmatter = readFrontmatter(designMdPath());
  const cssVars = parseCssVars(readTokensCss());

  it("DESIGN.md frontmatter is non-empty and has the expected top-level groups", () => {
    expect(Object.keys(frontmatter)).toEqual(
      expect.arrayContaining(["colors", "typography", "rounded", "spacing", "components"])
    );
  });

  describe("colors", () => {
    const colorLeaves = collectLeaves(frontmatter.colors as never);

    it("every DESIGN.md color has a --color-<key> custom property with the same value", () => {
      for (const [key, value] of colorLeaves) {
        const cssVarName = `color-${key}`;
        expect(cssVars.get(cssVarName), `--${cssVarName} should exist`).toBe(String(value));
      }
    });

    it("tokens.css defines no extra --color-* leaf not present in DESIGN.md", () => {
      const designKeys = new Set([...colorLeaves.keys()]);
      for (const cssKey of cssVars.keys()) {
        if (!cssKey.startsWith("color-")) continue;
        const key = cssKey.slice("color-".length);
        expect(designKeys.has(key), `--${cssKey} has no DESIGN.md colors.${key}`).toBe(true);
      }
    });
  });

  describe("typography", () => {
    const typography = frontmatter.typography as Record<string, Record<string, unknown>>;

    it("every DESIGN.md typography leaf has a --type-<variant>-<prop> custom property with the same value", () => {
      for (const [variant, props] of Object.entries(typography)) {
        for (const [prop, value] of Object.entries(props)) {
          const cssVarName = `type-${variant}-${kebab(prop)}`;
          expect(cssVars.get(cssVarName), `--${cssVarName} should exist`).toBe(String(value));
        }
      }
    });
  });

  describe("rounded", () => {
    const rounded = frontmatter.rounded as Record<string, string>;

    it("every DESIGN.md rounded leaf has a --rounded-<key> custom property with the same value", () => {
      for (const [key, value] of Object.entries(rounded)) {
        expect(cssVars.get(`rounded-${key}`)).toBe(String(value));
      }
    });
  });

  describe("spacing", () => {
    const spacing = frontmatter.spacing as Record<string, string>;

    it("every DESIGN.md spacing leaf has a --space-<key> custom property with the same value", () => {
      for (const [key, value] of Object.entries(spacing)) {
        expect(cssVars.get(`space-${key}`)).toBe(String(value));
      }
    });
  });

  describe("components", () => {
    const components = frontmatter.components as Record<string, Record<string, string>>;

    it("every scalar (non-group-reference) component leaf resolves to the referenced token or a matching literal", () => {
      for (const [componentName, props] of Object.entries(components)) {
        for (const [prop, rawValue] of Object.entries(props)) {
          const value = String(rawValue);
          const groupRefMatch = value.match(/^\{(\w+)\.([\w-]+)\}$/);
          if (groupRefMatch && groupRefMatch[1] === "typography") {
            // A ref to a whole typography variant (e.g. "{typography.label}")
            // expands to several properties, not one scalar var — the
            // component's own JSX/CSS applies those directly; nothing to
            // assert against a single custom property here.
            continue;
          }

          const cssVarName = `component-${componentName}-${kebab(prop)}`;
          const cssValue = cssVars.get(cssVarName);
          expect(cssValue, `--${cssVarName} should exist`).toBeDefined();

          if (groupRefMatch) {
            const [, group, key] = groupRefMatch;
            // e.g. {colors.brand-strong} -> var(--color-brand-strong)
            // e.g. {rounded.sm} -> var(--rounded-sm)
            const groupPrefix = group === "colors" ? "color" : group;
            expect(cssValue).toBe(`var(--${groupPrefix}-${key})`);
          } else {
            expect(cssValue).toBe(value);
          }
        }
      }
    });
  });

  it("tokens.css supplies a dark-mode reassignment (prefers-color-scheme + data-theme override)", () => {
    const cssText = readTokensCss();
    expect(cssText).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);
    expect(cssText).toMatch(/data-theme=["']dark["']/);
  });

  it('the prefers-color-scheme dark block and the data-theme="dark" override reassign the same set of --theme-* variables', () => {
    const cssText = readTokensCss();

    // Extract a balanced-brace block starting at the `{` that follows the
    // first match of `openRe` — a plain regex can't safely capture a
    // block containing its own nested `{...}` (the @media block nests
    // :root:not(...) { ... } inside it).
    function extractBalancedBlock(text: string, openRe: RegExp): string {
      const m = openRe.exec(text);
      if (!m) throw new Error(`Selector not found: ${openRe}`);
      const braceStart = text.indexOf("{", m.index);
      let depth = 0;
      for (let i = braceStart; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") {
          depth--;
          if (depth === 0) return text.slice(braceStart + 1, i);
        }
      }
      throw new Error("Unbalanced braces");
    }

    const mediaContent = extractBalancedBlock(cssText, /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{/);
    const overrideContent = extractBalancedBlock(cssText, /:root\[data-theme=["']dark["']\]\s*\{/);

    const namesIn = (text: string) => {
      const names = new Set<string>();
      const re = /--(theme-[a-z0-9-]+):/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) names.add(m[1]);
      return names;
    };
    const mediaNames = namesIn(mediaContent);
    const overrideNames = namesIn(overrideContent);
    expect(mediaNames.size).toBeGreaterThan(0);
    expect([...mediaNames].sort()).toEqual([...overrideNames].sort());
  });
});
