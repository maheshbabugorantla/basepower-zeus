import type { ButtonHTMLAttributes, ReactNode } from "react";

// DESIGN.md §5 Buttons: primary is forest with white text, secondary is a
// white surface with a control-border edge. Both are 36px tall with a 4px
// radius. Focus is a 2px sky ring with a 2px offset (see
// styles/components.css .btn:focus-visible). Disabled uses ink-disabled on
// surface-sunken. Loading keeps the button's width and swaps the label for
// a spinner — it never collapses or resizes the button.

export type ButtonVariant = "primary" | "secondary";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant: ButtonVariant;
  loading?: boolean;
  children: ReactNode;
}

export function Button({
  variant,
  loading = false,
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = [
    "btn",
    variant === "primary" ? "btn--primary" : "btn--secondary",
    loading ? "btn--loading" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      {...rest}
      type={rest.type ?? "button"}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <span className="btn__spinner" aria-hidden="true" /> : null}
      <span className="btn__label">{children}</span>
    </button>
  );
}
