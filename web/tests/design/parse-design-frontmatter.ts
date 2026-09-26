import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Hand-rolled parser for DESIGN.md's YAML frontmatter. web/package.json is
// scaffolded by M0-D1 and not in this ticket's `owns`, so no `yaml` /
// `js-yaml` dependency is added just for this one test file. The
// frontmatter here only ever uses: indented mappings, quoted string
// scalars, plain numeric scalars, and full-line `#` comments — this parser
// handles exactly that subset and nothing more.

export type FrontmatterValue = string | number | FrontmatterNode;
export interface FrontmatterNode {
  [key: string]: FrontmatterValue;
}

function parseScalar(raw: string): string | number {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  const asNumber = Number(trimmed);
  if (trimmed !== "" && !Number.isNaN(asNumber)) return asNumber;
  return trimmed;
}

/** Parse an indentation-based mapping-only YAML subset into a plain object tree. */
export function parseFrontmatter(yamlText: string): FrontmatterNode {
  const lines = yamlText
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));

  const root: FrontmatterNode = {};
  // stack of [indent, node]
  const stack: Array<[number, FrontmatterNode]> = [[-1, root]];

  for (const rawLine of lines) {
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    while (stack.length > 1 && stack[stack.length - 1][0] >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1][1];

    if (rest === "") {
      const child: FrontmatterNode = {};
      parent[key] = child;
      stack.push([indent, child]);
    } else {
      parent[key] = parseScalar(rest);
    }
  }

  return root;
}

/** Extract the first `---`-delimited frontmatter block from a markdown file. */
export function readFrontmatter(markdownPath: string): FrontmatterNode {
  const text = readFileSync(markdownPath, "utf8");
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error(`No frontmatter block found in ${markdownPath}`);
  return parseFrontmatter(match[1]);
}

export function designMdPath(): string {
  // repo-root/DESIGN.md, three levels up from web/tests/design/
  return fileURLToPath(new URL("../../../DESIGN.md", import.meta.url));
}

/** Recursively collect every leaf (string/number) path as "a.b.c" -> value. */
export function collectLeaves(
  node: FrontmatterNode,
  prefix = ""
): Map<string, string | number> {
  const out = new Map<string, string | number>();
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null) {
      for (const [k, v] of collectLeaves(value, path)) out.set(k, v);
    } else {
      out.set(path, value);
    }
  }
  return out;
}
