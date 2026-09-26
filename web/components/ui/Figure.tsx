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
          // M2-W1 responsive fix: a fixed 2.25rem (36px) figure could
          // overflow a narrow Overview panel (800px width) — clamp so it
          // shrinks instead. 1rem + 1.5vw is ~28px at an 800px viewport
          // and ~32px at 1100px (16px base font), staying below the
          // 36px ceiling at both, and reaches the ceiling itself above
          // ~1387px — never below 1.375rem (22px), never above the
          // DESIGN.md token value.
          fontSize: "clamp(1.375rem, 1rem + 1.5vw, var(--type-figure-font-size))",
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
