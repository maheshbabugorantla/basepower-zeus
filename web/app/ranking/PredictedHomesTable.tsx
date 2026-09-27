"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
} from "../../components/ui/DataTable";
import { MissingState } from "../../components/ui/MissingState";
import { PropensityBadge } from "../../components/PropensityBadge";
import { utilityStatusForHome } from "../../lib/priorityTier";
import type { PredictedHomeRow } from "../api/top-homes/route";

// M4-W2: the default ranking view -- one row per home, ordered by
// api.home_propensity.p_install_12m (read straight through by the route,
// never recomputed here). web/components/TopHomesTable.tsx is a
// different ticket's file (M2-W3/M2-W1), so this is a sibling component
// rather than an edit to it; RankingBoard.tsx picks between the two by
// the ranking mode. Same row shape/behavior (address links to
// /home/[prop_id], hover highlighting) as the team-weighted table, so
// switching modes doesn't jar.

function formatAddressLine(row: PredictedHomeRow): string {
  const parts = [row.situsNum, row.situsStreet].filter(Boolean).join(" ");
  const city = row.situsCity ?? "";
  return [parts, city].filter((s) => s && s.trim() !== "").join(", ");
}

export interface PredictedHomesTableProps {
  rows: PredictedHomeRow[];
  /** Plain county name for PropensityBadge's "N x the <county> average". */
  countyName: string;
  rangeStart?: number;
  hoveredPropId?: string | null;
  onHoverRow?: (row: PredictedHomeRow | null) => void;
  scrollToPropId?: string | null;
}

export function PredictedHomesTable({
  rows,
  countyName,
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
    <div ref={containerRef}>
      <DataTable className="data-table--top-homes" style={{ tableLayout: "fixed" }}>
        <colgroup>
          <col style={{ width: "40px" }} />
          <col />
          <col style={{ width: "220px" }} />
          <col style={{ width: "160px" }} />
        </colgroup>
        <DataTableHead>
          <DataTableRow>
            <DataTableHeaderCell>#</DataTableHeaderCell>
            <DataTableHeaderCell>Home</DataTableHeaderCell>
            <DataTableHeaderCell>Priority &amp; why</DataTableHeaderCell>
            <DataTableHeaderCell>Utility</DataTableHeaderCell>
          </DataTableRow>
        </DataTableHead>
        <DataTableBody>
          {rows.map((row, index) => {
            const addressLine = formatAddressLine(row);
            const title = [addressLine, row.situsZip].filter(Boolean).join(" ") || row.propId;
            const isHovered = hoveredPropId === row.propId;
            const utilityStatus = utilityStatusForHome({
              gateReason: row.gateReason,
              territoryNullReason: row.territoryNullReason,
            });
            const hasBackup = row.coverageBucket === "base_customer" || row.coverageBucket === "other_backup";
            return (
              <DataTableRow
                key={row.propId}
                className="data-table__row--hoverable"
                data-hovered={isHovered || undefined}
                data-testid="predicted-homes-row"
                data-prop-id={row.propId}
                onMouseEnter={() => onHoverRow?.(row)}
                onMouseLeave={() => onHoverRow?.(null)}
              >
                <DataTableCell>
                  <span style={{ color: "var(--theme-ink-muted)" }}>{rangeStart + index}</span>
                </DataTableCell>
                <DataTableCell>
                  <Link href={`/home/${row.propId}`} className="top-homes-address" title={title}>
                    {addressLine || row.propId}
                  </Link>
                  <div className="top-homes-zip">
                    {[row.situsZip, row.yrBuilt ? `built ${row.yrBuilt}` : null].filter(Boolean).join(" · ")}
                  </div>
                  {hasBackup ? (
                    <div style={{ fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
                      Already has backup
                    </div>
                  ) : null}
                </DataTableCell>
                <DataTableCell>
                  <PropensityBadge
                    pInstall12m={row.pInstall12m}
                    relativeToCounty={row.relativeToCounty}
                    decile={row.decile}
                    countyName={countyName}
                    extrapolatedFrom={row.extrapolatedFrom}
                    reasons={row.reasons}
                    maxReasons={2}
                    showReasons
                  />
                </DataTableCell>
                <DataTableCell>
                  <span data-testid="utility-status" data-status={utilityStatus.key}>
                    {utilityStatus.label}
                  </span>
                </DataTableCell>
              </DataTableRow>
            );
          })}
        </DataTableBody>
      </DataTable>
    </div>
  );
}
