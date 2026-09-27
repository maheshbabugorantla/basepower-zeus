import type { HTMLAttributes, ReactNode } from "react";

// DESIGN.md §5 Cards / Containers: a panel is a white surface, 12px radius,
// 24px padding. Panels never nest — do not render a <Panel> inside another
// <Panel>.

export interface PanelProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  /** Renders the same surface as a native <details> instead of a <div> --
   * for a manager-only disclosure (e.g. "Adjust priorities") that should
   * collapse without a second custom component. Still just one panel
   * surface with a <summary> as its first child. */
  as?: "div" | "details";
  /** Only meaningful with as="details" -- native open/closed state. */
  open?: boolean;
}

export function Panel({ children, style, as = "div", ...rest }: PanelProps) {
  const Tag = as;
  return (
    <Tag
      {...rest}
      style={{
        // DESIGN.md maps panel.backgroundColor to {colors.surface} (a
        // fixed light value — DESIGN.md defines no dark-surface variant
        // for "panel" specifically). --theme-surface is the semantic
        // token that actually swaps to dark-surface in dark mode, so the
        // panel background follows the theme rather than staying pinned
        // to light-mode white; --component-panel-background-color still
        // exists in tokens.css holding DESIGN.md's literal 1:1 mapping.
        backgroundColor: "var(--theme-surface)",
        color: "var(--theme-ink)",
        borderRadius: "var(--component-panel-rounded)",
        padding: "var(--component-panel-padding)",
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}
