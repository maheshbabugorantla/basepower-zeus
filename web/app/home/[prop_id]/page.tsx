import type { ReactNode } from "react";
import { Suspense } from "react";
import Link from "next/link";
import { query } from "../../../lib/db";
import { Panel } from "../../../components/ui/Panel";
import { MissingState } from "../../../components/ui/MissingState";
import { ProvenancePopover } from "../../../components/ui/ProvenancePopover";
import { PermitLabel } from "../../../components/PermitLabel";
import { ParcelMap } from "../../../components/ParcelMap";
import { SolarPanel } from "../../../components/SolarPanel";
import { ScoreExplainer } from "../../../components/ScoreExplainer";
import { PropensityBadge, type PropensityReason } from "../../../components/PropensityBadge";
import { utilityStatusForHome, buildYearNote, tierForDecile, type PriorityTierKey } from "../../../lib/priorityTier";
import { PermitPath, type PermitPathKind, type PermitPathStatsRow, type PermitRulesCitation } from "../../../components/PermitPath";
import { GridValue } from "../../../components/GridValue";
import { COUNTY_CANDIDATES, CAD_NAME } from "../../../lib/counties";
import { HomeTabs, JumpToTab } from "../../../components/HomeTabs";
import { CaseForKnock } from "../../../components/CaseForKnock";

// M3-W1: which appraisal district this home's parcel roll comes from,
// per county (Travis CAD / Harris CAD (HCAD) / Williamson CAD (WCAD)) --
// never a hardcoded "Travis CAD" regardless of which county the parcel
// actually sits in. Moved to lib/counties.ts (CAD_NAME) so
// EligibilityFunnel's caller can use the identical map (T7 fix).
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
} from "../../../components/ui/DataTable";

// M1-W1/M1-W3: /home/[prop_id], from api.home_detail — parcel facts (state
// code, homestead, situs, market value) and its permits, each with a
// provenance popover, plus (M1-W3 fix #4, HomeDetail.dc.html): score,
// rank, block group, a "Why this home" reasoning section, a mini parcel
// map, and a breadcrumb back to Ranking.
//
// M1 rule (superseded by M2-P8, kept for history): the county-level
// EAGLE-I total customer-hours (api.county_outage) never applied to a
// single home, so no outage figure appeared here. M2-P8 adds the real
// per-home figure — core.mv_home_signals.outage_minutes, sourced from the
// home's own distributor's EIA-861 SAIDI when reported, else the
// EAGLE-I county proxy on the same minutes-per-customer scale
// (outage_basis) — never the county total customer-hours figure.

export const dynamic = "force-dynamic";

interface PermitJson {
  permit_number: string;
  issue_date: string | null;
  work_class: string | null;
  permit_class: string | null;
  description: string | null;
  status_current: string | null;
  label: string | null;
  labeller: string | null;
  source_id: string | null;
}

interface HomeDetailRow {
  prop_id: string;
  geo_id: string | null;
  county_fips: string | null;
  prop_type_cd: string | null;
  imprv_state_cd: string | null;
  land_state_cd: string | null;
  hs_exempt: string | null;
  ov65_exempt: string | null;
  is_single_family: boolean;
  is_homestead: boolean;
  situs_num: string | null;
  situs_street: string | null;
  situs_city: string | null;
  situs_zip: string | null;
  market_value: string | number | null;
  tax_year: number | null;
  permits: PermitJson[];
  source_ids: string[];
}

interface SourceRow {
  source_id: string;
  source: string;
  url: string;
  retrieved_at: string | Date;
  sha256: string;
  rows: string | number | null;
  runner: "cron" | "cli";
  latest_run_id: string | null;
  latest_run_rows_in: number | null;
  latest_run_rows_loaded: number | null;
}

interface ScoreContextRow {
  block_group_geoid: string | null;
  score: string | number | null;
  score_null_reason: string | null;
  rate_per_1000: string | number | null;
  homes_gated: string | number | null;
  bg_rank: string | number | null;
  bg_scored_count: string | number | null;
}

interface TopHomeRankRow {
  rank: string | number;
  total: string | number;
  score: string | number;
}

// M4-W2: api.home_propensity -- the predictive headline. One row per
// gated home (or none for a home outside the gated population), never
// synthesized here.
interface HomePropensityDbRow {
  p_install_12m: string | number;
  relative_to_county: string | number | null;
  decile: number | null;
  reasons: PropensityReason[];
  extrapolated_from: string | null;
}

// "Before you knock": already has backup? (core.home_coverage) -- a
// primary-key lookup, same table/bucket values the ranking screen's
// "Hide homes that already have backup" toggle uses (api.top-homes
// route's excludeBackup predicate), so a rep sees the identical fact
// here that decided whether this home was even on the list.
async function getHomeCoverageBucket(propId: string): Promise<string | null> {
  try {
    const rows = await query<{ bucket: string | null }>(
      `select bucket from core.home_coverage where prop_id = $1`,
      [propId]
    );
    return rows[0]?.bucket ?? null;
  } catch (err) {
    console.error("home-detail: failed to load core.home_coverage", err);
    return null;
  }
}

async function getHomePropensity(propId: string): Promise<HomePropensityDbRow | null> {
  try {
    const rows = await query<HomePropensityDbRow>(
      `select p_install_12m, relative_to_county, decile, reasons, extrapolated_from
       from api.home_propensity
       where prop_id = $1`,
      [propId]
    );
    return rows[0] ?? null;
  } catch (err) {
    console.error("home-detail: failed to load api.home_propensity", err);
    return null;
  }
}

// M2-W1: core.mv_home_signals (0201_m2.sql) — every M2 per-home gate +
// need signal, read directly rather than through an `api` view: no view
// over this mv exists yet (api.top_homes_weighted only returns the top
// 50), and the ticket explicitly calls for "a small server query or an
// api view if one exists". Every join in the mv is LEFT JOIN, so a row
// always exists once the home is in the M1 gated universe
// (core.mv_home_block_group) — gate_reason/null_reason columns say why a
// given signal is missing, never a silent 0.
interface HomeSignalsRow {
  gate_reason: string | null;
  territory_null_reason: string | null;
  /** M-utility-gate (0303): 'most_likely_county_utility' (Harris -- a
   * county-level pin, since every HIFLD territory polygon overlaps for
   * that county) or 'service_area_polygon' (the normal ST_Within match,
   * e.g. Travis). Null only when territory_eia_id itself is null. */
  territory_basis: string | null;
  territory_eia_id: string | null;
  distributor_name: string | null;
  distributor_saidi: string | number | null;
  distributor_saidi_year: number | null;
  distributor_saidi_early_release: boolean | null;
  distributor_saidi_null_reason: string | null;
  flood_flag: boolean | null;
  flood_null_reason: string | null;
  empower_rate: string | number | null;
  empower_null_reason: string | null;
  acs_pct_65_plus: string | number | null;
  acs_65_null_reason: string | null;
  acs_pct_electric_heat: string | number | null;
  acs_heat_null_reason: string | null;
  backup_intent_rate: string | number | null;
  backup_intent_null_reason: string | null;
  source_ids: string[] | null;
  // M2-P8: home-level signals + the fixed outage basis.
  owner_65: boolean | null;
  owner_65_null_reason: string | null;
  home_solar: boolean | null;
  home_ev: boolean | null;
  home_generator: boolean | null;
  home_panel_upgrade: boolean | null;
  home_battery: boolean | null;
  battery_permit_date: string | Date | null;
  permit_null_reason: string | null;
  yr_built: number | null;
  yr_built_null_reason: string | null;
  installability_term: string | number | null;
  installability_null_reason: string | null;
  outage_minutes: string | number | null;
  outage_year: number | null;
  outage_basis: string | null;
  outage_null_reason: string | null;
  outage_source_ids: string[] | null;
  block_group_geoid: string | null;
}

// M2-P10: core.acs_income_age_bg -- block-group ACS shares, "labelled on
// screen as neighborhood figures" per the ticket (same for every home in
// the block group, like age65/electric_heat above).
interface IncomeAgeRow {
  median_household_income: string | number | null;
  median_household_income_null_reason: string | null;
  income_100k_share: string | number | null;
  income_100k_share_null_reason: string | null;
  age_35_64_share: string | number | null;
  age_35_64_share_null_reason: string | null;
  source_id: string;
}

const GATE_REASON_LABEL: Record<string, string> = {
  territory_not_base_served: "Not in a utility Base serves (HIFLD polygon match, or Base's served-utilities list does not mark it mapped=yes)",
};

/** territory_null_reason codes with a known plain-language line in
 * MissingState's own REASON_TEXT map -- rendered via MissingState
 * (never the generic "(raw_code)" fallback further below). */
const KNOWN_UTILITY_NULL_REASONS = new Set([
  "utility_not_confirmed",
  "multiply_certificated",
  "no_ccn_match",
  "ccn_holder_unmapped",
]);

// M2-W4: regulated (no retail choice, e.g. Austin Energy municipal) vs
// deregulated (retail choice, e.g. Oncor) market, from api.retail_market
// (0206_retail_market.sql) -- a single row keyed by eia_utility_number,
// the same EIA-861 number homeSignals.territory_eia_id already carries.
// A PK/unique-index lookup, well under the 50 ms budget.
interface RetailMarketRow {
  eia_utility_number: string;
  utility_name: string | null;
  retail_market: "deregulated" | "not_deregulated";
  plain_language: string;
  source_url: string;
  quote: string;
  retrieved_at: string | Date;
  source_id: string;
}

async function getRetailMarket(eiaId: string): Promise<RetailMarketRow | null> {
  try {
    const rows = await query<RetailMarketRow>(
      `select eia_utility_number, utility_name, retail_market, plain_language,
              source_url, quote, retrieved_at, source_id
       from api.retail_market
       where eia_utility_number = $1`,
      [eiaId]
    );
    return rows[0] ?? null;
  } catch (err) {
    console.error("home-detail: failed to load api.retail_market", err);
    return null;
  }
}

// M3-W1: eia_utility_number -> ERCOT settlement point, backed by the
// api.county_loadzone rows already loaded (M3-P4) — see that view for
// each row's own citation. api.county_loadzone is keyed by
// (county_fips, utility_name), and its utility_name text does not match
// api.base_capture/api.retail_market's utility_name spelling for the
// same utility (e.g. "CenterPoint Energy Houston Electric" vs.
// "CenterPoint Energy") -- checks/M3-ercot-layering.md's own open item --
// so this is an explicit, cited-by-comment crosswalk on the STABLE
// eia_utility_number key, never a fuzzy name match. Only the utilities
// this repo has ever seen a real county_loadzone row for are listed;
// anything else reads "no zone mapped for this utility yet".
const EIA_ID_TO_LOAD_ZONE: Record<string, string> = {
  "1015": "LZ_AEN", // Austin Energy (api.county_loadzone, Travis)
  "8901": "LZ_HOUSTON", // CenterPoint Energy (api.county_loadzone, Harris: "CenterPoint Energy Houston Electric")
  "14626": "LZ_LCRA", // Pedernales Electric Cooperative (api.county_loadzone, Travis)
  "1892": "LZ_LCRA", // Bluebonnet Electric Cooperative (api.county_loadzone, Travis)
};

interface BaseCaptureRow {
  base_capture: "full" | "partner" | "backup_only" | "not_served" | null;
  base_capture_null_reason: string | null;
}

interface GridValueLzRow {
  avg_daily_spread_usd_mwh: string | number | null;
  scarcity_days: string | number | null;
  scarcity_threshold_usd_mwh: string | number | null;
  window_start: string | Date | null;
  window_end: string | Date | null;
  grid_value_null_reason: string | null;
  source_ids: string[];
}

export interface GridValueForHome {
  baseCapture: "full" | "partner" | "backup_only" | "not_served" | null;
  baseCaptureNullReason: string | null;
  loadZone: string | null;
  avgDailySpreadUsdMwh: number | null;
  scarcityDays: number | null;
  scarcityThresholdUsdMwh: number | null;
  windowStart: string | null;
  windowEnd: string | null;
  gridValueNullReason: string | null;
  source: SourceRow | null;
}

/** api.base_capture (per-utility Base service tier) + api.grid_value_lz
 * (per-load-zone ERCOT spread/scarcity) for one home's territory_eia_id.
 * Never invents a load zone or a spread for a utility this repo hasn't
 * cited a zone for -- see EIA_ID_TO_LOAD_ZONE above. */
async function getGridValueForHome(eiaId: string | null): Promise<GridValueForHome> {
  if (!eiaId) {
    return {
      baseCapture: null,
      baseCaptureNullReason: "no_territory_match",
      loadZone: null,
      avgDailySpreadUsdMwh: null,
      scarcityDays: null,
      scarcityThresholdUsdMwh: null,
      windowStart: null,
      windowEnd: null,
      gridValueNullReason: null,
      source: null,
    };
  }
  try {
    const captureRows = await query<BaseCaptureRow>(
      `select base_capture, base_capture_null_reason from api.base_capture where eia_utility_number = $1`,
      [eiaId]
    );
    const capture = captureRows[0] ?? { base_capture: null, base_capture_null_reason: "utility_tier_not_classified" };
    const loadZone = EIA_ID_TO_LOAD_ZONE[eiaId] ?? null;

    let gridValue: GridValueLzRow | null = null;
    if ((capture.base_capture === "full" || capture.base_capture === "partner") && loadZone) {
      const rows = await query<GridValueLzRow>(
        `select avg_daily_spread_usd_mwh, scarcity_days, scarcity_threshold_usd_mwh,
                window_start, window_end, grid_value_null_reason, source_ids
         from api.grid_value_lz where load_zone = $1`,
        [loadZone]
      );
      gridValue = rows[0] ?? null;
    }

    let source: SourceRow | null = null;
    if (gridValue && gridValue.source_ids.length > 0) {
      const sources = await getSourcesByIds(gridValue.source_ids);
      source = sources.get(gridValue.source_ids[0]) ?? null;
    }

    return {
      baseCapture: capture.base_capture,
      baseCaptureNullReason: capture.base_capture_null_reason,
      loadZone,
      avgDailySpreadUsdMwh:
        gridValue?.avg_daily_spread_usd_mwh === null || gridValue?.avg_daily_spread_usd_mwh === undefined
          ? null
          : Number(gridValue.avg_daily_spread_usd_mwh),
      scarcityDays:
        gridValue?.scarcity_days === null || gridValue?.scarcity_days === undefined
          ? null
          : Number(gridValue.scarcity_days),
      scarcityThresholdUsdMwh:
        gridValue?.scarcity_threshold_usd_mwh === null || gridValue?.scarcity_threshold_usd_mwh === undefined
          ? null
          : Number(gridValue.scarcity_threshold_usd_mwh),
      windowStart: gridValue?.window_start ? String(gridValue.window_start).slice(0, 10) : null,
      windowEnd: gridValue?.window_end ? String(gridValue.window_end).slice(0, 10) : null,
      gridValueNullReason: gridValue?.grid_value_null_reason ?? null,
      source,
    };
  } catch (err) {
    console.error("home-detail: failed to load api.base_capture / api.grid_value_lz", err);
    return {
      baseCapture: null,
      baseCaptureNullReason: "utility_tier_not_classified",
      loadZone: null,
      avgDailySpreadUsdMwh: null,
      scarcityDays: null,
      scarcityThresholdUsdMwh: null,
      windowStart: null,
      windowEnd: null,
      gridValueNullReason: null,
      source: null,
    };
  }
}

async function getIncomeAge(blockGroupGeoid: string): Promise<IncomeAgeRow | null> {
  try {
    const rows = await query<IncomeAgeRow>(
      `select median_household_income, median_household_income_null_reason,
              income_100k_share, income_100k_share_null_reason,
              age_35_64_share, age_35_64_share_null_reason, source_id
       from api.acs_income_age_bg
       where geoid = $1`,
      [blockGroupGeoid]
    );
    return rows[0] ?? null;
  } catch (err) {
    console.error("home-detail: failed to load api.acs_income_age_bg", err);
    return null;
  }
}

interface PermitPathStatsDbRow {
  median_days: string | number | null;
  p90_days: string | number | null;
  share_never_finished: string | number | null;
  share_issued_online: string | number | null;
  source_id: string | null;
}

/** M2-P9: the latest SB 1252 period (jurisdiction='ALL', label='battery',
 * period_type='sb1252', period='after_sb1252', all installers) --
 * citywide, since Base's Austin permit raw file has no per-jurisdiction
 * split finer than that within Austin Energy territory. */
async function getPermitPathStats(): Promise<PermitPathStatsDbRow | null> {
  try {
    const rows = await query<PermitPathStatsDbRow>(
      `select median_days, p90_days, share_never_finished, share_issued_online, source_id
       from api.permit_path_stats
       where jurisdiction = 'ALL' and label = 'battery' and period_type = 'sb1252'
             and period = 'after_sb1252' and is_base_power = false`
    );
    return rows[0] ?? null;
  } catch (err) {
    console.error("home-detail: failed to load api.permit_path_stats", err);
    return null;
  }
}

interface PermitRuleDbRow {
  quote: string;
  source_url: string;
}

async function getPermitRuleCitation(permitPath: PermitPathKind): Promise<PermitRuleDbRow | null> {
  if (permitPath === null) return null;
  const rule = permitPath === "city_battery_permit" ? "residential_ess_permit_required" : "municipal_regulation_barred";
  const authority = permitPath === "city_battery_permit" ? "City of Austin (Austin Energy)" : "State of Texas (SB 1252)";
  try {
    const rows = await query<PermitRuleDbRow>(
      `select quote, source_url from api.permit_rules where authority = $1 and rule = $2`,
      [authority, rule]
    );
    return rows[0] ?? null;
  } catch (err) {
    console.error("home-detail: failed to load api.permit_rules", err);
    return null;
  }
}

async function getHomeSignals(propId: string): Promise<HomeSignalsRow | null> {
  try {
    const rows = await query<HomeSignalsRow>(
      `select gate_reason, territory_null_reason, territory_basis, territory_eia_id,
              distributor_name, distributor_saidi, distributor_saidi_year,
              distributor_saidi_early_release, distributor_saidi_null_reason,
              flood_flag, flood_null_reason,
              empower_rate, empower_null_reason,
              acs_pct_65_plus, acs_65_null_reason,
              acs_pct_electric_heat, acs_heat_null_reason,
              backup_intent_rate, backup_intent_null_reason,
              source_ids,
              owner_65, owner_65_null_reason,
              home_solar, home_ev, home_generator, home_panel_upgrade, home_battery,
              battery_permit_date, permit_null_reason,
              yr_built, yr_built_null_reason,
              installability_term, installability_null_reason,
              outage_minutes, outage_year, outage_basis, outage_null_reason, outage_source_ids,
              block_group_geoid
       from core.mv_home_signals
       where prop_id = $1`,
      [propId]
    );
    return rows[0] ?? null;
  } catch (err) {
    console.error("home-detail: failed to load core.mv_home_signals", err);
    return null;
  }
}

// core.mv_home_signals.distributor_saidi_null_reason only distinguishes
// "no territory match" / "EIA-861 not loaded at all" / a generic
// "no_eia861_figure_for_distributor" — it can't carry EIA's own reason
// for a specific distributor+year (e.g. Oncor 44372's real reason is the
// literal "not_reported", loaded as core.utility_reliability.
// saidi_incl_major_null_reason, per M2-P7/0201_m2.sql) because the mv's
// lateral join only selects rows where saidi_incl_major IS NOT NULL. A
// distributor that IS matched but has no reported figure is "not
// available" (a real, permanent absence from EIA), not "not loaded" (a
// pipeline that hasn't run yet) — so this looks up the real reason
// directly when a territory match exists but distributor_saidi is null.
async function getDistributorSaidiNullReason(eiaId: string): Promise<string | null> {
  try {
    const rows = await query<{ saidi_incl_major_null_reason: string | null }>(
      `select saidi_incl_major_null_reason
       from core.utility_reliability
       where eia_id = $1
       order by year desc
       limit 1`,
      [eiaId]
    );
    return rows[0]?.saidi_incl_major_null_reason ?? null;
  } catch (err) {
    console.error("home-detail: failed to load core.utility_reliability null reason", err);
    return null;
  }
}

/** Finds the api.sources row whose `source` label contains one of `needles` (case-insensitive). */
function findSourceByName(
  sourcesById: Map<string, SourceRow>,
  sourceIds: string[] | null | undefined,
  needles: string[]
): SourceRow | undefined {
  if (!sourceIds) return undefined;
  for (const id of sourceIds) {
    const row = sourcesById.get(id);
    if (row && needles.some((n) => row.source.toLowerCase().includes(n))) return row;
  }
  return undefined;
}

async function getSourcesByIds(sourceIds: string[]): Promise<Map<string, SourceRow>> {
  if (sourceIds.length === 0) return new Map();
  const rows = await query<SourceRow>(
    `select source_id, source, url, retrieved_at, sha256, rows, runner,
            latest_run_id, latest_run_rows_in, latest_run_rows_loaded
     from api.sources
     where source_id = any($1::uuid[])`,
    [sourceIds]
  );
  return new Map(rows.map((r) => [r.source_id, r]));
}

// Reads core.mv_home_block_group (perf(M1) materialization — see
// 0102_m1_materialize.sql), not a live ST_Within join: that spatial join
// is exactly what used to time out /ranking before it was materialized,
// and this per-home lookup would hit the same cost without it. The mv
// only contains gated (single-family + homestead) homes with geometry —
// a home outside that gate has no row here, which reads as "not gated
// for scoring", a real and distinct reason from "gated but not scored
// yet". Wrapped in try/catch so an unrefreshed/unavailable mv degrades to
// an honest MissingState instead of a 500.
async function getScoreContext(propId: string): Promise<ScoreContextRow | null> {
  try {
    const rows = await query<ScoreContextRow>(
      `with ranked_bgs as (
         select block_group_geoid, score,
                rank() over (order by score desc) as bg_rank,
                count(*) over () as bg_scored_count
         from api.blockgroup_scores
         where score is not null
       )
       select
         hbg.block_group_geoid,
         bs.score,
         coalesce(bs.score_null_reason, 'no_permit_coverage') as score_null_reason,
         bs.rate_per_1000,
         bs.homes_gated,
         rb.bg_rank,
         rb.bg_scored_count
       from core.mv_home_block_group hbg
       left join api.blockgroup_scores bs on bs.block_group_geoid = hbg.block_group_geoid
       left join ranked_bgs rb on rb.block_group_geoid = hbg.block_group_geoid
       where hbg.prop_id = $1`,
      [propId]
    );
    return rows[0] ?? null;
  } catch (err) {
    console.error("home-detail: failed to load score context", err);
    return null;
  }
}

async function getTopHomeRank(propId: string): Promise<TopHomeRankRow | null> {
  try {
    const rows = await query<TopHomeRankRow>(
      // Same ranking the /ranking page shows by default (equal weights),
      // so the header can never disagree with the table.
      `with ranked as (
         select prop_id, score,
                row_number() over () as rank,
                count(*) over () as total
         from api.top_homes_weighted(
           '{"outage":1,"home_value":1,"backup_intent":1,"age65":1,"home_permits":1,"electric_heat":1,"empower":1,"owner_65":1,"installability":1,"flood":1}'::jsonb,
           (select county_fips from core.mv_home_signals where prop_id = $1)
         )
       )
       select rank, total, score from ranked where prop_id = $1`,
      [propId]
    );
    return rows[0] ?? null;
  } catch (err) {
    console.error("home-detail: failed to load top_homes rank", err);
    return null;
  }
}

async function getParcelGeojson(propId: string): Promise<GeoJSON.Polygon | GeoJSON.MultiPolygon | null> {
  try {
    const rows = await query<{ geojson: string | null }>(
      `select extensions.ST_AsGeoJSON(pg.geom) as geojson
       from core.parcel_geoms pg
       where pg.prop_id = $1`,
      [propId]
    );
    const raw = rows[0]?.geojson ?? null;
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error("home-detail: failed to load parcel geometry", err);
    return null;
  }
}

async function classifierHasRun(): Promise<boolean> {
  try {
    const rows = await query<{ ran: boolean }>(
      `select exists(select 1 from core.permit_labels where labeller = 'rules') as ran`
    );
    return rows[0]?.ran ?? false;
  } catch (err) {
    console.error("home-detail: failed to check classifier state", err);
    return false;
  }
}

/** Redesign (Mock B): the Signals tab's real row count -- one row per
 * signal api.home_score_breakdown actually returns for this home (never
 * a hand-typed "12"), at equal weights (the tab shows the unweighted
 * breakdown, same as the existing ScoreExplainer default below). */
async function getSignalsCount(propId: string): Promise<number> {
  try {
    const rows = await query<{ n: string | number }>(
      `select count(*) as n from api.home_score_breakdown($1, $2::jsonb)`,
      [propId, JSON.stringify(EQUAL_WEIGHTS)]
    );
    return rows[0] ? Number(rows[0].n) : 0;
  } catch (err) {
    console.error("home-detail: failed to count api.home_score_breakdown rows", err);
    return 0;
  }
}

/** Redesign: the priority card's "In the top tenth of N ranked <county>
 * homes" -- N is the real gate-passed/ranked count for this home's own
 * county (api.gate_counts, reason='passed'), never a hardcoded figure. */
async function getRankedHomeCount(countyFips: string): Promise<number | null> {
  try {
    const rows = await query<{ n: string | number | null }>(
      `select home_count as n from api.gate_counts where county_fips = $1 and reason = 'passed'`,
      [countyFips]
    );
    return rows[0]?.n === null || rows[0]?.n === undefined ? null : Number(rows[0].n);
  } catch (err) {
    console.error("home-detail: failed to load api.gate_counts for the priority card", err);
    return null;
  }
}

/** Priority card sentence -- varies by tier (a real product bug fixed
 * here: "top tenth" is only correct for decile 1/tier "top"). */
function priorityCardSentence(tierKey: PriorityTierKey, rankedCount: number | null, countyName: string): string {
  if (rankedCount === null) {
    return "Ranked homes count not available right now.";
  }
  const rankedPhrase = `${rankedCount.toLocaleString()} ranked ${countyName} homes`;
  switch (tierKey) {
    case "top":
      return `In the top tenth of ${rankedPhrase}, by likelihood of adding backup in the next 12 months.`;
    case "high":
      return `In the next fifth of ${rankedPhrase}, by likelihood of adding backup in the next 12 months.`;
    case "medium":
      return `In the middle third of ${rankedPhrase}, by likelihood of adding backup in the next 12 months.`;
    case "low":
      return `In the lowest four-tenths of ${rankedPhrase}, by likelihood of adding backup in the next 12 months.`;
    default:
      return `Not yet scored among ${rankedPhrase}.`;
  }
}

function ProvenanceFor({
  sourceRow,
  id,
  children,
}: {
  sourceRow: SourceRow | undefined;
  id: string;
  children: ReactNode;
}) {
  if (!sourceRow) return <>{children}</>;
  return (
    <ProvenancePopover
      id={id}
      dataset={sourceRow.source}
      url={sourceRow.url}
      retrievedAt={
        sourceRow.retrieved_at instanceof Date
          ? sourceRow.retrieved_at.toISOString()
          : String(sourceRow.retrieved_at)
      }
      sha256={sourceRow.sha256}
      runId={sourceRow.latest_run_id ?? "none"}
      runner={sourceRow.runner}
      rowsIn={sourceRow.latest_run_rows_in ?? null}
      rowsLoaded={sourceRow.latest_run_rows_loaded ?? null}
      rawFileHref={`/sources/raw/${sourceRow.source_id}`}
    >
      {children}
    </ProvenancePopover>
  );
}

function NotRecorded() {
  return <span style={{ color: "var(--theme-ink-muted)" }}>Not recorded</span>;
}

// Same as WeightSliders' equalWeights() (a client module, so not callable
// here): every signal at the mid-point of the 0–10 scale.
const EQUAL_WEIGHTS = {
  outage: 5,
  home_value: 5,
  backup_intent: 5,
  age65: 5,
  home_permits: 5,
  electric_heat: 5,
  empower: 5,
  owner_65: 5,
  installability: 5,
  flood: 5,
  income_100k: 5,
  age_35_64: 5,
  permit_risk: 5,
};

// M2-P8: base article cited as the source for the "150-200A main breaker"
// installability rule (a Base help article, not a Base internal number —
// used here as provenance for a plain-language installability note).
const BASE_PANEL_ARTICLE_URL = "https://help.basepowercompany.com/en/articles/10280705";

interface TexasOutagePercentileRow {
  saidi: string | number;
}

/**
 * "fewer outage minutes than N% of Texas utilities" (M2-P8 acceptance:
 * a real percentile against every Texas distributor reporting to
 * EIA-861 for the same year outage_minutes came from — not against
 * homes, which is the bug this ticket fixes). Applies identically
 * whether outage_minutes came from the home's own distributor's SAIDI or
 * the EAGLE-I county proxy (outage_basis) — both are the same unit.
 * core.utility_reliability is a small (tens of rows) table, so this full
 * scan for one year stays well under the 1s budget without an index.
 */
async function getTexasOutagePercentile(outageMinutes: number, outageYear: number): Promise<number | null> {
  try {
    const rows = await query<TexasOutagePercentileRow>(
      `select saidi_incl_major as saidi from core.utility_reliability
       where year = $1 and saidi_incl_major is not null`,
      [outageYear]
    );
    if (rows.length === 0) return null;
    const better = rows.filter((r) => Number(r.saidi) > outageMinutes).length;
    return Math.round((better / rows.length) * 100);
  } catch (err) {
    console.error("home-detail: failed to compute the Texas outage percentile", err);
    return null;
  }
}

export default async function HomeDetailPage({
  params,
}: {
  params: Promise<{ prop_id: string }>;
}) {
  const { prop_id } = await params;

  const rows = await query<HomeDetailRow>(
    `select prop_id, geo_id, county_fips, prop_type_cd, imprv_state_cd, land_state_cd,
            hs_exempt, ov65_exempt, is_single_family, is_homestead,
            situs_num, situs_street, situs_city, situs_zip, market_value, tax_year,
            permits, source_ids
     from api.home_detail
     where prop_id = $1`,
    [prop_id]
  );

  if (rows.length === 0) {
    return (
      <Panel>
        <MissingState
          variant="not-loaded"
          reason={`No parcel with ID ${prop_id}`}
        />
      </Panel>
    );
  }

  const home = rows[0];
  // M3-W1: every home carries the county its lot actually sits in
  // (api.home_detail.county_fips) -- Travis/Harris/Williamson wording
  // must follow that, never a hardcoded "Travis".
  const countyName = COUNTY_CANDIDATES.find((c) => c.fips === home.county_fips)?.name ?? "this";
  const homeSignals = await getHomeSignals(home.prop_id);
  const gridValue = await getGridValueForHome(homeSignals?.territory_eia_id ?? null);
  const distributorSaidiRealNullReason =
    homeSignals && homeSignals.distributor_saidi === null && homeSignals.territory_eia_id
      ? await getDistributorSaidiNullReason(homeSignals.territory_eia_id)
      : null;
  const retailMarket = homeSignals?.territory_eia_id
    ? await getRetailMarket(homeSignals.territory_eia_id)
    : null;
  // M2-P9: same territory -> path derivation api.home_score_breakdown uses
  // -- Austin Energy (EIA 1015) keeps a city battery permit under SB
  // 1252's municipally-owned-utility exception; every other matched
  // territory (Oncor-area cities) follows state rules only.
  const permitPath: PermitPathKind =
    homeSignals?.territory_eia_id === "1015"
      ? "city_battery_permit"
      : homeSignals?.territory_eia_id
        ? "state_rules_only"
        : null;
  const incomeAge = homeSignals?.block_group_geoid ? await getIncomeAge(homeSignals.block_group_geoid) : null;
  const permitSourceIds = home.permits.map((p) => p.source_id).filter((s): s is string => !!s);

  const [sourcesById, scoreContext, homePropensity, parcelGeojson, rulesHaveRun, texasOutagePercentile, permitPathStatsRow, permitRuleRow, coverageBucket, signalsCount, rankedHomeCount] = await Promise.all([
    getSourcesByIds(
      Array.from(
        new Set([
          ...(home.source_ids ?? []),
          ...permitSourceIds,
          ...(homeSignals?.source_ids ?? []),
          ...(retailMarket ? [retailMarket.source_id] : []),
          ...(incomeAge ? [incomeAge.source_id] : []),
        ])
      )
    ),
    getScoreContext(home.prop_id),
    // M4-W2 perf: replaces getTopHomeRank (api.top_homes_weighted, which
    // scores every gated Travis home on every call, ~1.6s on prod) with a
    // primary-key lookup on api.home_propensity for this one home.
    getHomePropensity(home.prop_id),
    getParcelGeojson(home.prop_id),
    classifierHasRun(),
    homeSignals?.outage_minutes !== null && homeSignals?.outage_minutes !== undefined && homeSignals?.outage_year
      ? getTexasOutagePercentile(Number(homeSignals.outage_minutes), homeSignals.outage_year)
      : Promise.resolve(null),
    permitPath === "city_battery_permit" ? getPermitPathStats() : Promise.resolve(null),
    getPermitRuleCitation(permitPath),
    getHomeCoverageBucket(home.prop_id),
    getSignalsCount(home.prop_id),
    getRankedHomeCount(home.county_fips ?? ""),
  ]);

  const permitPathStats: PermitPathStatsRow | null = permitPathStatsRow
    ? {
        medianDays: permitPathStatsRow.median_days === null ? null : Number(permitPathStatsRow.median_days),
        p90Days: permitPathStatsRow.p90_days === null ? null : Number(permitPathStatsRow.p90_days),
        shareNeverFinished:
          permitPathStatsRow.share_never_finished === null ? null : Number(permitPathStatsRow.share_never_finished),
        shareIssuedOnline:
          permitPathStatsRow.share_issued_online === null ? null : Number(permitPathStatsRow.share_issued_online),
        provenance: (() => {
          const src = permitPathStatsRow.source_id ? sourcesById.get(permitPathStatsRow.source_id) : undefined;
          if (!src) return null;
          return {
            dataset: src.source,
            url: src.url,
            retrievedAt: src.retrieved_at instanceof Date ? src.retrieved_at.toISOString() : String(src.retrieved_at),
            sha256: src.sha256,
            runId: src.latest_run_id ?? "none",
            runner: src.runner,
            rowsIn: src.latest_run_rows_in ?? null,
            rowsLoaded: src.latest_run_rows_loaded ?? null,
            rawFileHref: `/sources/raw/${src.source_id}`,
          };
        })(),
      }
    : null;

  const permitRuleCitation: PermitRulesCitation | null = permitRuleRow
    ? { quote: permitRuleRow.quote, sourceUrl: permitRuleRow.source_url }
    : null;

  const address = [home.situs_num, home.situs_street].filter(Boolean).join(" ");
  const cityZip = [home.situs_city, home.situs_zip].filter(Boolean).join(" ");
  const stateCode = home.imprv_state_cd ?? home.land_state_cd;
  const parcelSourceId = home.source_ids?.[0];

  // ---------------------------------------------------------------------
  // Redesign (Mock B): tab-shell computed values. Every fact below comes
  // from data already fetched above for the (unchanged) Signals/Permits/
  // Parcel & solar/Sources sections -- nothing new is invented for the
  // Summary tab.
  // ---------------------------------------------------------------------
  const H2 = {
    fontFamily: "var(--type-heading-font-family)",
    fontSize: "var(--type-heading-font-size)",
    fontWeight: "var(--type-heading-font-weight)",
    marginTop: 0,
  } as const;

  const hasOwnBackup = coverageBucket === "base_customer" || coverageBucket === "other_backup";
  const utilityStatus = utilityStatusForHome({
    gateReason: homeSignals?.gate_reason ?? null,
    territoryNullReason: homeSignals?.territory_null_reason ?? null,
  });
  const priorityTier = tierForDecile(homePropensity?.decile ?? null);
  // Real dataset names behind the signals CaseForKnock's sentence
  // templates actually use (backup_intent/installability/home_permits ->
  // Austin permits; home_value/parcel facts -> the county CAD; income_100k/
  // age_35_64 -> ACS; outage -> EIA-861) -- a fixed list of the datasets
  // this app's data model ties to those signals, not a per-home dynamic
  // lookup (a known simplification, not an invented source).
  const caseSourceNames = ["Austin permits", `${countyName} CAD`, "ACS 2024", "EIA-861"];

  const recentPermits = [...home.permits]
    .sort((a, b) => (b.issue_date ?? "").localeCompare(a.issue_date ?? ""))
    .slice(0, 3);

  const signalsTabContent =
    homeSignals && homeSignals.gate_reason === null ? (
      <Panel>
        <h2 style={H2}>How the score is built</h2>
        <ScoreExplainer propId={home.prop_id} weights={EQUAL_WEIGHTS} />
      </Panel>
    ) : (
      <Panel>
        <h2 style={H2}>How the score is built</h2>
        <MissingState
          variant="not-loaded"
          reason="This home isn't scored, so there is no signal breakdown to show"
        />
      </Panel>
    );

  const permitsTabContent = (
    <Panel>
      <h2 style={H2}>Permits on this parcel</h2>
      {home.permits.length === 0 ? (
        homeSignals?.backup_intent_null_reason === "no_permit_coverage" ? (
          <MissingState variant="not-available" reason="no_permit_coverage" />
        ) : (
          <p style={{ margin: 0, color: "var(--theme-ink-muted)" }}>No City of Austin permits on file for this home.</p>
        )
      ) : (
        <DataTable>
          <DataTableHead>
            <DataTableRow>
              <DataTableHeaderCell>Permit</DataTableHeaderCell>
              <DataTableHeaderCell>Issued</DataTableHeaderCell>
              <DataTableHeaderCell>Class</DataTableHeaderCell>
              <DataTableHeaderCell>Description</DataTableHeaderCell>
              <DataTableHeaderCell>Status</DataTableHeaderCell>
              <DataTableHeaderCell>Label</DataTableHeaderCell>
            </DataTableRow>
          </DataTableHead>
          <DataTableBody>
            {home.permits.map((permit) => (
              <DataTableRow key={permit.permit_number}>
                <DataTableCell>
                  <ProvenanceFor sourceRow={sourcesById.get(permit.source_id ?? "")} id={`permit-${permit.permit_number}`}>
                    <span style={{ fontFamily: "var(--type-data-font-family)" }}>{permit.permit_number}</span>
                  </ProvenanceFor>
                </DataTableCell>
                <DataTableCell>{permit.issue_date ?? <NotRecorded />}</DataTableCell>
                <DataTableCell>{permit.permit_class ?? permit.work_class ?? <NotRecorded />}</DataTableCell>
                <DataTableCell>{permit.description ?? <NotRecorded />}</DataTableCell>
                <DataTableCell>{permit.status_current ?? <NotRecorded />}</DataTableCell>
                <DataTableCell>
                  <PermitLabel label={permit.label} labeller={permit.labeller} classifierHasRun={rulesHaveRun} />
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      )}
    </Panel>
  );

  const parcelSolarTabContent = (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      <Panel>
        <h2 style={H2}>Parcel</h2>
        {parcelGeojson ? (
          <ParcelMap geojson={parcelGeojson} />
        ) : (
          <MissingState variant="not-loaded" reason="No lot outline on file for this parcel" />
        )}
        <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "var(--space-2) var(--space-4)", marginTop: "var(--space-3)" }}>
          <dt style={{ color: "var(--theme-ink-muted)" }}>Property type</dt>
          <dd style={{ margin: 0 }}>
            {stateCode === null ? (
              <MissingState variant="not-loaded" reason="No property type on this parcel record" />
            ) : (
              <ProvenanceFor sourceRow={sourcesById.get(parcelSourceId ?? "")} id={`${home.prop_id}-state-cd`}>
                <span>
                  {stateCode === "A1" ? "Single-family home" : stateCode}{" "}
                  <span style={{ fontFamily: "var(--type-data-font-family)", color: "var(--theme-ink-muted)" }}>({stateCode})</span>
                </span>
              </ProvenanceFor>
            )}
          </dd>

          <dt style={{ color: "var(--theme-ink-muted)" }}>Homestead</dt>
          <dd style={{ margin: 0 }}>{home.is_homestead ? "Yes" : "No"}</dd>

          <dt style={{ color: "var(--theme-ink-muted)" }}>Market value</dt>
          <dd style={{ margin: 0 }}>
            {home.market_value === null ? (
              <MissingState variant="not-loaded" reason="Market value not recorded for this parcel" />
            ) : (
              <ProvenanceFor sourceRow={sourcesById.get(parcelSourceId ?? "")} id={`${home.prop_id}-market-value`}>
                <span style={{ fontFamily: "var(--type-data-font-family)" }}>${Number(home.market_value).toLocaleString()}</span>
              </ProvenanceFor>
            )}
          </dd>
        </dl>
      </Panel>

      <SolarPanel propId={home.prop_id} />
    </div>
  );

  const sourcesTabContent = (
    <Panel>
      <h2 style={H2}>Sources behind this record</h2>
      {sourcesById.size === 0 ? (
        <MissingState variant="not-loaded" reason="No source manifest rows loaded for this home yet" />
      ) : (
        <DataTable>
          <DataTableHead>
            <DataTableRow>
              <DataTableHeaderCell>Dataset</DataTableHeaderCell>
              <DataTableHeaderCell>Retrieved</DataTableHeaderCell>
              <DataTableHeaderCell>SHA-256</DataTableHeaderCell>
              <DataTableHeaderCell>Raw file</DataTableHeaderCell>
            </DataTableRow>
          </DataTableHead>
          <DataTableBody>
            {Array.from(sourcesById.values()).map((src) => (
              <DataTableRow key={src.source_id}>
                <DataTableCell>
                  {src.url ? (
                    <a href={src.url} target="_blank" rel="noreferrer">
                      {src.source}
                    </a>
                  ) : (
                    src.source
                  )}
                </DataTableCell>
                <DataTableCell style={{ fontFamily: "var(--type-data-font-family)" }}>
                  {src.retrieved_at instanceof Date ? src.retrieved_at.toISOString().slice(0, 10) : String(src.retrieved_at).slice(0, 10)}
                </DataTableCell>
                <DataTableCell style={{ fontFamily: "var(--type-data-font-family)" }}>{src.sha256.slice(0, 12)}…</DataTableCell>
                <DataTableCell>
                  <a href={`/sources/raw/${src.source_id}`}>View raw file</a>
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      )}
    </Panel>
  );

  const summaryTabContent = (
    <div className="home-summary">
      <div>
        <h2 style={{ ...H2, fontSize: "20px" }}>The case for a knock.</h2>
        {homeSignals && homeSignals.gate_reason === null ? (
          <CaseForKnock
            propId={home.prop_id}
            weights={EQUAL_WEIGHTS}
            sourceNames={caseSourceNames}
            maxMeters={6}
            includeMissingMeter
          />
        ) : (
          <MissingState
            variant="not-loaded"
            reason={
              homeSignals === null
                ? `Not scored: only owner-occupied single-family homes with a mapped lot inside ${countyName} County are ranked`
                : (GATE_REASON_LABEL[homeSignals.gate_reason ?? ""] ?? "Excluded from ranking")
            }
          />
        )}

        <div className="home-summary__facts">
          <div>
            {home.market_value === null ? (
              <MissingState variant="not-loaded" reason="Market value not recorded for this parcel" />
            ) : (
              <ProvenanceFor sourceRow={sourcesById.get(parcelSourceId ?? "")} id={`${home.prop_id}-summary-market-value`}>
                <span style={{ fontFamily: "var(--type-data-font-family)" }}>${Number(home.market_value).toLocaleString()}</span>
              </ProvenanceFor>
            )}
            <small>Appraisal, {CAD_NAME[home.county_fips ?? ""] ?? `${countyName} CAD`}</small>
          </div>
          <div>
            {homeSignals?.yr_built == null ? (
              <MissingState variant="not-loaded" reason={homeSignals?.yr_built_null_reason ?? "Build year not available"} />
            ) : (
              <span style={{ fontFamily: "var(--type-data-font-family)" }}>{homeSignals.yr_built}</span>
            )}
            <small>Built</small>
          </div>
          <div>
            {hasOwnBackup ? (
              <span>
                Yes{homeSignals?.battery_permit_date ? ` (${String(homeSignals.battery_permit_date).slice(0, 10)})` : ""}
              </span>
            ) : (
              <span>None on file</span>
            )}
            <small>Existing backup permit</small>
          </div>
          <div>
            {homeSignals?.flood_flag === null || homeSignals?.flood_flag === undefined ? (
              <MissingState variant="not-loaded" reason={homeSignals?.flood_null_reason ?? "Flood zones not loaded"} />
            ) : (
              <span>{homeSignals.flood_flag ? "Inside FEMA high-risk" : "Outside FEMA high-risk"}</span>
            )}
            <small>Flood zone</small>
          </div>
          <div>
            {permitPath === "city_battery_permit" && permitPathStats?.medianDays != null ? (
              <span style={{ fontFamily: "var(--type-data-font-family)" }}>City of Austin · ~{Math.round(permitPathStats.medianDays)} days</span>
            ) : permitPath === "state_rules_only" ? (
              <span>State rules only</span>
            ) : (
              <MissingState variant="not-loaded" reason="Permit path not resolvable yet" />
            )}
            <small>Permit path, typical</small>
          </div>
          <div>
            <GridValue
              idSuffix={`${home.prop_id}-summary`}
              baseCapture={gridValue.baseCapture}
              baseCaptureNullReason={gridValue.baseCaptureNullReason}
              loadZone={gridValue.loadZone}
              avgDailySpreadUsdMwh={gridValue.avgDailySpreadUsdMwh}
              scarcityDays={gridValue.scarcityDays}
              scarcityThresholdUsdMwh={gridValue.scarcityThresholdUsdMwh}
              windowStart={gridValue.windowStart}
              windowEnd={gridValue.windowEnd}
              gridValueNullReason={gridValue.gridValueNullReason}
              source={
                gridValue.source
                  ? {
                      dataset: gridValue.source.source,
                      url: gridValue.source.url,
                      retrievedAt:
                        gridValue.source.retrieved_at instanceof Date
                          ? gridValue.source.retrieved_at.toISOString()
                          : String(gridValue.source.retrieved_at),
                      sha256: gridValue.source.sha256,
                      runId: gridValue.source.latest_run_id ?? "none",
                      runner: gridValue.source.runner,
                      rowsIn: gridValue.source.latest_run_rows_in,
                      rowsLoaded: gridValue.source.latest_run_rows_loaded,
                      rawFileHref: `/sources/raw/${gridValue.source.source_id}`,
                    }
                  : null
              }
            />
            <small>Grid value to Base</small>
          </div>
        </div>

        <div style={{ marginTop: "var(--space-2)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontWeight: 600, fontSize: "var(--type-body-font-size)" }}>Permits on this parcel</span>
            <JumpToTab tab="permits">All {home.permits.length} permits →</JumpToTab>
          </div>
          {recentPermits.length === 0 ? (
            <p style={{ margin: "var(--space-2) 0 0 0", color: "var(--theme-ink-muted)", fontSize: "var(--type-label-font-size)" }}>
              No permits on file for this home.
            </p>
          ) : (
            <div style={{ marginTop: "var(--space-2)" }}>
              {recentPermits.map((permit) => (
                <div key={permit.permit_number} className="permit-preview-row">
                  <div style={{ fontFamily: "var(--type-data-font-family)" }}>{permit.permit_number}</div>
                  <div>{permit.issue_date ?? "—"}</div>
                  <div>{permit.description ?? "—"}</div>
                  <div style={{ color: "var(--theme-ink-muted)" }}>{permit.label ?? "no label"}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        <div className="priority-card">
          <div className="priority-card__kicker">Priority</div>
          <div className="priority-card__big">{priorityTier.label}</div>
          <div className="priority-card__sub">{priorityCardSentence(priorityTier.key, rankedHomeCount, countyName)}</div>
          <Link href="/sources#how-leads-are-prioritized" className="priority-card__link">
            How the ranking works →
          </Link>
        </div>

        <div className="knock-checklist">
          <h3>Before you knock</h3>
          <div className="knock-checklist__item">
            <span className={"knock-checklist__icon" + (utilityStatus.key === "served" ? " knock-checklist__icon--ok" : "")}>
              {utilityStatus.key === "served" ? "✓" : "1"}
            </span>
            <div>
              {utilityStatus.label}
              <small>{utilityStatus.action}</small>
            </div>
          </div>
          <div className="knock-checklist__item">
            <span className={"knock-checklist__icon" + (!hasOwnBackup ? " knock-checklist__icon--ok" : "")}>
              {!hasOwnBackup ? "✓" : "!"}
            </span>
            <div>
              {hasOwnBackup ? "Already has backup" : "No backup on file"}
              <small>
                {hasOwnBackup
                  ? "Say so and move on."
                  : "No battery or generator permit at this address — worth a knock."}
              </small>
            </div>
          </div>
          <div className="knock-checklist__item">
            <span className="knock-checklist__icon">3</span>
            <div>
              Plan the permit
              <small>
                {permitPath === "city_battery_permit" && permitPathStats?.medianDays != null
                  ? `City of Austin battery permit: typically ~${Math.round(permitPathStats.medianDays)} days${
                      permitPathStats.p90Days != null ? `, slowest 10% take ${Math.round(permitPathStats.p90Days)}+ days` : ""
                    }${
                      permitPathStats.shareNeverFinished != null
                        ? `, ${(permitPathStats.shareNeverFinished * 100).toFixed(1)}% never finish`
                        : ""
                    }.`
                  : permitPath === "state_rules_only"
                    ? "State rules only — no city permit path on file."
                    : "Permit path not resolvable yet."}
              </small>
            </div>
          </div>
          <div className="knock-checklist__item">
            <span className="knock-checklist__icon">4</span>
            <div>
              Confirm the address on site
              <small>
                {utilityStatus.key === "served"
                  ? "Parcel matched to a Base-served utility; service address not yet verified."
                  : "Utility service not yet confirmed at this address."}
              </small>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ display: "grid", gap: "var(--space-2)" }}>
      <nav aria-label="Breadcrumb" className="breadcrumb">
        {/* T4 fix: a home's OWN county (home.county_fips), not whatever
            county happened to be selected on the page that linked here --
            a Williamson home must send "Back to lead list" back to
            Williamson, never silently to Travis. */}
        <Link href={home.county_fips ? `/ranking?county=${home.county_fips}` : "/ranking"}>{countyName} lead list</Link>
        <span className="breadcrumb__separator" aria-hidden="true">
          /
        </span>
        <span>{address || home.prop_id}</span>
      </nav>

      <Panel style={{ padding: "var(--space-2) var(--space-4)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--space-6)" }}>
          <div>
            <h1
              style={{
                fontFamily: "var(--type-title-font-family)",
                fontSize: "var(--type-title-font-size)",
                fontWeight: "var(--type-title-font-weight)",
                margin: 0,
              }}
            >
              {address || home.prop_id}
            </h1>
            {cityZip ? <p style={{ color: "var(--theme-ink-muted)", margin: "var(--space-1) 0" }}>{cityZip}</p> : null}
            <div style={{ fontFamily: "var(--type-data-font-family)", fontSize: "var(--type-data-font-size)", color: "var(--theme-ink-muted)" }}>
              {CAD_NAME[home.county_fips ?? ""] ?? `${countyName} CAD`} property {home.prop_id}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "var(--space-1)", textAlign: "right" }}>
            {homePropensity ? null : (
              <a
                href={home.county_fips ? `/ranking?county=${home.county_fips}` : "/ranking"}
                style={{ fontSize: "var(--type-label-font-size)", maxWidth: "220px" }}
              >
                See {countyName}&rsquo;s lead list
              </a>
            )}
          </div>
        </div>

        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginTop: "var(--space-2)" }}>
          {home.is_single_family ? <span className="chip">Single-family home</span> : null}
          {home.is_homestead ? <span className="chip">Owner-occupied (homestead)</span> : null}
        </div>
      </Panel>

      <Suspense fallback={null}>
        <HomeTabs
          signalsCount={signalsCount}
          permitsCount={home.permits.length}
          sourcesCount={sourcesById.size}
          summary={summaryTabContent}
          signals={signalsTabContent}
          permits={permitsTabContent}
          parcelSolar={parcelSolarTabContent}
          sources={sourcesTabContent}
        />
      </Suspense>
    </div>
  );
}
