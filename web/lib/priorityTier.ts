// Priority tier — the ONE place core.home_propensity.decile becomes a
// rep-facing label. Per the product rule (CLAUDE.md-adjacent, set by the
// GTM stakeholder): nobody outreach-facing ever sees a multiple,
// probability, percentile or raw decile number. The model's likelihood
// (p_install_12m / decile) still ORDERS every list and drives which tier
// a home lands in -- it just never renders as a number. decile 1 is the
// model's highest-likelihood bucket per county (see core/home_propensity
// pipeline: "decile 1 = highest p_install_12m within the home's county").
//
// Mapping (documented again, in prose, on /sources "How leads are
// prioritized" -- keep both in sync):
//   decile 1        -> Top priority
//   decile 2-3       -> High
//   decile 4-6       -> Medium
//   decile 7-10       -> Low
//   decile null/other -> Not scored

export type PriorityTierKey = "top" | "high" | "medium" | "low" | "unscored";

export interface PriorityTierMeta {
  key: PriorityTierKey;
  label: string;
  /** One-line description of what the tier means, for a legend/disclosure. */
  description: string;
  /** Existing DESIGN.md theme-aware score-ramp token (tokens.css already
   * flips --theme-score-N per light/dark) -- never a new color. */
  scoreToken: string;
  /** True when the tier's fill is dark enough to need light (ink-on-dark) text. */
  darkFill: boolean;
}

const TIER_META: Record<PriorityTierKey, PriorityTierMeta> = {
  top: {
    key: "top",
    label: "Top priority",
    description: "The county's most likely tenth of homes.",
    scoreToken: "var(--theme-score-5)",
    darkFill: true,
  },
  high: {
    key: "high",
    label: "High",
    description: "The next fifth of homes, by likelihood.",
    scoreToken: "var(--theme-score-4)",
    darkFill: true,
  },
  medium: {
    key: "medium",
    label: "Medium",
    description: "The middle third of homes, by likelihood.",
    scoreToken: "var(--theme-score-3)",
    darkFill: false,
  },
  low: {
    key: "low",
    label: "Low",
    description: "The lowest four-tenths of homes, by likelihood.",
    scoreToken: "var(--theme-score-1)",
    darkFill: false,
  },
  unscored: {
    key: "unscored",
    label: "Not scored",
    description: "This home hasn't been scored yet.",
    scoreToken: "var(--component-state-not-loaded-background-color)",
    darkFill: false,
  },
};

export const PRIORITY_TIER_ORDER: PriorityTierKey[] = ["top", "high", "medium", "low", "unscored"];

/** decile -> tier. Never called with a percentile/probability -- only
 * the integer decile column (1 = highest likelihood, 10 = lowest). */
export function tierForDecile(decile: number | null | undefined): PriorityTierMeta {
  if (decile === null || decile === undefined || !Number.isFinite(decile)) return TIER_META.unscored;
  if (decile <= 1) return TIER_META.top;
  if (decile <= 3) return TIER_META.high;
  if (decile <= 6) return TIER_META.medium;
  return TIER_META.low;
}

export function tierMeta(key: PriorityTierKey): PriorityTierMeta {
  return TIER_META[key];
}

export function allTierMeta(): PriorityTierMeta[] {
  return PRIORITY_TIER_ORDER.map((k) => TIER_META[k]);
}

/** Inverse of tierForDecile -- the [min, max] decile range a tier filter
 * maps to, for the lead list's server-side "Priority" filter
 * (fetchPredictedHomes minDecile/maxDecile). "unscored" and "all" both
 * mean "don't filter" -- unscored homes never carry a decile at all, so
 * there is no decile range that could select them; the lead list simply
 * never lists them (they're outside the gated/scored population).*/
export function decileRangeForTier(tier: PriorityTierKey | "all"): [number | null, number | null] {
  switch (tier) {
    case "top":
      return [1, 1];
    case "high":
      return [2, 3];
    case "medium":
      return [4, 6];
    case "low":
      return [7, 10];
    default:
      return [null, null];
  }
}

// ---------------------------------------------------------------------------
// Plain-language reason phrases.
//
// core.home_propensity.reasons[].feature is already pipelines/models/
// pipeline.py's FEATURE_LABELS text (e.g. "share of neighbors 65+"), not
// the raw column name -- this maps THAT label text to the rep-facing
// phrase a GTM rep would actually say. An unmapped label falls back to
// itself (still readable, just not tuned), so a new model feature never
// disappears from the UI.
// ---------------------------------------------------------------------------

// Rep-approved reason vocabulary ONLY -- a rep must be able to say this
// out loud at the door. Every entry here is a story ("neighbors added
// backup"), never a bare threshold or fact ("year built", "installed
// before 2000"). Facts like build year belong on the row meta line and
// the door brief's "Before you knock" section instead (see
// buildYearNote below), never as a reason chip.
export const REASON_PHRASES: Record<string, string> = {
  "home value": "High-value home",
  "over-65 exemption on file": "Homeowner 65+",
  "share of neighbors with electric heat": "Electric heat",
  "medical-need rate (zip)": "Many neighbors rely on powered medical devices",
  "outage exposure": "Long outages on this utility",
  "home's own solar permit": "Already has solar",
  "neighbors who already added backup": "Neighbors recently added backup",
};

// Model feature labels that are real contributors but must NEVER become
// a reason chip -- they're a bare threshold/fact, not a sentence a rep
// can say, or they'd contradict the door-brief's own "already has
// backup -- skip" rule (a home's own prior battery/generator permit is a
// reason to DE-prioritize, not a reason to knock). Filtered out of the
// model's top-3 before display; since web/ only ever receives that
// stored top-3 (never a 4th contributor), a home whose top-3 are all
// excluded shows fewer reason chips rather than a fabricated one --
// "missing means empty," never invented.
const EXCLUDED_REASON_LABELS = new Set([
  "year built",
  "installability",
  "share of neighbors 65+",
  "share of neighbors earning $100k+",
  "share of neighbors aged 35-64",
  "home's own ev charger permit",
  "home's own panel-upgrade permit",
  "home's own prior battery permit",
  "home's own prior generator permit",
]);

export function isEligibleReason(featureLabel: string): boolean {
  return !EXCLUDED_REASON_LABELS.has(featureLabel.toLowerCase());
}

/** Case-insensitive lookup. Callers should filter through
 * isEligibleReason first -- this still returns a readable fallback
 * (capitalized label) for anything that slips through, but never for
 * one of the excluded labels above by design. */
export function plainReason(featureLabel: string): string {
  const phrase = REASON_PHRASES[featureLabel.toLowerCase()];
  if (phrase) return phrase;
  // Fallback: capitalize the model's own label so it's still a full
  // sentence fragment, not raw feature-engineering text.
  return featureLabel.charAt(0).toUpperCase() + featureLabel.slice(1);
}

/** Build-year fact for the door brief's "Before you knock" -- never a
 * reason chip (see EXCLUDED_REASON_LABELS above). Harris carries no
 * yr_built for any home (no public appraisal-roll field loaded for it)
 * -- that is said plainly, never guessed or defaulted to a year. */
export function buildYearNote(yrBuilt: number | null): string {
  if (yrBuilt === null) return "Build year not available";
  return yrBuilt >= 2000
    ? `Built ${yrBuilt} -- wiring likely to modern code`
    : `Built ${yrBuilt} -- older wiring, check the panel`;
}

// ---------------------------------------------------------------------------
// Utility service status -- a distinct, always-visible concept from
// priority tier (T2). "Ranked prospect" never implies "confirmed
// servable"; this is the single copy source for that status everywhere
// a home/area shows it (lead list rows, door brief, export CSV).
// ---------------------------------------------------------------------------

export type UtilityStatusKey = "served" | "unconfirmed" | "not_served" | "unknown";

export interface UtilityStatusMeta {
  key: UtilityStatusKey;
  label: string;
  /** Longer imperative for the door brief / list header. */
  action: string;
}

const UTILITY_STATUS_META: Record<UtilityStatusKey, UtilityStatusMeta> = {
  served: { key: "served", label: "Base serves this utility", action: "Servable — no extra check needed." },
  unconfirmed: {
    key: "unconfirmed",
    label: "Utility not confirmed",
    action: "Verify the utility at the door before promising service.",
  },
  not_served: { key: "not_served", label: "Not served", action: "Base doesn't serve this utility yet — do not pitch." },
  unknown: {
    key: "unknown",
    label: "Utility not confirmed",
    action: "Verify the utility at the door before promising service.",
  },
};

/** gate_reason (excludes a home from ranking entirely) + territory_null_
 * reason (a ranked home whose utility match is still fail-open) ->
 * utility status. core.home_propensity only ever holds gated
 * (non-excluded) homes, so a ranked row's gate_reason is always null/
 * 'passed'/'utility_not_confirmed' in practice -- gateReason is still
 * accepted here so the home-detail page (which CAN show an excluded
 * home) uses the same function. Only an explicit "not on Base's served
 * list" reason reads as "not served"; every unresolved/fail-open reason
 * -- including 'utility_not_confirmed' and the three CCN-mapping
 * reasons ('multiply_certificated', 'no_ccn_match',
 * 'ccn_holder_unmapped' -- none in the DB yet) -- reads as "not
 * confirmed". Unknown/unmapped reasons default to "unconfirmed", never
 * "served": unknown eligibility must never read as confirmed. */
export function utilityStatusForHome(input: {
  gateReason?: string | null;
  territoryNullReason?: string | null;
}): UtilityStatusMeta {
  const { gateReason = null, territoryNullReason = null } = input;
  if (gateReason === "territory_not_base_served") return UTILITY_STATUS_META.not_served;
  if (gateReason && gateReason !== "passed" && gateReason !== "utility_not_confirmed") {
    // Excluded for a reason unrelated to utility service (e.g. not
    // owner-occupied) -- status is genuinely unknown, not "not served".
    return UTILITY_STATUS_META.unknown;
  }
  if (territoryNullReason) return UTILITY_STATUS_META.unconfirmed;
  if (gateReason === "utility_not_confirmed") return UTILITY_STATUS_META.unconfirmed;
  return UTILITY_STATUS_META.served;
}

export function utilityStatusMeta(key: UtilityStatusKey): UtilityStatusMeta {
  return UTILITY_STATUS_META[key];
}
