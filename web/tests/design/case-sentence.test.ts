import { describe, expect, it } from "vitest";
import {
  buildCaseSentenceParts,
  containsBannedVocabulary,
  roundMinutesToHours,
  roundRatePer1000ToPer100,
  roundToWholePercent,
  splitBoldMarkers,
  type CaseSignalInput,
} from "../../lib/caseSentence";

// These three figures (87.08, 181.98, 83.0) are real values already
// quoted in the app/critique (3901 Watersedge, 2026-09-27) -- not
// invented for this test, per the real-data rule. No live DB call is
// needed to check a pure rounding function against a number already on
// record.

describe("caseSentence rounding helpers", () => {
  it("rounds a per-1,000-homes rate to a per-100 figure a rep can say out loud", () => {
    expect(roundRatePer1000ToPer100(87.08)).toBe(9);
  });

  it("rounds outage minutes to whole hours", () => {
    expect(roundMinutesToHours(181.98)).toBe(3);
  });

  it("rounds an already-percentage-point value to a whole percent", () => {
    expect(roundToWholePercent(83.0)).toBe(83);
  });
});

describe("splitBoldMarkers", () => {
  it("splits **bold** markers out of a sentence", () => {
    const parts = splitBoldMarkers("About **9 in 100 nearby homes** added a battery.");
    expect(parts).toEqual([
      { bold: false, text: "About " },
      { bold: true, text: "9 in 100 nearby homes" },
      { bold: false, text: " added a battery." },
    ]);
  });
});

function signal(overrides: Partial<CaseSignalInput> & { key: string; rawValue: number }): CaseSignalInput {
  return {
    label: overrides.key,
    rawUnit: "",
    term: 1,
    anchorValue: null,
    anchorBasis: null,
    available: true,
    ...overrides,
  };
}

describe("buildCaseSentenceParts", () => {
  const signals: CaseSignalInput[] = [
    signal({ key: "backup_intent", rawValue: 87.08, term: 1.0 }),
    signal({ key: "installability", rawValue: 2024, term: 1.0 }),
    signal({ key: "outage", rawValue: 181.98, term: 0.25 }),
    signal({ key: "income_100k", rawValue: 83.0, term: 1.0 }),
    // Not templated -- must never appear as a sentence fragment.
    signal({ key: "flood", rawValue: 0, term: 0.9 }),
  ];

  it("orders the strongest terms first and never invents a fragment for an untemplated signal", () => {
    const parts = buildCaseSentenceParts(signals, 4);
    expect(parts.map((p) => p.key)).not.toContain("flood");
    expect(parts.length).toBeGreaterThan(0);
    // Every term-1.0 signal outranks the term-0.25 outage signal.
    const outageIndex = parts.findIndex((p) => p.key === "outage");
    expect(outageIndex).toBe(parts.length - 1);
  });

  it("never uses banned Census/model vocabulary in the rendered sentence text", () => {
    const parts = buildCaseSentenceParts(signals, 4);
    for (const part of parts) {
      expect(containsBannedVocabulary(part.text), `banned vocabulary in: ${part.text}`).toBe(false);
    }
  });

  it("renders the real quoted figures rounded to rep-facing units", () => {
    const parts = buildCaseSentenceParts(signals, 4);
    const joined = parts.map((p) => p.text).join(" ");
    expect(joined).toContain("9 in 100 nearby homes");
    expect(joined).toContain("built in 2024");
    expect(joined).toContain("83%");
    expect(joined).toContain("3 hours");
  });

  it("skips a signal whose template legitimately has nothing to say (home_permits with no permit on file)", () => {
    const parts = buildCaseSentenceParts(
      [signal({ key: "home_permits", rawValue: 0, term: 0.5 })],
      4
    );
    expect(parts).toEqual([]);
  });

  it("leaves a missing (unavailable) signal out of the prose entirely", () => {
    const parts = buildCaseSentenceParts(
      [signal({ key: "outage", rawValue: 181.98, term: 1, available: false })],
      4
    );
    expect(parts).toEqual([]);
  });
});

// Meter captions, checked against the real breakdown values of home 122302
// (3901 Watersedge, Travis) that the redesign critique quoted.
import { meterCaption, formatDollarsShort } from "../../lib/caseSentence";

describe("meterCaption", () => {
  it("captions each signal in rep-facing words with its real value", () => {
    expect(meterCaption("outage", 181.98)).toBe("About 3 hours without power a year");
    expect(meterCaption("backup_intent", 87.08)).toBe("About 9 in 100 nearby homes added backup");
    expect(meterCaption("income_100k", 83.0)).toBe("83 % of households earn $100k+");
    expect(meterCaption("age65", 28.35)).toBe("28 % of neighbors are 65+");
    expect(meterCaption("installability", 2024)).toBe("Built 2024");
    expect(meterCaption("home_value", 12100000)).toBe("$12.1M appraisal");
    expect(meterCaption("flood", 0)).toBe("Outside FEMA high-risk zone");
  });

  it("never shows model vocabulary or a bare flag", () => {
    for (const [k, v] of [["outage", 181.98], ["backup_intent", 87.08], ["flood", 0], ["home_permits", 0], ["owner_65", 0], ["installability", 2024]] as const) {
      const c = meterCaption(k, v) ?? "";
      expect(c).not.toMatch(/\b(flag|anchor|term)\b/i);
      expect(c).not.toMatch(/^\s*[01]\s*$/);
    }
  });

  it("returns null for a missing value rather than inventing one", () => {
    expect(meterCaption("outage", null)).toBeNull();
  });

  it("shortens dollars", () => {
    expect(formatDollarsShort(12100000)).toBe("$12.1M");
  });
});

// Real rows seen on /ranking: 2109 River Oaks Blvd (Harris, HCAD appraisal
// $13,378,483) and 4904 Beverly Skyline (Travis, built 1958).
describe("county-aware and honest templates", () => {
  const sig = (key: string, rawValue: number, term: number): CaseSignalInput => ({
    key, label: key, rawValue, rawUnit: "", term, anchorValue: null, anchorBasis: null, available: true,
  });

  it("names the home's own appraisal district", () => {
    const parts = buildCaseSentenceParts([sig("home_value", 13378483, 1)], 4, { cadShort: "HCAD" });
    expect(parts[0].text).toBe("HCAD appraises this home at **$13,378,483**.");
    expect(parts[0].text).not.toMatch(/Travis/);
  });

  it("does not call a pre-2000 build straightforward to install", () => {
    const parts = buildCaseSentenceParts([sig("installability", 1958, 1)], 4);
    expect(parts[0].text).toBe("This home was **built in 1958**.");
  });
});
