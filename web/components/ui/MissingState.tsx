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
      <span className="missing-state__reason">{reason}</span>
    </span>
  );
}
