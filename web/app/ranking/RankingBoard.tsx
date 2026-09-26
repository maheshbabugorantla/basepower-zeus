"use client";

import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { BlockGroupMap, type MapDot } from "../../components/BlockGroupMap";
import { TopHomesTable, TopHomesPagination, type TopHomeRow } from "../../components/TopHomesTable";
import { WeightSliders, equalWeights } from "../../components/WeightSliders";
import { ScoreExplainer } from "../../components/ScoreExplainer";
import { Panel } from "../../components/ui/Panel";
import { MissingState } from "../../components/ui/MissingState";
import type { SignalKey } from "../api/top-homes/route";

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

function buildRankMap(rows: TopHomeRow[]): Map<string, number> {
  const map = new Map<string, number>();
  rows.forEach((row, index) => map.set(row.propId, index + 1));
  return map;
}

async function fetchPage(params: {
  weights: Record<SignalKey, number>;
  blockGroupGeoid: string | null;
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
      weights: params.weights,
      countyFips: TRAVIS_COUNTY_FIPS,
      blockGroupGeoid: params.blockGroupGeoid,
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
function blockGroupLabel(geoid: string): string {
  if (!/^\d{12}$/.test(geoid)) return `Block group ${geoid}`;
  const tractRaw = geoid.slice(5, 11);
  const tract = `${Number(tractRaw.slice(0, 4))}${tractRaw.slice(4) === "00" ? "" : `.${tractRaw.slice(4)}`}`;
  return `Tract ${tract}, block group ${geoid.slice(11)}`;
}

export function RankingBoard({
  rows: initialRows,
  initialTotal,
  leftRail,
  defaultWeights = null,
}: {
  rows: TopHomeRow[];
  /** Real gate-passed county home count (api.homes_ranked_weighted_count), server-rendered. */
  initialTotal: number;
  /** Server-rendered gate funnel + Quality panel (left column, above the sliders). */
  leftRail: ReactNode;
  /** api.default_weights, read server-side (M2-P8); null falls back to equal=5. */
  defaultWeights?: Record<SignalKey, number> | null;
}) {
  const [weights, setWeights] = useState<Record<SignalKey, number>>(defaultWeights ?? equalWeights());
  // M2-P8: "Hide homes built before 2000" — a team choice, not a Base
  // rule, default OFF. Filtered in the /api/top-homes route on yr_built
  // (a column the ranking function already returns on every row), never
  // a second request-time scan of core.parcels.
  const [hideOldHomes, setHideOldHomes] = useState(false);
  // M2-P11: "Hide homes that already have backup" -- default ON (a home
  // already known to have its own battery/generator/other-installer permit
  // is excluded from outreach ranking by default; toggle restores them).
  // Wired straight through to api.homes_ranked_weighted's p_exclude_backup.
  const [hideExistingBackup, setHideExistingBackup] = useState(true);

  // County-wide vs. block-group-scoped ranking.
  const [selectedGeoid, setSelectedGeoid] = useState<string | null>(null);
  const [cursors, setCursors] = useState<Cursor[]>([FIRST_CURSOR]);
  const [pageIndex, setPageIndex] = useState(0);
  const [rows, setRows] = useState<TopHomeRow[]>(initialRows);
  const [total, setTotal] = useState<number | null>(initialTotal);
  const [rankDeltas, setRankDeltas] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every gate-passed home in the selected block group, for the map dots.
  const [dots, setDots] = useState<MapDot[]>([]);

  // Hover sync: a row hover sets both; a dot hover sets both too, but
  // additionally marks the source as "map" so the table scrolls the row
  // into view (a row's own hover never re-triggers its own scroll).
  const [hoveredPropId, setHoveredPropId] = useState<string | null>(null);
  const [hoveredGeoid, setHoveredGeoid] = useState<string | null>(null);
  const [scrollToPropId, setScrollToPropId] = useState<string | null>(null);

  // M2-W5: which home's score breakdown is expanded below the table.
  // Toggled by clicking a row anywhere except its address link (which
  // still navigates to the home page as before) — TopHomesTable.tsx
  // itself is owned by a different ticket, so this reads its existing
  // data-prop-id row attribute via delegation instead of adding a new
  // prop there.
  const [explainPropId, setExplainPropId] = useState<string | null>(null);

  function handleTableClick(event: ReactMouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("a")) return; // let the address link navigate normally
    const rowEl = target.closest<HTMLElement>("[data-prop-id]");
    const propId = rowEl?.getAttribute("data-prop-id");
    if (!propId) return;
    setExplainPropId((current) => (current === propId ? null : propId));
  }

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

    const mySeq = ++requestSeqRef.current;
    setCursors([FIRST_CURSOR]);
    setPageIndex(0);

    const debounceTimer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const [page, dotsPage] = await Promise.all([
          fetchPage({ weights, blockGroupGeoid: selectedGeoid, cursor: FIRST_CURSOR, withTotal: true, hideOldHomes, excludeBackup: hideExistingBackup }),
          selectedGeoid
            ? fetchPage({
                weights,
                blockGroupGeoid: selectedGeoid,
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
  }, [weights, selectedGeoid, hideOldHomes, hideExistingBackup]);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    };
  }, []);

  async function goToPage(nextIndex: number, cursor: Cursor) {
    const mySeq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchPage({ weights, blockGroupGeoid: selectedGeoid, cursor, withTotal: false, hideOldHomes, excludeBackup: hideExistingBackup });
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

  const rangeStart = pageIndex * DEFAULT_PAGE_SIZE + 1;

  return (
    <div style={{ display: "grid", gap: "var(--space-6)" }}>
    <div className="ranking-board">
      <div className="ranking-board__rail">
        {leftRail}
        <WeightSliders
          weights={weights}
          onChange={setWeights}
          onReset={() => setWeights(equalWeights())}
          defaultWeights={defaultWeights}
        />
        <Panel>
          <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--type-body-font-size)" }}>
            <input
              type="checkbox"
              checked={hideOldHomes}
              onChange={(e) => setHideOldHomes(e.target.checked)}
              data-testid="hide-old-homes-toggle"
            />
            Hide homes built before 2000
          </label>
          <p style={{ margin: "var(--space-1) 0 0 0", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
            A team choice, not a Base rule.
          </p>
        </Panel>
        <Panel>
          <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--type-body-font-size)" }}>
            <input
              type="checkbox"
              checked={hideExistingBackup}
              onChange={(e) => setHideExistingBackup(e.target.checked)}
              data-testid="hide-existing-backup-toggle"
            />
            Hide homes that already have backup
          </label>
          <p style={{ margin: "var(--space-1) 0 0 0", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
            On by default: excludes homes already known to have a battery, generator, or other installer&rsquo;s backup permit on file.
          </p>
        </Panel>
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
            Block groups by weighted score
          </h2>
        </div>
        <div style={{ flex: "1 1 auto", minHeight: 0 }}>
          <BlockGroupMap
            geojsonUrl="/ranking/blockgroups"
            weights={weights}
            countyFips={TRAVIS_COUNTY_FIPS}
            hoveredGeoid={hoveredGeoid}
            onFeatureHover={setHoveredGeoid}
            selectedGeoid={selectedGeoid}
            onSelectGeoid={handleSelectGeoid}
            dots={dots}
            hoveredPropId={hoveredPropId}
            onDotHover={handleDotHover}
          />
        </div>
      </Panel>

      <Panel style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
        <div style={{ marginBottom: "var(--space-2)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "var(--space-3)" }}>
            <h2
              style={{
                fontFamily: "var(--type-heading-font-family)",
                fontSize: "var(--type-heading-font-size)",
                fontWeight: "var(--type-heading-font-weight)",
                margin: 0,
                textWrap: "balance",
              }}
            >
              {selectedGeoid ? "Homes in this block group" : "Homes ranked county-wide"}
            </h2>
            <span
              aria-live="polite"
              style={{ fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)", whiteSpace: "nowrap" }}
            >
              {loading ? "Re-ranking…" : ""}
            </span>
          </div>
          <p style={{ margin: "var(--space-1) 0 0 0", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
            Click a home to see the full score breakdown below.
          </p>
          {selectedGeoid ? (
            <div
              data-testid="selected-blockgroup-chip"
              style={{
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "var(--space-2)",
                marginTop: "var(--space-2)",
                fontSize: "var(--type-label-font-size)",
              }}
            >
              <span className="chip">{blockGroupLabel(selectedGeoid)}</span>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => handleSelectGeoid(null)}
                aria-label="Clear block group selection and show all homes"
                data-testid="clear-blockgroup"
                style={{ whiteSpace: "nowrap" }}
              >
                Show all homes
              </button>
            </div>
          ) : null}
        </div>
        {error ? (
          <div style={{ marginBottom: "var(--space-2)" }}>
            <MissingState variant="not-loaded" reason={error} />
          </div>
        ) : null}
        <div style={{ flex: "1 1 auto", minHeight: 0, overflow: "auto" }} onClick={handleTableClick}>
          <TopHomesTable
            rows={rows}
            rangeStart={rangeStart}
            hoveredPropId={hoveredPropId}
            onHoverRow={handleRowHover}
            scrollToPropId={scrollToPropId}
            rankDeltas={rankDeltas}
          />
        </div>
        <TopHomesPagination
          rangeStart={rangeStart}
          rows={rows}
          total={total}
          hasPrevious={pageIndex > 0}
          hasNext={rows.length === DEFAULT_PAGE_SIZE}
          onPrevious={handlePrevious}
          onNext={handleNext}
        />
      </Panel>
    </div>

    {explainPropId ? (
      <Panel data-testid="score-explainer-panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--space-4)", marginBottom: "var(--space-3)" }}>
          <h2
            style={{
              fontFamily: "var(--type-heading-font-family)",
              fontSize: "var(--type-heading-font-size)",
              fontWeight: "var(--type-heading-font-weight)",
              margin: 0,
            }}
          >
            Why this home
          </h2>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => setExplainPropId(null)}
            aria-label="Close the score breakdown"
            data-testid="close-score-explainer"
          >
            Close
          </button>
        </div>
        <ScoreExplainer propId={explainPropId} weights={weights} />
      </Panel>
    ) : null}
    </div>
  );
}
