"use client";

import { Panel } from "./ui/Panel";
import { MissingState } from "./ui/MissingState";
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
  flood: "Flood risk",
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

export function equalWeights(): Record<SignalKey, number> {
  const out = {} as Record<SignalKey, number>;
  for (const key of SIGNAL_ORDER) out[key] = 1;
  return out;
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
        Team choices, not data. Moving a slider re-ranks the list.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        {SIGNAL_ORDER.map((key) => {
          const meta = REASON_META[key];
          const weight = weights[key] ?? 0;
          const pct = total > 0 ? (weight / total) * 100 : 0;
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
                <span style={{ fontFamily: "var(--type-data-font-family)", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
                  {pct.toFixed(0)}%
                </span>
              </div>
              <input
                id={`weight-${key}`}
                type="range"
                min={0}
                max={100}
                step={1}
                value={weight}
                onChange={(e) => setWeight(key, Number(e.target.value))}
                className="weight-slider"
                aria-label={`${SIGNAL_LABELS[key]} weight`}
              />
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: "var(--space-4)" }}>
        <button type="button" className="btn btn--secondary" disabled aria-disabled="true">
          Learned weights
        </button>
        <div style={{ marginTop: "var(--space-2)" }}>
          <MissingState variant="not-available" reason="Available after the M4 model runs" />
        </div>
      </div>
    </Panel>
  );
}
