import type { ReactNode } from "react";
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
import { PermitPath, type PermitPathKind, type PermitPathStatsRow, type PermitRulesCitation } from "../../../components/PermitPath";
import { GridValue } from "../../../components/GridValue";
import { COUNTY_CANDIDATES } from "../../../lib/counties";

// M3-W1: which appraisal district this home's parcel roll comes from,
// per county (Travis CAD / Harris CAD (HCAD) / Williamson CAD (WCAD)) --
// never a hardcoded "Travis CAD" regardless of which county the parcel
// actually sits in.
const CAD_NAME: Record<string, string> = {
  "48453": "Travis CAD",
  "48201": "Harris CAD (HCAD)",
  "48491": "Williamson CAD (WCAD)",
};
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
  reasons: PropensityReason[];
  extrapolated_from: string | null;
}

async function getHomePropensity(propId: string): Promise<HomePropensityDbRow | null> {
  try {
    const rows = await query<HomePropensityDbRow>(
      `select p_install_12m, relative_to_county, reasons, extrapolated_from
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

  const [sourcesById, scoreContext, homePropensity, parcelGeojson, rulesHaveRun, texasOutagePercentile, permitPathStatsRow, permitRuleRow] = await Promise.all([
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

  return (
    <div style={{ display: "grid", gap: "var(--space-6)" }}>
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link href="/ranking">Ranking</Link>
        <span className="breadcrumb__separator" aria-hidden="true">
          /
        </span>
        <span>{address || home.prop_id}</span>
      </nav>

      <Panel>
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
              <a href="/ranking" style={{ fontSize: "var(--type-label-font-size)", maxWidth: "220px" }}>
                See where it ranks
              </a>
            )}
          </div>
        </div>

        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginTop: "var(--space-4)" }}>
          {home.is_single_family ? <span className="chip">Single-family home</span> : null}
          {home.is_homestead ? <span className="chip">Owner-occupied (homestead)</span> : null}
        </div>
      </Panel>

      <Panel>
        <h2
          style={{
            fontFamily: "var(--type-heading-font-family)",
            fontSize: "var(--type-heading-font-size)",
            fontWeight: "var(--type-heading-font-weight)",
            marginTop: 0,
          }}
        >
          Likelihood of adding backup in the next 12 months
        </h2>
        {homePropensity === null ? (
          <MissingState
            variant="not-loaded"
            reason={`Not scored: only owner-occupied single-family homes with a mapped lot inside ${countyName} County are scored`}
          />
        ) : (
          <PropensityBadge
            pInstall12m={Number(homePropensity.p_install_12m)}
            relativeToCounty={homePropensity.relative_to_county === null ? null : Number(homePropensity.relative_to_county)}
            countyName={countyName}
            extrapolatedFrom={homePropensity.extrapolated_from}
            reasons={homePropensity.reasons}
            showReasons
          />
        )}
      </Panel>

      <Panel>
        <h2
          style={{
            fontFamily: "var(--type-heading-font-family)",
            fontSize: "var(--type-heading-font-size)",
            fontWeight: "var(--type-heading-font-weight)",
            marginTop: 0,
          }}
        >
          Why this home
        </h2>

        {homeSignals === null ? (
          <MissingState
            variant="not-loaded"
            reason={`Not scored: only owner-occupied single-family homes with a mapped lot inside ${countyName} County are ranked`}
          />
        ) : homeSignals.gate_reason ? (
          <div
            style={{
              backgroundColor: "var(--color-excluded-fill)",
              color: "var(--theme-ink)",
              borderRadius: "var(--rounded-sm)",
              padding: "var(--space-3)",
              marginBottom: "var(--space-4)",
            }}
          >
            <strong>Excluded from ranking:</strong>{" "}
            {GATE_REASON_LABEL[homeSignals.gate_reason] ?? homeSignals.gate_reason}
          </div>
        ) : homeSignals.territory_null_reason === "utility_not_confirmed" ? (
          // M-utility-gate copy fix: Williamson's every HIFLD territory
          // polygon overlaps, so which utility actually serves this home
          // can't be resolved from the polygon alone. The raw code is
          // passed straight through -- MissingState's own REASON_TEXT map
          // (components/ui/MissingState.tsx) is the one place every
          // null_reason code becomes plain text, per CLAUDE.md's "Added
          // after M2-W3" rule -- never a second hardcoded copy of it here.
          <div style={{ marginBottom: "var(--space-4)" }}>
            <MissingState variant="not-loaded" reason={homeSignals.territory_null_reason} />
          </div>
        ) : homeSignals.territory_null_reason ? (
          <div style={{ marginBottom: "var(--space-4)" }}>
            <MissingState
              variant="not-loaded"
              reason={`Whether Base serves this home's utility isn't resolvable yet (${homeSignals.territory_null_reason}) — it passes by default until it is`}
            />
          </div>
        ) : homeSignals.territory_basis === "most_likely_county_utility" && homeSignals.distributor_name ? (
          // Harris: territory is pinned to the one Base-served utility
          // that actually covers the county (every HIFLD polygon
          // overlaps there too), so this is a strong inference, not a
          // confirmed per-parcel match -- said plainly rather than shown
          // with the same confidence as Travis's polygon match.
          <div style={{ marginBottom: "var(--space-4)", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
            Most likely utility: {homeSignals.distributor_name} — confirm at the address.
          </div>
        ) : null}

        {homeSignals ? (
          <dl style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: "var(--space-4) var(--space-6)", margin: 0 }}>
            <div>
              <dt style={{ color: "var(--theme-ink-muted)", fontSize: "var(--type-label-font-size)" }}>Outage exposure</dt>
              <dd style={{ margin: "var(--space-1) 0 0 0" }}>
                {homeSignals.outage_minutes === null ? (
                  distributorSaidiRealNullReason ? (
                    // A real EIA-861 distributor is matched (e.g. Oncor
                    // 44372) but EIA itself reports no figure for it, and
                    // this county has no EAGLE-I proxy either yet —
                    // "not available", not "not loaded": the pipeline has
                    // run and this is EIA's own stated reason (e.g.
                    // "not_reported"), never a made-up one.
                    <MissingState variant="not-available" reason={distributorSaidiRealNullReason} />
                  ) : (
                    <MissingState
                      variant="not-loaded"
                      reason={homeSignals.outage_null_reason ?? "No outage figure for this home yet"}
                    />
                  )
                ) : (
                  <>
                    <ProvenanceFor
                      sourceRow={findSourceByName(
                        sourcesById,
                        homeSignals.outage_source_ids ?? homeSignals.source_ids,
                        homeSignals.outage_basis === "county_eaglei_proxy"
                          ? ["eaglei", "eagle-i", "outage"]
                          : ["eia861", "eia-861", "reliability"]
                      )}
                      id={`${home.prop_id}-outage`}
                    >
                      <span>
                        {homeSignals.outage_basis === "county_eaglei_proxy" ? (
                          <>
                            {countyName} County averaged{" "}
                            <span style={{ fontFamily: "var(--type-data-font-family)", fontWeight: 600 }}>
                              {Number(homeSignals.outage_minutes).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                            </span>{" "}
                            minutes without power per customer in {homeSignals.outage_year} (EAGLE-I county proxy, used
                            because {homeSignals.distributor_name ?? "this home's utility"} doesn&rsquo;t report to EIA)
                          </>
                        ) : (
                          <>
                            {homeSignals.distributor_name ?? "This distributor"}'s customers averaged{" "}
                            <span style={{ fontFamily: "var(--type-data-font-family)", fontWeight: 600 }}>
                              {Number(homeSignals.outage_minutes).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                            </span>{" "}
                            minutes without power in {homeSignals.outage_year} (SAIDI, incl. major events)
                          </>
                        )}
                      </span>
                    </ProvenanceFor>
                    {homeSignals.distributor_saidi_early_release ? (
                      <div style={{ fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
                        Early release, not fully edited (EIA-861)
                      </div>
                    ) : null}
                    {texasOutagePercentile !== null ? (
                      <div style={{ fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
                        Fewer outage minutes than{" "}
                        <span style={{ fontFamily: "var(--type-data-font-family)" }}>{texasOutagePercentile}%</span> of
                        Texas utilities reporting to EIA-861 in {homeSignals.outage_year}
                      </div>
                    ) : null}
                  </>
                )}
              </dd>
            </div>

            <div>
              <dt style={{ color: "var(--theme-ink-muted)", fontSize: "var(--type-label-font-size)" }}>Electricity market</dt>
              <dd style={{ margin: "var(--space-1) 0 0 0" }}>
                {homeSignals.territory_eia_id === null ? (
                  <MissingState
                    variant="not-loaded"
                    reason="No utility territory match for this home yet — the electricity market can't be shown without one"
                  />
                ) : retailMarket === null ? (
                  <MissingState
                    variant="not-available"
                    reason="This home's utility isn't in Base's cited retail-market list yet"
                  />
                ) : (
                  (() => {
                    const marketManifest = sourcesById.get(retailMarket.source_id);
                    // Reuses the existing ProvenancePopover as-is (DESIGN.md:
                    // reuse tokens/base components, never invent new ones) —
                    // its "Dataset" row is repurposed to carry Base's own
                    // verbatim quote as the link text, hrefed to Base's
                    // source page (retailMarket.source_url), while
                    // retrieved/SHA-256/run/raw-file still describe the
                    // loaded data/manual/retail_market.csv snapshot.
                    if (!marketManifest) return <span>{retailMarket.plain_language}</span>;
                    return (
                      <ProvenancePopover
                        id={`${home.prop_id}-retail-market`}
                        dataset={`"${retailMarket.quote}"`}
                        url={retailMarket.source_url}
                        retrievedAt={
                          marketManifest.retrieved_at instanceof Date
                            ? marketManifest.retrieved_at.toISOString()
                            : String(marketManifest.retrieved_at)
                        }
                        sha256={marketManifest.sha256}
                        runId={marketManifest.latest_run_id ?? "none"}
                        runner={marketManifest.runner}
                        rowsIn={marketManifest.latest_run_rows_in ?? null}
                        rowsLoaded={marketManifest.latest_run_rows_loaded ?? null}
                        rawFileHref={`/sources/raw/${marketManifest.source_id}`}
                      >
                        <span>{retailMarket.plain_language}</span>
                      </ProvenancePopover>
                    );
                  })()
                )}
              </dd>
            </div>

            <div>
              <dt style={{ color: "var(--theme-ink-muted)", fontSize: "var(--type-label-font-size)" }}>Grid value to Base</dt>
              <dd style={{ margin: "var(--space-1) 0 0 0" }}>
                <GridValue
                  idSuffix={home.prop_id}
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
              </dd>
            </div>

            <div>
              <dt style={{ color: "var(--theme-ink-muted)", fontSize: "var(--type-label-font-size)" }}>Flood zone</dt>
              <dd style={{ margin: "var(--space-1) 0 0 0" }}>
                {homeSignals.flood_flag === null ? (
                  <MissingState variant="not-loaded" reason={homeSignals.flood_null_reason ?? "Flood zones not loaded"} />
                ) : (
                  <ProvenanceFor
                    sourceRow={findSourceByName(sourcesById, homeSignals.source_ids, ["nfhl", "flood"])}
                    id={`${home.prop_id}-flood`}
                  >
                    <span>{homeSignals.flood_flag ? "Inside a FEMA high-risk flood zone" : "Outside FEMA high-risk flood zones"}</span>
                  </ProvenanceFor>
                )}
              </dd>
            </div>

            <div>
              <dt style={{ color: "var(--theme-ink-muted)", fontSize: "var(--type-label-font-size)" }}>Medical need (emPOWER)</dt>
              <dd style={{ margin: "var(--space-1) 0 0 0" }}>
                {homeSignals.empower_rate === null ? (
                  <MissingState
                    variant={homeSignals.empower_null_reason === "suppressed_1_to_10" ? "not-available" : "not-loaded"}
                    reason={homeSignals.empower_null_reason ?? "No emPOWER figure"}
                  />
                ) : (
                  <ProvenanceFor
                    sourceRow={findSourceByName(sourcesById, homeSignals.source_ids, ["empower"])}
                    id={`${home.prop_id}-empower`}
                  >
                    <span>
                      <span style={{ fontFamily: "var(--type-data-font-family)", fontWeight: 600 }}>
                        {(Number(homeSignals.empower_rate) * 1000).toFixed(1)}
                      </span>{" "}
                      power-dependent Medicare devices per 1,000 Medicare beneficiaries in this ZIP
                    </span>
                  </ProvenanceFor>
                )}
              </dd>
            </div>

            <div>
              <dt style={{ color: "var(--theme-ink-muted)", fontSize: "var(--type-label-font-size)" }}>Age 65+ (ACS)</dt>
              <dd style={{ margin: "var(--space-1) 0 0 0" }}>
                {homeSignals.acs_pct_65_plus === null ? (
                  <MissingState variant="not-loaded" reason={homeSignals.acs_65_null_reason ?? "No ACS figure"} />
                ) : (
                  <ProvenanceFor
                    sourceRow={findSourceByName(sourcesById, homeSignals.source_ids, ["acs", "census"])}
                    id={`${home.prop_id}-age65`}
                  >
                    <span>
                      <span style={{ fontFamily: "var(--type-data-font-family)", fontWeight: 600 }}>
                        {(Number(homeSignals.acs_pct_65_plus) * 100).toFixed(1)}%
                      </span>{" "}
                      of this block group's population is 65+ (ACS 2024, same for all homes in block group)
                    </span>
                  </ProvenanceFor>
                )}
              </dd>
            </div>

            <div>
              <dt style={{ color: "var(--theme-ink-muted)", fontSize: "var(--type-label-font-size)" }}>Electric heat (ACS)</dt>
              <dd style={{ margin: "var(--space-1) 0 0 0" }}>
                {homeSignals.acs_pct_electric_heat === null ? (
                  <MissingState variant="not-loaded" reason={homeSignals.acs_heat_null_reason ?? "No ACS figure"} />
                ) : (
                  <ProvenanceFor
                    sourceRow={findSourceByName(sourcesById, homeSignals.source_ids, ["acs", "census"])}
                    id={`${home.prop_id}-heat`}
                  >
                    <span>
                      <span style={{ fontFamily: "var(--type-data-font-family)", fontWeight: 600 }}>
                        {(Number(homeSignals.acs_pct_electric_heat) * 100).toFixed(1)}%
                      </span>{" "}
                      of housing units in this block group heat with electricity (ACS 2024, same for all homes in block group)
                    </span>
                  </ProvenanceFor>
                )}
              </dd>
            </div>

            <div>
              <dt style={{ color: "var(--theme-ink-muted)", fontSize: "var(--type-label-font-size)" }}>Permit path</dt>
              <dd style={{ margin: "var(--space-1) 0 0 0" }}>
                <PermitPath
                  propId={home.prop_id}
                  permitPath={permitPath}
                  stats={permitPathStats}
                  ruleCitation={permitRuleCitation}
                />
              </dd>
            </div>

            <div>
              <dt style={{ color: "var(--theme-ink-muted)", fontSize: "var(--type-label-font-size)" }}>Household income $100k+ (ACS, neighborhood figure)</dt>
              <dd style={{ margin: "var(--space-1) 0 0 0" }}>
                {incomeAge === null || incomeAge.income_100k_share === null ? (
                  <MissingState
                    variant="not-loaded"
                    reason={incomeAge?.income_100k_share_null_reason ?? "No ACS income figure"}
                  />
                ) : (
                  <ProvenanceFor sourceRow={sourcesById.get(incomeAge.source_id)} id={`${home.prop_id}-income100k`}>
                    <span>
                      <span style={{ fontFamily: "var(--type-data-font-family)", fontWeight: 600 }}>
                        {(Number(incomeAge.income_100k_share) * 100).toFixed(1)}%
                      </span>{" "}
                      of this block group&rsquo;s households earn $100k+ (ACS 2024 5-year, same for every home in the block group)
                    </span>
                  </ProvenanceFor>
                )}
              </dd>
            </div>

            <div>
              <dt style={{ color: "var(--theme-ink-muted)", fontSize: "var(--type-label-font-size)" }}>Prime working age 35-64 (ACS, neighborhood figure)</dt>
              <dd style={{ margin: "var(--space-1) 0 0 0" }}>
                {incomeAge === null || incomeAge.age_35_64_share === null ? (
                  <MissingState
                    variant="not-loaded"
                    reason={incomeAge?.age_35_64_share_null_reason ?? "No ACS age figure"}
                  />
                ) : (
                  <ProvenanceFor sourceRow={sourcesById.get(incomeAge.source_id)} id={`${home.prop_id}-age3564`}>
                    <span>
                      <span style={{ fontFamily: "var(--type-data-font-family)", fontWeight: 600 }}>
                        {(Number(incomeAge.age_35_64_share) * 100).toFixed(1)}%
                      </span>{" "}
                      of this block group&rsquo;s population is aged 35-64 (ACS 2024 5-year, same for every home in the block group)
                    </span>
                  </ProvenanceFor>
                )}
              </dd>
            </div>

            <div>
              <dt style={{ color: "var(--theme-ink-muted)", fontSize: "var(--type-label-font-size)" }}>Backup intent</dt>
              <dd style={{ margin: "var(--space-1) 0 0 0" }}>
                {homeSignals.backup_intent_rate === null ? (
                  <MissingState
                    variant="not-loaded"
                    reason={homeSignals.backup_intent_null_reason ?? "Rate not computed for this block group"}
                  />
                ) : (
                  <span>
                    <span style={{ fontFamily: "var(--type-data-font-family)", fontWeight: 600 }}>
                      {Number(homeSignals.backup_intent_rate).toFixed(2)}
                    </span>{" "}
                    battery or generator permits per 1,000 owner-occupied homes in this neighborhood (36 months, same for all homes in block group)
                  </span>
                )}
              </dd>
            </div>

            <div>
              <dt style={{ color: "var(--theme-ink-muted)", fontSize: "var(--type-label-font-size)" }}>Homeowner 65+</dt>
              <dd style={{ margin: "var(--space-1) 0 0 0" }}>
                {homeSignals.owner_65 === null ? (
                  <MissingState variant="not-loaded" reason={homeSignals.owner_65_null_reason ?? "Not loaded"} />
                ) : (
                  <span>{homeSignals.owner_65 ? "Yes — has the TCAD over-65 homestead exemption" : "No"}</span>
                )}
              </dd>
            </div>

            <div>
              <dt style={{ color: "var(--theme-ink-muted)", fontSize: "var(--type-label-font-size)" }}>This home&rsquo;s own permits</dt>
              <dd style={{ margin: "var(--space-1) 0 0 0" }}>
                {homeSignals.permit_null_reason ? (
                  <MissingState variant="not-available" reason={homeSignals.permit_null_reason} />
                ) : homeSignals.home_battery ? (
                  <span>
                    Already has a home battery
                    {homeSignals.battery_permit_date ? ` (permit ${String(homeSignals.battery_permit_date).slice(0, 10)})` : ""}
                  </span>
                ) : (
                  (() => {
                    const facts = [
                      homeSignals.home_solar ? "solar" : null,
                      homeSignals.home_ev ? "an EV charger" : null,
                      homeSignals.home_generator ? "a generator" : null,
                      homeSignals.home_panel_upgrade ? "a panel upgrade" : null,
                    ].filter((s): s is string => s !== null);
                    return facts.length > 0 ? (
                      <span>Own permit on file for {facts.join(", ")}</span>
                    ) : (
                      <span style={{ color: "var(--theme-ink-muted)" }}>No solar, EV, generator, or panel permit on file for this home</span>
                    );
                  })()
                )}
              </dd>
            </div>

            <div>
              <dt style={{ color: "var(--theme-ink-muted)", fontSize: "var(--type-label-font-size)" }}>Built</dt>
              <dd style={{ margin: "var(--space-1) 0 0 0" }}>
                {homeSignals.yr_built === null ? (
                  <MissingState variant="not-loaded" reason={homeSignals.yr_built_null_reason ?? "Year built not loaded"} />
                ) : (
                  <>
                    <span>Built {homeSignals.yr_built}</span>
                    {homeSignals.yr_built < 2000 && !homeSignals.home_panel_upgrade ? (
                      <div style={{ fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)", marginTop: "var(--space-1)" }}>
                        Older home:{" "}
                        <a href={BASE_PANEL_ARTICLE_URL} target="_blank" rel="noreferrer">
                          Base needs a 150–200A main breaker in Austin
                        </a>
                        ; check the panel.
                      </div>
                    ) : null}
                  </>
                )}
              </dd>
            </div>
          </dl>
        ) : null}
      </Panel>

      {homeSignals && homeSignals.gate_reason === null ? (
        <Panel>
          <h2
            style={{
              fontFamily: "var(--type-heading-font-family)",
              fontSize: "var(--type-heading-font-size)",
              fontWeight: "var(--type-heading-font-weight)",
              marginTop: 0,
            }}
          >
            How the score is built
          </h2>
          <ScoreExplainer propId={home.prop_id} weights={EQUAL_WEIGHTS} />
        </Panel>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: "var(--space-6)", alignItems: "start" }}>
        <Panel>
          <h2
            style={{
              fontFamily: "var(--type-heading-font-family)",
              fontSize: "var(--type-heading-font-size)",
              fontWeight: "var(--type-heading-font-weight)",
              marginTop: 0,
            }}
          >
            Permits on this parcel
          </h2>
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
                      <ProvenanceFor
                        sourceRow={sourcesById.get(permit.source_id ?? "")}
                        id={`permit-${permit.permit_number}`}
                      >
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

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
          <Panel>
            <h2
              style={{
                fontFamily: "var(--type-heading-font-family)",
                fontSize: "var(--type-heading-font-size)",
                fontWeight: "var(--type-heading-font-weight)",
                marginTop: 0,
              }}
            >
              Parcel
            </h2>
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
                    <span>{stateCode === "A1" ? "Single-family home" : stateCode} <span style={{ fontFamily: "var(--type-data-font-family)", color: "var(--theme-ink-muted)" }}>({stateCode})</span></span>
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
                    <span style={{ fontFamily: "var(--type-data-font-family)" }}>
                      ${Number(home.market_value).toLocaleString()}
                    </span>
                  </ProvenanceFor>
                )}
              </dd>
            </dl>
          </Panel>

          <SolarPanel propId={home.prop_id} />
        </div>
      </div>
    </div>
  );
}
