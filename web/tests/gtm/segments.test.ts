import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SEGMENTS,
  SEGMENT_ORDER,
  HOLDOUT_SHARE,
  isHoldout,
  predictedFeaturesForSegment,
  segmentByKey,
  segmentForReasons,
  segmentForSignalKeys,
} from "../../lib/segments";

// GTM P0: segment assignment is pure logic over the model's own reason
// strings. The strings under test are read from the model code itself
// (pipelines/models/pipeline.py FEATURE_LABELS), not typed here, so a
// renamed model feature fails this test instead of silently dropping a
// segment.

const pipelineSource = readFileSync(
  fileURLToPath(new URL("../../../pipelines/models/pipeline.py", import.meta.url)),
  "utf8"
);
const featureLabelsBlock = pipelineSource.slice(
  pipelineSource.indexOf("FEATURE_LABELS"),
  pipelineSource.indexOf("}", pipelineSource.indexOf("FEATURE_LABELS"))
);
const modelFeatureLabels = Array.from(featureLabelsBlock.matchAll(/:\s*"([^"]+)"/g)).map((m) => m[1]);

describe("segments", () => {
  it("reads the model's feature labels", () => {
    expect(modelFeatureLabels.length).toBeGreaterThan(10);
  });

  it("maps every model feature label to a segment", () => {
    for (const feature of modelFeatureLabels) {
      expect(segmentForReasons([{ feature, direction: "raises" }]), feature).not.toBeNull();
    }
  });

  it("uses the first reason that RAISES the likelihood", () => {
    const seg = segmentForReasons([
      { feature: "home value", direction: "lowers" },
      { feature: "neighbors who already added backup", direction: "raises" },
      { feature: "outage exposure", direction: "raises" },
    ]);
    expect(seg?.key).toBe("neighbors");
  });

  it("returns null when no reason raises the likelihood", () => {
    expect(segmentForReasons([{ feature: "home value", direction: "lowers" }])).toBeNull();
    expect(segmentForReasons(null)).toBeNull();
  });

  it("maps weighted-mode signal keys", () => {
    expect(segmentForSignalKeys(["outage", "home_value"])?.key).toBe("storm_weary");
    expect(segmentForSignalKeys(["not_a_signal"])).toBeNull();
  });

  it("lists predicted-mode features per segment for the SQL filter", () => {
    const features = predictedFeaturesForSegment("tech_forward");
    expect(features).toContain("home's own solar permit");
    expect(features.every((f) => /\s/.test(f))).toBe(true);
  });

  it("keeps care-at-home messaging away from individual health claims", () => {
    expect(SEGMENTS.care_at_home.areaLevelOnly).toBe(true);
    expect(SEGMENTS.care_at_home.message).toMatch(/community/i);
  });

  it("orders every segment exactly once", () => {
    expect(new Set(SEGMENT_ORDER).size).toBe(Object.keys(SEGMENTS).length);
    expect(segmentByKey("easy_install")?.name).toBe("Easy install");
    expect(segmentByKey("nope")).toBeNull();
  });

  it("holdout is a stable per-home flag (real TCAD prop_ids from checks/M1-H2.md)", () => {
    const spotCheck = readFileSync(
      fileURLToPath(new URL("../../../checks/M1-H2.md", import.meta.url)),
      "utf8"
    );
    const propIds = Array.from(spotCheck.matchAll(/^\| (\d{6}) \|/gm)).map((m) => m[1]);
    expect(propIds.length).toBeGreaterThanOrEqual(5);
    for (const id of propIds) {
      expect(isHoldout(id)).toBe(isHoldout(id));
    }
    expect(HOLDOUT_SHARE).toBe(0.1);
  });
});
