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
//
// M1-W3-b fix #3: the ~520px right column was wrapping addresses to
// 3-4 lines and forcing a horizontal scrollbar (Block group, Market value,
// a verbose reasons chip and a raw decimal score all fighting for the same
// narrow width). Block group and market value are already shown on the
// home detail page, so they're dropped here; the table now fits Rank,
// Home (single-line address + a small muted ZIP line), a Score bar, and
// one compact reason chip, all inside a fixed-layout table that never
// scrolls sideways.

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

function formatAddressLine(row: TopHomeRow): string {
  const parts = [row.situsNum, row.situsStreet].filter(Boolean).join(" ");
  const city = row.situsCity ?? "";
  return [parts, city].filter((s) => s && s.trim() !== "").join(", ");
}

/** Drops a trailing ".00" (or a trailing insignificant zero, e.g. "200.50" -> "200.5"). */
function formatRate(rate: number): string {
  const fixed = rate.toFixed(2);
  if (fixed.endsWith(".00")) return fixed.slice(0, -3);
  if (fixed.endsWith("0")) return fixed.slice(0, -1);
  return fixed;
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
    <DataTable className="data-table--top-homes" style={{ tableLayout: "fixed" }}>
      <colgroup>
        <col style={{ width: "40px" }} />
        <col />
        <col style={{ width: "108px" }} />
        <col style={{ width: "104px" }} />
      </colgroup>
      <DataTableHead>
        <DataTableRow>
          <DataTableHeaderCell>#</DataTableHeaderCell>
          <DataTableHeaderCell>Home</DataTableHeaderCell>
          <DataTableHeaderCell>Score</DataTableHeaderCell>
          <DataTableHeaderCell>Reason</DataTableHeaderCell>
        </DataTableRow>
      </DataTableHead>
      <DataTableBody>
        {rows.map((row, index) => {
          const addressLine = formatAddressLine(row);
          const title = [addressLine, row.situsZip].filter(Boolean).join(" ") || row.propId;
          return (
            <DataTableRow
              key={row.propId}
              selected={hoveredGeoid === row.blockGroupGeoid}
              onMouseEnter={() => onHoverRow?.(row.blockGroupGeoid)}
              onMouseLeave={() => onHoverRow?.(null)}
            >
              <DataTableCell>
                <span style={{ color: "var(--theme-ink-muted)" }}>{index + 1}</span>
              </DataTableCell>
              <DataTableCell>
                <Link href={`/home/${row.propId}`} className="top-homes-address" title={title}>
                  {addressLine || row.propId}
                </Link>
                {row.situsZip ? <div className="top-homes-zip">{row.situsZip}</div> : null}
              </DataTableCell>
              <DataTableCell>
                {row.score === null ? (
                  <MissingState variant="not-loaded" reason="Block group score not yet computed" />
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
                {row.ratePer1000 === null ? (
                  <MissingState variant="not-loaded" reason="Rate not yet computed" />
                ) : (
                  <span className="chip" title={row.reasons.join("; ") || undefined}>
                    <span className="chip__label">{formatRate(row.ratePer1000)} / 1k homes</span>
                  </span>
                )}
              </DataTableCell>
            </DataTableRow>
          );
        })}
      </DataTableBody>
    </DataTable>
  );
}
