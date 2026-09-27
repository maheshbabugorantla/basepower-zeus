"use client";

import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BlockGroupMap, type MapDot } from "../../components/BlockGroupMap";
import { TopHomesTable, TopHomesPagination, type TopHomeRow } from "../../components/TopHomesTable";
import { WeightSliders, equalWeights } from "../../components/WeightSliders";
import { Panel } from "../../components/ui/Panel";
import { MissingState } from "../../components/ui/MissingState";
import type { SignalKey, PredictedHomeRow } from "../api/top-homes/route";
import { PredictedHomesTable } from "./PredictedHomesTable";
import { bucketBy, filterRows, countyTotals, type GeoRollupRow } from "../../lib/geoRollup";
import { decileRangeForTier, tierMeta, tierForDecile, PRIORITY_TIER_ORDER, type PriorityTierKey } from "../../lib/priorityTier";

// M4-W2: predicted (api.home_propensity.p_install_12m) is the ranking
// DEFAULT; "Team-weighted score" is the alternative, unchanged (M2-W1's)
// slider-driven ranking. Moving a slider only matters in weighted mode,
// so it also switches the mode -- a slider that silently did nothing in
// predicted mode would be a confusing dead control.

type RankingMode = "predicted" | "weighted";

// M2-W1: owns the ranking screen's live state — hovered block group
// (M1-W1, unchanged), weights (M2-W1), the current ranked page, and the
// rank-change indicator shown for 2s after a re-rank. Moving a slider
// debounces ~250ms then POSTs to /api/top-homes (api.homes_ranked_weighted),
// never a full page reload — the map/table/left-rail stay mounted.
//
// M2-W3 scope change: the table is no longer a fixed top-50 — it pages
// through every gate-passed county home (keyset pagination, DEFAULT_PAGE_SIZE
// per page) unless a block group is selected on the map, in which case it
// pages through that block group's gate-passed homes only. The map itself
// recolors from api.blockgroup_scores_weighted (its own debounced fetch,
// see BlockGroupMap) and, once a block group is selected, draws every one
// of that block group's homes as a colored dot (replacing the removed
// fixed top-50 pins). A table row hover highlights its dot + block-group
// outline; a dot hover highlights its row (and scrolls it into view only
// if it isn't already visible).

// Client-safe duplicate of app/api/top-homes/route.ts's SIGNAL_KEYS
// (matching web/app/export/homes/route.ts's own existing duplicate of the
// same list) -- importing the real SIGNAL_KEYS VALUE from route.ts here
// would pull that whole server module (next/server, lib/db.ts's `pg`
// import) into the client bundle; a type-only import (SignalKey, above)
// is erased at build and stays safe.
const SIGNAL_KEYS: readonly SignalKey[] = [
  "outage",
  "home_value",
  "backup_intent",
  "age65",
  "home_permits",
  "electric_heat",
  "empower",
  "owner_65",
  "installability",
  "flood",
  "income_100k",
  "age_35_64",
  "permit_risk",
];

const DEBOUNCE_MS = 250;
const RANK_DELTA_DISPLAY_MS = 2000;
const TRAVIS_COUNTY_FIPS = "48453";
const DEFAULT_PAGE_SIZE = 50;
// Large enough to cover any real Travis block group's gate-passed home
// count in one call (the biggest observed group is in the low hundreds) —
// never a second "load more" round trip for the map dots.
const DOTS_PAGE_SIZE = 5000;

interface Cursor {
  afterScore: number | null;
  afterPropId: string | null;
}

const FIRST_CURSOR: Cursor = { afterScore: null, afterPropId: null };

interface PredictedCursor {
  afterP: string | null;
  afterPropId: string | null;
}

const FIRST_PREDICTED_CURSOR: PredictedCursor = { afterP: null, afterPropId: null };

async function fetchPredictedPage(params: {
  countyFips: string;
  blockGroupGeoid: string | null;
  situsCity?: string | null;
  situsZip?: string | null;
  cursor: PredictedCursor;
  pageSize?: number;
  withTotal: boolean;
  hideOldHomes?: boolean;
  excludeBackup?: boolean;
  tier?: PriorityTierKey | "all";
}): Promise<{ rows: PredictedHomeRow[]; total: number | null }> {
  const [minDecile, maxDecile] = decileRangeForTier(params.tier ?? "all");
  const response = await fetch("/api/top-homes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({
      mode: "predicted",
      countyFips: params.countyFips,
      blockGroupGeoid: params.blockGroupGeoid,
      situsCity: params.situsCity ?? undefined,
      situsZip: params.situsZip ?? undefined,
      afterP: params.cursor.afterP,
      afterPropId: params.cursor.afterPropId,
      pageSize: params.pageSize ?? DEFAULT_PAGE_SIZE,
      hideOldHomes: params.hideOldHomes ?? false,
      excludeBackup: params.excludeBackup ?? true,
      minDecile,
      maxDecile,
    }),
  });
  if (!response.ok) throw new Error(`Ranking request failed (HTTP ${response.status})`);
  return response.json();
}

function buildRankMap(rows: TopHomeRow[]): Map<string, number> {
  const map = new Map<string, number>();
  rows.forEach((row, index) => map.set(row.propId, index + 1));
  return map;
}

async function fetchPage(params: {
  countyFips: string;
  weights: Record<SignalKey, number>;
  blockGroupGeoid: string | null;
  situsCity?: string | null;
  situsZip?: string | null;
  cursor: Cursor;
  pageSize?: number;
  withTotal: boolean;
  hideOldHomes?: boolean;
  /** M2-P11 "Hide homes that already have backup" -- default ON. */
  excludeBackup?: boolean;
}): Promise<{ rows: TopHomeRow[]; total: number | null }> {
  const response = await fetch("/api/top-homes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({
      mode: "weighted",
      weights: params.weights,
      countyFips: params.countyFips,
      blockGroupGeoid: params.blockGroupGeoid,
      situsCity: params.situsCity ?? undefined,
      situsZip: params.situsZip ?? undefined,
      afterScore: params.cursor.afterScore,
      afterPropId: params.cursor.afterPropId,
      pageSize: params.pageSize ?? DEFAULT_PAGE_SIZE,
      hideOldHomes: params.hideOldHomes ?? false,
      excludeBackup: params.excludeBackup ?? true,
    }),
  });
  if (!response.ok) throw new Error(`Ranking request failed (HTTP ${response.status})`);
  return response.json();
}

/**
 * A block group GEOID (state 2 + county 3 + tract 6 + block group 1, e.g.
 * 484530329001) as people read it on a census map: "Tract 329, block group 1".
 */
// M-drilldown (item 3): a <select>'s value is always a plain string, so
// the city/ZIP filter's real states (null = "All", "" = the no-value
// bucket, anything else = an exact value) need distinct sentinel strings
// that can never collide with a real city name or ZIP.
const ALL_VALUE = "__all__";
const NULL_BUCKET_VALUE = "__none__";

function toSelectValue(key: string): string {
  return key === "" ? NULL_BUCKET_VALUE : key;
}

function fromSelectValue(value: string): string | null {
  if (value === ALL_VALUE) return null;
  if (value === NULL_BUCKET_VALUE) return "";
  return value;
}

function blockGroupLabel(geoid: string): string {
  if (!/^\d{12}$/.test(geoid)) return `Block group ${geoid}`;
  const tractRaw = geoid.slice(5, 11);
  const tract = `${Number(tractRaw.slice(0, 4))}${tractRaw.slice(4) === "00" ? "" : `.${tractRaw.slice(4)}`}`;
  return `Tract ${tract}, block group ${geoid.slice(11)}`;
}

export function RankingBoard({
  rows: initialRows,
  initialTotal,
  questionText,
  statusLine,
  defaultWeights = null,
  predictedRows: initialPredictedRows,
  predictedTotal: initialPredictedTotal,
  countyName = "Travis",
  countyFips = TRAVIS_COUNTY_FIPS,
  geoRollup = [],
  initialMode = "predicted",
  initialWeights = null,
  initialCity = null,
  initialZip = null,
  initialBlockGroupGeoid = null,
  initialHideOldHomes = false,
  initialHideExistingBackup = true,
  initialTier = "all",
}: {
  rows: TopHomeRow[];
  /** Real gate-passed county home count (api.homes_ranked_weighted_count), server-rendered. */
  initialTotal: number;
  /** Redesign (Mock A): "Which <County> homes should Base knock next?" -- built server-side from the real county name. */
  questionText: ReactNode;
  /** Redesign: one real status line built server-side from api.gate_counts (replaces the old left-rail gate funnel). */
  statusLine: ReactNode;
  /** api.default_weights, read server-side (M2-P8); null falls back to equal=5. */
  defaultWeights?: Record<SignalKey, number> | null;
  /** M4-W2: server-rendered predicted-mode page 1 (the ranking default) and its exact filtered count. */
  predictedRows: PredictedHomeRow[];
  predictedTotal: number | null;
  /** api.model_card, server-rendered for the "How we know it works" panel. */
  countyName?: string;
  /** M3-W1: the county the ranking/map/table are scoped to — follows
   * the top-bar county switcher via app/ranking/page.tsx's `?county=`. */
  countyFips?: string;
  /** M-drilldown (item 3): api.home_geo_rollup rows for this county,
   * cascaded client-side into the City -> ZIP -> Neighborhood dropdowns. */
  geoRollup?: GeoRollupRow[];
  /** M-urlstate (item 4): every initial* prop below is read from the URL
   * server-side (app/ranking/page.tsx) so the first paint already matches
   * what's in the address bar -- these are only the React state seeds;
   * the effect below keeps the URL in sync with state after that. */
  initialMode?: RankingMode;
  initialWeights?: Record<SignalKey, number> | null;
  initialCity?: string | null;
  initialZip?: string | null;
  initialBlockGroupGeoid?: string | null;
  initialHideOldHomes?: boolean;
  initialHideExistingBackup?: boolean;
  /** Lead-list "Priority" filter -- decile range under the hood (lib/priorityTier). */
  initialTier?: PriorityTierKey | "all";
}) {
  // M4-W2: predicted is the default ranking mode; "weighted" is the
  // team-adjustment alternative (unchanged M2-W1 behavior).
  const [mode, setMode] = useState<RankingMode>(initialMode);
  const [weights, setWeights] = useState<Record<SignalKey, number>>(initialWeights ?? defaultWeights ?? equalWeights());
  // M2-P8: "Hide homes built before 2000" — a team choice, not a Base
  // rule, default OFF. Filtered in the /api/top-homes route on yr_built
  // (a column the ranking function already returns on every row), never
  // a second request-time scan of core.parcels.
  const [hideOldHomes, setHideOldHomes] = useState(initialHideOldHomes);
  // M2-P11: "Hide homes that already have backup" -- default ON (a home
  // already known to have its own battery/generator/other-installer permit
  // is excluded from outreach ranking by default; toggle restores them).
  // Wired straight through to api.homes_ranked_weighted's p_exclude_backup.
  const [hideExistingBackup, setHideExistingBackup] = useState(initialHideExistingBackup);
  // Priority tier filter -- "all" means every tier; otherwise a
  // decileRangeForTier(tier) range is sent to /api/top-homes. Only
  // affects predicted mode (the model's own decile); has no effect in
  // team-weighted mode, which has no decile.
  const [tierFilter, setTierFilter] = useState<PriorityTierKey | "all">(initialTier);

  // M-drilldown (item 3): city/ZIP filter state -- null = "All", ""
  // (empty string) = the "no value on file" bucket, same convention as
  // lib/geoRollup.ts / app/api/top-homes/route.ts's situsCity/situsZip.
  const [selectedCity, setSelectedCity] = useState<string | null>(initialCity);
  const [selectedZip, setSelectedZip] = useState<string | null>(initialZip);

  // County-wide vs. block-group-scoped ranking.
  const [selectedGeoid, setSelectedGeoid] = useState<string | null>(initialBlockGroupGeoid);
  const [cursors, setCursors] = useState<Cursor[]>([FIRST_CURSOR]);
  const [pageIndex, setPageIndex] = useState(0);
  const [rows, setRows] = useState<TopHomeRow[]>(initialRows);
  const [total, setTotal] = useState<number | null>(initialTotal);
  const [rankDeltas, setRankDeltas] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // M4-W2: predicted-mode's own page/cursor state -- kept separate from
  // the weighted-mode state above so switching modes never mixes a
  // numeric score cursor with a p_install_12m cursor.
  const [predictedCursors, setPredictedCursors] = useState<PredictedCursor[]>([FIRST_PREDICTED_CURSOR]);
  const [predictedPageIndex, setPredictedPageIndex] = useState(0);
  const [predictedRows, setPredictedRows] = useState<PredictedHomeRow[]>(initialPredictedRows);
  const [predictedTotal, setPredictedTotal] = useState<number | null>(initialPredictedTotal);
  const [predictedLoading, setPredictedLoading] = useState(false);
  const [predictedError, setPredictedError] = useState<string | null>(null);

  // Every gate-passed home in the selected block group, for the map dots.
  const [dots, setDots] = useState<MapDot[]>([]);

  // Hover sync: a row hover sets both; a dot hover sets both too, but
  // additionally marks the source as "map" so the table scrolls the row
  // into view (a row's own hover never re-triggers its own scroll).
  const [hoveredPropId, setHoveredPropId] = useState<string | null>(null);
  const [hoveredGeoid, setHoveredGeoid] = useState<string | null>(null);
  const [scrollToPropId, setScrollToPropId] = useState<string | null>(null);

  // Redesign (Mock A): the one row expanded IN PLACE with the case for a
  // knock -- replaces the "Why this home" panel that used to append below
  // the whole board (critique P0: "home detail is a separate route/panel,
  // not in-place"). Both PredictedHomesTable and TopHomesTable own their
  // own expand toggle now; this is just the shared piece of state.
  const [expandedPropId, setExpandedPropId] = useState<string | null>(null);
  function toggleExpand(propId: string) {
    setExpandedPropId((current) => (current === propId ? null : propId));
  }

  // "Locate on map" -- flies the map to one home's real parcel centroid.
  const [focusHome, setFocusHome] = useState<{ lon: number | null; lat: number | null } | null>(null);
  function handleLocateOnMap(row: { propId: string; lon: number | null; lat: number | null }) {
    setHoveredPropId(row.propId);
    setFocusHome({ lon: row.lon, lat: row.lat });
  }

  // Redesign: Filters + Adjust priorities are popovers off the rail
  // header (DESIGN.md "no modal where an inline popover/disclosure would
  // do") instead of always-open panels in a left rail column.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);

  // Search: filters the CURRENTLY LOADED page's real rows by address/ZIP
  // (never a fabricated match) -- a query that exactly matches a known
  // city or ZIP in this county's geo rollup also drives the same
  // city/ZIP drilldown the selects below use, so typing "78731" narrows
  // the whole board, not just the visible page.
  const [searchQuery, setSearchQuery] = useState("");

  // Keyboard: Up/Down moves the highlighted row (scoped to the rail
  // list, not window), Enter expands it.
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const prevRankRef = useRef<Map<string, number>>(buildRankMap(initialRows));
  const isFirstRun = useRef(true);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeqRef = useRef(0);

  // Re-fetch the current page whenever weights or the block-group
  // selection change (always resets to page 1 — "Moving a slider
  // re-scores both the map and the current table view"). Skipped on
  // mount: initialRows/initialTotal (server-rendered, equal weights, no
  // selection) are already the correct first paint.
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    if (mode !== "weighted") return; // predicted mode has its own effect below

    const mySeq = ++requestSeqRef.current;
    setCursors([FIRST_CURSOR]);
    setPageIndex(0);

    const debounceTimer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const [page, dotsPage] = await Promise.all([
          fetchPage({ countyFips, weights, blockGroupGeoid: selectedGeoid, situsCity: selectedCity, situsZip: selectedZip, cursor: FIRST_CURSOR, withTotal: true, hideOldHomes, excludeBackup: hideExistingBackup }),
          selectedGeoid
            ? fetchPage({
                countyFips,
                weights,
                blockGroupGeoid: selectedGeoid,
                situsCity: selectedCity,
                situsZip: selectedZip,
                cursor: FIRST_CURSOR,
                pageSize: DOTS_PAGE_SIZE,
                withTotal: false,
                hideOldHomes,
                excludeBackup: hideExistingBackup,
              })
            : Promise.resolve({ rows: [] as TopHomeRow[], total: null }),
        ]);
        if (mySeq !== requestSeqRef.current) return; // a newer request superseded this one

        const previousRanks = prevRankRef.current;
        const newRanks = buildRankMap(page.rows);
        const deltas = new Map<string, number>();
        for (const [propId, newRank] of newRanks) {
          const oldRank = previousRanks.get(propId);
          if (oldRank !== undefined && oldRank !== newRank) deltas.set(propId, oldRank - newRank);
        }

        setRows(page.rows);
        setTotal(page.total);
        setDots(dotsPage.rows.map((r) => ({ propId: r.propId, score: r.score, lon: r.lon, lat: r.lat })));
        setRankDeltas(deltas);
        prevRankRef.current = newRanks;

        if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
        clearTimerRef.current = setTimeout(() => setRankDeltas(new Map()), RANK_DELTA_DISPLAY_MS);
      } catch (err) {
        if (mySeq === requestSeqRef.current) {
          setError(err instanceof Error ? err.message : "Failed to re-rank");
        }
      } finally {
        if (mySeq === requestSeqRef.current) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(debounceTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, weights, selectedGeoid, selectedCity, selectedZip, hideOldHomes, hideExistingBackup]);

  const isFirstPredictedRun = useRef(true);
  const predictedSeqRef = useRef(0);

  // M4-W2: re-fetch predicted-mode homes whenever the block-group
  // selection or a toggle changes (weights never matter in predicted
  // mode -- it isn't in this effect's deps). Skipped on mount: the
  // server-rendered predictedRows/predictedTotal are already page 1's
  // correct state.
  useEffect(() => {
    if (isFirstPredictedRun.current) {
      isFirstPredictedRun.current = false;
      return;
    }
    if (mode !== "predicted") return;

    const mySeq = ++predictedSeqRef.current;
    setPredictedCursors([FIRST_PREDICTED_CURSOR]);
    setPredictedPageIndex(0);

    const debounceTimer = setTimeout(async () => {
      setPredictedLoading(true);
      setPredictedError(null);
      try {
        const [page, dotsPage] = await Promise.all([
          fetchPredictedPage({
            countyFips,
            blockGroupGeoid: selectedGeoid,
            situsCity: selectedCity,
            situsZip: selectedZip,
            cursor: FIRST_PREDICTED_CURSOR,
            withTotal: true,
            hideOldHomes,
            excludeBackup: hideExistingBackup,
            tier: tierFilter,
          }),
          selectedGeoid
            ? fetchPredictedPage({
                countyFips,
                blockGroupGeoid: selectedGeoid,
                situsCity: selectedCity,
                situsZip: selectedZip,
                cursor: FIRST_PREDICTED_CURSOR,
                pageSize: DOTS_PAGE_SIZE,
                withTotal: false,
                hideOldHomes,
                excludeBackup: hideExistingBackup,
                tier: tierFilter,
              })
            : Promise.resolve({ rows: [] as PredictedHomeRow[], total: null }),
        ]);
        if (mySeq !== predictedSeqRef.current) return;
        setPredictedRows(page.rows);
        setPredictedTotal(page.total);
        setDots(dotsPage.rows.map((r) => ({ propId: r.propId, score: r.pInstall12m, lon: r.lon, lat: r.lat })));
      } catch (err) {
        if (mySeq === predictedSeqRef.current) {
          setPredictedError(err instanceof Error ? err.message : "Failed to load predicted ranking");
        }
      } finally {
        if (mySeq === predictedSeqRef.current) setPredictedLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(debounceTimer);
  }, [mode, selectedGeoid, selectedCity, selectedZip, hideOldHomes, hideExistingBackup, tierFilter]);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    };
  }, []);

  async function goToPredictedPage(nextIndex: number, cursor: PredictedCursor) {
    const mySeq = ++predictedSeqRef.current;
    setPredictedLoading(true);
    setPredictedError(null);
    try {
      const page = await fetchPredictedPage({
        countyFips,
        blockGroupGeoid: selectedGeoid,
        situsCity: selectedCity,
        situsZip: selectedZip,
        cursor,
        withTotal: false,
        hideOldHomes,
        excludeBackup: hideExistingBackup,
        tier: tierFilter,
      });
      if (mySeq !== predictedSeqRef.current) return;
      setPredictedRows(page.rows);
      setPredictedPageIndex(nextIndex);
    } catch (err) {
      if (mySeq === predictedSeqRef.current) {
        setPredictedError(err instanceof Error ? err.message : "Failed to load page");
      }
    } finally {
      if (mySeq === predictedSeqRef.current) setPredictedLoading(false);
    }
  }

  function handlePredictedNext() {
    if (predictedRows.length === 0) return;
    const last = predictedRows[predictedRows.length - 1];
    const nextCursor: PredictedCursor = { afterP: last.pInstall12mCursor, afterPropId: last.propId };
    setPredictedCursors((prev) => {
      const next = prev.slice(0, predictedPageIndex + 1);
      next.push(nextCursor);
      return next;
    });
    void goToPredictedPage(predictedPageIndex + 1, nextCursor);
  }

  function handlePredictedPrevious() {
    if (predictedPageIndex === 0) return;
    void goToPredictedPage(predictedPageIndex - 1, predictedCursors[predictedPageIndex - 1]);
  }

  function handleModeChange(nextMode: RankingMode) {
    setMode(nextMode);
    setHoveredPropId(null);
    setExpandedPropId(null);
    setHighlightedIndex(null);
  }

  // Keyboard: Up/Down moves the highlighted row, Enter expands it --
  // scoped to this list container (onKeyDown on the list div), never a
  // window-level listener that would steal arrow keys from the sliders,
  // the search input, or the city/ZIP/neighborhood selects.
  function handleListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const currentRows = mode === "predicted" ? displayedPredictedRows : displayedRows;
    if (currentRows.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((prev) => {
        const base = prev ?? -1;
        const next = event.key === "ArrowDown" ? Math.min(currentRows.length - 1, base + 1) : Math.max(0, base - 1);
        const row = currentRows[next];
        if (row) {
          setHoveredPropId(row.propId);
          setScrollToPropId(row.propId);
        }
        return next;
      });
    } else if (event.key === "Enter") {
      if (highlightedIndex !== null && currentRows[highlightedIndex]) {
        event.preventDefault();
        toggleExpand(currentRows[highlightedIndex].propId);
      }
    }
  }

  async function goToPage(nextIndex: number, cursor: Cursor) {
    const mySeq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchPage({ countyFips, weights, blockGroupGeoid: selectedGeoid, situsCity: selectedCity, situsZip: selectedZip, cursor, withTotal: false, hideOldHomes, excludeBackup: hideExistingBackup });
      if (mySeq !== requestSeqRef.current) return;
      setRows(page.rows);
      setPageIndex(nextIndex);
      prevRankRef.current = new Map(); // page-to-page deltas aren't meaningful; only re-rank deltas are
      setRankDeltas(new Map());
    } catch (err) {
      if (mySeq === requestSeqRef.current) setError(err instanceof Error ? err.message : "Failed to load page");
    } finally {
      if (mySeq === requestSeqRef.current) setLoading(false);
    }
  }

  function handleNext() {
    if (rows.length === 0) return;
    const last = rows[rows.length - 1];
    const nextCursor: Cursor = { afterScore: last.score, afterPropId: last.propId };
    setCursors((prev) => {
      const next = prev.slice(0, pageIndex + 1);
      next.push(nextCursor);
      return next;
    });
    void goToPage(pageIndex + 1, nextCursor);
  }

  function handlePrevious() {
    if (pageIndex === 0) return;
    void goToPage(pageIndex - 1, cursors[pageIndex - 1]);
  }

  function handleRowHover(row: TopHomeRow | null) {
    setHoveredPropId(row?.propId ?? null);
    setHoveredGeoid(row?.blockGroupGeoid ?? null);
    setScrollToPropId(null);
  }

  function handleDotHover(propId: string | null) {
    setHoveredPropId(propId);
    if (propId) {
      setHoveredGeoid(selectedGeoid);
      setScrollToPropId(propId);
    }
  }

  function handleSelectGeoid(geoid: string | null) {
    setSelectedGeoid((current) => (current === geoid ? null : geoid));
    setHoveredPropId(null);
  }

  // M-drilldown (item 3): City -> ZIP -> Neighborhood cascade -- picking a
  // higher level clears every level below it (a new city may not even
  // contain the previously-selected ZIP/block group).
  function handleSelectCity(city: string | null) {
    setSelectedCity(city);
    setSelectedZip(null);
    setSelectedGeoid(null);
    setHoveredPropId(null);
  }

  function handleSelectZip(zip: string | null) {
    setSelectedZip(zip);
    setSelectedGeoid(null);
    setHoveredPropId(null);
  }

  // M-urlstate (item 4): keep mode/weights/backup/pre2000/city/zip/bg in
  // the URL so a reload -- and the CSV export, which forwards the current
  // url's params (ExportButton) -- reproduce exactly what's on screen.
  // window.history.replaceState (not router.replace) so this never
  // re-runs the force-dynamic server render on every slider tick.
  //
  // Built from window.location directly, not usePathname()/useSearchParams()
  // -- those need a Suspense boundary (this component has none, and
  // adding one just for this would be its own risk) and would re-render
  // every consumer of them on every keystroke. Debounced on the existing
  // 250 ms timer: a raw per-keystroke replaceState call hits browser rate
  // limits (Safari throws SecurityError past ~100 calls/30s, which one
  // slider drag alone can reach) and would fire well before the weights
  // state has settled anyway.
  const isFirstUrlSync = useRef(true);
  useEffect(() => {
    if (isFirstUrlSync.current) {
      isFirstUrlSync.current = false;
      return;
    }
    const syncTimer = setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      params.set("mode", mode);
      if (mode === "weighted") {
        for (const key of SIGNAL_KEYS) params.set(`w_${key}`, String(weights[key] ?? 0));
      } else {
        for (const key of SIGNAL_KEYS) params.delete(`w_${key}`);
      }
      params.set("backup", hideExistingBackup ? "hide" : "show");
      params.set("pre2000", hideOldHomes ? "hide" : "show");
      if (selectedCity !== null) params.set("city", selectedCity);
      else params.delete("city");
      if (selectedZip !== null) params.set("zip", selectedZip);
      else params.delete("zip");
      if (selectedGeoid !== null) params.set("bg", selectedGeoid);
      else params.delete("bg");
      if (tierFilter !== "all") params.set("tier", tierFilter);
      else params.delete("tier");
      const next = `${window.location.pathname}?${params.toString()}`;
      if (`${window.location.pathname}${window.location.search}` !== next) {
        window.history.replaceState(window.history.state, "", next);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(syncTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, weights, hideExistingBackup, hideOldHomes, selectedCity, selectedZip, selectedGeoid, tierFilter]);

  // M-drilldown (item 3, revised): shared drill-down state for the three
  // <select>s and the map's fitToGeoids -- computed once per render
  // (geoRollup is small: one row per city/ZIP/block-group tuple) rather
  // than three separate inline computations.
  const rowsForCity = selectedCity !== null ? filterRows(geoRollup, { city: selectedCity }) : geoRollup;
  const rowsForZip = selectedZip !== null ? filterRows(rowsForCity, { zip: selectedZip }) : rowsForCity;
  // Map shading (layout-review pivot): share of each block group's homes
  // in decile 1 ("Top priority"), straight from the same api.home_geo_
  // rollup rows already fetched for the dropdowns -- no second query.
  // A block group with 0 homes never appears here (its geoRollup row
  // wouldn't exist), so this is never a divide-by-zero.
  const priorityByGeoid = new Map<string, number>();
  for (const r of geoRollup) {
    if (r.blockGroupGeoid && r.homeCount > 0) {
      priorityByGeoid.set(r.blockGroupGeoid, r.top10Count / r.homeCount);
    }
  }

  const cityBuckets = bucketBy(geoRollup, (r) => r.situsCity ?? "");
  const zipBuckets = bucketBy(rowsForCity, (r) => r.situsZip ?? "");
  const bgBuckets = bucketBy(rowsForZip, (r) => r.blockGroupGeoid ?? "");
  // Map follow (coordinator's revised spec): fit to the selected area's
  // block groups, not only a single block-group selection -- the rollup
  // (already filtered to the current city/ZIP) IS that set of block
  // groups; a specific neighborhood pick narrows it to just the one.
  const fitToGeoids: string[] | null =
    selectedGeoid !== null
      ? [selectedGeoid]
      : selectedCity !== null || selectedZip !== null
        ? Array.from(new Set(rowsForZip.map((r) => r.blockGroupGeoid)))
        : null;

  const rangeStart = pageIndex * DEFAULT_PAGE_SIZE + 1;
  const predictedRangeStart = predictedPageIndex * DEFAULT_PAGE_SIZE + 1;

  // Search: filters the currently loaded page's real rows by address/ZIP
  // (client-side, on data already fetched -- never a fabricated match).
  // A query landing exactly on a city or ZIP this county's geo rollup
  // already knows about also drives the real city/ZIP drilldown, so
  // typing "78731" narrows the whole board (a new fetch), not just the
  // visible page.
  const searchNormalized = searchQuery.trim().toLowerCase();
  function matchesSearch(situsNum: string | null, situsStreet: string | null, situsCity: string | null, situsZip: string | null): boolean {
    if (!searchNormalized) return true;
    const haystack = [situsNum, situsStreet, situsCity, situsZip].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(searchNormalized);
  }
  const displayedPredictedRows = predictedRows.filter((r) => matchesSearch(r.situsNum, r.situsStreet, r.situsCity, r.situsZip));
  const displayedRows = rows.filter((r) => matchesSearch(r.situsNum, r.situsStreet, r.situsCity, r.situsZip));

  const isFirstSearchRun = useRef(true);
  useEffect(() => {
    if (isFirstSearchRun.current) {
      isFirstSearchRun.current = false;
      return;
    }
    const debounceTimer = setTimeout(() => {
      const q = searchQuery.trim();
      if (!q) return;
      const zipMatch = geoRollup.find((r) => r.situsZip === q);
      if (zipMatch) {
        handleSelectZip(q);
        return;
      }
      const cityMatch = cityBuckets.find((b) => b.key.toLowerCase() === q.toLowerCase());
      if (cityMatch) handleSelectCity(cityMatch.key);
    }, 400);
    return () => clearTimeout(debounceTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  // Filters count -- the two toggles are always "set" one way or the
  // other (mock: "Filters 2" with both toggles showing as chips), plus
  // one more per active drilldown/tier selection.
  const activeFilterCount =
    2 + (selectedCity !== null ? 1 : 0) + (selectedZip !== null ? 1 : 0) + (selectedGeoid !== null ? 1 : 0) + (tierFilter !== "all" ? 1 : 0);

  // Top-ranked pins (Mock A): only meaningful on the list's first page --
  // "top 10" stops meaning anything once you've paged past it.
  const activeRangeStart = mode === "predicted" ? predictedRangeStart : rangeStart;
  const topPins =
    activeRangeStart === 1
      ? (mode === "predicted" ? displayedPredictedRows : displayedRows)
          .slice(0, 10)
          .map((r, i) => ({ propId: r.propId, rank: i + 1, lon: r.lon, lat: r.lat }))
      : [];

  // Selected-home card (map, bottom-left): whichever row is hovered or
  // expanded, else the top-ranked home on the current page.
  // Declared as one homogeneous Array<A | B> (not inferred from the
  // ternary, which TS would instead type as Array<A> | Array<B> --
  // fine for .find, but every method whose param type differs between A
  // and B, like .indexOf below, would then need an argument assignable
  // to BOTH at once).
  const activeRowsForCard: Array<PredictedHomeRow | TopHomeRow> = mode === "predicted" ? displayedPredictedRows : displayedRows;
  const cardRow =
    activeRowsForCard.find((r) => r.propId === expandedPropId) ??
    activeRowsForCard.find((r) => r.propId === hoveredPropId) ??
    (activeRangeStart === 1 ? activeRowsForCard[0] : undefined);
  const selectedHomeCard = cardRow
    ? {
        propId: cardRow.propId,
        rank: activeRangeStart === 1 ? activeRowsForCard.indexOf(cardRow) + 1 : null,
        address: [cardRow.situsNum, cardRow.situsStreet].filter(Boolean).join(" ") || cardRow.propId,
        metaLine: [cardRow.situsCity, cardRow.situsZip].filter(Boolean).join(" ") || "",
        tierLabel:
          mode === "predicted" && "decile" in cardRow
            ? tierMeta(tierForDecile((cardRow as PredictedHomeRow).decile).key).label
            : "Team priority score",
        tierSublabel:
          mode === "predicted" && "decile" in cardRow
            ? tierMeta(tierForDecile((cardRow as PredictedHomeRow).decile).key).description
            : "",
      }
    : null;


  return (
    <div className="ranking-board">
      <Panel className="ranking-board__map-panel" style={{ display: "flex", flexDirection: "column", minHeight: 0, padding: 0, overflow: "hidden" }}>
        <div style={{ flex: "1 1 auto", minHeight: 0 }}>
          <BlockGroupMap
            key={countyFips}
            geojsonUrl={`/ranking/blockgroups?county=${countyFips}`}
            weights={weights}
            countyFips={countyFips}
            hoveredGeoid={hoveredGeoid}
            onFeatureHover={setHoveredGeoid}
            selectedGeoid={selectedGeoid}
            onSelectGeoid={handleSelectGeoid}
            dots={dots}
            hoveredPropId={hoveredPropId}
            onDotHover={handleDotHover}
            fitToGeoids={fitToGeoids}
            priorityByGeoid={mode === "predicted" ? priorityByGeoid : null}
            shadeLabel={mode === "predicted" ? "top-priority homes" : "team priority score"}
            topPins={topPins}
            onPinClick={(propId) => toggleExpand(propId)}
            selectedHome={selectedHomeCard}
            focusHome={focusHome}
          />
        </div>
      </Panel>

      <aside className="ranking-board__rail">
        <div className="ranking-rail__header">
          <h2 className="ranking-rail__question">{questionText}</h2>
          <div className="ranking-rail__status">{statusLine}</div>

          <div className="modes" role="group" aria-label="Ranking mode">
            <button
              type="button"
              className={"modes__option" + (mode === "predicted" ? " modes__option--on" : "")}
              onClick={() => handleModeChange("predicted")}
              data-testid="ranking-mode-predicted"
            >
              Likely to add backup
            </button>
            <button
              type="button"
              className={"modes__option" + (mode === "weighted" ? " modes__option--on" : "")}
              onClick={() => handleModeChange("weighted")}
              data-testid="ranking-mode-weighted"
            >
              Team priorities
            </button>
          </div>

          <div className="ranking-rail__controls">
            <input
              type="search"
              className="ranking-rail__search"
              placeholder="Find address or ZIP"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Find address or ZIP"
            />
            <div className="popover-anchor">
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => {
                  setFiltersOpen((v) => !v);
                  setAdjustOpen(false);
                }}
                aria-expanded={filtersOpen}
                data-testid="filters-toggle"
              >
                Filters <span className="count-badge">{activeFilterCount}</span>
              </button>
              {filtersOpen ? (
                <div className="popover-panel" role="dialog" aria-label="Filters">
                  <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--type-body-font-size)" }}>
                    <input
                      type="checkbox"
                      checked={hideOldHomes}
                      onChange={(e) => setHideOldHomes(e.target.checked)}
                      data-testid="hide-old-homes-toggle"
                    />
                    Hide homes built before 2000
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--type-body-font-size)", marginTop: "var(--space-2)" }}>
                    <input
                      type="checkbox"
                      checked={hideExistingBackup}
                      onChange={(e) => setHideExistingBackup(e.target.checked)}
                      data-testid="hide-existing-backup-toggle"
                    />
                    Hide homes that already have backup
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: "2px", fontSize: "var(--type-label-font-size)", marginTop: "var(--space-3)" }}>
                    Priority tier
                    <select value={tierFilter} onChange={(e) => setTierFilter(e.target.value as PriorityTierKey | "all")} data-testid="tier-filter">
                      <option value="all">All tiers</option>
                      {PRIORITY_TIER_ORDER.filter((t) => t !== "unscored").map((t) => (
                        <option key={t} value={t}>
                          {tierMeta(t).label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div data-testid="geo-drilldown" style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: "2px", fontSize: "var(--type-label-font-size)" }}>
                      City
                      <select
                        data-testid="drilldown-city"
                        value={selectedCity ?? ALL_VALUE}
                        onChange={(e) => handleSelectCity(fromSelectValue(e.target.value))}
                      >
                        <option value={ALL_VALUE}>All ({geoRollup.reduce((s, r) => s + r.homeCount, 0).toLocaleString()} homes)</option>
                        {cityBuckets.map((b) => (
                          <option key={b.key || NULL_BUCKET_VALUE} value={toSelectValue(b.key)}>
                            {(b.key || "No city on file")} ({b.homeCount.toLocaleString()} homes)
                          </option>
                        ))}
                      </select>
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: "2px", fontSize: "var(--type-label-font-size)" }}>
                      ZIP
                      <select
                        data-testid="drilldown-zip"
                        value={selectedZip ?? ALL_VALUE}
                        onChange={(e) => handleSelectZip(fromSelectValue(e.target.value))}
                      >
                        <option value={ALL_VALUE}>All ({rowsForCity.reduce((s, r) => s + r.homeCount, 0).toLocaleString()} homes)</option>
                        {zipBuckets.map((b) => (
                          <option key={b.key || NULL_BUCKET_VALUE} value={toSelectValue(b.key)}>
                            {(b.key || "No ZIP on file")} ({b.homeCount.toLocaleString()} homes)
                          </option>
                        ))}
                      </select>
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: "2px", fontSize: "var(--type-label-font-size)" }}>
                      Neighborhood
                      <select
                        data-testid="drilldown-blockgroup"
                        value={selectedGeoid ?? ALL_VALUE}
                        onChange={(e) => handleSelectGeoid(fromSelectValue(e.target.value))}
                      >
                        <option value={ALL_VALUE}>All ({rowsForZip.reduce((s, r) => s + r.homeCount, 0).toLocaleString()} homes)</option>
                        {bgBuckets.map((b) => (
                          <option key={b.key} value={b.key}>
                            {blockGroupLabel(b.key)} ({b.homeCount.toLocaleString()} homes)
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {selectedCity !== null || selectedZip !== null || selectedGeoid !== null ? (
                    <div
                      data-testid="selected-blockgroup-chip"
                      style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "var(--space-2)", marginTop: "var(--space-3)", fontSize: "var(--type-label-font-size)" }}
                    >
                      {selectedCity !== null ? <span className="chip">{selectedCity || "No city on file"}</span> : null}
                      {selectedZip !== null ? <span className="chip">{selectedZip || "No ZIP on file"}</span> : null}
                      {selectedGeoid !== null ? <span className="chip">{blockGroupLabel(selectedGeoid)}</span> : null}
                      <button
                        type="button"
                        className="btn btn--secondary"
                        onClick={() => handleSelectCity(null)}
                        aria-label="Clear city/ZIP/neighborhood selection and show all homes"
                        data-testid="clear-blockgroup"
                        style={{ whiteSpace: "nowrap" }}
                      >
                        Show all homes
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="popover-anchor">
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => {
                  setAdjustOpen((v) => !v);
                  setFiltersOpen(false);
                }}
                aria-expanded={adjustOpen}
                data-testid="adjust-priorities-toggle"
              >
                Adjust priorities
              </button>
              {adjustOpen ? (
                <div className="popover-panel popover-panel--wide" role="dialog" aria-label="Adjust priorities" data-testid="adjust-priorities-disclosure">
                  <p style={{ margin: "0 0 var(--space-3) 0", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
                    The list is ordered by &ldquo;Likely to add backup&rdquo; by default. Switch to &ldquo;Team
                    priorities&rdquo; only if your team wants to rank by its own signal mix instead.
                  </p>
                  <WeightSliders
                    weights={weights}
                    onChange={(next) => {
                      setWeights(next);
                      setMode("weighted");
                    }}
                    onReset={() => setWeights(equalWeights())}
                    defaultWeights={defaultWeights}
                  />
                  <p style={{ margin: "var(--space-3) 0 0 0", fontSize: "var(--type-label-font-size)" }}>
                    <Link href="/sources#how-leads-are-prioritized">How the ranking works →</Link>
                  </p>
                </div>
              ) : null}
            </div>
          </div>

          <div className="chips">
            <span>
              <span className="chips__dot" />
              {hideExistingBackup ? "Homes with backup on file hidden" : "Homes with backup on file shown"}
            </span>
            <span>
              <span className={"chips__dot" + (hideOldHomes ? "" : " chips__dot--off")} />
              {hideOldHomes ? "Built before 2000 hidden" : "Built before 2000 shown"}
            </span>
          </div>
        </div>

        <div className="ranking-rail__listhead">
          <span>
            <b>{(mode === "predicted" ? predictedTotal : total)?.toLocaleString() ?? "—"}</b> homes ranked
          </span>
          <span>
            showing {activeRangeStart}–{activeRangeStart + (mode === "predicted" ? displayedPredictedRows.length : displayedRows.length) - 1} ·{" "}
            {mode === "predicted" ? "likely to add backup, 12 months" : "team priority score"}
          </span>
          <span aria-live="polite" style={{ color: "var(--theme-ink-muted)" }}>
            {(mode === "weighted" ? loading : predictedLoading) ? "Re-ranking…" : ""}
          </span>
        </div>

        {(mode === "weighted" ? error : predictedError) ? (
          <div style={{ padding: "0 var(--space-3)" }}>
            <MissingState variant="not-loaded" reason={(mode === "weighted" ? error : predictedError) ?? ""} />
          </div>
        ) : null}

        <div
          className="ranking-rail__list"
          ref={listRef}
          role="listbox"
          aria-label="Ranked homes"
          tabIndex={0}
          onKeyDown={handleListKeyDown}
        >
          {mode === "predicted" ? (
            <PredictedHomesTable
              rows={displayedPredictedRows}
              countyName={countyName}
              rangeStart={predictedRangeStart}
              hoveredPropId={hoveredPropId}
              onHoverRow={(row) => {
                setHoveredPropId(row?.propId ?? null);
                setHoveredGeoid(row?.blockGroupGeoid ?? null);
                setScrollToPropId(null);
              }}
              scrollToPropId={scrollToPropId}
              expandedPropId={expandedPropId}
              onToggleExpand={toggleExpand}
              onLocateOnMap={handleLocateOnMap}
            />
          ) : (
            <TopHomesTable
              rows={displayedRows}
              rangeStart={rangeStart}
              hoveredPropId={hoveredPropId}
              onHoverRow={handleRowHover}
              scrollToPropId={scrollToPropId}
              rankDeltas={rankDeltas}
              expandedPropId={expandedPropId}
              onToggleExpand={toggleExpand}
              weights={weights}
              onLocateOnMap={handleLocateOnMap}
            />
          )}
        </div>

        {mode === "predicted" ? (
          <TopHomesPagination
            rangeStart={predictedRangeStart}
            // TopHomesPagination (a different ticket's component) only
            // ever reads rows.length -- PredictedHomeRow's real shape
            // isn't TopHomeRow, so this cast is scoped to that one safe
            // fact rather than widening the component's own prop type.
            rows={predictedRows as unknown as TopHomeRow[]}
            total={predictedTotal}
            hasPrevious={predictedPageIndex > 0}
            hasNext={predictedRows.length === DEFAULT_PAGE_SIZE}
            onPrevious={handlePredictedPrevious}
            onNext={handlePredictedNext}
          />
        ) : (
          <TopHomesPagination
            rangeStart={rangeStart}
            rows={rows}
            total={total}
            hasPrevious={pageIndex > 0}
            hasNext={rows.length === DEFAULT_PAGE_SIZE}
            onPrevious={handlePrevious}
            onNext={handleNext}
          />
        )}
      </aside>
    </div>
  );
}
