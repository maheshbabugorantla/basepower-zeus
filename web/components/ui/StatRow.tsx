import type { ReactNode } from "react";
import Link from "next/link";
import { Figure } from "./Figure";
import { MissingState } from "./MissingState";
import { ProvenancePopover, type ProvenancePopoverProps } from "./ProvenancePopover";

// M1-W3-b fix #2: Overview's "Ranking readiness" and "Provenance" panels
// used to embed headline Figures mid-sentence ("Of 441,961 parcels ...").
// DESIGN.md's figure pattern ("a headline figure lives inside a sentence
// ... with its provenance link beside it") is one thing inside a single
// prose panel (Outage exposure keeps that shape); a panel reporting
// several related counts reads better as a quiet stat list — one label,
// one figure, one provenance icon per row — never a grid of identical
// stat cards (DESIGN.md §6 Don't).

export type StatRowSource = Omit<ProvenancePopoverProps, "children" | "id">;

export interface StatRowProps {
  id: string;
  label: string;
  value: string | number | null;
  unit: string;
  missingReason?: string;
  source?: StatRowSource | null;
  linkHref?: string;
  linkLabel?: ReactNode;
}

export function StatRow({ id, label, value, unit, missingReason, source, linkHref, linkLabel }: StatRowProps) {
  const figureOrMissing =
    value === null ? (
      <MissingState variant="not-loaded" reason={missingReason ?? "Not loaded"} />
    ) : (
      <Figure value={value} unit={unit} />
    );

  return (
    <div className="stat-row">
      <span
        style={{
          fontFamily: "var(--type-label-font-family)",
          fontSize: "var(--type-label-font-size)",
          color: "var(--theme-ink-muted)",
        }}
      >
        {label}
      </span>
      <span className="stat-row__value">
        {source && value !== null ? (
          <ProvenancePopover id={id} {...source}>
            {figureOrMissing}
          </ProvenancePopover>
        ) : (
          figureOrMissing
        )}
        {linkHref ? (
          <Link href={linkHref} style={{ fontSize: "var(--type-label-font-size)" }}>
            {linkLabel}
          </Link>
        ) : null}
      </span>
    </div>
  );
}

export function StatList({ children }: { children: ReactNode }) {
  return <div className="stat-list">{children}</div>;
}
