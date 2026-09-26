import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Guard against the live production incident this ticket fixed: pages
// running a request-time `select ... from core.parcels` (a 441,961-row
// full scan) or a live spatial join (ST_Within/ST_Intersects), instead of
// reading from a precomputed source (api.gate_counts,
// api.parcel_gate_counts, core.mv_home_signals, api.top_homes_weighted,
// api.join_rate, api.blockgroup_scores). Under concurrent load this
// exhausted the shared Supabase pooler's connection limit and caused
// statement-timeout cascades across the app.
//
// The one exemption is /home/[prop_id] (and its API-route sibling,
// /api/solar/[prop_id]): a single-row lookup by primary key (prop_id) is
// cheap and correct, unlike an unbounded scan or a spatial join over the
// whole table.

const ROOTS = ["app", "components"];
const EXEMPT_DIR_SEGMENTS = ["home", "[prop_id]", "solar"];
const FORBIDDEN_PATTERNS = [/from\s+core\.parcels\b/i, /ST_Within\s*\(/i, /ST_Intersects\s*\(/i];

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function isExempt(filePath: string): boolean {
  return EXEMPT_DIR_SEGMENTS.some((seg) => filePath.includes(`${seg}/`) || filePath.includes(`${seg}\\`));
}

describe("no live core.parcels scans or spatial joins outside home/[prop_id]", () => {
  it("never runs `from core.parcels`, ST_Within, or ST_Intersects at request time except a single-home lookup by prop_id", () => {
    const webDir = new URL("../..", import.meta.url).pathname;
    const offenders: string[] = [];

    for (const root of ROOTS) {
      const files = listFiles(join(webDir, root));
      for (const file of files) {
        if (isExempt(file)) continue;
        const raw = readFileSync(file, "utf8");
        // Strip comments first: several files here explain, in prose,
        // *why* a live core.parcels scan was removed — only actual query
        // strings must avoid the forbidden patterns.
        const source = raw
          .replace(/\/\*[\s\S]*?\*\//g, " ")
          .replace(/\/\/.*$/gm, " ");
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.test(source)) {
            offenders.push(`${file.replace(webDir, "")}: matches ${pattern}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
