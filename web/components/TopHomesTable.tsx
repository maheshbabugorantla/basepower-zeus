"use client";

import { useState } from "react";

import Link from "next/link";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
} from "./ui/DataTable";
import { MissingState } from "./ui/MissingState";
import { Chip, type SignalName } from "./ui/Chip";

// M2-W1: top-50 table from api.top_homes_weighted (score v1, re-ranked
// live by WeightSliders — see app/ranking/RankingBoard.tsx). Every row
// still links to /home/[prop_id] (M1-W1 acceptance, unchanged). The old
// single "rate/1k homes" chip (M1, backup-intent-only) is replaced by the
// function's own top-3 `reasons`, rendered as signal-colored chips
// (DESIGN.md §5 Chips) so the ranking reads as multi-signal even before
// every M2 pipeline has loaded.

export interface TopHomeRow {
  propId: string;
  situsNum: string | null;
  situsStreet: string | null;
  situsCity: string | null;
  situsZip: string | null;
  marketValue: number | null;
  blockGroupGeoid: string;
  countyFips: string | null;
  score: number | null;
  /** api.top_homes_weighted's top-3 nonzero-contributing signal keys, in order. */
  reasons: string[];
  distributorName: string | null;
  distributorSaidi: number | null;
  distributorSaidiYear: number | null;
  distributorSaidiEarlyRelease: boolean | null;
  floodFlag: boolean | null;
  empowerRate: number | null;
  acsPct65Plus: number | null;
  acsPctElectricHeat: number | null;
  backupIntentRate: number | null;
}

/** api.top_homes_weighted's reason keys -> a short label + DESIGN.md signal
 * category for the chip dot. outage is a "will this home lose power"
 * exposure signal -> the outage (grid-off red) category. flood is an
 * INSTALLABILITY signal (0204_flood_direction.sql: the score favors
 * homes OUTSIDE a FEMA flood zone, per PRODUCT.md/the spec's Signals
 * table) -> install (deep blue), not outage red. empower/age65/
 * electric_heat are household-need signals -> household (sky).
 * backup_intent (a demonstrated interest in battery/generator backup) ->
 * install (deep blue) too. */
export const REASON_META: Record<string, { label: string; signal: SignalName }> = {
  outage: { label: "Outage exposure", signal: "outage" },
  flood: { label: "Outside flood zone", signal: "install" },
  empower: { label: "Medical need", signal: "household" },
  age65: { label: "Age 65+", signal: "household" },
  electric_heat: { label: "Electric heat", signal: "household" },
  backup_intent: { label: "Backup intent", signal: "install" },
};

function formatAddressLine(row: TopHomeRow): string {
  const parts = [row.situsNum, row.situsStreet].filter(Boolean).join(" ");
  const city = row.situsCity ?? "";
  return [parts, city].filter((s) => s && s.trim() !== "").join(", ");
}

export interface TopHomesTableProps {
  rows: TopHomeRow[];
  hoveredGeoid?: string | null;
  onHoverRow?: (geoid: string | null) => void;
  /** propId -> rank delta (oldRank - newRank; positive = moved up). Cleared 2s after a re-rank. */
  rankDeltas?: Map<string, number>;
}

export function TopHomesTable({ rows, onHoverRow, rankDeltas }: TopHomesTableProps) {
  // Highlight only the row under the cursor. Highlighting every row in the
  // hovered row's block group painted most of the list (the top homes share
  // a few block groups); the map already shows the block group.
  const [hoveredPropId, setHoveredPropId] = useState<string | null>(null);
  if (rows.length === 0) {
    return (
      <MissingState
        variant="not-loaded"
        reason="api.top_homes_weighted returned no rows — no homes have a nonzero weight sum, or no homes have passed the gate yet"
      />
    );
  }

  return (
    <DataTable className="data-table--top-homes" style={{ tableLayout: "fixed" }}>
      <colgroup>
        <col style={{ width: "40px" }} />
        <col />
        <col style={{ width: "88px" }} />
        <col style={{ width: "180px" }} />
      </colgroup>
      <DataTableHead>
        <DataTableRow>
          <DataTableHeaderCell>#</DataTableHeaderCell>
          <DataTableHeaderCell>Home</DataTableHeaderCell>
          <DataTableHeaderCell>Score</DataTableHeaderCell>
          <DataTableHeaderCell>Top signals</DataTableHeaderCell>
        </DataTableRow>
      </DataTableHead>
      <DataTableBody>
        {rows.map((row, index) => {
          const addressLine = formatAddressLine(row);
          const title = [addressLine, row.situsZip].filter(Boolean).join(" ") || row.propId;
          const delta = rankDeltas?.get(row.propId);
          return (
            <DataTableRow
              key={row.propId}
              className="data-table__row--hoverable"
              data-hovered={hoveredPropId === row.propId || undefined}
              onMouseEnter={() => { setHoveredPropId(row.propId); onHoverRow?.(row.blockGroupGeoid); }}
              onMouseLeave={() => { setHoveredPropId(null); onHoverRow?.(null); }}
            >
              <DataTableCell>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-1)" }}>
                  <span style={{ color: "var(--theme-ink-muted)" }}>{index + 1}</span>
                  {delta && delta !== 0 ? (
                    <span
                      className={delta > 0 ? "rank-delta rank-delta--up" : "rank-delta rank-delta--down"}
                      aria-label={delta > 0 ? `Moved up ${delta}` : `Moved down ${Math.abs(delta)}`}
                    >
                      {delta > 0 ? "↑" : "↓"}
                      {Math.abs(delta)}
                    </span>
                  ) : null}
                </span>
              </DataTableCell>
              <DataTableCell>
                <Link href={`/home/${row.propId}`} className="top-homes-address" title={title}>
                  {addressLine || row.propId}
                </Link>
                {row.situsZip ? <div className="top-homes-zip">{row.situsZip}</div> : null}
              </DataTableCell>
              <DataTableCell>
                {row.score === null ? (
                  <MissingState variant="not-loaded" reason="No signal has a nonzero weight for this home" />
                ) : (
                  <div className="top-homes-score">
                    <span className="top-homes-score__bar-track">
                      <span
                        className="top-homes-score__bar-fill"
                        style={{ width: `${Math.max(0, Math.min(1, row.score)) * 100}%` }}
                      />
                    </span>
                    <span style={{ fontFamily: "var(--type-data-font-family)" }}>{row.score.toFixed(3)}</span>
                  </div>
                )}
              </DataTableCell>
              <DataTableCell>
                {row.reasons.length === 0 ? (
                  <MissingState variant="not-loaded" reason="No weighted signal available for this home" />
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)" }}>
                    {row.reasons.map((reason) => {
                      const meta = REASON_META[reason];
                      if (!meta) return null;
                      return <Chip key={reason} label={meta.label} signal={meta.signal} />;
                    })}
                  </div>
                )}
              </DataTableCell>
            </DataTableRow>
          );
        })}
      </DataTableBody>
    </DataTable>
  );
}
