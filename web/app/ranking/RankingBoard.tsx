"use client";

import { useState } from "react";
import { BlockGroupMap } from "../../components/BlockGroupMap";
import { TopHomesTable, type TopHomeRow } from "../../components/TopHomesTable";
import { Panel } from "../../components/ui/Panel";

// M1-W1: owns the one piece of client state the ranking page needs —
// which block group is hovered — shared between the map (highlight) and
// the top-50 table (row highlight + the reverse: hovering a row
// highlights the block group). Everything else on the page (data
// fetching, the Quality panel) stays server-rendered in page.tsx.

export function RankingBoard({ rows }: { rows: TopHomeRow[] }) {
  const [hoveredGeoid, setHoveredGeoid] = useState<string | null>(null);

  return (
    <div style={{ display: "grid", gap: "var(--space-6)" }}>
      <Panel>
        <BlockGroupMap
          geojsonUrl="/ranking/blockgroups"
          hoveredGeoid={hoveredGeoid}
          onFeatureHover={setHoveredGeoid}
        />
      </Panel>
      <Panel>
        <h2
          style={{
            fontFamily: "var(--type-heading-font-family)",
            fontSize: "var(--type-heading-font-size)",
            fontWeight: "var(--type-heading-font-weight)",
            marginTop: 0,
          }}
        >
          Top 50 homes
        </h2>
        <TopHomesTable rows={rows} hoveredGeoid={hoveredGeoid} onHoverRow={setHoveredGeoid} />
      </Panel>
    </div>
  );
}
