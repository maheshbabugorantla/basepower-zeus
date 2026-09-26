import type { SignalName } from "../components/ui/Chip";

// GTM P0: outreach segments. A home's segment is decided by the first of
// the model's own top-3 reasons (core.home_propensity.reasons, SHAP /
// standardized-coefficient order, most important first) that RAISES its
// likelihood -- never by a threshold we pick. The feature strings below
// are pipelines/models/pipeline.py's FEATURE_LABELS values verbatim;
// the weighted-mode signal keys are api.homes_ranked_weighted's reason
// codes (see app/export/shared.ts WEIGHTED_REASON_LABELS).
//
// Messages and channels are the team's suggestions, labelled as such in
// the UI -- they are copy, not data. "Care at home" is driven by ZIP /
// block-group figures, so its message is for community and utility
// programs only and never implies Base knows a household's health.

export type SegmentKey =
  | "storm_weary"
  | "neighbors"
  | "tech_forward"
  | "easy_install"
  | "care_at_home"
  | "established";

export interface Segment {
  key: SegmentKey;
  name: string;
  /** What puts a home in this segment, in plain words. */
  drivenBy: string;
  /** Suggested opening line (team copy, not data). */
  message: string;
  /** Suggested channel (team copy, not data). */
  channel: string;
  signal: SignalName;
  /** True when every driver is an area-level figure, not a per-household fact. */
  areaLevelOnly: boolean;
}

export const SEGMENTS: Record<SegmentKey, Segment> = {
  storm_weary: {
    key: "storm_weary",
    name: "Storm-weary",
    drivenBy: "Outage exposure from this home's utility",
    message: "The grid here goes down. With backup, the next outage is one you won't notice.",
    channel: "Mail and door-knocking, 1 to 5 months after a major outage",
    signal: "outage",
    areaLevelOnly: true,
  },
  neighbors: {
    key: "neighbors",
    name: "Neighbors already did it",
    drivenBy: "Nearby homes already added battery or generator backup",
    message: "Homes in your neighborhood already have backup power. Here's how it works for them.",
    channel: "Door-knocking and referral offers",
    signal: "household",
    areaLevelOnly: true,
  },
  tech_forward: {
    key: "tech_forward",
    name: "Tech-forward",
    drivenBy: "This home's own solar, EV charger or panel-upgrade permit",
    message: "Pair backup power with the solar, EV or electrical upgrade you already have.",
    channel: "Digital ads and installer partners",
    signal: "install",
    areaLevelOnly: false,
  },
  easy_install: {
    key: "easy_install",
    name: "Easy install",
    drivenBy: "Newer home, likely no panel upgrade needed",
    message: "Newer homes like yours usually install in days, with no panel upgrade.",
    channel: "Mail and inside sales",
    signal: "install",
    areaLevelOnly: false,
  },
  care_at_home: {
    key: "care_at_home",
    name: "Care at home",
    drivenBy: "Medical-need rate in the ZIP or an older neighborhood (area figures)",
    message:
      "Community and utility resilience programs only. Don't reference health or age in individual outreach.",
    channel: "Community and utility programs",
    signal: "household",
    areaLevelOnly: true,
  },
  established: {
    key: "established",
    name: "Established homeowners",
    drivenBy: "Home value and neighborhood income",
    message: "Protect your home and everything in it when the grid goes down.",
    channel: "Mail and digital ads",
    signal: "grid",
    areaLevelOnly: false,
  },
};

export const SEGMENT_ORDER: SegmentKey[] = [
  "storm_weary",
  "neighbors",
  "tech_forward",
  "easy_install",
  "established",
  "care_at_home",
];

const FEATURE_TO_SEGMENT: Record<string, SegmentKey> = {
  // Predicted mode: pipelines/models/pipeline.py FEATURE_LABELS values.
  "outage exposure": "storm_weary",
  "neighbors who already added backup": "neighbors",
  "home's own solar permit": "tech_forward",
  "home's own EV charger permit": "tech_forward",
  "home's own panel-upgrade permit": "tech_forward",
  "home's own prior battery permit": "tech_forward",
  "home's own prior generator permit": "tech_forward",
  "year built": "easy_install",
  "medical-need rate (ZIP)": "care_at_home",
  "share of neighbors 65+": "care_at_home",
  "over-65 exemption on file": "care_at_home",
  "home value": "established",
  "share of neighbors earning $100k+": "established",
  "share of neighbors aged 35-64": "established",
  "share of neighbors with electric heat": "established",
  // Weighted mode: api.homes_ranked_weighted reason codes.
  outage: "storm_weary",
  backup_intent: "neighbors",
  home_permits: "tech_forward",
  installability: "easy_install",
  permit_risk: "easy_install",
  empower: "care_at_home",
  age65: "care_at_home",
  owner_65: "care_at_home",
  home_value: "established",
  income_100k: "established",
  age_35_64: "established",
  electric_heat: "established",
};

export interface ReasonLike {
  feature: string;
  direction: "raises" | "lowers";
}

/** Segment for the first reason that raises the likelihood, or null when
 * no reason raises it (or the reason isn't one we map). Never guessed. */
export function segmentForReasons(reasons: ReasonLike[] | null | undefined): Segment | null {
  if (!reasons) return null;
  for (const reason of reasons) {
    if (reason.direction !== "raises") continue;
    const key = FEATURE_TO_SEGMENT[reason.feature];
    if (key) return SEGMENTS[key];
  }
  return null;
}

/** Weighted mode: reasons are signal keys that already raise the score. */
export function segmentForSignalKeys(keys: string[] | null | undefined): Segment | null {
  if (!keys) return null;
  for (const key of keys) {
    const seg = FEATURE_TO_SEGMENT[key];
    if (seg) return SEGMENTS[seg];
  }
  return null;
}

/** Predicted-mode feature names (model reason strings) that lead to a
 * segment -- lets SQL filter by segment instead of paging every home. */
export function predictedFeaturesForSegment(key: SegmentKey): string[] {
  return Object.entries(FEATURE_TO_SEGMENT)
    .filter(([feature, seg]) => seg === key && /\s/.test(feature))
    .map(([feature]) => feature);
}

export function segmentByKey(key: string | null | undefined): Segment | null {
  if (!key) return null;
  return (SEGMENTS as Record<string, Segment>)[key] ?? null;
}

/** Signal color for a model reason, so a reason chip uses the same color
 * as its signal everywhere (DESIGN.md signal categories). */
export function signalForFeature(feature: string): SignalName {
  const seg = FEATURE_TO_SEGMENT[feature];
  if (seg === "storm_weary") return "outage";
  if (seg === "tech_forward" || seg === "easy_install") return "install";
  if (seg === "established" && feature.includes("value")) return "grid";
  return "household";
}

/** Share of homes held out of outreach so lift can be measured. */
export const HOLDOUT_SHARE = 0.1;

/** Stable 10% holdout: FNV-1a hash of prop_id, so the same home is in the
 * same group on every export and every day. */
export function isHoldout(propId: string): boolean {
  let hash = 0x811c9dc5;
  for (let i = 0; i < propId.length; i += 1) {
    hash ^= propId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 1000 < HOLDOUT_SHARE * 1000;
}
