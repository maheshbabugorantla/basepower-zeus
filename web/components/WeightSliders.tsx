"use client";

import { Panel } from "./ui/Panel";
import type { SignalKey } from "../app/api/top-homes/route";
import { REASON_META } from "./TopHomesTable";

// M2-W1: DESIGN.md §5 "Weight sliders" — label, current weight as a % of
// the total, and a reset-to-equal action; DESIGN.md §1 "Choices are
// labeled as choices" — weights are the team's parameters, never data.
// Each slider's dot reuses the same signal color as its Chip in
// TopHomesTable's "Top signals" column, so a slider and the reasons it
// produces read as the same thing. Moving any slider calls onChange
// immediately; the ~250ms debounce and the actual re-rank fetch live one
// level up in RankingBoard (the slider itself has no knowledge of the
// network call).

export const SIGNAL_LABELS: Record<SignalKey, string> = {
  outage: "Outage exposure",
  flood: "Outside flood zone",
  empower: "Medical need",
  age65: "Age 65+",
  electric_heat: "Electric heat",
  backup_intent: "Backup intent",
};

export const SIGNAL_ORDER: SignalKey[] = [
  "outage",
  "flood",
  "empower",
  "age65",
  "electric_heat",
  "backup_intent",
];

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

export interface WeightSlidersProps {
  weights: Record<SignalKey, number>;
  onChange: (weights: Record<SignalKey, number>) => void;
  onReset: () => void;
}

export function WeightSliders({ weights, onChange, onReset }: WeightSlidersProps) {
  const total = SIGNAL_ORDER.reduce((sum, key) => sum + (weights[key] ?? 0), 0);

  function setWeight(key: SignalKey, value: number) {
    onChange({ ...weights, [key]: value });
  }

  return (
    <Panel>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "var(--space-1)" }}>
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
        <button type="button" className="btn btn--secondary" onClick={onReset}>
          Reset to equal
        </button>
      </div>
      <p style={{ margin: "0 0 var(--space-3) 0", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
        Team choices, not data. 0 ignores a signal, 10 makes it count most; % is its share of the score. Dot colors match the signal tags in the list.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        {SIGNAL_ORDER.map((key) => {
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
                      backgroundColor: `var(--color-signal-${meta.signal})`,
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

      <p style={{ margin: "var(--space-4) 0 0", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
        Learned weights (from Base&rsquo;s own sign-ups) are not available yet.
      </p>
    </Panel>
  );
}
