import { Chip } from "./ui/Chip";
import { MissingState } from "./ui/MissingState";
import { signalForFeature } from "../lib/segments";

// M4-W2: the predictive headline — core.home_propensity's calibrated
// 12-month backup-adoption probability, read straight from
// api.home_propensity by the caller (never computed here). relative_to_
// county already IS the "N times the county average" figure (p_install_
// 12m / mean(p_install_12m) in the home's county) -- this component only
// formats it, never recomputes it. reasons are the model's own top-3
// contributions (plain feature name + direction); `value` is on the
// model's internal scale (e.g. a home-value term of ~16), so it is never
// shown -- only the feature name and whether it raises or lowers the
// likelihood.

export interface PropensityReason {
  feature: string;
  direction: "raises" | "lowers";
  value: number | null;
}

export interface PropensityBadgeProps {
  /** Calibrated probability (0-1) this home adds battery/generator backup in the next 12 months. */
  pInstall12m: number;
  /** p_install_12m / the county's own mean -- null when the county mean isn't computable (e.g. too few homes). */
  relativeToCounty: number | null;
  /** Plain county name for "the <county> average" ("Travis"), not a FIPS code. */
  countyName: string;
  /** 'austin_installs' when this home's permit-derived features are null (outside Austin permit coverage). */
  extrapolatedFrom?: string | null;
  /** Model's top-3 contributions, most important first. */
  reasons?: PropensityReason[];
  /** Show the reason chips (ranking rows keep it compact; the home page always shows them). */
  showReasons?: boolean;
}

/** "3.1x" style multiplier, one decimal, never rounded to a bare integer that reads like a count. */
function formatMultiplier(relativeToCounty: number): string {
  return `${relativeToCounty.toFixed(1)}×`;
}

/** "about 322 in 1,000" / "fewer than 1 in 1,000" -- never a bare percentage a GTM reader has to convert. */
function formatPer1000(pInstall12m: number): string {
  const per1000 = pInstall12m * 1000;
  if (per1000 < 1) return "fewer than 1 in 1,000";
  return `about ${Math.round(per1000).toLocaleString()} in 1,000`;
}

export function PropensityBadge({
  pInstall12m,
  relativeToCounty,
  countyName,
  extrapolatedFrom = null,
  reasons = [],
  showReasons = true,
}: PropensityBadgeProps) {
  return (
    <div className="propensity-badge">
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "var(--space-2)" }}>
        {relativeToCounty === null ? (
          <MissingState variant="not-loaded" reason="No county average to compare this home against yet" />
        ) : (
          <span
            style={{
              fontFamily: "var(--type-figure-font-family)",
              fontSize: "var(--type-figure-font-size)",
              fontWeight: "var(--type-figure-font-weight)",
            }}
          >
            {formatMultiplier(relativeToCounty)} the {countyName} average
          </span>
        )}
        <span style={{ fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
          &asymp; {formatPer1000(pInstall12m)} similar homes
        </span>
      </div>

      {extrapolatedFrom === "austin_installs" ? (
        <p style={{ margin: "var(--space-1) 0 0 0", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
          Predicted from Austin installs (no permit data for this city)
        </p>
      ) : null}

      {showReasons && reasons.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)", marginTop: "var(--space-2)" }}>
          {reasons.map((reason, index) => (
            <Chip
              key={`${reason.feature}-${index}`}
              signal={signalForFeature(reason.feature)}
              label={`${reason.direction === "raises" ? "↑" : "↓"} ${reason.feature}`}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
