"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { MissingState } from "../../components/ui/MissingState";
import { PriorityTierBadge } from "../../components/ui/PriorityTierBadge";
import { Chip } from "../../components/ui/Chip";
import { utilityStatusForHome, plainReason, isEligibleReason } from "../../lib/priorityTier";
import type { PredictedHomeRow } from "../api/top-homes/route";

// M4-W2: the default ranking view -- one row per home, ordered by
// api.home_propensity.p_install_12m (read straight through by the route,
// never recomputed here).
//
// Layout-review fix: this used to be an HTML <table> with a fixed
// colgroup, which let a long address wrap into the next column and let
// long reason chips overlap the row below at 1440px. Rewritten as a CSS
// grid "row" (role=table/row/cell, the same ARIA pattern PredictionProof.tsx
// already uses for a precise, non-<table> layout) with a fixed 4-column
// template, an ellipsis on the address, and priority+reasons pinned to
// one non-wrapping line -- so >=5 rows are visible at 1440x900 without
// scrolling, per the review's own acceptance bar.

function formatAddressLine(row: PredictedHomeRow): string {
  const parts = [row.situsNum, row.situsStreet].filter(Boolean).join(" ");
  const city = row.situsCity ?? "";
  return [parts, city].filter((s) => s && s.trim() !== "").join(", ");
}

function blockGroupShortLabel(geoid: string): string | null {
  if (!/^\d{12}$/.test(geoid)) return null;
  const tractRaw = geoid.slice(5, 11);
  const tract = `${Number(tractRaw.slice(0, 4))}${tractRaw.slice(4) === "00" ? "" : `.${tractRaw.slice(4)}`}`;
  return `Tract ${tract}`;
}

const ROW_GRID_TEMPLATE = "28px minmax(80px, 1fr) minmax(150px, 220px) minmax(90px, 110px)";

export interface PredictedHomesTableProps {
  rows: PredictedHomeRow[];
  /** Kept for callers that still pass it (unused in this render -- PropensityBadge no longer shows a county-relative figure). */
  countyName?: string;
  rangeStart?: number;
  hoveredPropId?: string | null;
  onHoverRow?: (row: PredictedHomeRow | null) => void;
  scrollToPropId?: string | null;
}

export function PredictedHomesTable({
  rows,
  rangeStart = 1,
  hoveredPropId = null,
  onHoverRow,
  scrollToPropId,
}: PredictedHomesTableProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!scrollToPropId) return;
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-prop-id="${scrollToPropId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [scrollToPropId]);

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
        <span role="columnheader">Home</span>
        <span role="columnheader">Priority &amp; why</span>
        <span role="columnheader">Utility</span>
      </div>
      {rows.map((row, index) => {
        const addressLine = formatAddressLine(row);
        const title = [addressLine, row.situsZip].filter(Boolean).join(" ") || row.propId;
        const isHovered = hoveredPropId === row.propId;
        const utilityStatus = utilityStatusForHome({
          gateReason: row.gateReason,
          territoryNullReason: row.territoryNullReason,
        });
        const hasBackup = row.coverageBucket === "base_customer" || row.coverageBucket === "other_backup";
        const neighborhood = blockGroupShortLabel(row.blockGroupGeoid);
        const metaLine = [row.situsZip, neighborhood, row.yrBuilt ? `built ${row.yrBuilt}` : null]
          .filter(Boolean)
          .join(" · ");
        const shownReasons = row.reasons
          .filter((r) => r.direction === "raises" && isEligibleReason(r.feature))
          .slice(0, 2);

        return (
          <div
            key={row.propId}
            role="row"
            className="predicted-homes-table__row predicted-homes-table__row--body"
            style={{ gridTemplateColumns: ROW_GRID_TEMPLATE }}
            data-hovered={isHovered || undefined}
            data-testid="predicted-homes-row"
            data-prop-id={row.propId}
            onMouseEnter={() => onHoverRow?.(row)}
            onMouseLeave={() => onHoverRow?.(null)}
          >
            <span role="cell" style={{ color: "var(--theme-ink-muted)" }}>
              {rangeStart + index}
            </span>
            <span role="cell" className="predicted-homes-table__home-cell">
              <Link href={`/home/${row.propId}`} className="top-homes-address" title={title}>
                {addressLine || row.propId}
              </Link>
              <div className="top-homes-zip">{metaLine || " "}</div>
              {hasBackup ? (
                <div style={{ fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
                  Already has backup
                </div>
              ) : null}
            </span>
            <span role="cell" className="predicted-homes-table__priority-cell">
              {row.decile === null ? (
                <MissingState variant="not-loaded" reason="Not scored yet" />
              ) : (
                <PriorityTierBadge decile={row.decile} compact />
              )}
              {shownReasons.length > 0 ? (
                <span className="predicted-homes-table__reasons">
                  {shownReasons.map((reason, i) => (
                    <Chip key={`${reason.feature}-${i}`} signal="install" label={plainReason(reason.feature)} />
                  ))}
                </span>
              ) : null}
            </span>
            <span role="cell" data-testid="utility-status" data-status={utilityStatus.key}>
              {utilityStatus.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
