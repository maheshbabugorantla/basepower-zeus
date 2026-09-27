"use client";

import { Panel } from "./ui/Panel";
import type { SignalKey } from "../app/api/top-homes/route";
import { REASON_META } from "./TopHomesTable";

// M2-W1/M2-P8: DESIGN.md §5 "Weight sliders" — label, current weight as a
// % of the total, and a reset-to-equal action; DESIGN.md §1 "Choices are
// labeled as choices" — weights are the team's parameters, never data.
// Each slider's dot reuses the same signal color as its Chip in
// TopHomesTable's "Top signals" column, so a slider and the reasons it
// produces read as the same thing. Moving any slider calls onChange
// immediately; the ~250ms debounce and the actual re-rank fetch live one
// level up in RankingBoard (the slider itself has no knowledge of the
// network call).
//
// M2-P8: 10 signals now (owner_65, home_permits, installability,
// home_value joined outage/backup_intent/age65/electric_heat/empower/
// flood), plus an "Evidence-based defaults" button (api.default_weights,
// a 2026-09-26 time-split study on real Austin permits — see
// checks/M2-P8-ranking-evidence.md) alongside "Reset to equal".
//
// Redesign (2026-09-27, critique P2 "13 flat sliders with no grouping"):
// regrouped from 3 plain headings into PRODUCT.md's own four signal
// families (outage exposure / grid value / installability / household
// fit) — the exact same signal->family map REASON_META already uses for
// every chip and meter dot (components/TopHomesTable.tsx), so a slider's
// group and its dot color always agree with the rest of the app. Lives
// behind an "Adjust priorities" disclosure (RankingBoard.tsx), not on
// the default path.

export const SIGNAL_LABELS: Record<SignalKey, string> = {
  outage: "Outage exposure",
  home_value: "Home value",
  backup_intent: "Neighbors installing backup",
  age65: "Age 65+",
  home_permits: "Own solar/EV/generator permit",
  electric_heat: "Electric heat",
  empower: "Medical need",
  owner_65: "Homeowner 65+",
  installability: "Installability",
  flood: "Outside flood zone",
  // M2-web-followup (P9/P10): income_100k/age_35_64 are block-group ACS
  // shares (neighborhood figures); permit_risk is the Austin permit-
  // timeline friction term (an installability/eligibility signal on
  // "This home", small default weight).
  income_100k: "Households earning $100k+",
  age_35_64: "Adults 35–64",
  permit_risk: "Permit friction",
};

export interface SliderGroup {
  heading: string;
  keys: SignalKey[];
}

// PRODUCT.md's four signal families, in the DESIGN.md chip order
// (outage / grid / installability / household) -- REASON_META (below,
// imported from TopHomesTable.tsx) is the single source of truth for
// which family each key belongs to; this array just walks that same map
// grouped by family; a signal absent from REASON_META would be a bug
// there, not something to special-case here.
export const SLIDER_GROUPS: SliderGroup[] = [
  { heading: "Outage exposure", keys: ["outage"] },
  { heading: "Grid value", keys: ["home_value"] },
  { heading: "Installability", keys: ["backup_intent", "home_permits", "installability", "flood", "permit_risk"] },
  { heading: "Household fit", keys: ["empower", "age65", "electric_heat", "owner_65", "income_100k", "age_35_64"] },
];

export const SIGNAL_ORDER: SignalKey[] = SLIDER_GROUPS.flatMap((g) => g.keys);

// Each slider is an importance level on a 0–10 scale; "equal" starts every
// signal at the middle (5) so the thumbs sit where people expect and have
// room to move both ways. Only the ratios matter to the score, so 5s rank
// exactly like the 1s used server-side.
export const WEIGHT_MAX = 10;
export const WEIGHT_EQUAL = 5;

export function equalWeights(): Record<SignalKey, number> {
  const out = {} as Record<SignalKey, number>;
  for (const key of SIGNAL_ORDER) out[key] = WEIGHT_EQUAL;
  return out;
}

/**
 * Each signal's share of the score, to one decimal ("16.7%"), so equal
 * weights read identically instead of 17/17/17/17/16/16. Trailing ".0" is
 * dropped ("25%", "100%").
 */
function formatShare(weight: number, total: number): string {
  if (total <= 0) return "0";
  const pct = Math.round(((weight / total) * 100) * 10) / 10;
  return Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
}

/** api.default_weights.basis, joined into one plain-language popover/title
 * string. Never fabricated — the headline numbers (135,083-home cohort,
 * 11.5x/5.1x lift, 0.727/0.682 AUC) come straight from
 * checks/M2-P8-ranking-evidence.md's own results table. */
export const DEFAULTS_EVIDENCE_SUMMARY =
  "From a 2026-09-26 study of 135,083 real gate-passed Austin homes: home value and " +
  "outage exposure showed the strongest link to later adopting a battery or generator " +
  "(11.5x higher adoption rate, top vs. bottom fifth, AUC 0.727); neighbors already " +
  "installing backup power was next strongest (5.1x, AUC 0.682). Full study: " +
  "checks/M2-P8-ranking-evidence.md.";

export interface WeightSlidersProps {
  weights: Record<SignalKey, number>;
  onChange: (weights: Record<SignalKey, number>) => void;
  onReset: () => void;
  /** api.default_weights, read server-side; null when it couldn't be read
   * (falls back to equal=5 for every key, same as onReset). */
  defaultWeights?: Record<SignalKey, number> | null;
}

export function WeightSliders({ weights, onChange, onReset, defaultWeights = null }: WeightSlidersProps) {
  const total = SIGNAL_ORDER.reduce((sum, key) => sum + (weights[key] ?? 0), 0);

  function setWeight(key: SignalKey, value: number) {
    onChange({ ...weights, [key]: value });
  }

  function applyDefaults() {
    onChange(defaultWeights ?? equalWeights());
  }

  return (
    <Panel>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "var(--space-1)", gap: "var(--space-2)", flexWrap: "wrap" }}>
        <h2
          style={{
            fontFamily: "var(--type-heading-font-family)",
            fontSize: "var(--type-heading-font-size)",
            fontWeight: "var(--type-heading-font-weight)",
            margin: 0,
          }}
        >
          Weights
        </h2>
        <span style={{ display: "flex", gap: "var(--space-2)" }}>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={applyDefaults}
            title={DEFAULTS_EVIDENCE_SUMMARY}
            data-testid="weight-defaults-button"
          >
            Evidence-based defaults
          </button>
          <button type="button" className="btn btn--secondary" onClick={onReset} data-testid="weight-reset-button">
            Reset to equal
          </button>
        </span>
      </div>
      <p style={{ margin: "0 0 var(--space-3) 0", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
        Team choices, not data. 0 ignores a signal, 10 makes it count most; % is its share of the score. Dot colors match the signal tags in the list.{" "}
        <span title={DEFAULTS_EVIDENCE_SUMMARY} style={{ borderBottom: "1px dotted var(--theme-ink-muted)", cursor: "help" }}>
          How defaults were chosen
        </span>
        {" — from a study of real Austin installs."}
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
        {SLIDER_GROUPS.map((group) => (
          <div key={group.heading}>
            <div
              style={{
                fontSize: "var(--type-label-font-size)",
                fontWeight: 600,
                color: "var(--theme-ink-muted)",
                marginBottom: "var(--space-2)",
                textTransform: "none",
              }}
            >
              {group.heading}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
              {group.keys.map((key) => {
                const meta = REASON_META[key];
                const weight = weights[key] ?? 0;
                const pct = formatShare(weight, total);
                return (
                  <div key={key} style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <label htmlFor={`weight-${key}`} style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}>
                        <span
                          aria-hidden="true"
                          style={{
                            width: 10,
                            height: 10,
                            minWidth: 10,
                            borderRadius: "var(--rounded-full)",
                            backgroundColor: meta ? `var(--color-signal-${meta.signal})` : "var(--theme-ink-muted)",
                          }}
                        />
                        <span style={{ fontSize: "var(--type-body-font-size)" }}>{SIGNAL_LABELS[key]}</span>
                      </label>
                      <span style={{ fontSize: "var(--type-label-font-size)", whiteSpace: "nowrap", color: "var(--theme-ink-muted)" }}>
                        <span style={{ fontFamily: "var(--type-data-font-family)", color: "var(--theme-ink)", fontWeight: 600 }}>{weight}</span>
                        {" · "}
                        {weight === 0 ? (
                          "off"
                        ) : (
                          <>
                            <span style={{ fontFamily: "var(--type-data-font-family)" }}>{pct}%</span> of score
                          </>
                        )}
                      </span>
                    </div>
                    <input
                      id={`weight-${key}`}
                      type="range"
                      min={0}
                      max={WEIGHT_MAX}
                      step={1}
                      value={weight}
                      onChange={(e) => setWeight(key, Number(e.target.value))}
                      className="weight-slider"
                      style={{ ["--fill" as string]: `${(weight / WEIGHT_MAX) * 100}%` }}
                      aria-label={`${SIGNAL_LABELS[key]} importance`}
                      aria-valuetext={weight === 0 ? "off" : `${weight} of ${WEIGHT_MAX}, ${pct} percent of the score`}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <p style={{ margin: "var(--space-4) 0 0", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
        Learned weights (from Base&rsquo;s own sign-ups) are not available yet.
      </p>
    </Panel>
  );
}
