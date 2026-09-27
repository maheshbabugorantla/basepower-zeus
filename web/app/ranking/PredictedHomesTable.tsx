"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { HomeRow } from "../../components/HomeRow";
import { homeMetaLine, reasonSignal, streetLine } from "../../lib/homeRowFormat";
import { MissingState } from "../../components/ui/MissingState";
import { PriorityTierBadge } from "../../components/ui/PriorityTierBadge";
import { Chip } from "../../components/ui/Chip";
import { CaseForKnock } from "../../components/CaseForKnock";
import { utilityStatusForHome, reasonPhraseForContext, isEligibleReason } from "../../lib/priorityTier";
import { equalWeights } from "../../components/WeightSliders";
import type { PredictedHomeRow } from "../api/top-homes/route";

// M4-W2: the default ranking view -- one row per home, ordered by
// api.home_propensity.p_install_12m (read straight through by the route,
// never recomputed here).
//
// Layout-review fix: this used to be an HTML <table> with a fixed
// colgroup, which let a long address wrap into the next column and let
// long reason chips overlap the row below at 1440px. Rewritten as a CSS
// grid "row" (role=table/row/cell, the same ARIA pattern PredictionProof.tsx
// already uses for a precise, non-<table> layout).
//
// Map-as-dominant-surface pivot: the list is now a narrow (~30%) side
// column, not a wide table -- a 4-column row (address | priority |
// utility) clipped mid-word at that width. Down to 2 columns: # and a
// single stacked cell (address, meta, tier + utility, reasons).
//
// Redesign (Mock A, critique P0 "home detail opens in place"): a row can
// expand in place to the case for a knock (CaseForKnock, real breakdown
// terms, no LLM/synthetic data) instead of a route change -- the deep
// link (/home/[prop_id]) stays for "Open full record."

export interface PredictedHomesTableProps {
  rows: PredictedHomeRow[];
  /** Kept for callers that still pass it (unused in this render -- PropensityBadge no longer shows a county-relative figure). */
  countyName?: string;
  rangeStart?: number;
  hoveredPropId?: string | null;
  onHoverRow?: (row: PredictedHomeRow | null) => void;
  scrollToPropId?: string | null;
  /** Redesign (Mock A): the one row expanded in place. */
  expandedPropId?: string | null;
  onToggleExpand?: (propId: string) => void;
  onLocateOnMap?: (row: PredictedHomeRow) => void;
  /** Short appraisal-district name for this county's source note ("Travis CAD"). */
  cadShort?: string;
}

export function PredictedHomesTable({
  rows,
  rangeStart = 1,
  hoveredPropId = null,
  onHoverRow,
  scrollToPropId,
  expandedPropId = null,
  onToggleExpand,
  onLocateOnMap,
  cadShort,
}: PredictedHomesTableProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!scrollToPropId) return;
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-prop-id="${scrollToPropId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [scrollToPropId]);

  // Rank 1 opens expanded on first load; only a user's own expansion
  // should scroll the list and move focus, never the page's first paint.
  const initialExpandedRef = useRef(expandedPropId);
  useEffect(() => {
    if (!expandedPropId || expandedPropId === initialExpandedRef.current) return;
    initialExpandedRef.current = null;
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-prop-id="${expandedPropId}"]`);
    el?.scrollIntoView({ block: "nearest" });
    el?.focus?.({ preventScroll: true });
  }, [expandedPropId]);

  if (rows.length === 0) {
    return <MissingState variant="not-loaded" reason="No homes to rank yet" />;
  }

  return (
    <div ref={containerRef} className="predicted-homes-table" role="table" aria-label="Homes ranked by likelihood of adding backup">
      <div role="row" className="visually-hidden">
        <span role="columnheader">Rank</span>
        <span role="columnheader">Home</span>
        <span role="columnheader">Priority and utility</span>
      </div>
      {rows.map((row, index) => {
        const utilityStatus = utilityStatusForHome({
          gateReason: row.gateReason,
          territoryNullReason: row.territoryNullReason,
        });
        const hasBackup = row.coverageBucket === "base_customer" || row.coverageBucket === "other_backup";
        const shownReasons = row.reasons
          .filter((r) => r.direction === "raises" && isEligibleReason(r.feature))
          .slice(0, 2);
        return (
          <HomeRow
            key={row.propId}
            testId="predicted-homes-row"
            propId={row.propId}
            rank={rangeStart + index}
            street={streetLine(row.situsNum, row.situsStreet)}
            meta={homeMetaLine({ city: row.situsCity, zip: row.situsZip, yrBuilt: row.yrBuilt, utility: row.distributorName })}
            note={hasBackup ? "Already has backup" : null}
            hovered={hoveredPropId === row.propId}
            expanded={expandedPropId === row.propId}
            onHover={(on) => onHoverRow?.(on ? row : null)}
            onToggle={() => onToggleExpand?.(row.propId)}
            side={
              <>
                {row.decile === null ? (
                  <MissingState variant="not-loaded" reason="Not scored yet" />
                ) : (
                  <PriorityTierBadge decile={row.decile} compact />
                )}
                <span data-testid="utility-status" data-status={utilityStatus.key} className="home-row__utility">
                  {utilityStatus.label}
                </span>
              </>
            }
            chips={
              shownReasons.length > 0
                ? shownReasons.map((reason, i) => (
                    <Chip
                      key={`${reason.feature}-${i}`}
                      signal={reasonSignal(reason.feature)}
                      label={reasonPhraseForContext(reason.feature, utilityStatus.key)}
                    />
                  ))
                : null
            }
            expandContent={
              <>
                <CaseForKnock propId={row.propId} weights={equalWeights()} cadShort={cadShort} compact />
                <div className="row-expand__actions">
                  <Link href={`/home/${row.propId}`}>Open full record →</Link>
                  <button type="button" className="row-expand__link" onClick={() => onLocateOnMap?.(row)}>
                    Locate on map
                  </button>
                  <Link href={`/home/${row.propId}?tab=signals`}>All 12 signals</Link>
                </div>
              </>
            }
          />
        );
      })}
    </div>
  );
}
