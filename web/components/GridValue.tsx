import { MissingState } from "./ui/MissingState";
import { ProvenancePopover, type ProvenancePopoverProps } from "./ui/ProvenancePopover";
import { Figure } from "./ui/Figure";

// M3-W1: "Grid value to Base" — the ERCOT price-spread/scarcity economics
// of this home's load zone, ALWAYS shown as its own line, never merged
// into outage exposure (checks/M3-ercot-layering.md section C item 1;
// PRODUCT.md's "grid value to Base vs. outage need to the homeowner"
// distinction). CLAUDE.md's real-data rule: the only dollar values this
// app ever shows are real ERCOT market prices ($/MWh) — never a made-up
// Base revenue number.
//
// Gated by api.base_capture (M3-S1, from core.retail_market): Base is a
// licensed Texas REP that only realizes VPP/wholesale economics where it
// actually sells energy, not everywhere it has a battery customer.
//   'full'/'partner' -- Base sells energy here; the zone's real spread
//                       and scarcity-day count apply.
//   'backup_only'    -- e.g. Austin Energy: Base sells backup only, no
//                       VPP economics AT ALL here -- never a number,
//                       never a 0.
//   'not_served'     -- Base doesn't serve this utility at all.
//   null              -- this utility's tier hasn't been classified yet.

export type BaseCaptureTier = "full" | "partner" | "backup_only" | "not_served";

export type GridValueSource = Omit<ProvenancePopoverProps, "children" | "id">;

export interface GridValueProps {
  /** api.base_capture.base_capture for this home's utility (territory_eia_id). */
  baseCapture: BaseCaptureTier | null;
  baseCaptureNullReason: string | null;
  /** api.county_loadzone's settlement_point for this home's utility, or
   * null when no crosswalk row exists for it yet (never guessed). */
  loadZone: string | null;
  /** Reason a load zone couldn't be resolved for this utility -- only
   * meaningful when baseCapture is 'full'/'partner' (backup_only/
   * not_served never need a zone at all). */
  zoneNullReason?: string | null;
  avgDailySpreadUsdMwh: number | null;
  scarcityDays: number | null;
  scarcityThresholdUsdMwh: number | null;
  windowStart: string | null;
  windowEnd: string | null;
  gridValueNullReason: string | null;
  /** api.grid_value_lz.source_ids[0] -> api.sources, the ERCOT NP6-905-CD row. */
  source: GridValueSource | null;
  /** Unique DOM id suffix (e.g. a prop_id) so multiple GridValue instances on one page don't collide. */
  idSuffix: string;
}

function usdMwh(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function GridValue({
  baseCapture,
  baseCaptureNullReason,
  loadZone,
  zoneNullReason,
  avgDailySpreadUsdMwh,
  scarcityDays,
  scarcityThresholdUsdMwh,
  windowStart,
  windowEnd,
  gridValueNullReason,
  source,
  idSuffix,
}: GridValueProps) {
  if (baseCapture === "backup_only") {
    return <MissingState variant="not-available" reason="backup_only_no_vpp" />;
  }
  if (baseCapture === "not_served") {
    return <MissingState variant="not-available" reason="not_served_by_base" />;
  }
  if (baseCapture === null) {
    return <MissingState variant="not-available" reason={baseCaptureNullReason ?? "utility_tier_not_classified"} />;
  }

  // full or partner from here on -- VPP/wholesale economics apply, so a
  // real load zone + spread is expected, never invented if missing.
  if (!loadZone) {
    return <MissingState variant="not-available" reason={zoneNullReason ?? "no_zone_mapped_for_utility"} />;
  }
  if (avgDailySpreadUsdMwh === null) {
    return <MissingState variant="not-loaded" reason={gridValueNullReason ?? "not_loaded"} />;
  }

  const spreadFigure = (
    <Figure value={usdMwh(avgDailySpreadUsdMwh)} unit={`average daily price spread, ${loadZone} zone`} />
  );

  const wrapped = source ? (
    <ProvenancePopover id={`grid-value-${idSuffix}`} {...source}>
      {spreadFigure}
    </ProvenancePopover>
  ) : (
    spreadFigure
  );

  return (
    <span>
      <span style={{ display: "block" }}>{wrapped}</span>
      {scarcityDays !== null && scarcityThresholdUsdMwh !== null ? (
        <span
          style={{
            display: "block",
            fontSize: "var(--type-label-font-size)",
            color: "var(--theme-ink-muted)",
          }}
        >
          {scarcityDays} scarcity days ({">"}${scarcityThresholdUsdMwh}/MWh) in the trailing 12 months
          {windowStart && windowEnd ? ` (${windowStart} to ${windowEnd})` : ""}.
        </span>
      ) : null}
      {gridValueNullReason ? (
        <span
          style={{
            display: "block",
            fontSize: "var(--type-label-font-size)",
            color: "var(--theme-ink-muted)",
          }}
        >
          {gridValueNullReason === "fewer_than_8_load_zones_loaded_anchor_unreliable"
            ? "Only some ERCOT load zones are loaded, so this figure isn't yet compared against every zone."
            : gridValueNullReason}
        </span>
      ) : null}
    </span>
  );
}
