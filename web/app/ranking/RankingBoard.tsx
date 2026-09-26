"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { BlockGroupMap } from "../../components/BlockGroupMap";
import { TopHomesTable, type TopHomeRow } from "../../components/TopHomesTable";
import { Panel } from "../../components/ui/Panel";

// M1-W1/M1-W3: owns the one piece of client state the ranking page needs —
// which block group is hovered — shared between the map (highlight) and
// the top-homes table (row highlight + the reverse). Main.dc.html's
// layout is "eligibility funnel + map + top-homes table in one screen":
// a 3-column grid (left rail, map, table), everything visible without
// scrolling the page itself — only the table body scrolls internally if
// it overflows, so every linked row from api.top_homes stays in the DOM
// for the ranking-page test's link assertions.

export function RankingBoard({
  rows,
  leftRail,
}: {
  rows: TopHomeRow[];
  /** Server-rendered eligibility funnel + Quality panel (Main.dc.html's left column). */
  leftRail: ReactNode;
}) {
  const [hoveredGeoid, setHoveredGeoid] = useState<string | null>(null);

  return (
    <div className="ranking-board">
      <div className="ranking-board__rail">{leftRail}</div>

      <Panel style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "var(--space-2)" }}>
          <h2
            style={{
              fontFamily: "var(--type-heading-font-family)",
              fontSize: "var(--type-heading-font-size)",
              fontWeight: "var(--type-heading-font-weight)",
              margin: 0,
            }}
          >
            Block groups by score
          </h2>
        </div>
        <div style={{ flex: "1 1 auto", minHeight: 0 }}>
          <BlockGroupMap
            geojsonUrl="/ranking/blockgroups"
            hoveredGeoid={hoveredGeoid}
            onFeatureHover={setHoveredGeoid}
          />
        </div>
      </Panel>

      <Panel style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "var(--space-2)" }}>
          <h2
            style={{
              fontFamily: "var(--type-heading-font-family)",
              fontSize: "var(--type-heading-font-size)",
              fontWeight: "var(--type-heading-font-weight)",
              margin: 0,
            }}
          >
            Top homes
          </h2>
          <span style={{ fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
            {rows.length.toLocaleString()} · from api.top_homes
          </span>
        </div>
        <div style={{ flex: "1 1 auto", minHeight: 0, overflow: "auto" }}>
          <TopHomesTable rows={rows} hoveredGeoid={hoveredGeoid} onHoverRow={setHoveredGeoid} />
        </div>
      </Panel>
    </div>
  );
}
