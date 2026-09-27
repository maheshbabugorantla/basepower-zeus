import { tierForDecile } from "../../lib/priorityTier";

// The one rendered form of core.home_propensity.decile. No caller ever
// passes a probability, multiple or percentile here -- only the integer
// decile column. Styled like DESIGN.md's Chip (a dot + label), colored
// with the existing score-ramp token (Green Means Score: this chip IS
// the ranking) -- a dot avoids the light-on-dark / dark-on-light
// contrast flip the ramp does between themes, which a filled pill would
// have to solve twice.

export interface PriorityTierBadgeProps {
  decile: number | null;
  /** Suppresses the description tooltip (list rows already show a legend). */
  compact?: boolean;
}

export function PriorityTierBadge({ decile, compact = false }: PriorityTierBadgeProps) {
  const tier = tierForDecile(decile);
  return (
    <span
      className="priority-tier-badge"
      data-tier={tier.key}
      title={compact ? undefined : tier.description}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        fontFamily: "var(--type-label-font-family)",
        fontSize: "var(--type-label-font-size)",
        fontWeight: 600,
        color: "var(--theme-ink)",
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          width: "10px",
          height: "10px",
          borderRadius: "50%",
          backgroundColor: tier.scoreToken,
          border: tier.key === "unscored" ? "1px solid var(--theme-divider)" : undefined,
        }}
      />
      {tier.label}
    </span>
  );
}
