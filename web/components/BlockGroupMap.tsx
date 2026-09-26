"use client";

import { useEffect, useRef } from "react";
import type { Map as MapLibreMap, ExpressionSpecification, MapLayerMouseEvent } from "maplibre-gl";
import { maplibregl } from "../lib/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";

// DESIGN.md §2 score ramp (light theme; the map basemap is light Positron,
// so the map always renders the light-mode ramp regardless of the page
// theme) and "The Missing Is Grey Rule": a block group with no score gets
// the hatched not-loaded fill, never the lowest ramp step. These are pure,
// exported constants/functions (no maplibre/DOM dependency) precisely so
// M1-W1's acceptance criterion — "unscored block groups are hatched, not
// colored as low scores" — is checkable without a browser/WebGL context.

export const SCORE_RAMP = [
  "#d6f0b4", // score-1
  "#b2dd79", // score-2
  "#77a45a", // score-3
  "#1e4d2b", // score-4
  "#102a17", // score-5
] as const;

export const NOT_LOADED_HATCH_IMAGE_ID = "blockgroup-not-loaded-hatch";
export const NOT_LOADED_HATCH_BG = "#e6e4e0"; // --color-not-loaded-bg
export const NOT_LOADED_HATCH_STRIPE = "#d8d7d5"; // --color-surface-sunken

/** score is api.blockgroup_scores' percent_rank (0..1), or null. */
export function scoreRampColor(score: number): (typeof SCORE_RAMP)[number] {
  const clamped = Math.min(1, Math.max(0, score));
  const idx = Math.min(SCORE_RAMP.length - 1, Math.floor(clamped * SCORE_RAMP.length));
  return SCORE_RAMP[idx];
}

/**
 * A maplibre `fill-color` step expression matching scoreRampColor's
 * buckets exactly, for the "score is not null" layer. Never applied to
 * unscored features — those use the hatch pattern layer instead.
 */
export function scoreFillExpression(): ExpressionSpecification {
  return [
    "step",
    ["get", "score"],
    SCORE_RAMP[0],
    0.2,
    SCORE_RAMP[1],
    0.4,
    SCORE_RAMP[2],
    0.6,
    SCORE_RAMP[3],
    0.8,
    SCORE_RAMP[4],
  ] as unknown as ExpressionSpecification;
}

export const SCORED_FILTER = ["!=", ["get", "score"], null] as unknown as ExpressionSpecification;
export const UNSCORED_FILTER = ["==", ["get", "score"], null] as unknown as ExpressionSpecification;

function buildHatchPattern(): ImageData {
  const size = 8;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("BlockGroupMap: 2D canvas context unavailable for hatch pattern");
  ctx.fillStyle = NOT_LOADED_HATCH_BG;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = NOT_LOADED_HATCH_STRIPE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, size);
  ctx.lineTo(size, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-size / 2, size / 2);
  ctx.lineTo(size / 2, -size / 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(size / 2, size * 1.5);
  ctx.lineTo(size * 1.5, size / 2);
  ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}

export interface BlockGroupMapProps {
  /** URL of the FeatureCollection served by app/ranking/blockgroups/route.ts */
  geojsonUrl: string;
  /** api.top_homes' block_group_geoid for the currently hovered table row, or null. */
  hoveredGeoid?: string | null;
  onFeatureHover?: (geoid: string | null) => void;
  /** CSS height; defaults to filling its container (Main.dc.html's single-screen layout). */
  height?: string;
}

const SOURCE_ID = "blockgroups";
const LAYER_SCORED = "blockgroups-scored";
const LAYER_UNSCORED = "blockgroups-unscored";
const LAYER_OUTLINE = "blockgroups-outline";
const LAYER_HIGHLIGHT = "blockgroups-highlight";

export function BlockGroupMap({
  geojsonUrl,
  hoveredGeoid = null,
  onFeatureHover,
  height = "100%",
}: BlockGroupMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      // OpenFreeMap Positron: no API key required. Kept muted per
      // DESIGN.md §6 "Do: use a muted, low-chroma basemap so the
      // choropleth carries the color."
      style: "https://tiles.openfreemap.org/styles/positron",
      center: [-97.7431, 30.2672], // Austin/Travis County
      zoom: 9,
    });
    mapRef.current = map;

    map.on("load", () => {
      if (!map.hasImage(NOT_LOADED_HATCH_IMAGE_ID)) {
        map.addImage(NOT_LOADED_HATCH_IMAGE_ID, buildHatchPattern());
      }

      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: geojsonUrl,
        promoteId: "geoid",
      });

      map.addLayer({
        id: LAYER_SCORED,
        type: "fill",
        source: SOURCE_ID,
        filter: SCORED_FILTER,
        paint: {
          "fill-color": scoreFillExpression(),
          "fill-opacity": 0.75,
        },
      });

      map.addLayer({
        id: LAYER_UNSCORED,
        type: "fill",
        source: SOURCE_ID,
        filter: UNSCORED_FILTER,
        paint: {
          "fill-pattern": NOT_LOADED_HATCH_IMAGE_ID,
        },
      });

      map.addLayer({
        id: LAYER_OUTLINE,
        type: "line",
        source: SOURCE_ID,
        paint: {
          "line-color": "#54524f",
          "line-width": 0.5,
        },
      });

      map.addLayer({
        id: LAYER_HIGHLIGHT,
        type: "line",
        source: SOURCE_ID,
        filter: ["==", ["get", "geoid"], ""],
        paint: {
          "line-color": "#048ee5",
          "line-width": 3,
        },
      });

      map.on("mousemove", LAYER_SCORED, (e: MapLayerMouseEvent) => {
        const geoid = e.features?.[0]?.properties?.geoid as string | undefined;
        onFeatureHover?.(geoid ?? null);
      });
      map.on("mousemove", LAYER_UNSCORED, (e: MapLayerMouseEvent) => {
        const geoid = e.features?.[0]?.properties?.geoid as string | undefined;
        onFeatureHover?.(geoid ?? null);
      });
      map.on("mouseleave", LAYER_SCORED, () => onFeatureHover?.(null));
      map.on("mouseleave", LAYER_UNSCORED, () => onFeatureHover?.(null));
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // geojsonUrl/onFeatureHover are stable for the page's lifetime; the map
    // instance is created once and updated imperatively below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const applyHighlight = () => {
      if (!map.getLayer(LAYER_HIGHLIGHT)) return;
      map.setFilter(LAYER_HIGHLIGHT, ["==", ["get", "geoid"], hoveredGeoid ?? ""]);
    };
    if (map.isStyleLoaded()) applyHighlight();
    else map.once("load", applyHighlight);
  }, [hoveredGeoid]);

  return (
    <div
      ref={containerRef}
      data-testid="blockgroup-map"
      style={{
        width: "100%",
        height,
        minHeight: "360px",
        borderRadius: "var(--rounded-md)",
        overflow: "hidden",
      }}
    />
  );
}
