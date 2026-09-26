import { query } from "../../lib/db";
import { RankingBoard } from "./RankingBoard";
import { QualityPanel, type QualityPanelData, type ClassifierPrecisionRow } from "../../components/QualityPanel";
import { EligibilityFunnel, type FunnelStep } from "../../components/EligibilityFunnel";
import type { TopHomeRow } from "../../components/TopHomesTable";

// M1-W1: MapLibre choropleth of Travis block groups (api.blockgroup_scores,
// via the app/ranking/blockgroups route handler) + top-50 table
// (api.top_homes) + Quality panel (api.join_rate, api.classifier_precision,
// api.parcel_gate_counts). force-dynamic: parcels/permits/geometry
// pipelines may be loading concurrently, so every request must reflect
// the live view state, never a build-time snapshot.

export const dynamic = "force-dynamic";

interface TopHomesRowDb {
  prop_id: string;
  situs_num: string | null;
  situs_street: string | null;
  situs_city: string | null;
  situs_zip: string | null;
  market_value: string | number | null;
  block_group_geoid: string;
  score: string | number | null;
  rate_per_1000: string | number | null;
  reasons: string[];
}

interface JoinRateRow {
  permits_with_tcad_id: string | number;
  matched_to_parcels: string | number;
  join_rate: string | number | null;
  join_rate_null_reason: string | null;
}

interface ClassifierPrecisionRowDb {
  label: string;
  claude_labelled_count: string | number | null;
  true_positive_count: string | number | null;
  precision: string | number | null;
  precision_null_reason: string | null;
}

interface ParcelGateCountsRow {
  total_parcels: string | number;
  single_family_count: string | number;
  not_single_family_count: string | number;
  homestead_count: string | number;
  not_homestead_count: string | number;
}

function toNumberOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

interface FunnelCountsRow {
  total_parcels: string | number;
  single_family_count: string | number;
  single_family_homestead_count: string | number;
  gated_with_geometry_count: string | number;
}

async function getFunnelSteps(): Promise<FunnelStep[]> {
  // Real intersection counts (single-family AND homestead AND has parcel
  // geometry) — api.parcel_gate_counts reports single-family and
  // homestead as independent gates over all parcels, which would be
  // dishonest to draw as one narrowing funnel (M1-W3 fix: funnel honesty).
  // One pass over core.parcels with FILTER (not three separate COUNT(*)
  // subqueries, each its own full scan) for the first three steps; the
  // last step reads core.mv_home_block_group (perf(M1) materialization),
  // never a live ST_Within join — that join is exactly what used to make
  // /ranking time out before it was materialized.
  const [countsRows, gatedRows] = await Promise.all([
    query<FunnelCountsRow>(
      `select
         count(*) as total_parcels,
         count(*) filter (
           where imprv_state_cd like 'A1%' or land_state_cd like 'A1%'
         ) as single_family_count,
         count(*) filter (
           where (imprv_state_cd like 'A1%' or land_state_cd like 'A1%') and hs_exempt = 'T'
         ) as single_family_homestead_count
       from core.parcels`
    ),
    query<{ n: string | number }>(`select count(*) as n from core.mv_home_block_group`),
  ]);
  if (countsRows.length === 0) return [];
  const row = { ...countsRows[0], gated_with_geometry_count: gatedRows[0]?.n ?? 0 };
  const total = Number(row.total_parcels);
  if (total === 0) return [];

  const values = [
    { label: "Residential parcels (TCAD, Travis)", value: Number(row.total_parcels) },
    { label: "Single-family (state code A1)", value: Number(row.single_family_count) },
    { label: "Single-family + homestead", value: Number(row.single_family_homestead_count) },
    { label: "Gated with parcel geometry (scoreable)", value: Number(row.gated_with_geometry_count) },
  ];
  return values.map((v) => ({ ...v, ratio: v.value / total }));
}

async function getTopHomes(): Promise<TopHomeRow[]> {
  const rows = await query<TopHomesRowDb>(
    `select prop_id, situs_num, situs_street, situs_city, situs_zip, market_value,
            block_group_geoid, score, rate_per_1000, reasons
     from api.top_homes`
  );
  return rows.map((row) => ({
    propId: row.prop_id,
    situsNum: row.situs_num,
    situsStreet: row.situs_street,
    situsCity: row.situs_city,
    situsZip: row.situs_zip,
    marketValue: toNumberOrNull(row.market_value),
    blockGroupGeoid: row.block_group_geoid,
    score: toNumberOrNull(row.score),
    ratePer1000: toNumberOrNull(row.rate_per_1000),
    reasons: row.reasons ?? [],
  }));
}

async function getQualityPanelData(): Promise<QualityPanelData> {
  const [joinRateRows, precisionRows, gateRows] = await Promise.all([
    query<JoinRateRow>(
      `select permits_with_tcad_id, matched_to_parcels, join_rate, join_rate_null_reason
       from api.join_rate`
    ),
    query<ClassifierPrecisionRowDb>(
      `select label, claude_labelled_count, true_positive_count, precision, precision_null_reason
       from api.classifier_precision`
    ),
    query<ParcelGateCountsRow>(
      `select total_parcels, single_family_count, not_single_family_count, homestead_count, not_homestead_count
       from api.parcel_gate_counts`
    ),
  ]);

  const joinRateRow = joinRateRows[0];
  const precisionByLabel: ClassifierPrecisionRow[] = precisionRows.map((row) => ({
    label: row.label,
    claudeLabelledCount: toNumberOrNull(row.claude_labelled_count),
    truePositiveCount: toNumberOrNull(row.true_positive_count),
    precision: toNumberOrNull(row.precision),
    precisionNullReason: row.precision_null_reason,
  }));
  const gateRow = gateRows[0];

  return {
    joinRate: joinRateRow ? toNumberOrNull(joinRateRow.join_rate) : null,
    joinRateNullReason: joinRateRow?.join_rate_null_reason ?? "no_permits_loaded_yet",
    permitsWithTcadId: joinRateRow ? Number(joinRateRow.permits_with_tcad_id) : 0,
    matchedToParcels: joinRateRow ? Number(joinRateRow.matched_to_parcels) : 0,
    precisionByLabel,
    gateCounts: gateRow
      ? {
          totalParcels: Number(gateRow.total_parcels),
          singleFamilyCount: Number(gateRow.single_family_count),
          notSingleFamilyCount: Number(gateRow.not_single_family_count),
          homesteadCount: Number(gateRow.homestead_count),
          notHomesteadCount: Number(gateRow.not_homestead_count),
        }
      : null,
  };
}

export default async function RankingPage() {
  const [topHomes, qualityData, funnelSteps] = await Promise.all([
    getTopHomes(),
    getQualityPanelData(),
    getFunnelSteps(),
  ]);

  const leftRail = (
    <>
      <EligibilityFunnel steps={funnelSteps} />
      <QualityPanel data={qualityData} />
    </>
  );

  return (
    <div style={{ display: "grid", gap: "var(--space-4)" }}>
      <div>
        <h1
          style={{
            fontFamily: "var(--type-title-font-family)",
            fontSize: "var(--type-title-font-size)",
            fontWeight: "var(--type-title-font-weight)",
            margin: 0,
          }}
        >
          Where should Base knock next?
        </h1>
        <p style={{ color: "var(--theme-ink-muted)", margin: "var(--space-1) 0 0 0", maxWidth: "80ch" }}>
          Ranking owner-occupied single-family homes inside Travis County on outage
          exposure, grid value, installability and household fit.
        </p>
      </div>
      <RankingBoard rows={topHomes} leftRail={leftRail} />
    </div>
  );
}
