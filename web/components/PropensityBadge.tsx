import { Chip } from "./ui/Chip";
import { PriorityTierBadge } from "./ui/PriorityTierBadge";
import { MissingState } from "./ui/MissingState";
import { plainReason } from "../lib/priorityTier";

// M4-W2, revised for the "no multiples in front of a rep" product rule:
// core.home_propensity still drives ranking under the hood
// (p_install_12m orders every list; decile sets the tier below), but
// this component never renders p_install_12m, relative_to_county or any
// other probability/multiple/percentile number. It renders only:
//   - a priority tier chip (decile -> Top priority/High/Medium/Low)
//   - up to 3 plain-language reasons (the model's own top-3
//     contributions, relabeled for a GTM rep)
//   - whether the prediction is extrapolated from Austin permits (plain
//     words, not a caveat about model confidence)
// relativeToCounty/pInstall12m are still accepted (callers pass them
// through from the same DB row) but are display-dead here on purpose --
// keeping the props means callers don't need a second fetch just to
// drop a field, and a future internal-only debug view can still read them.

export interface PropensityReason {
  feature: string;
  direction: "raises" | "lowers";
  value: number | null;
}

export interface PropensityBadgeProps {
  /** Calibrated probability (0-1) -- kept for ordering/debugging, never rendered. */
  pInstall12m: number;
  /** p_install_12m / the county's own mean -- kept for ordering/debugging, never rendered. */
  relativeToCounty: number | null;
  /** core.home_propensity.decile (1 = highest likelihood in-county, 10 = lowest). Drives the tier chip. */
  decile?: number | null;
  /** Plain county name -- kept for callers that still pass it; unused in this render. */
  countyName: string;
  /** 'austin_installs' when this home's permit-derived features are null (outside Austin permit coverage). */
  extrapolatedFrom?: string | null;
  /** Model's top-3 contributions, most important first. */
  reasons?: PropensityReason[];
  /** Show the reason chips (ranking rows keep it compact; the home page always shows them). */
  showReasons?: boolean;
  /** Cap how many reason chips render (lead-list rows show 2, the door brief shows all 3). */
  maxReasons?: number;
}

export function PropensityBadge({
  decile = null,
  extrapolatedFrom = null,
  reasons = [],
  showReasons = true,
  maxReasons = 3,
}: PropensityBadgeProps) {
  const risingReasons = reasons.filter((r) => r.direction === "raises").slice(0, maxReasons);
  // If a home has fewer than maxReasons rising reasons, fill in from
  // "lowers" only when there's nothing else to say (still labeled
  // plainly -- "Already has backup" reads as a reason to skip, not a
  // reason to knock, and the door brief's own "Before you knock" section
  // is the one place a lowering reason really belongs). Kept here so a
  // rep never sees a bare, reasonless tier chip when the model *has* a
  // top-3 for this home.
  const shownReasons = risingReasons.length > 0 ? risingReasons : reasons.slice(0, maxReasons);

  return (
    <div className="propensity-badge">
      {decile === null ? (
        <MissingState variant="not-loaded" reason="Not scored yet" />
      ) : (
        <PriorityTierBadge decile={decile} />
      )}

      {extrapolatedFrom === "austin_installs" ? (
        <p style={{ margin: "var(--space-1) 0 0 0", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
          Prediction extrapolated from Austin installs — no local permit history for this city
        </p>
      ) : null}

      {showReasons && shownReasons.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)", marginTop: "var(--space-2)" }}>
          {shownReasons.map((reason, index) => (
            <Chip key={`${reason.feature}-${index}`} signal="install" label={plainReason(reason.feature)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
