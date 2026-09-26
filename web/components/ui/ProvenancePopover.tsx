import type { ReactNode } from "react";
import { CopyShaButton } from "./CopyShaButton";
import { ProvenancePopoverAnchor } from "./ProvenancePopoverAnchor";

// DESIGN.md §5 "Signature component: Provenance popover" — every sourced
// number is a button styled as text with a dotted underline; activating it
// opens a popover, anchored to the number, via the native popover API (so
// it is never clipped), showing: dataset name + URL, retrieval time,
// truncated SHA-256 (full on copy), pipeline run ID + runner, rows
// in/loaded, and a "View raw file" link. All values are props — a page
// passes them from a real api.sources row; nothing here is a literal
// example value.

export interface ProvenancePopoverProps {
  /** The sourced number/text this popover is attached to. */
  children: ReactNode;
  dataset: string;
  url: string;
  retrievedAt: string;
  sha256: string;
  runId: string;
  runner: "cron" | "cli";
  rowsIn: number | null;
  rowsLoaded: number | null;
  rawFileHref: string;
  /**
   * A unique id for this popover instance. Required, not defaulted: a
   * ranked list can cite the same source (same dataset+sha256) from many
   * rows, and a dataset/sha256-derived default would give every one of
   * those rows' popovers the same id, so activating any of them would
   * always open the first row's popover. Callers should pass something
   * that is unique per rendered row, e.g. the row's own id plus the
   * signal name (`${homeId}-outage-provenance`).
   */
  id: string;
}

function truncateSha(sha256: string): string {
  return sha256.length > 12 ? `${sha256.slice(0, 12)}…` : sha256;
}

export function ProvenancePopover({
  children,
  dataset,
  url,
  retrievedAt,
  sha256,
  runId,
  runner,
  rowsIn,
  rowsLoaded,
  rawFileHref,
  id,
}: ProvenancePopoverProps) {
  const triggerId = `${id}-trigger`;
  const popoverId = `${id}-popover`;

  return (
    <>
      <span>{children}</span>
      <button
        type="button"
        id={triggerId}
        aria-label="Show source"
        className="provenance-trigger"
        popoverTarget={popoverId}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 7.2v3.6M8 5.2v.01" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </button>
      <span id={popoverId} popover="auto" className="provenance-popover">
        <span className="provenance-popover__row">
          <span className="provenance-popover__label">Dataset</span>
          <span className="provenance-popover__value">
            <a href={url} target="_blank" rel="noreferrer noopener">
              {dataset}
            </a>
          </span>
        </span>
        <span className="provenance-popover__row">
          <span className="provenance-popover__label">Retrieved</span>
          <span className="provenance-popover__value">{retrievedAt}</span>
        </span>
        <span className="provenance-popover__row">
          <span className="provenance-popover__label">SHA-256</span>
          <span className="provenance-popover__value" title={sha256}>
            <code>{truncateSha(sha256)}</code>
            <CopyShaButton sha256={sha256} />
          </span>
        </span>
        <span className="provenance-popover__row">
          <span className="provenance-popover__label">Pipeline run</span>
          <span className="provenance-popover__value">
            {runId} ({runner})
          </span>
        </span>
        <span className="provenance-popover__row">
          <span className="provenance-popover__label">Rows in / loaded</span>
          <span className="provenance-popover__value">
            {rowsIn === null ? "not recorded" : rowsIn} /{" "}
            {rowsLoaded === null ? "not recorded" : rowsLoaded}
          </span>
        </span>
        <span className="provenance-popover__row">
          <a href={rawFileHref}>View raw file</a>
        </span>
      </span>
      <ProvenancePopoverAnchor triggerId={triggerId} popoverId={popoverId} />
    </>
  );
}
