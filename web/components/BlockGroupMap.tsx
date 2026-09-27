"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap, ExpressionSpecification, MapLayerMouseEvent } from "maplibre-gl";
import { maplibregl } from "../lib/maplibre";
import type { SignalKey } from "../app/api/top-homes/route";
import { COUNTY_MAP_CENTER } from "../lib/counties";
import { emitIntroStageReady, onIntroCue } from "../lib/introBus";
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

/** Frame the area in the clear part of the map: measure the legend
 * (top-left) and the selected-home card (bottom-left) where they actually
 * render, then try two layouts -- clear them vertically (area sits between
 * legend and card) or horizontally (area sits to their right) -- and keep
 * whichever lets the camera zoom in further. Falls back to fixed padding
 * before the overlays have rendered or on narrow maps. */
function bestFramePadding(map: MapLibreMap, bounds: [[number, number], [number, number]]): Pad {
  const el = map.getContainer();
  if (el.clientWidth < 640) return framePadding(el);
  const host = el.parentElement;
  const cr = el.getBoundingClientRect();
  const legend = host?.querySelector<HTMLElement>('[data-testid="map-legend"]')?.getBoundingClientRect();
  const card = host?.querySelector<HTMLElement>('[data-testid="map-selected-home-card"]')?.getBoundingClientRect();
  const M = 28;
  const right = 64; // zoom control + attribution
  const vertical: Pad = {
    top: legend ? legend.bottom - cr.top + M : M,
    bottom: card ? cr.bottom - card.top + M : M,
    left: M,
    right,
  };
  const horizontal: Pad = {
    top: M,
    bottom: M,
    left: Math.max(legend ? legend.right - cr.left : 0, card ? card.right - cr.left : 0) + M,
    right,
  };
  let best: Pad = vertical;
  let bestZoom = -Infinity;
  for (const pad of [vertical, horizontal]) {
    if (pad.left + pad.right >= el.clientWidth - 80 || pad.top + pad.bottom >= el.clientHeight - 80) continue;
    const cam = map.cameraForBounds(bounds, { padding: pad, maxZoom: 14 });
    const z = cam?.zoom ?? -Infinity;
    if (z > bestZoom) {
      bestZoom = z;
      best = pad;
    }
  }
  return best;
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
  /** The pin to emphasise (the selected / expanded home); defaults to rank 1. */
  selectedPinId?: string | null;
  /** Rounded map corners (panel use); false for the full-bleed ranking workspace. */
  rounded?: boolean;
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
  selectedPinId = null,
  rounded = true,
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
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

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
            // first-visit intro reel: hidden until its wavefront reaches this
            // block group (never set outside the reel; cleared on "restore")
            ["==", ["feature-state", "introHidden"], true],
            0,
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
      const opts = { padding: extraPad(m, bestFramePadding(m, bounds)), maxZoom: 14, pitch: 0, bearing: 0 };
      if (reducedMotion()) m.fitBounds(bounds, { ...opts, animate: false });
      else m.fitBounds(bounds, { ...opts, duration: 900, essential: true });
      fittedKeyRef.current = selectionKey; // one glide per selection -- no re-fit on later sourcedata ticks
      // First-visit intro reel: the county frame is settled once this fit and
      // its tiles are done; the reel waits for this before revealing the map.
      if (!hasSelection) m.once("idle", () => emitIntroStageReady());
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
  // First-visit intro reel (components/intro). The reel plays over this map
  // and raises cues on lib/introBus; this effect answers them and undoes
  // every change on "restore" (saved camera, feature-state, wave layers), so
  // the page ends in exactly its normal first-load state.
  //   live  -> save the county camera, hide the priority fill
  //   wave  -> a gold ring spreads from rank 1's pin; block groups inside it
  //            fade back to their real shade
  //   glide -> eased camera move to rank 1
  //   restore -> jump back to the saved camera, clear everything
  // ---------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const m: MapLibreMap = map;
    const WAVE_SOURCE = "zeus-intro-wave";
    const WAVE_GLOW = "zeus-intro-wave-glow";
    const WAVE_LINE = "zeus-intro-wave-line";
    let saved: { center: [number, number]; zoom: number; bearing: number; pitch: number } | null = null;
    let centroids: Array<{ geoid: string; d: number }> = [];
    let hidden = new Set<string>();
    let origin: [number, number] | null = null;
    let maxKm = 0;

    const km = (a: [number, number], b: [number, number]) => {
      const kx = 111.32 * Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
      return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110.57);
    };
    const ring = (c: [number, number], rKm: number) => {
      const pts: [number, number][] = [];
      const kx = 111.32 * Math.cos(c[1] * (Math.PI / 180));
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * Math.PI * 2;
        pts.push([c[0] + (Math.cos(a) * rKm) / kx, c[1] + (Math.sin(a) * rKm) / 110.57]);
      }
      return { type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: pts } };
    };
    const clearWave = () => {
      if (m.getLayer(WAVE_LINE)) m.removeLayer(WAVE_LINE);
      if (m.getLayer(WAVE_GLOW)) m.removeLayer(WAVE_GLOW);
      if (m.getSource(WAVE_SOURCE)) m.removeSource(WAVE_SOURCE);
    };
    const reveal = (geoid: string) => {
      m.setFeatureState({ source: SOURCE_ID, id: geoid }, { introHidden: false });
      hidden.delete(geoid);
    };

    return onIntroCue(({ cue, progress }) => {
      if (cue === "live") {
        const c = m.getCenter();
        saved = { center: [c.lng, c.lat], zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() };
        const pin = pinPropsRef.current.topPins.find((p) => p.rank === 1 && p.lon !== null && p.lat !== null);
        origin = pin ? [pin.lon as number, pin.lat as number] : saved.center;
        const boxes = new Map<string, [number, number, number, number]>();
        try {
          for (const f of m.querySourceFeatures(SOURCE_ID)) {
            const geoid = f.properties?.geoid as string | undefined;
            if (!geoid || !f.geometry || !("coordinates" in f.geometry)) continue;
            const b = boxes.get(geoid) ?? [Infinity, Infinity, -Infinity, -Infinity];
            extendBbox(b, f.geometry.coordinates);
            boxes.set(geoid, b);
          }
        } catch {
          // source not parsed: the fill simply stays as it is
        }
        centroids = Array.from(boxes, ([geoid, b]) => ({ geoid, d: km(origin as [number, number], [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]) }));
        maxKm = centroids.reduce((mx, x) => Math.max(mx, x.d), 0) * 1.04;
        hidden = new Set(centroids.map((x) => x.geoid));
        for (const g of hidden) m.setFeatureState({ source: SOURCE_ID, id: g }, { introHidden: true });
        clearWave();
        m.addSource(WAVE_SOURCE, { type: "geojson", data: ring(origin, 0.01) });
        m.addLayer({ id: WAVE_GLOW, type: "line", source: WAVE_SOURCE, paint: { "line-color": "#f7c33c", "line-width": 16, "line-blur": 10, "line-opacity": 0 } });
        m.addLayer({ id: WAVE_LINE, type: "line", source: WAVE_SOURCE, paint: { "line-color": "#f7c33c", "line-width": 2.5, "line-opacity": 0 } });
      } else if (cue === "wave" && origin && typeof progress === "number") {
        const eased = progress >= 1 ? 1 : 1 - Math.pow(2, -8 * progress);
        const r = Math.max(0.01, maxKm * eased);
        for (const x of centroids) if (x.d <= r && hidden.has(x.geoid)) reveal(x.geoid);
        const src = m.getSource(WAVE_SOURCE) as { setData?: (d: unknown) => void } | undefined;
        src?.setData?.(ring(origin, r));
        const fade = progress < 0.85 ? 1 : Math.max(0, (1 - progress) / 0.15);
        if (m.getLayer(WAVE_LINE)) m.setPaintProperty(WAVE_LINE, "line-opacity", 0.95 * fade);
        if (m.getLayer(WAVE_GLOW)) m.setPaintProperty(WAVE_GLOW, "line-opacity", 0.45 * fade);
      } else if (cue === "glide" && saved && origin) {
        for (const g of Array.from(hidden)) reveal(g);
        clearWave();
        m.easeTo({ center: origin, zoom: saved.zoom + 2.2, duration: 1200, easing: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)), essential: true });
      } else if (cue === "restore") {
        clearWave();
        for (const x of centroids) m.removeFeatureState({ source: SOURCE_ID, id: x.geoid }, "introHidden");
        hidden.clear();
        if (saved) m.jumpTo(saved);
        saved = null;
        origin = null;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

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
  // list. Rank 1-6 filled forest, 7-10 outlined. The selected home's pin
  // (rank 1 by default) is larger with a lime ring and always sits on top.
  // Pins that would overlap on screen (within PIN_MERGE_PX at the current
  // zoom) merge into one pill listing their ranks; clicking the pill zooms
  // in until they separate. Re-laid-out after every zoom.
  // ---------------------------------------------------------------------
  const pinPropsRef = useRef({ topPins, selectedPinId, onPinClick, onDotHover });
  pinPropsRef.current = { topPins, selectedPinId, onPinClick, onDotHover };

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const m: MapLibreMap = map;
    const PIN_MERGE_PX = 34;
    const CLEAR_SELECTED_PX = 38;

    function clear() {
      for (const marker of pinMarkersRef.current.values()) marker.remove();
      pinMarkersRef.current = new Map();
    }

    function pinEl(label: string, kind: "filled" | "outlined" | "selected" | "group"): HTMLDivElement {
      const el = document.createElement("div");
      el.className = `map-pin map-pin--${kind}`;
      el.dataset.testid = "map-pin";
      el.textContent = label;
      return el;
    }

    function layout() {
      clear();
      const { topPins: pins, selectedPinId: selId, onPinClick: click, onDotHover: hover } = pinPropsRef.current;
      const placed = pins.filter((p): p is typeof p & { lon: number; lat: number } => p.lon !== null && p.lat !== null);
      if (placed.length === 0) return;
      const selected = placed.find((p) => p.propId === selId) ?? placed.find((p) => p.rank === 1) ?? null;
      const rest = placed.filter((p) => p !== selected);

      // Greedy grouping on screen position; each group tracks the running
      // centroid of its members, which is where its marker is drawn.
      const groups: Array<{ pins: typeof rest; x: number; y: number }> = [];
      for (const p of rest) {
        const pt = m.project([p.lon, p.lat]);
        const g = groups.find((gr) => Math.hypot(gr.x - pt.x, gr.y - pt.y) < PIN_MERGE_PX);
        if (g) {
          g.pins.push(p);
          g.x += (pt.x - g.x) / g.pins.length;
          g.y += (pt.y - g.y) / g.pins.length;
        } else groups.push({ pins: [p], x: pt.x, y: pt.y });
      }

      // Keep the selected pin readable: nudge any pin or group that would
      // sit under it straight out along the line between them (or
      // downwards when they coincide) until it clears the selected pin.
      const selPt = selected ? m.project([selected.lon, selected.lat]) : null;
      const offsetFor = (g: { x: number; y: number }): [number, number] => {
        if (!selPt) return [0, 0];
        const dx = g.x - selPt.x;
        const dy = g.y - selPt.y;
        const d = Math.hypot(dx, dy);
        if (d >= CLEAR_SELECTED_PX) return [0, 0];
        const ux = d < 1 ? 0 : dx / d;
        const uy = d < 1 ? 1 : dy / d;
        return [ux * (CLEAR_SELECTED_PX - d), uy * (CLEAR_SELECTED_PX - d)];
      };

      for (const g of groups) {
        const offset = offsetFor(g);
        if (g.pins.length === 1) {
          const p = g.pins[0];
          const el = pinEl(String(p.rank), p.rank <= 6 ? "filled" : "outlined");
          el.dataset.propId = p.propId;
          el.dataset.rank = String(p.rank);
          el.setAttribute("aria-label", `Rank ${p.rank}`);
          el.addEventListener("mouseenter", () => hover?.(p.propId));
          el.addEventListener("mouseleave", () => hover?.(null));
          el.addEventListener("click", (e) => {
            e.stopPropagation();
            click?.(p.propId);
          });
          pinMarkersRef.current.set(p.propId, new maplibregl.Marker({ element: el, anchor: "center", offset: offset }).setLngLat([p.lon, p.lat]).addTo(m));
        } else {
          const ranks = g.pins.map((p) => p.rank).sort((a, b) => a - b);
          const el = pinEl(ranks.join(" · "), "group");
          el.dataset.rank = ranks.join(",");
          el.setAttribute("aria-label", `Ranks ${ranks.join(", ")}; zoom in to separate`);
          el.title = "Zoom in to separate these homes";
          el.addEventListener("click", (e) => {
            e.stopPropagation();
            let w = Infinity, so = Infinity, ea = -Infinity, n = -Infinity;
            for (const p of g.pins) {
              w = Math.min(w, p.lon); ea = Math.max(ea, p.lon);
              so = Math.min(so, p.lat); n = Math.max(n, p.lat);
            }
            const target = m.cameraForBounds([[w, so], [ea, n]], { padding: 120, maxZoom: 17 });
            const zoom = Math.max(m.getZoom() + 2, Math.min(17, target?.zoom ?? m.getZoom() + 2));
            const center: [number, number] = [(w + ea) / 2, (so + n) / 2];
            if (reducedMotion()) m.jumpTo({ center, zoom });
            else m.easeTo({ center, zoom, duration: 700, essential: true });
          });
          const at = m.unproject([g.x, g.y]);
          pinMarkersRef.current.set(`group-${ranks.join("-")}`, new maplibregl.Marker({ element: el, anchor: "center", offset: offset }).setLngLat(at).addTo(m));
        }
      }

      if (selected) {
        const el = pinEl(String(selected.rank), "selected");
        el.dataset.propId = selected.propId;
        el.dataset.rank = String(selected.rank);
        el.setAttribute("aria-label", `Rank ${selected.rank}, selected`);
        el.addEventListener("mouseenter", () => hover?.(selected.propId));
        el.addEventListener("mouseleave", () => hover?.(null));
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          click?.(selected.propId);
        });
        pinMarkersRef.current.set(selected.propId, new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([selected.lon, selected.lat]).addTo(m));
      }
    }

    layout();
    m.on("zoomend", layout);
    return () => {
      m.off("zoomend", layout);
      clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, JSON.stringify(topPins), selectedPinId]);

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
          borderRadius: rounded ? "var(--rounded-md)" : 0,
          overflow: "hidden",
        }}
      />
      <MapLegend selected={selectedGeoid !== null} shadeLabel={shadeLabel} showPins={topPins.some((p) => p.lon !== null && p.lat !== null)} />
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
    <div data-testid="map-selected-home-card" className="map-card map-card--home">
      <div className="map-card__kicker">{home.rank !== null ? `Rank ${home.rank} · selected home` : "Selected home"}</div>
      <div className="map-card__row">
        <span className="map-card__address" title={home.address}>
          {home.address}
        </span>
        <span className="map-card__tier">{home.tierLabel}</span>
      </div>
      {home.metaLine ? <div className="map-card__meta">{home.metaLine}</div> : null}
      <a href={`/home/${home.propId}`} className="map-card__link">
        <span>Open full record</span>
        <span aria-hidden="true">→</span>
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legend (top-left card): what the shading means, the score ramp with its
// two ends named, the hatch for block groups with no ranked homes, the pin
// key, and -- only while a block group is selected -- the home-dot and
// selected-outline keys.
// ---------------------------------------------------------------------------

function MapLegend({ selected, shadeLabel, showPins }: { selected: boolean; shadeLabel: string; showPins: boolean }) {
  const team = shadeLabel !== "top-priority homes";
  return (
    <div data-testid="map-legend" className="map-card map-card--legend">
      <div className="map-card__title">{team ? "Team priority by area" : "Priority by area"}</div>
      <div className="map-card__explain">
        {team ? "Shading = the average team priority score of each block group's homes." : "Shading = share of each block group's homes in the top priority tier."}
      </div>
      <div className="map-legend__ramp" aria-hidden="true" style={{ background: `linear-gradient(90deg, ${SCORE_RAMP.join(", ")})` }} />
      <div className="map-legend__ends">
        <span>{team ? "lower" : "fewer"}</span>
        <span>{team ? "higher team score" : "more top-priority homes"}</span>
      </div>
      <div className="map-legend__key">
        <span className="map-legend__hatch" aria-hidden="true" />
        No ranked homes · not served or not eligible
      </div>
      {showPins ? (
        <div className="map-legend__key">
          <span className="map-legend__pin" aria-hidden="true" />
          Top 10 homes pinned
        </div>
      ) : null}
      {selected ? (
        <>
          <div className="map-legend__key">
            <span className="map-legend__dot" aria-hidden="true" style={{ background: SCORE_RAMP[SCORE_RAMP.length - 1] }} />
            Home, colored the same way
          </div>
          <div className="map-legend__key">
            <span className="map-legend__outline" aria-hidden="true" />
            Selected block group
          </div>
        </>
      ) : null}
    </div>
  );
}
