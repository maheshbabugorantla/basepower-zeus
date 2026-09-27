"use client";

import { useEffect, useRef } from "react";

import Link from "next/link";
import { MissingState } from "./ui/MissingState";
import { Chip, type SignalName } from "./ui/Chip";
import { CaseForKnock } from "./CaseForKnock";
import { HomeRow } from "./HomeRow";
import { homeMetaLine, streetLine } from "../lib/homeRowFormat";
import type { SignalKey } from "../app/api/top-homes/route";

// M2-W1: ranked-homes table from api.homes_ranked_weighted (score v1,
// re-ranked live by WeightSliders — see app/ranking/RankingBoard.tsx).
// Every row still links to /home/[prop_id] (M1-W1 acceptance, unchanged).
// The old single "rate/1k homes" chip (M1, backup-intent-only) is
// replaced by the function's own top-3 `reasons`, rendered as
// signal-colored chips (DESIGN.md §5 Chips).
//
// M2-W3 scope change: this is no longer a fixed top-50 — RankingBoard
// pages it (county-wide, or scoped to a clicked block group) via
// keyset pagination, and hoveredPropId/onHoverRow are lifted to
// RankingBoard so a map pin/dot hover can highlight a row here too
// (previously this component owned its own hover state).

export interface TopHomeRow {
  propId: string;
  situsNum: string | null;
  situsStreet: string | null;
  situsCity: string | null;
  situsZip: string | null;
  marketValue: number | null;
  blockGroupGeoid: string;
  countyFips: string | null;
  score: number | null;
  /** api.homes_ranked_weighted's top-3 nonzero-contributing signal keys, in order. */
  reasons: string[];
  distributorName: string | null;
  distributorSaidi: number | null;
  distributorSaidiYear: number | null;
  distributorSaidiEarlyRelease: boolean | null;
  floodFlag: boolean | null;
  empowerRate: number | null;
  acsPct65Plus: number | null;
  acsPctElectricHeat: number | null;
  backupIntentRate: number | null;
  /** Parcel centroid (core.parcel_geoms) — null when no geometry has loaded. */
  lon: number | null;
  lat: number | null;
  /** M2-P8 home-level signals — null (with permitNullReason) outside the
   * City of Austin permit area, never false. */
  ownerIs65: boolean | null;
  homeSolar: boolean | null;
  homeEv: boolean | null;
  homeGenerator: boolean | null;
  homePanelUpgrade: boolean | null;
  homeBattery: boolean | null;
  homeBatteryPermitDate: string | null;
  permitNullReason: string | null;
  yrBuilt: number | null;
  livingArea: number | null;
  outageMinutes: number | null;
  outageYear: number | null;
  /** 'distributor_saidi' or 'county_eaglei_proxy' — which basis outageMinutes came from. */
  outageBasis: string | null;
  outageSourceIds: string[];
  homeValueTerm: number | null;
  installabilityTerm: number | null;
  /** M2-P10/P9 (block group ACS shares + per-home permit path/risk). */
  income100kShare: number | null;
  age3564Share: number | null;
  permitPath: string | null;
  permitRiskTerm: number | null;
}

/** api.homes_ranked_weighted's reason keys -> a short label + DESIGN.md signal
 * category for the chip dot. outage is a "will this home lose power"
 * exposure signal -> the outage (grid-off red) category. flood is an
 * INSTALLABILITY signal (0204_flood_direction.sql: the score favors
 * homes OUTSIDE a FEMA flood zone, per PRODUCT.md/the spec's Signals
 * table) -> install (deep blue), not outage red. empower/age65/
 * electric_heat are household-need signals -> household (sky).
 * backup_intent (a demonstrated interest in battery/generator backup) ->
 * install (deep blue) too. M2-P8 adds four home-level signals: owner_65
 * (a household characteristic -> household), home_permits/installability
 * (the home's own hardware/eligibility -> install), and home_value (the
 * "grid value" signal category from PRODUCT.md's four signals -> grid,
 * gold — its first use). flood is never returned in `reasons` (the SQL
 * function excludes it from "top signal" candidates), but keeps an entry
 * here so ScoreExplainer's stacked bar can still color its segment.*/
export const REASON_META: Record<string, { label: string; signal: SignalName }> = {
  outage: { label: "Outage exposure", signal: "outage" },
  flood: { label: "Outside flood zone", signal: "install" },
  empower: { label: "Medical need", signal: "household" },
  age65: { label: "Age 65+", signal: "household" },
  electric_heat: { label: "Electric heat", signal: "household" },
  backup_intent: { label: "Neighbors installing backup", signal: "install" },
  owner_65: { label: "Homeowner 65+", signal: "household" },
  home_permits: { label: "Own solar/EV/generator permit", signal: "install" },
  installability: { label: "Installability", signal: "install" },
  home_value: { label: "Home value", signal: "grid" },
  // M2-P10: block-group ACS shares -> household (same category as
  // age65/electric_heat, the other neighborhood-demographic signals).
  income_100k: { label: "Household income $100k+", signal: "household" },
  age_35_64: { label: "Prime working age 35-64", signal: "household" },
  // M2-P9: permit-timeline risk is an installability/eligibility signal,
  // same category as home_permits/installability/backup_intent.
  permit_risk: { label: "Permit friction", signal: "install" },
};

export interface TopHomesTableProps {
  rows: TopHomeRow[];
  /** 1-based rank of rows[0] on the current page (county pages: 1, 51, 101, ...;
   * block-group selection: also 1-based within that block group's ranking). */
  rangeStart?: number;
  /** Controlled from RankingBoard so a map pin/dot hover highlights the same row. */
  hoveredPropId?: string | null;
  onHoverRow?: (row: TopHomeRow | null) => void;
  /** Set (to a propId) only when the hover originated from the map, so the row
   * scrolls into view; a row's own hover never re-triggers its own scroll. */
  scrollToPropId?: string | null;
  /** propId -> rank delta (oldRank - newRank; positive = moved up). Cleared 2s after a re-rank. */
  rankDeltas?: Map<string, number>;
  /** Redesign (Mock A): the one row expanded in place with the real case
   * for a knock + 3 meters, at the team's own live slider weights --
   * replaces the score explainer that used to append below the board. */
  expandedPropId?: string | null;
  onToggleExpand?: (propId: string) => void;
  weights?: Record<SignalKey, number>;
  onLocateOnMap?: (row: TopHomeRow) => void;
  /** Short appraisal-district name for this county's source note ("Travis CAD"). */
  cadShort?: string;
}

export function TopHomesTable({
  rows,
  rangeStart = 1,
  hoveredPropId = null,
  onHoverRow,
  scrollToPropId,
  rankDeltas,
  expandedPropId = null,
  onToggleExpand,
  weights,
  onLocateOnMap,
  cadShort,
}: TopHomesTableProps) {
  // DataTableRow (web/components/ui/DataTable.tsx, not owned by this
  // ticket) is a plain function component with no `ref` in its prop
  // type, so the scroll target is found via data-prop-id on a wrapping
  // container instead of a per-row ref.
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!scrollToPropId) return;
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-prop-id="${scrollToPropId}"]`);
    // "only if not visible" — scrollIntoView({block: "nearest"}) is a no-op
    // when the element is already fully within the scroll container.
    el?.scrollIntoView({ block: "nearest" });
  }, [scrollToPropId]);

  // Rank 1 opens expanded on first load; only a user's own expansion
  // should scroll the list and move focus.
  const initialExpandedRef = useRef(expandedPropId);
  useEffect(() => {
    if (!expandedPropId || expandedPropId === initialExpandedRef.current) return;
    initialExpandedRef.current = null;
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-prop-id="${expandedPropId}"]`);
    el?.scrollIntoView({ block: "nearest" });
    el?.focus?.({ preventScroll: true });
  }, [expandedPropId]);

  if (rows.length === 0) {
    return (
      <MissingState
        variant="not-loaded"
        reason="No homes to rank — set at least one signal weight above zero"
      />
    );
  }

  return (
    <div ref={containerRef} className="predicted-homes-table" role="table" aria-label="Homes ranked by the team's priorities">
      <div role="row" className="visually-hidden">
        <span role="columnheader">Rank</span>
        <span role="columnheader">Home</span>
        <span role="columnheader">Team priority score</span>
      </div>
      {rows.map((row, index) => {
        const delta = rankDeltas?.get(row.propId);
        return (
          <HomeRow
            key={row.propId}
            testId="top-homes-row"
            propId={row.propId}
            rank={rangeStart + index}
            rankDelta={delta && delta !== 0 ? delta : undefined}
            street={streetLine(row.situsNum, row.situsStreet)}
            meta={homeMetaLine({ city: row.situsCity, zip: row.situsZip, yrBuilt: row.yrBuilt, utility: row.distributorName })}
            hovered={hoveredPropId === row.propId}
            expanded={expandedPropId === row.propId}
            onHover={(on) => onHoverRow?.(on ? row : null)}
            onToggle={() => onToggleExpand?.(row.propId)}
            side={
              row.score === null ? (
                <MissingState variant="not-loaded" reason="No signal has a nonzero weight for this home" />
              ) : (
                <>
                  <span className="top-homes-score" title="Team priority score, 0 to 1, from the weights your team set">
                    <span className="top-homes-score__bar-track">
                      <span className="top-homes-score__bar-fill" style={{ width: `${Math.max(0, Math.min(1, row.score)) * 100}%` }} />
                    </span>
                    <span className="home-row__score">{row.score.toFixed(2)}</span>
                  </span>
                  <span className="home-row__utility">team score</span>
                </>
              )
            }
            chips={
              row.reasons.length === 0 ? (
                <MissingState variant="not-loaded" reason="No weighted signal available for this home" />
              ) : (
                row.reasons.slice(0, 2).map((reason) => {
                  const meta = REASON_META[reason];
                  if (!meta) return null;
                  return <Chip key={reason} label={meta.label} signal={meta.signal} />;
                })
              )
            }
            expandContent={
              <>
                <CaseForKnock
                  propId={row.propId}
                  weights={weights ?? ({} as Record<SignalKey, number>)}
                  cadShort={cadShort}
                  compact
                />
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

export function TopHomesPagination({
  rangeStart,
  rows,
  total,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
}: {
  rangeStart: number;
  rows: TopHomeRow[];
  total?: number | null;
  hasPrevious?: boolean;
  hasNext?: boolean;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const rangeEnd = rangeStart + rows.length - 1;
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginTop: "var(--space-2)",
        fontSize: "var(--type-label-font-size)",
        color: "var(--theme-ink-muted)",
      }}
    >
      <span data-testid="top-homes-range">
        {rows.length === 0
          ? "No homes to show"
          : total === null || total === undefined
            ? `Showing ${rangeStart}–${rangeEnd}`
            : `Showing ${rangeStart}–${rangeEnd} of ${total.toLocaleString()} homes`}
      </span>
      <span style={{ display: "flex", gap: "var(--space-2)" }}>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={onPrevious}
          disabled={!hasPrevious}
          aria-disabled={!hasPrevious}
          data-testid="top-homes-prev"
        >
          Previous
        </button>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={onNext}
          disabled={!hasNext}
          aria-disabled={!hasNext}
          data-testid="top-homes-next"
        >
          Next
        </button>
      </span>
    </div>
  );
}
