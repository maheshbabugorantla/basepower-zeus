"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { MissingState } from "../../components/ui/MissingState";
import { PriorityTierBadge } from "../../components/ui/PriorityTierBadge";
import { Chip } from "../../components/ui/Chip";
import { CaseForKnock } from "../../components/CaseForKnock";
import { utilityStatusForHome, reasonPhraseForContext, isEligibleReason } from "../../lib/priorityTier";
import { equalWeights } from "../../components/WeightSliders";
import type { PredictedHomeRow } from "../api/top-homes/route";

// M4-W2: the default ranking view -- one row per home, ordered by
// api.home_propensity.p_install_12m (read straight through by the route,
// never recomputed here).
//
// Layout-review fix: this used to be an HTML <table> with a fixed
// colgroup, which let a long address wrap into the next column and let
// long reason chips overlap the row below at 1440px. Rewritten as a CSS
// grid "row" (role=table/row/cell, the same ARIA pattern PredictionProof.tsx
// already uses for a precise, non-<table> layout).
//
// Map-as-dominant-surface pivot: the list is now a narrow (~30%) side
// column, not a wide table -- a 4-column row (address | priority |
// utility) clipped mid-word at that width. Down to 2 columns: # and a
// single stacked cell (address, meta, tier + utility, reasons).
//
// Redesign (Mock A, critique P0 "home detail opens in place"): a row can
// expand in place to the case for a knock (CaseForKnock, real breakdown
// terms, no LLM/synthetic data) instead of a route change -- the deep
// link (/home/[prop_id]) stays for "Open full record."

function formatAddressLine(row: PredictedHomeRow): string {
  const parts = [row.situsNum, row.situsStreet].filter(Boolean).join(" ");
  const city = row.situsCity ?? "";
  return [parts, city].filter((s) => s && s.trim() !== "").join(", ");
}

const ROW_GRID_TEMPLATE = "20px minmax(0, 1fr)";

export interface PredictedHomesTableProps {
  rows: PredictedHomeRow[];
  /** Kept for callers that still pass it (unused in this render -- PropensityBadge no longer shows a county-relative figure). */
  countyName?: string;
  rangeStart?: number;
  hoveredPropId?: string | null;
  onHoverRow?: (row: PredictedHomeRow | null) => void;
  scrollToPropId?: string | null;
  /** Redesign (Mock A): the one row expanded in place. */
  expandedPropId?: string | null;
  onToggleExpand?: (propId: string) => void;
  onLocateOnMap?: (row: PredictedHomeRow) => void;
}

export function PredictedHomesTable({
  rows,
  rangeStart = 1,
  hoveredPropId = null,
  onHoverRow,
  scrollToPropId,
  expandedPropId = null,
  onToggleExpand,
  onLocateOnMap,
}: PredictedHomesTableProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!scrollToPropId) return;
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-prop-id="${scrollToPropId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [scrollToPropId]);

  useEffect(() => {
    if (!expandedPropId) return;
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-prop-id="${expandedPropId}"]`);
    el?.scrollIntoView({ block: "nearest" });
    el?.focus?.();
  }, [expandedPropId]);

  if (rows.length === 0) {
    return <MissingState variant="not-loaded" reason="No homes to rank yet" />;
  }

  return (
    <div ref={containerRef} className="predicted-homes-table" role="table" aria-label="Homes ranked by priority">
      <div
        role="row"
        className="predicted-homes-table__row predicted-homes-table__row--head"
        style={{ gridTemplateColumns: ROW_GRID_TEMPLATE }}
      >
        <span role="columnheader">#</span>
        <span role="columnheader">Home / priority / utility</span>
      </div>
      {rows.map((row, index) => {
        const addressLine = formatAddressLine(row);
        const title = [addressLine, row.situsZip].filter(Boolean).join(" ") || row.propId;
        const isHovered = hoveredPropId === row.propId;
        const isExpanded = expandedPropId === row.propId;
        const utilityStatus = utilityStatusForHome({
          gateReason: row.gateReason,
          territoryNullReason: row.territoryNullReason,
        });
        const hasBackup = row.coverageBucket === "base_customer" || row.coverageBucket === "other_backup";
        // Layout-review fix: no census-tract jargon ("Tract 1.02") --
        // this app has no real named-neighborhood data source yet, so
        // that slot is simply omitted rather than filled with a
        // block-group id dressed up as one.
        const metaLine = [row.situsZip, row.yrBuilt ? `built ${row.yrBuilt}` : null].filter(Boolean).join(" · ");
        const shownReasons = row.reasons
          .filter((r) => r.direction === "raises" && isEligibleReason(r.feature))
          .slice(0, 2);

        return (
          <div
            key={row.propId}
            role="row"
            tabIndex={-1}
            className={
              "predicted-homes-table__row predicted-homes-table__row--body" +
              (isExpanded ? " predicted-homes-table__row--expanded" : "")
            }
            style={{ gridTemplateColumns: ROW_GRID_TEMPLATE }}
            data-hovered={isHovered || undefined}
            data-testid="predicted-homes-row"
            data-prop-id={row.propId}
            onMouseEnter={() => onHoverRow?.(row)}
            onMouseLeave={() => onHoverRow?.(null)}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("a")) return;
              onToggleExpand?.(row.propId);
            }}
          >
            <span role="cell" style={{ color: "var(--theme-ink-muted)", paddingTop: "2px" }}>
              {rangeStart + index}
            </span>
            <span role="cell" className="predicted-homes-table__home-cell">
              <Link href={`/home/${row.propId}`} className="top-homes-address" title={title}>
                {addressLine || row.propId}
              </Link>
              <div className="top-homes-zip">{metaLine || " "}</div>
              {hasBackup ? (
                <div style={{ fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
                  Already has backup
                </div>
              ) : null}
              <div className="predicted-homes-table__priority-cell">
                {row.decile === null ? (
                  <MissingState variant="not-loaded" reason="Not scored yet" />
                ) : (
                  <PriorityTierBadge decile={row.decile} compact />
                )}
                <span data-testid="utility-status" data-status={utilityStatus.key} className="predicted-homes-table__utility">
                  {utilityStatus.label}
                </span>
              </div>
              {shownReasons.length > 0 ? (
                <span className="predicted-homes-table__reasons">
                  {shownReasons.map((reason, i) => (
                    <Chip
                      key={`${reason.feature}-${i}`}
                      signal="install"
                      label={reasonPhraseForContext(reason.feature, utilityStatus.key)}
                    />
                  ))}
                </span>
              ) : null}

              {isExpanded ? (
                <div className="row-expand" onClick={(e) => e.stopPropagation()}>
                  <CaseForKnock
                    propId={row.propId}
                    weights={equalWeights()}
                    sourceNames={["Austin permits", "Travis CAD", "ACS 2024", "EIA-861"]}
                    compact
                  />
                  <div className="row-expand__actions">
                    <Link href={`/home/${row.propId}`}>Open full record →</Link>
                    <button type="button" className="row-expand__link" onClick={() => onLocateOnMap?.(row)}>
                      Locate on map
                    </button>
                    <Link href={`/home/${row.propId}?tab=signals`}>All 12 signals</Link>
                  </div>
                </div>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}
