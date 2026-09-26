"use client";

import { useEffect, useRef } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// M1-W3 fix #4 (Home detail): HomeDetail.dc.html's "Parcel" mini map,
// built with the same MapLibre stack as the ranking choropleth
// (BlockGroupMap), fit to this one parcel's real polygon
// (core.parcel_geoms.geom, via ST_AsGeoJSON — app/home/[prop_id]/page.tsx
// passes the real GeoJSON, never a fabricated shape). No missing-geometry
// fallback lives here: the caller renders MissingState instead of this
// component when geom is null.

export interface ParcelMapProps {
  /** A real GeoJSON Polygon/MultiPolygon from ST_AsGeoJSON(core.parcel_geoms.geom). */
  geojson: GeoJSON.Polygon | GeoJSON.MultiPolygon;
}

const SOURCE_ID = "parcel";

function boundsOf(geojson: GeoJSON.Polygon | GeoJSON.MultiPolygon): [[number, number], [number, number]] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const rings = geojson.type === "Polygon" ? geojson.coordinates : geojson.coordinates.flat();
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return [
    [minX, minY],
    [maxX, maxY],
  ];
}

export function ParcelMap({ geojson }: ParcelMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: "https://tiles.openfreemap.org/styles/positron",
      center: [0, 0],
      zoom: 1,
      attributionControl: false,
    });
    mapRef.current = map;

    map.on("load", () => {
      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: { type: "Feature", geometry: geojson, properties: {} },
      });
      map.addLayer({
        id: "parcel-fill",
        type: "fill",
        source: SOURCE_ID,
        paint: { "fill-color": "#d6f0b4", "fill-opacity": 0.65 },
      });
      map.addLayer({
        id: "parcel-outline",
        type: "line",
        source: SOURCE_ID,
        paint: { "line-color": "#1e4d2b", "line-width": 2 },
      });
      map.fitBounds(boundsOf(geojson), { padding: 24, animate: false, maxZoom: 19 });
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // geojson is fixed for this parcel's page lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={containerRef}
      data-testid="parcel-map"
      style={{
        width: "100%",
        height: "220px",
        borderRadius: "var(--rounded-md)",
        overflow: "hidden",
      }}
    />
  );
}
