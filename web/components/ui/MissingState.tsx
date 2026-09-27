import type { HTMLAttributes } from "react";

// DESIGN.md "The Missing Is Grey Rule": "not loaded" (pipeline hasn't run)
// and "not available" (no public source, e.g. Harris permits) are two
// visibly different, grey-toned states, each with its reason written out.
// A missing value is never 0, blank, or a dash — every caller must supply
// a non-empty `reason`, enforced both at the type level (required prop)
// and at runtime (throws on empty/whitespace).

export type MissingVariant = "not-loaded" | "not-available";

export interface MissingStateProps extends HTMLAttributes<HTMLSpanElement> {
  variant: MissingVariant;
  /** Why the value is missing, e.g. "EAGLE-I pipeline has not run yet". */
  reason: string;
  /** Render as a map-fill hatch (45deg pattern) instead of a label chip. */
  asMapFill?: boolean;
}

// Database null-reason codes (snake_case) are never shown raw. Every code
// the pipelines write is translated here once, so any caller can pass
// the column value straight through.
const REASON_TEXT: Record<string, string> = {
  // M3-W1: grid-value-to-Base states (components/GridValue.tsx) and the
  // Harris/Williamson "no public permit feed" state — always a plain
  // reason, never a number or a 0 (CLAUDE.md real-data rule).
  backup_only_no_vpp: "Base sells backup only here",
  not_served_by_base: "Base doesn't serve this utility",
  utility_tier_not_classified: "This utility's Base service tier isn't classified yet",
  no_zone_mapped_for_utility: "No price zone mapped for this utility yet",
  fewer_than_8_load_zones_loaded_anchor_unreliable:
    "Only some ERCOT load zones are loaded, so this comparison covers just those zones",
  no_public_permit_feed: "No public permit feed for this city",
  acs_not_loaded: "Census household data not loaded yet",
  block_group_not_in_acs: "No Census figure for this neighborhood",
  block_group_not_in_score_view: "This neighborhood isn't scored yet",
  county_customers_not_loaded: "County customer counts not loaded yet",
  crosswalk_not_loaded: "Base's served-utilities list not loaded yet",
  empower_not_loaded: "Medicare device data not loaded yet",
  flood_zones_not_loaded: "Flood maps not loaded yet",
  no_acs_figure: "The Census didn't publish this figure here",
  no_claude_labels_yet: "Not checked yet",
  no_customer_count_for_county: "No customer count for this county",
  no_eia861_figure_for_distributor: "This utility doesn't report outage minutes to EIA",
  no_empower_figure: "No Medicare device figure for this ZIP",
  no_gated_homes_in_block_group: "No homes Base can serve in this neighborhood",
  no_permit_coverage: "No public permit feed for this city (only City of Austin permits are loaded)",
  no_permits_loaded_yet: "Permits not loaded yet",
  no_territory_match: "No utility service area matches this home",
  not_loaded: "Not loaded yet",
  not_reported: "This utility didn't report outage minutes to EIA this year",
  permits_not_loaded: "Permits not loaded yet",
  retail_market_not_loaded: "Market list not loaded yet",
  suppressed_1_to_10: "Hidden by the source for privacy (1 to 10 people)",
  territories_not_loaded: "Utility service areas not loaded yet",
  territory_not_base_served: "In a utility Base doesn't serve",
  // M-utility-gate (0303): every HIFLD territory polygon overlaps for
  // this county, so which utility serves this home can't be confirmed
  // from the polygon alone -- still ranked/scored, just not counted as
  // Base-servable until confirmed at the address.
  utility_not_confirmed: "Utility not confirmed — check the address with the utility",
  utility_not_in_retail_market_file: "This utility isn't in the market list yet",
  zip_not_in_empower: "This ZIP isn't in the Medicare device data",
};

/** Plain text for a reason: known codes are translated; other snake_case codes become a generic line. */
export function plainReason(reason: string): string {
  const key = reason.trim();
  if (REASON_TEXT[key]) return REASON_TEXT[key];
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(key)) return "Not available for this home";
  return reason;
}

const VARIANT_LABEL: Record<MissingVariant, string> = {
  "not-loaded": "Not loaded",
  "not-available": "Not available",
};

export function MissingState({
  variant,
  reason,
  asMapFill = false,
  className,
  ...rest
}: MissingStateProps) {
  if (!reason || reason.trim() === "") {
    throw new Error(
      "MissingState requires a non-empty `reason` — a missing value is never rendered without saying why."
    );
  }

  const classes = [
    "missing-state",
    variant === "not-loaded" ? "missing-state--not-loaded" : "missing-state--not-available",
    asMapFill ? "hatch-missing" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span {...rest} className={classes} data-state={variant}>
      <span className="missing-state__label">{VARIANT_LABEL[variant]}</span>
      <span className="missing-state__reason">{plainReason(reason)}</span>
    </span>
  );
}
