"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap, ExpressionSpecification, MapLayerMouseEvent } from "maplibre-gl";
import { maplibregl } from "../lib/maplibre";
import type { SignalKey } from "../app/api/top-homes/route";
import { COUNTY_MAP_CENTER } from "../lib/counties";
import "maplibre-gl/dist/maplibre-gl.css";

// DESIGN.md §2 score ramp (light theme; the map basemap is light Positron,
// so the map always renders the light-mode ramp regardless of the page
// theme) and "The Missing Is Grey Rule": a block group with no score gets
// the hatched not-loaded fill, never the lowest ramp step. These are pure,
// exported constants/functions (no maplibre/DOM dependency) precisely so
// M1-W1's acceptance criterion — "unscored block groups are hatched, not
// colored as low scores" — is checkable without a browser/WebGL context.
// web/tests/m1/blockgroup-map.test.ts (owned by M1-W1, not this ticket)
// asserts SCORE_RAMP/SCORED_FILTER/UNSCORED_FILTER/scoreRampColor exactly
// as they were — these stay unchanged here.

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

// Camera-motion polish (2026-09-27 user feedback: "zooms and color changes
// feel jumpy"), following the same patterns as the Hyperlocal reference
// map (app/components/zoning/ZoningMap.tsx in that sibling repo, read-only
// reference, no code copied): a single eased fitBounds per selection
// change (never re-fit on every sourcedata tick), frame padding that
// clears this map's own overlays, and prefers-reduced-motion falling back
// to an instant jump everywhere a duration would otherwise animate.

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Pad = { top: number; bottom: number; left: number; right: number };

/** Clears the legend (top-left), the selected-home card (bottom-left) and
 * the zoom control (bottom-right) so a fitBounds frames the AREA in the
 * clear part of the map, not underneath an overlay. */
function framePadding(el: HTMLElement): Pad {
  const wide = el.clientWidth >= 640;
  return wide ? { top: 90, left: 260, right: 56, bottom: 150 } : { top: 24, left: 16, right: 16, bottom: 120 };
}

/** fitBounds adds its padding to whatever padding the camera already
 * holds, so pass only the difference (Hyperlocal's extraPad). */
function extraPad(map: MapLibreMap, want: Pad): Pad {
  const p = map.getPadding();
  const have = { top: p.top ?? 0, bottom: p.bottom ?? 0, left: p.left ?? 0, right: p.right ?? 0 };
  return {
    top: Math.max(0, want.top - have.top),
    bottom: Math.max(0, want.bottom - have.bottom),
    left: Math.max(0, want.left - have.left),
    right: Math.max(0, want.right - have.right),
  };
}

// NOTE: the style spec only allows a ["zoom"] expression to appear as
// the OUTERMOST expression, or nested directly inside a top-level
// case/match/coalesce/let -- never further inside arithmetic like ["*",
// ...]. A first version of this file's zoom-interpolated "fills fade in
// as you zoom" polish (Hyperlocal's fadeIn) nested interpolate(zoom)
// inside a "*", which MapLibre rejects when validating the layer at
// addLayer() time -- silently throwing inside the map's "load" handler
// and leaving `ready` stuck false (the map never rendered at all, in
// dev testing). Dropped the zoom fade-in nicety rather than risk that
// again; the dimming behavior below still holds without it.

/** score is api.blockgroup_scores_weighted's absolute mean final_score (0..1) across the group's scored homes, or null. */
export function scoreRampColor(score: number): (typeof SCORE_RAMP)[number] {
  const clamped = Math.min(1, Math.max(0, score));
  const idx = Math.min(SCORE_RAMP.length - 1, Math.floor(clamped * SCORE_RAMP.length));
  return SCORE_RAMP[idx];
}

/**
 * A maplibre `fill-color` step expression over the block group's
 * feature-state `score` (set client-side from api.blockgroup_scores_weighted
 * — M2-W3; NOT the GeoJSON `score` property, which is the retired v0
 * backup-intent-only score baked into api.blockgroup_geojson's geometry
 * cache). Matches scoreRampColor's buckets exactly. Only applied where
 * feature-state score is a number — see SCORED_STATE_FILTER.
 */
export function scoreFillExpression(): ExpressionSpecification {
  return [
    "step",
    ["feature-state", "score"],
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

// Kept for the pre-existing test file's exact-value assertions (M1-W1,
// not owned by this ticket) — no longer wired into a layer filter here;
// the scored/unscored split now runs on feature-state (set from
// api.blockgroup_scores_weighted), not the GeoJSON's baked-in v0 score.
export const SCORED_FILTER = ["!=", ["get", "score"], null] as unknown as ExpressionSpecification;
export const UNSCORED_FILTER = ["==", ["get", "score"], null] as unknown as ExpressionSpecification;

const HAS_FEATURE_STATE_SCORE = ["!=", ["feature-state", "score"], null] as unknown as ExpressionSpecification;

/** Recursively walks any GeoJSON geometry's coordinate array (Polygon,
 * MultiPolygon, or a nested array of either), extending [minLon, minLat,
 * maxLon, maxLat] in place. No turf dependency -- this repo's other map
 * code doesn't pull one in either, and a plain min/max walk is all a
 * fitBounds box needs. */
function extendBbox(bbox: [number, number, number, number], coords: unknown): void {
  if (!Array.isArray(coords)) return;
  if (typeof coords[0] === "number" && typeof coords[1] === "number") {
    const lon = coords[0] as number;
    const lat = coords[1] as number;
    if (lon < bbox[0]) bbox[0] = lon;
    if (lat < bbox[1]) bbox[1] = lat;
    if (lon > bbox[2]) bbox[2] = lon;
    if (lat > bbox[3]) bbox[3] = lat;
    return;
  }
  for (const c of coords) extendBbox(bbox, c);
}

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

export interface MapDot {
  propId: string;
  score: number | null;
  lon: number | null;
  lat: number | null;
}

export interface BlockGroupMapProps {
  /** URL of the FeatureCollection served by app/ranking/blockgroups/route.ts */
  geojsonUrl: string;
  /** The weights the table is currently ranked by — every debounced change
   * here re-fetches /api/blockgroup-scores and recolors via feature-state. */
  weights: Record<SignalKey, number>;
  countyFips: string;
  /** api.homes_ranked_weighted's block_group_geoid for the currently hovered
   * table row, or null. Drives the thin hover outline. */
  hoveredGeoid?: string | null;
  onFeatureHover?: (geoid: string | null) => void;
  /** The block group the user clicked (or null) — drives the thicker
   * selected outline and which homes are drawn as dots. */
  selectedGeoid?: string | null;
  onSelectGeoid?: (geoid: string | null) => void;
  /** Every gate-passed home in the selected block group (M2-W3 scope
   * change replaced the fixed top-50 pins with these) — null/[] when
   * nothing is selected. */
  dots?: MapDot[];
  hoveredPropId?: string | null;
  onDotHover?: (propId: string | null) => void;
  /** CSS height; defaults to filling its container (Main.dc.html's single-screen layout). */
  height?: string;
  /** M-drilldown (revised): the block groups the current city/ZIP/
   * neighborhood selection covers (from api.home_geo_rollup, RankingBoard's
   * own fitToGeoids) -- the map fits its viewport to their combined
   * bounds. null/[] resets to the county's default center/zoom. */
  fitToGeoids?: string[] | null;
  /** Layout-review pivot: shade by priority (share of this block group's
   * homes in decile 1, "Top priority" -- from api.home_geo_rollup's
   * top10Count/homeCount, computed by RankingBoard) instead of the
   * team-weighted score, when in predicted mode (the default). Reuses
   * the identical feature-state/ramp/hatch machinery scoreFillExpression
   * already provides (still keyed on feature-state "score", per the
   * pinned M2-W3 test) -- this just changes what value gets set there,
   * never a second rendering path. When provided (non-null), the
   * weighted-score fetch effect below is skipped entirely. */
  priorityByGeoid?: Map<string, number> | null;
  /** Legend + a11y label for what the ramp means -- "top-priority homes"
   * (predicted, default) vs "weighted score" (manager's secondary mode). */
  shadeLabel?: string;
  /** Redesign (Mock A): the top-ranked homes on the CURRENT page-1 list
   * (real rows, never synthetic), rendered as numbered pins regardless of
   * block-group selection -- rank 1-6 filled forest, 7-10 outlined, so
   * the top five still read from across a room. */
  topPins?: Array<{ propId: string; rank: number; lon: number | null; lat: number | null }>;
  onPinClick?: (propId: string) => void;
  /** Bottom-left "selected home" card -- rank/address/tier + a link to
   * the full record. Null hides the card entirely. */
  selectedHome?: {
    rank: number | null;
    address: string;
    metaLine: string;
    tierLabel: string;
    tierSublabel: string;
    propId: string;
  } | null;
  /** "Locate on map" -- flies to one home's real parcel centroid. Never
   * recenters on a fabricated coordinate; a home with no centroid yet
   * simply doesn't move the map. */
  focusHome?: { lon: number | null; lat: number | null } | null;
}

const SOURCE_ID = "blockgroups";
const LAYER_UNSCORED = "blockgroups-unscored";
const LAYER_SCORED = "blockgroups-scored";
const LAYER_OUTLINE = "blockgroups-outline";
const LAYER_HOVER_OUTLINE = "blockgroups-hover-outline";
const LAYER_SELECTED_OUTLINE = "blockgroups-selected-outline";

const DEBOUNCE_MS = 250;

export function BlockGroupMap({
  geojsonUrl,
  weights,
  countyFips,
  hoveredGeoid = null,
  onFeatureHover,
  selectedGeoid = null,
  onSelectGeoid,
  dots = [],
  hoveredPropId = null,
  onDotHover,
  height = "100%",
  fitToGeoids = null,
  priorityByGeoid = null,
  shadeLabel = "top-priority homes",
  topPins = [],
  onPinClick,
  selectedHome = null,
  focusHome = null,
}: BlockGroupMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const mapLoadedRef = useRef(false);
  const geoidsRef = useRef<Set<string>>(new Set());
  const scoresRef = useRef<Map<string, number>>(new Map());
  const markersRef = useRef<Map<string, InstanceType<typeof maplibregl.Marker>>>(new Map());
  const pinMarkersRef = useRef<Map<string, InstanceType<typeof maplibregl.Marker>>>(new Map());
  // null = nothing dimmed (no city/ZIP/neighborhood selection); a Set =
  // exactly those geoids that stay at full opacity, everything else dims.
  const dimSetRef = useRef<Set<string> | null>(null);
  // Tracks the selection key (fitToGeoids, sorted+joined, or "" for
  // "whole county") a camera fit has already completed for, so a later
  // sourcedata tick for the SAME selection never re-triggers fitBounds
  // (the reported "jumpy" bug) -- only a genuinely new selection does.
  const fittedKeyRef = useRef<string | null>(null);
  const [scoredCount, setScoredCount] = useState(0);
  const [ready, setReady] = useState(false);

  // ---------------------------------------------------------------------
  // Map init (once).
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current) return;

    // M3-W1: per-county map center (Austin/Houston/Georgetown), keyed off
    // the same countyFips prop that already drives /api/blockgroup-scores
    // below — falls back to the Travis center for an unrecognized fips
    // rather than defaulting to nothing.
    const mapCenter = COUNTY_MAP_CENTER[countyFips] ?? COUNTY_MAP_CENTER["48453"];

    const map = new maplibregl.Map({
      container: containerRef.current,
      // OpenFreeMap Positron: no API key required. Kept muted per
      // DESIGN.md §6 "Do: use a muted, low-chroma basemap so the
      // choropleth carries the color."
      style: "https://tiles.openfreemap.org/styles/positron",
      center: mapCenter.center,
      zoom: mapCenter.zoom,
    });
    mapRef.current = map;

    map.on("error", (e: unknown) => {
      // eslint-disable-next-line no-console
      console.error("BlockGroupMap error event", e);
    });

    map.on("load", () => {
      try {
      if (!map.hasImage(NOT_LOADED_HATCH_IMAGE_ID)) {
        map.addImage(NOT_LOADED_HATCH_IMAGE_ID, buildHatchPattern());
      }

      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: geojsonUrl,
        promoteId: "geoid",
      });

      // Hatch sits underneath every feature — "The Missing Is Grey Rule":
      // a block group with no weighted score (no gate-passed homes, or
      // not yet fetched) stays hatched, never colored as a low score.
      map.addLayer({
        id: LAYER_UNSCORED,
        type: "fill",
        source: SOURCE_ID,
        paint: {
          "fill-pattern": NOT_LOADED_HATCH_IMAGE_ID,
          "fill-opacity-transition": { duration: 300, delay: 0 },
        },
      });

      // Scored fill sits on top, opacity 0 (transparent, hatch shows
      // through) wherever feature-state score hasn't been set. A
      // zoom-interpolated base opacity (FILL_OPACITY_BASE) keeps basemap
      // streets readable when zoomed in; DIMMED_FACTOR dims every block
      // group outside the current city/ZIP/neighborhood selection to 30%
      // (never removes it — color and shape stay legible for context).
      map.addLayer({
        id: LAYER_SCORED,
        type: "fill",
        source: SOURCE_ID,
        paint: {
          "fill-color": scoreFillExpression(),
          "fill-opacity": [
            "case",
            ["==", ["feature-state", "dimmed"], true],
            ["case", HAS_FEATURE_STATE_SCORE, 0.225, 0],
            ["case", HAS_FEATURE_STATE_SCORE, 0.75, 0],
          ] as unknown as ExpressionSpecification,
          "fill-opacity-transition": { duration: 300, delay: 0 },
          "fill-color-transition": { duration: 300, delay: 0 },
        },
      });

      map.addLayer({
        id: LAYER_OUTLINE,
        type: "line",
        source: SOURCE_ID,
        paint: { "line-color": "#54524f", "line-width": 0.5 },
      });

      map.addLayer({
        id: LAYER_HOVER_OUTLINE,
        type: "line",
        source: SOURCE_ID,
        filter: ["==", ["get", "geoid"], ""],
        paint: { "line-color": "#048ee5", "line-width": 3, "line-opacity": 1, "line-opacity-transition": { duration: 150, delay: 0 } },
      });

      // Selected block group — forest outline (DESIGN.md brand-strong),
      // thicker than the hover outline so both can be visible at once.
      map.addLayer({
        id: LAYER_SELECTED_OUTLINE,
        type: "line",
        source: SOURCE_ID,
        filter: ["==", ["get", "geoid"], ""],
        paint: { "line-color": "#1e4d2b", "line-width": 4, "line-opacity": 1, "line-opacity-transition": { duration: 150, delay: 0 } },
      });

      const readGeoid = (e: MapLayerMouseEvent) =>
        (e.features?.[0]?.properties?.geoid as string | undefined) ?? null;

      // LAYER_SCORED and LAYER_UNSCORED now both render across EVERY
      // feature (opacity, not a geometry filter, is what makes the hatch
      // show through) — binding interaction handlers to both would fire
      // the click/hover callback twice per click (and, for the
      // toggle-select state update, cancel itself back to null). One
      // layer's hit-test is enough; LAYER_SCORED sits on top.
      map.on("mousemove", LAYER_SCORED, (e: MapLayerMouseEvent) => onFeatureHover?.(readGeoid(e)));
      map.on("mouseleave", LAYER_SCORED, () => onFeatureHover?.(null));

      map.on("click", LAYER_SCORED, (e: MapLayerMouseEvent) => onSelectGeoid?.(readGeoid(e)));
      // A click that hits neither layer (open water/basemap) clears the
      // selection — "clicking outside returns to the county ranking".
      map.on("click", (e) => {
        const features = map.queryRenderedFeatures(e.point, { layers: [LAYER_SCORED] });
        if (features.length === 0) onSelectGeoid?.(null);
      });

      const collectGeoids = () => {
        try {
          const features = map.querySourceFeatures(SOURCE_ID);
          const next = new Set(geoidsRef.current);
          for (const f of features) {
            const geoid = f.properties?.geoid as string | undefined;
            if (geoid) next.add(geoid);
          }
          geoidsRef.current = next;
          applyScores();
        } catch {
          // Source tiles not parsed yet — a later sourcedata event retries.
        }
      };
      map.on("sourcedata", (e) => {
        if (e.sourceId === SOURCE_ID && map.isSourceLoaded(SOURCE_ID)) collectGeoids();
      });

      mapLoadedRef.current = true;
      setReady(true);
      } catch (err) {
        console.error("BlockGroupMap load handler threw", err);
      }
    });

    function applyScores() {
      const m = mapRef.current;
      if (!m) return;
      let scored = 0;
      const dimSet = dimSetRef.current;
      for (const geoid of geoidsRef.current) {
        const score = scoresRef.current.get(geoid);
        m.setFeatureState(
          { source: SOURCE_ID, id: geoid },
          { score: score ?? null, dimmed: dimSet !== null && !dimSet.has(geoid) }
        );
        if (score !== undefined) scored += 1;
      }
      setScoredCount(scored);
    }
    // Exposed on the ref so the weights-fetch effect below can call it
    // after updating scoresRef without duplicating the loop.
    (map as unknown as { __applyScores?: () => void }).__applyScores = applyScores;

    return () => {
      map.remove();
      mapRef.current = null;
      mapLoadedRef.current = false;
    };
    // geojsonUrl/onFeatureHover/onSelectGeoid are stable for the page's
    // lifetime; the map instance is created once and updated imperatively.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------
  // Weighted block-group scores — refetched on every debounced weights
  // change (same 250ms debounce RankingBoard uses for /api/top-homes),
  // and once on mount so the map is never stuck showing v0/hatched
  // colors before the first slider move (M2-W3: the map used to only
  // recolor when the TABLE'S OWN fetch happened to run).
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!ready || priorityByGeoid) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/blockgroup-scores", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({ weights, countyFips }),
        });
        if (!response.ok || cancelled) return;
        const data: { scores: Array<{ geoid: string; score: number; homesScored: number }> } = await response.json();
        if (cancelled) return;
        const next = new Map<string, number>();
        for (const row of data.scores) next.set(row.geoid, row.score);
        scoresRef.current = next;
        const map = mapRef.current as unknown as { __applyScores?: () => void } | null;
        map?.__applyScores?.();
      } catch {
        // Left uncolored (hatched) — never a fabricated score.
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, JSON.stringify(weights), countyFips]);

  // ---------------------------------------------------------------------
  // Priority shading (layout-review pivot) — reuses the identical
  // feature-state "score" key and ramp the weighted-score effect above
  // sets, just fed from RankingBoard's already-fetched api.home_geo_
  // rollup share (top10Count/homeCount) instead of a live re-score
  // fetch. No network request here at all.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!ready || !priorityByGeoid) return;
    scoresRef.current = priorityByGeoid;
    const map = mapRef.current as unknown as { __applyScores?: () => void } | null;
    map?.__applyScores?.();
  }, [ready, priorityByGeoid]);

  // ---------------------------------------------------------------------
  // Hover / selected outlines.
  // ---------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      if (!map.getLayer(LAYER_HOVER_OUTLINE)) return;
      map.setFilter(LAYER_HOVER_OUTLINE, ["==", ["get", "geoid"], hoveredGeoid ?? ""]);
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [hoveredGeoid]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      if (!map.getLayer(LAYER_SELECTED_OUTLINE)) return;
      map.setFilter(LAYER_SELECTED_OUTLINE, ["==", ["get", "geoid"], selectedGeoid ?? ""]);
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [selectedGeoid]);

  // ---------------------------------------------------------------------
  // M-drilldown (revised): fit the viewport to the selected area's block
  // groups. Runs off the already-loaded SOURCE_ID GeoJSON source (no
  // second fetch) -- querySourceFeatures needs the source parsed, so this
  // waits for `ready` (set once on map "load") and retries via
  // "sourcedata" if the tile/feature index isn't populated yet on the
  // first try (same wait pattern the collectGeoids effect above uses).
  // ---------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    // Layout-review fix: fit the WHOLE county's block groups on load
    // (whenever no specific city/ZIP/neighborhood is selected) -- same
    // bbox logic below, just unfiltered (every feature the source has)
    // instead of filtered to a wanted-geoid set.
    //
    // 2026-09-27 motion fix: dim every block group outside the wanted set
    // (never remove it) so the selection reads without hiding context,
    // and fit the camera ONCE per selection key -- fittedKeyRef stops a
    // later sourcedata tick for the SAME selection from re-triggering
    // fitBounds (the reported "jumpy" bug); only a genuinely new
    // selection fits again.
    const hasSelection = !!fitToGeoids && fitToGeoids.length > 0;
    const wanted = hasSelection ? new Set(fitToGeoids) : null;
    const selectionKey = hasSelection ? Array.from(wanted!).sort().join(",") : "";
    dimSetRef.current = wanted;
    (map as unknown as { __applyScores?: () => void }).__applyScores?.();

    let cancelled = false;
    let usedFallbackCenter = false;

    // `map` is narrowed non-null above, but TS doesn't carry that through
    // a nested function declaration's closure -- `m` is the same value,
    // just captured through a binding TS keeps typed non-null throughout.
    const m: MapLibreMap = map;

    function tryFit() {
      if (cancelled) return;
      if (fittedKeyRef.current === selectionKey) return; // already fit this exact selection
      let features: ReturnType<MapLibreMap["querySourceFeatures"]>;
      try {
        features = wanted
          ? m.querySourceFeatures(SOURCE_ID, {
              filter: ["in", ["get", "geoid"], ["literal", Array.from(wanted)]] as unknown as ExpressionSpecification,
            })
          : m.querySourceFeatures(SOURCE_ID);
      } catch {
        return; // source not parsed yet -- the sourcedata listener below retries
      }
      if (features.length === 0) {
        // Nothing parsed yet for a whole-county fit -- ease to the
        // fallback center once so the map isn't blank while waiting,
        // then let the next sourcedata event try the real fit.
        if (!hasSelection && !usedFallbackCenter) {
          usedFallbackCenter = true;
          const mapCenter = COUNTY_MAP_CENTER[countyFips] ?? COUNTY_MAP_CENTER["48453"];
          if (reducedMotion()) m.jumpTo({ center: mapCenter.center, zoom: mapCenter.zoom });
          else m.easeTo({ center: mapCenter.center, zoom: mapCenter.zoom, duration: 0 });
        }
        return;
      }
      const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const f of features) {
        if (f.geometry && "coordinates" in f.geometry) extendBbox(bbox, f.geometry.coordinates);
      }
      if (!Number.isFinite(bbox[0])) return;
      const bounds: [[number, number], [number, number]] = [
        [bbox[0], bbox[1]],
        [bbox[2], bbox[3]],
      ];
      const opts = { padding: extraPad(m, framePadding(m.getContainer())), maxZoom: 14, pitch: 0, bearing: 0 };
      if (reducedMotion()) m.fitBounds(bounds, { ...opts, animate: false });
      else m.fitBounds(bounds, { ...opts, duration: 900, essential: true });
      fittedKeyRef.current = selectionKey; // one glide per selection -- no re-fit on later sourcedata ticks
    }

    tryFit();
    const onSourceData = (e: { sourceId?: string; dataType?: string }) => {
      if (e.sourceId === SOURCE_ID && m.isSourceLoaded(SOURCE_ID)) tryFit();
    };
    m.on("sourcedata", onSourceData as Parameters<MapLibreMap["on"]>[1]);
    return () => {
      cancelled = true;
      m.off("sourcedata", onSourceData as Parameters<MapLibreMap["off"]>[1]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, countyFips, JSON.stringify(fitToGeoids)]);

  // ---------------------------------------------------------------------
  // Dots — every gate-passed home in the selected block group, colored by
  // the same weighted score ramp, replacing the removed top-50 pins.
  // ---------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const marker of markersRef.current.values()) marker.remove();
    markersRef.current = new Map();

    for (const dot of dots) {
      if (dot.lon === null || dot.lat === null) continue;
      const el = document.createElement("div");
      el.className = "map-dot";
      el.dataset.testid = "map-dot";
      el.dataset.propId = dot.propId;
      const color = dot.score === null ? NOT_LOADED_HATCH_STRIPE : scoreRampColor(dot.score);
      el.style.width = "10px";
      el.style.height = "10px";
      el.style.borderRadius = "50%";
      el.style.background = color;
      el.style.border = "2px solid #ffffff";
      el.style.boxShadow = "0 0 0 1px rgba(0,0,0,0.25)";
      el.style.cursor = "pointer";
      el.addEventListener("mouseenter", () => onDotHover?.(dot.propId));
      el.addEventListener("mouseleave", () => onDotHover?.(null));

      const marker = new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([dot.lon, dot.lat]).addTo(map);
      markersRef.current.set(dot.propId, marker);
    }

    return () => {
      for (const marker of markersRef.current.values()) marker.remove();
      markersRef.current = new Map();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dots]);

  useEffect(() => {
    for (const [propId, marker] of markersRef.current) {
      const el = marker.getElement();
      const isHovered = propId === hoveredPropId;
      el.style.outline = isHovered ? "2px solid #1e4d2b" : "none";
      el.style.transform = isHovered ? "scale(1.4)" : "scale(1)";
      el.style.zIndex = isHovered ? "10" : "0";
    }
  }, [hoveredPropId]);

  // ---------------------------------------------------------------------
  // Top-ranked pins (Mock A): numbered markers for the current page-1
  // list, independent of any block-group selection/dots. Rank 1-6 filled
  // forest, 7-10 outlined, per the mock -- real ranks/coordinates only.
  // ---------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const marker of pinMarkersRef.current.values()) marker.remove();
    pinMarkersRef.current = new Map();

    for (const pin of topPins) {
      if (pin.lon === null || pin.lat === null) continue;
      const filled = pin.rank <= 6;
      const el = document.createElement("div");
      el.className = "map-pin";
      el.dataset.testid = "map-pin";
      el.dataset.propId = pin.propId;
      el.dataset.rank = String(pin.rank);
      el.style.width = "24px";
      el.style.height = "24px";
      el.style.borderRadius = "50%";
      el.style.display = "flex";
      el.style.alignItems = "center";
      el.style.justifyContent = "center";
      el.style.fontSize = "11px";
      el.style.fontWeight = "600";
      el.style.fontFamily = "var(--type-body-font-family, sans-serif)";
      el.style.cursor = "pointer";
      el.style.boxShadow = "0 1px 3px rgba(0,0,0,0.35)";
      if (filled) {
        el.style.background = "#1e4d2b";
        el.style.color = "#fff";
        el.style.border = "2px solid #ffffff";
      } else {
        el.style.background = "#ffffff";
        el.style.color = "#1e4d2b";
        el.style.border = "2px solid #1e4d2b";
      }
      el.textContent = String(pin.rank);
      el.addEventListener("mouseenter", () => onDotHover?.(pin.propId));
      el.addEventListener("mouseleave", () => onDotHover?.(null));
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        onPinClick?.(pin.propId);
      });

      const marker = new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([pin.lon, pin.lat]).addTo(map);
      pinMarkersRef.current.set(pin.propId, marker);
    }

    return () => {
      for (const marker of pinMarkersRef.current.values()) marker.remove();
      pinMarkersRef.current = new Map();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(topPins)]);

  // ---------------------------------------------------------------------
  // "Locate on map" -- flies to a real parcel centroid only; never moves
  // the camera for a home with no loaded coordinate.
  // ---------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !focusHome || focusHome.lon === null || focusHome.lat === null) return;
    const target = { center: [focusHome.lon, focusHome.lat] as [number, number], zoom: Math.max(map.getZoom(), 15) };
    if (reducedMotion()) map.jumpTo(target);
    else map.flyTo({ ...target, duration: 900, essential: true });
  }, [ready, focusHome]);

  return (
    <div style={{ position: "relative", width: "100%", height, minHeight: "360px" }}>
      <div
        ref={containerRef}
        data-testid="blockgroup-map"
        data-scored-count={scoredCount}
        data-dot-count={dots.filter((d) => d.lon !== null && d.lat !== null).length}
        style={{
          width: "100%",
          height: "100%",
          borderRadius: "var(--rounded-md)",
          overflow: "hidden",
        }}
      />
      <MapLegend selected={selectedGeoid !== null} shadeLabel={shadeLabel} />
      {selectedHome ? <SelectedHomeCard home={selectedHome} /> : null}
    </div>
  );
}

function SelectedHomeCard({
  home,
}: {
  home: NonNullable<BlockGroupMapProps["selectedHome"]>;
}) {
  return (
    <div
      data-testid="map-selected-home-card"
      style={{
        position: "absolute",
        left: "var(--space-3)",
        bottom: "var(--space-3)",
        maxWidth: "300px",
        backgroundColor: "var(--theme-surface)",
        color: "var(--theme-ink)",
        borderRadius: "var(--rounded-md)",
        padding: "var(--space-3)",
        boxShadow: "0 4px 12px rgba(0,0,0,0.16)",
      }}
    >
      <div style={{ fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
        {home.rank !== null ? `Rank ${home.rank} · selected home` : "Selected home"}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "var(--space-2)", marginTop: "2px" }}>
        <div style={{ fontWeight: 600 }}>{home.address}</div>
        <div style={{ fontSize: "var(--type-label-font-size)", fontWeight: 600, color: "var(--theme-brand-accent-text)", textAlign: "right", whiteSpace: "nowrap" }}>
          {home.tierLabel}
          <div style={{ fontWeight: 400, color: "var(--theme-ink-muted)", fontSize: "11px" }}>{home.tierSublabel}</div>
        </div>
      </div>
      <div style={{ fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)", marginTop: "2px" }}>{home.metaLine}</div>
      <a
        href={`/home/${home.propId}`}
        style={{ marginTop: "var(--space-2)", fontSize: "var(--type-label-font-size)", fontWeight: 600, color: "var(--theme-brand-accent-text)", display: "block" }}
      >
        Open full record →
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legend — DESIGN.md's 5-step score ramp (low -> high, at the CURRENT
// weights, since the ramp is an absolute mean score recomputed every
// slider move — never a fixed number), the hatch swatch for "no gated homes /
// not scored", and, only while a block group is selected, the home-dot
// scale + the selected-outline swatch. Bottom-left overlay so it never
// covers the basemap's (bottom-right) attribution control.
// ---------------------------------------------------------------------------

function MapLegend({ selected, shadeLabel }: { selected: boolean; shadeLabel: string }) {
  return (
    <div
      data-testid="map-legend"
      style={{
        position: "absolute",
        left: "var(--space-3)",
        top: "var(--space-3)",
        backgroundColor: "var(--theme-surface)",
        color: "var(--theme-ink)",
        borderRadius: "var(--rounded-md)",
        padding: "var(--space-2) var(--space-3)",
        boxShadow: "0 1px 4px rgba(0,0,0,0.2)",
        fontSize: "var(--type-label-font-size)",
        maxWidth: "260px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <span style={{ display: "flex", alignItems: "center", gap: "2px" }}>
          {SCORE_RAMP.map((color, i) => (
            <span key={i} style={{ width: "14px", height: "10px", backgroundColor: color, display: "inline-block" }} />
          ))}
        </span>
        <span style={{ color: "var(--theme-ink-muted)", whiteSpace: "nowrap" }}>
          Fewer &harr; more {shadeLabel}
        </span>
      </div>

      {selected ? (
        <div style={{ marginTop: "6px", borderTop: "1px solid var(--theme-ink-muted)", paddingTop: "6px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "4px" }}>
            <span
              aria-hidden="true"
              style={{ width: "10px", height: "10px", borderRadius: "50%", background: SCORE_RAMP[SCORE_RAMP.length - 1], border: "2px solid #ffffff", boxShadow: "0 0 0 1px rgba(0,0,0,0.25)" }}
            />
            <span>Home, colored the same way</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            <span aria-hidden="true" style={{ width: "18px", height: "0px", borderTop: "3px solid #1e4d2b" }} />
            <span>Selected block group</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
