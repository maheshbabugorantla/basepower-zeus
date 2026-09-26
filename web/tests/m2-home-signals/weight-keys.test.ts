import { describe, expect, it } from "vitest";
import { SIGNAL_KEYS, sanitizeWeights } from "../../app/api/top-homes/route";
import { REASON_META } from "../../components/TopHomesTable";
import { SLIDER_GROUPS, SIGNAL_ORDER, equalWeights, WEIGHT_EQUAL } from "../../components/WeightSliders";

// M2-P8: the ranking function now reads 10 weight keys (home-level
// signals owner_65/home_permits/installability/home_value joined to the
// existing outage/backup_intent/age65/electric_heat/empower/flood) —
// pure unit tests, no DB, covering the plumbing every route/component
// shares (sanitizeWeights, REASON_META, the slider groups).

const EXPECTED_KEYS = [
  "outage",
  "home_value",
  "backup_intent",
  "age65",
  "home_permits",
  "electric_heat",
  "empower",
  "owner_65",
  "installability",
  "flood",
];

describe("M2-P8 weight keys", () => {
  it("SIGNAL_KEYS is exactly the 10 keys the SQL scoring functions read", () => {
    expect(new Set(SIGNAL_KEYS)).toEqual(new Set(EXPECTED_KEYS));
    expect(SIGNAL_KEYS.length).toBe(10);
  });

  it("sanitizeWeights keeps every real key and drops unknown/invalid ones", () => {
    const out = sanitizeWeights({
      outage: 8,
      home_value: 0, // 0 is dropped (matches the SQL's "> 0" semantics for a real weight)
      owner_65: -1, // negative dropped
      installability: "5", // wrong type dropped
      not_a_real_key: 10,
      flood: 2,
    });
    expect(out).toEqual({ outage: 8, flood: 2 });
  });

  it("every SIGNAL_KEY has a REASON_META entry (chip label + a valid Chip signal color)", () => {
    for (const key of SIGNAL_KEYS) {
      expect(REASON_META[key], `missing REASON_META for ${key}`).toBeDefined();
      expect(["outage", "grid", "install", "household"]).toContain(REASON_META[key].signal);
    }
  });

  it("SLIDER_GROUPS covers every SIGNAL_KEY exactly once, grouped under the ticket's 3 headings", () => {
    expect(SLIDER_GROUPS.map((g) => g.heading)).toEqual(["Outage & grid", "This home", "Neighborhood"]);
    expect(new Set(SIGNAL_ORDER)).toEqual(new Set(EXPECTED_KEYS));
    const seen = new Set<string>();
    for (const group of SLIDER_GROUPS) {
      for (const key of group.keys) {
        expect(seen.has(key), `${key} appears in more than one group`).toBe(false);
        seen.add(key);
      }
    }
    expect(seen.size).toBe(10);
  });

  it("equalWeights() sets every one of the 10 keys to the same mid-scale value", () => {
    const weights = equalWeights();
    expect(Object.keys(weights).length).toBe(10);
    for (const key of SIGNAL_KEYS) expect(weights[key]).toBe(WEIGHT_EQUAL);
  });
});
