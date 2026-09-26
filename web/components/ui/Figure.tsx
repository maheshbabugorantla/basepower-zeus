import type { HTMLAttributes } from "react";

// DESIGN.md §3 "The Unit Rule": every figure carries its unit
// ("customer-hours", "$/MWh", "per 1,000 homes", "days") — a bare number
// is incomplete. `unit` is required both at the type level and at
// runtime. `value` is left as string | number so a caller can pass either
// a real query result or a MissingState-carrying node instead — but a
// literal example value must never be hard-coded by a page; it always
// comes from an `api.*` view.

export interface FigureProps extends HTMLAttributes<HTMLSpanElement> {
  value: string | number;
  unit: string;
}

export function Figure({ value, unit, className, ...rest }: FigureProps) {
  if (!unit || unit.trim() === "") {
    throw new Error("Figure requires a non-empty `unit` — a bare number is incomplete.");
  }

  return (
    <span {...rest} className={["figure", className ?? ""].filter(Boolean).join(" ")}>
      <span
        className="figure__value"
        style={{
          fontFamily: "var(--type-figure-font-family)",
          fontSize: "var(--type-figure-font-size)",
          fontWeight: "var(--type-figure-font-weight)",
          lineHeight: "var(--type-figure-line-height)",
          letterSpacing: "var(--type-figure-letter-spacing)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </span>{" "}
      <span
        className="figure__unit"
        style={{
          fontFamily: "var(--type-label-font-family)",
          fontSize: "var(--type-label-font-size)",
          fontWeight: "var(--type-label-font-weight)",
          color: "var(--theme-ink-muted)",
        }}
      >
        {unit}
      </span>
    </span>
  );
}
