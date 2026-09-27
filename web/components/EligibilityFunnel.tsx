import { Panel } from "./ui/Panel";

// M1-W3 fix #4: Main.dc.html's "Who is eligible" funnel — a stacked list
// of gates with a proportional bar, each step's width relative to the
// first (total) step. Every `value`/`ratio` here comes from a real
// api.parcel_gate_counts + api.gate_counts query in app/ranking/page.tsx
// (M2-W1 perf fix: precomputed reads only, never a live core.parcels
// scan or ST_Within join) — never a literal number.

export interface FunnelStep {
  label: string;
  value: number;
  /** 0..1, this step's count divided by the funnel's first step. */
  ratio: number;
}

export function EligibilityFunnel({
  steps,
  note,
  // T7 fix: this footer used to hardcode "the 2026 Travis Central
  // Appraisal District roll" regardless of which county's funnel is
  // shown -- callers now pass the real per-county appraisal-district
  // name (lib/counties.ts CAD_NAME).
  appraisalDistrictName = "Travis Central Appraisal District",
}: {
  steps: FunnelStep[];
  note?: string;
  appraisalDistrictName?: string;
}) {
  return (
    <Panel>
      <h2
        style={{
          fontFamily: "var(--type-heading-font-family)",
          fontSize: "var(--type-heading-font-size)",
          fontWeight: "var(--type-heading-font-weight)",
          marginTop: 0,
        }}
      >
        Who is eligible
      </h2>
      {note ? (
        <p style={{ margin: "0 0 var(--space-2) 0", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
          {note}
        </p>
      ) : null}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        {steps.map((step) => (
          <div key={step.label} style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "var(--type-body-font-size)",
              }}
            >
              <span>{step.label}</span>
              <span style={{ fontFamily: "var(--type-data-font-family)", fontWeight: 600 }}>
                {step.value.toLocaleString()}
              </span>
            </div>
            <div className="funnel-row__track">
              <div
                className="funnel-row__fill"
                style={{ width: `${Math.max(0, Math.min(1, step.ratio)) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <p style={{ fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)", marginBottom: 0 }}>
        From the {appraisalDistrictName}&rsquo;s roll. The next panel shows which of these homes Base can serve.
      </p>
    </Panel>
  );
}
