"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { BlockGroupMap } from "../../components/BlockGroupMap";
import { TopHomesTable, type TopHomeRow } from "../../components/TopHomesTable";
import { WeightSliders, equalWeights } from "../../components/WeightSliders";
import { Panel } from "../../components/ui/Panel";
import { MissingState } from "../../components/ui/MissingState";
import type { SignalKey } from "../api/top-homes/route";

// M2-W1: owns the ranking screen's live state — hovered block group
// (M1-W1, unchanged), weights (M2-W1), the current ranked rows, and the
// rank-change indicator shown for 2s after a re-rank. Moving a slider
// debounces ~250ms then POSTs to /api/top-homes (api.top_homes_weighted),
// never a full page reload — the map/table/left-rail stay mounted.

const DEBOUNCE_MS = 250;
const RANK_DELTA_DISPLAY_MS = 2000;
const TRAVIS_COUNTY_FIPS = "48453";

function buildRankMap(rows: TopHomeRow[]): Map<string, number> {
  const map = new Map<string, number>();
  rows.forEach((row, index) => map.set(row.propId, index + 1));
  return map;
}

export function RankingBoard({
  rows: initialRows,
  leftRail,
}: {
  rows: TopHomeRow[];
  /** Server-rendered gate funnel + Quality panel (left column, above the sliders). */
  leftRail: ReactNode;
}) {
  const [hoveredGeoid, setHoveredGeoid] = useState<string | null>(null);
  const [weights, setWeights] = useState<Record<SignalKey, number>>(equalWeights());
  const [rows, setRows] = useState<TopHomeRow[]>(initialRows);
  const [rankDeltas, setRankDeltas] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prevRankRef = useRef<Map<string, number>>(buildRankMap(initialRows));
  const isFirstWeightsChange = useRef(true);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Skip the fetch on mount — initialRows (server-rendered, equal
    // weights) is already the correct first paint.
    if (isFirstWeightsChange.current) {
      isFirstWeightsChange.current = false;
      return;
    }

    const debounceTimer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch("/api/top-homes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({ weights, countyFips: TRAVIS_COUNTY_FIPS }),
        });
        if (!response.ok) {
          throw new Error(`top-homes request failed (HTTP ${response.status})`);
        }
        const data: { rows: TopHomeRow[] } = await response.json();

        const previousRanks = prevRankRef.current;
        const newRanks = buildRankMap(data.rows);
        const deltas = new Map<string, number>();
        for (const [propId, newRank] of newRanks) {
          const oldRank = previousRanks.get(propId);
          if (oldRank !== undefined && oldRank !== newRank) {
            deltas.set(propId, oldRank - newRank);
          }
        }

        setRows(data.rows);
        setRankDeltas(deltas);
        prevRankRef.current = newRanks;

        if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
        clearTimerRef.current = setTimeout(() => setRankDeltas(new Map()), RANK_DELTA_DISPLAY_MS);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to re-rank");
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(debounceTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weights]);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    };
  }, []);

  return (
    <div className="ranking-board">
      <div className="ranking-board__rail">
        {leftRail}
        <WeightSliders weights={weights} onChange={setWeights} onReset={() => setWeights(equalWeights())} />
      </div>

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
            {rows.length.toLocaleString()} · from api.top_homes_weighted{loading ? " · re-ranking…" : ""}
          </span>
        </div>
        {error ? (
          <div style={{ marginBottom: "var(--space-2)" }}>
            <MissingState variant="not-loaded" reason={error} />
          </div>
        ) : null}
        <div style={{ flex: "1 1 auto", minHeight: 0, overflow: "auto" }}>
          <TopHomesTable rows={rows} hoveredGeoid={hoveredGeoid} onHoverRow={setHoveredGeoid} rankDeltas={rankDeltas} />
        </div>
      </Panel>
    </div>
  );
}
