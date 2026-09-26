import type { HTMLAttributes, ReactNode } from "react";

// DESIGN.md §5 top bar / freshness summary: a stale badge, shown "quiet
// unless something is stale". stale-bg/stale-ink are gold-toned, distinct
// from the grey not-loaded/not-available states and from error red.

export interface StaleBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
}

export function StaleBadge({ children, className, ...rest }: StaleBadgeProps) {
  return (
    <span
      {...rest}
      className={["badge--stale", className ?? ""].filter(Boolean).join(" ")}
      role="status"
    >
      {children}
    </span>
  );
}
