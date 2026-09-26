import type { HTMLAttributes } from "react";

// DESIGN.md §5 Chips: a pill with a 10px dot in the signal color, the
// signal name, and (for county/zone-level signals that can't separate
// homes within a county) a label suffix like "same for all Travis homes".
// `signal` is one of the four named DESIGN.md signal categories, not a
// free-form color — the chip resolves it to that signal's fill (and, per
// "Light fills always carry their edge color", its edge/border color
// where DESIGN.md defines one: grid and household do, outage and install
// don't).

export type SignalName = "outage" | "grid" | "install" | "household";

const SIGNAL_FILL: Record<SignalName, string> = {
  outage: "var(--color-signal-outage)",
  grid: "var(--color-signal-grid)",
  install: "var(--color-signal-install)",
  household: "var(--color-signal-household)",
};

// Only grid and household have a named "-edge" token in DESIGN.md.
const SIGNAL_EDGE: Partial<Record<SignalName, string>> = {
  grid: "var(--color-signal-grid-edge)",
  household: "var(--color-signal-household-edge)",
};

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  label: string;
  signal: SignalName;
  /** e.g. "same for all Travis homes" — omitted for parcel-level signals. */
  scope?: string;
}

export function Chip({ label, signal, scope, className, ...rest }: ChipProps) {
  const edge = SIGNAL_EDGE[signal];
  return (
    <span {...rest} className={["chip", className ?? ""].filter(Boolean).join(" ")}>
      <span
        className="chip__dot"
        data-signal={signal}
        style={{
          backgroundColor: SIGNAL_FILL[signal],
          border: edge ? `1px solid ${edge}` : undefined,
        }}
        aria-hidden="true"
      />
      <span className="chip__label">{label}</span>
      {scope ? <span className="chip__scope">{scope}</span> : null}
    </span>
  );
}
