"use client";

import { useEffect, useRef, useState } from "react";
import { maplibregl } from "../lib/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  ZONE_BUCKET_META,
  HOME_BUCKET_TO_ZONE,
  type ZoneBucket,
  type CoverageBucketCount,
} from "./coverageZones";

// M2-P11: "where Base is not yet, but backup demand is proven" — a
// choropleth over Travis block groups, 4 zone buckets computed from real
// counts only (api.coverage_gaps_bg / api.blockgroup_geojson via
// app/ranking/coverage/blockgroups/route.ts):
//
//   'covered_by_base'  -- this block group already has >=1 Base customer
//   'demand_absent'    -- proven backup demand (an other-installer permit),
//                         zero Base customers
//   'untapped'         -- no proven backup demand yet, but real prospects
//   'not_observable'   -- outside the City of Austin permit coverage area
//                         (no permit data at all) -- NEVER shown as a gap
//
// Privacy: this file only ever renders ZONE-level counts/labels. No prop
// (here or in the route above) carries a per-home Base-customer flag or
// another installer's name -- api.coverage_gaps_bg itself is block-group
// aggregated, so there is nothing per-home to leak.

export interface CoverageGapsProps {
  /** api.coverage_bucket_counts -- HOME-level counts (never per-address). */
  bucketCounts: CoverageBucketCount[];
}

export function CoverageLegend({ bucketCounts }: CoverageGapsProps) {
  const homesByZone = new Map<ZoneBucket, number>();
  for (const row of bucketCounts) {
    homesByZone.set(HOME_BUCKET_TO_ZONE[row.bucket], row.homeCount);
  }
  const order: ZoneBucket[] = ["covered_by_base", "demand_absent", "untapped", "not_observable"];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      {order.map((bucket) => {
        const meta = ZONE_BUCKET_META[bucket];
        const count = homesByZone.get(bucket) ?? 0;
        return (
          <div key={bucket} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }} data-testid={`coverage-legend-${bucket}`}>
            <span
              aria-hidden="true"
              style={{ width: 14, height: 14, minWidth: 14, borderRadius: "var(--rounded-sm)", backgroundColor: meta.color, border: "1px solid var(--color-control-border)" }}
            />
            <span style={{ flex: "1 1 auto" }}>{meta.label}</span>
            <span style={{ fontFamily: "var(--type-data-font-family)", fontWeight: 600 }}>
              {count.toLocaleString()}
            </span>
            <span style={{ color: "var(--theme-ink-muted)", fontSize: "var(--type-label-font-size)" }}>homes</span>
          </div>
        );
      })}
    </div>
  );
}

interface HoveredZone {
  bucket: ZoneBucket;
  homes: number | null;
  baseCustomers: number | null;
  otherBackup: number | null;
  prospects: number | null;
  gapScore: number | null;
}

const SOURCE_ID = "coverage-blockgroups";

/** A minimal, static (non-live-reranking) choropleth -- deliberately its
 * own small MapLibre instance rather than reusing BlockGroupMap.tsx: that
 * component is tightly coupled to the weight-sliders' live re-scoring
 * (feature-state set from a debounced /api/blockgroup-scores POST), which
 * has nothing to do with this page's fixed, precomputed zone buckets. */
export function CoverageMap({ geojsonUrl }: { geojsonUrl: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hovered, setHovered] = useState<HoveredZone | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: "https://tiles.openfreemap.org/styles/positron",
      center: [-97.7431, 30.2672],
      zoom: 9,
    });

    map.on("load", () => {
      map.addSource(SOURCE_ID, { type: "geojson", data: geojsonUrl });
      map.addLayer({
        id: "coverage-fill",
        type: "fill",
        source: SOURCE_ID,
        paint: { "fill-color": ["get", "fillColor"], "fill-opacity": 0.75 },
      });
      map.addLayer({
        id: "coverage-outline",
        type: "line",
        source: SOURCE_ID,
        paint: { "line-color": "#54524f", "line-width": 0.5 },
      });
      map.on("mousemove", "coverage-fill", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as Record<string, unknown>;
        setHovered({
          bucket: p.bucket as ZoneBucket,
          homes: (p.homes as number | null) ?? null,
          baseCustomers: (p.baseCustomers as number | null) ?? null,
          otherBackup: (p.otherBackup as number | null) ?? null,
          prospects: (p.prospects as number | null) ?? null,
          gapScore: (p.gapScore as number | null) ?? null,
        });
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "coverage-fill", () => {
        setHovered(null);
        map.getCanvas().style.cursor = "";
      });
    });

    return () => map.remove();
  }, [geojsonUrl]);

  return (
    <div style={{ position: "relative", height: "480px" }}>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      {hovered ? (
        <div
          data-testid="coverage-hover-tooltip"
          style={{
            position: "absolute",
            top: "var(--space-2)",
            right: "var(--space-2)",
            backgroundColor: "var(--theme-surface)",
            border: "1px solid var(--theme-divider)",
            borderRadius: "var(--rounded-sm)",
            padding: "var(--space-2) var(--space-3)",
            fontSize: "var(--type-label-font-size)",
            boxShadow: "var(--shadow-1, 0 1px 4px rgba(0,0,0,0.15))",
            maxWidth: "260px",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: "var(--space-1)" }}>{ZONE_BUCKET_META[hovered.bucket].label}</div>
          {hovered.bucket === "not_observable" ? (
            <div>No City of Austin permit coverage for this block group.</div>
          ) : (
            <div style={{ display: "grid", gap: 2 }}>
              <span>{(hovered.homes ?? 0).toLocaleString()} homes</span>
              <span>{(hovered.baseCustomers ?? 0).toLocaleString()} Base customers</span>
              <span>{(hovered.otherBackup ?? 0).toLocaleString()} other-installer backup</span>
              <span>{(hovered.prospects ?? 0).toLocaleString()} prospects</span>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
