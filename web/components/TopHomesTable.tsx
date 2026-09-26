"use client";

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

// M1-W1: top-50 table from api.top_homes. Every row links to
// /home/[prop_id] (acceptance criterion). Hovering a row highlights its
// block group on the map — the hover handlers are plain props so this
// component itself stays server-renderable-shaped (no internal state);
// the "use client" boundary for the actual hover *state* lives one level
// up, in app/ranking/RankingBoard.tsx.

export interface TopHomeRow {
  propId: string;
  situsNum: string | null;
  situsStreet: string | null;
  situsCity: string | null;
  situsZip: string | null;
  marketValue: number | null;
  blockGroupGeoid: string;
  score: number | null;
  ratePer1000: number | null;
  reasons: string[];
}

function formatAddress(row: TopHomeRow): string {
  const parts = [row.situsNum, row.situsStreet].filter(Boolean).join(" ");
  const cityZip = [row.situsCity, row.situsZip].filter(Boolean).join(" ");
  const full = [parts, cityZip].filter((s) => s && s.trim() !== "").join(", ");
  return full;
}

export interface TopHomesTableProps {
  rows: TopHomeRow[];
  hoveredGeoid?: string | null;
  onHoverRow?: (geoid: string | null) => void;
}

export function TopHomesTable({ rows, hoveredGeoid = null, onHoverRow }: TopHomesTableProps) {
  if (rows.length === 0) {
    return (
      <MissingState
        variant="not-loaded"
        reason="api.top_homes has no rows yet — parcels, geometry, block groups, or permits are still loading"
      />
    );
  }

  return (
    <DataTable>
      <DataTableHead>
        <DataTableRow>
          <DataTableHeaderCell>Home</DataTableHeaderCell>
          <DataTableHeaderCell>Block group</DataTableHeaderCell>
          <DataTableHeaderCell>Score</DataTableHeaderCell>
          <DataTableHeaderCell>Rate per 1,000 homes</DataTableHeaderCell>
          <DataTableHeaderCell>Market value</DataTableHeaderCell>
          <DataTableHeaderCell>Reasons</DataTableHeaderCell>
        </DataTableRow>
      </DataTableHead>
      <DataTableBody>
        {rows.map((row) => {
          const address = formatAddress(row);
          return (
            <DataTableRow
              key={row.propId}
              selected={hoveredGeoid === row.blockGroupGeoid}
              onMouseEnter={() => onHoverRow?.(row.blockGroupGeoid)}
              onMouseLeave={() => onHoverRow?.(null)}
            >
              <DataTableCell>
                <Link href={`/home/${row.propId}`}>{address || row.propId}</Link>
              </DataTableCell>
              <DataTableCell>
                <span style={{ fontFamily: "var(--type-data-font-family)" }}>{row.blockGroupGeoid}</span>
              </DataTableCell>
              <DataTableCell>
                {row.score === null ? (
                  <MissingState variant="not-loaded" reason="Block group score not yet computed" />
                ) : (
                  <span style={{ fontFamily: "var(--type-data-font-family)" }}>{row.score.toFixed(3)}</span>
                )}
              </DataTableCell>
              <DataTableCell>
                {row.ratePer1000 === null ? (
                  <MissingState variant="not-loaded" reason="Rate not yet computed" />
                ) : (
                  <span style={{ fontFamily: "var(--type-data-font-family)" }}>
                    {row.ratePer1000.toFixed(2)} per 1,000 homes
                  </span>
                )}
              </DataTableCell>
              <DataTableCell>
                {row.marketValue === null ? (
                  <MissingState variant="not-loaded" reason="Market value not recorded for this parcel" />
                ) : (
                  <span style={{ fontFamily: "var(--type-data-font-family)" }}>
                    ${row.marketValue.toLocaleString()}
                  </span>
                )}
              </DataTableCell>
              <DataTableCell>
                <div style={{ display: "flex", gap: "var(--space-1)", flexWrap: "wrap" }}>
                  {row.reasons.map((reason, i) => (
                    <span className="chip" key={i}>
                      <span className="chip__label">{reason}</span>
                    </span>
                  ))}
                </div>
              </DataTableCell>
            </DataTableRow>
          );
        })}
      </DataTableBody>
    </DataTable>
  );
}
