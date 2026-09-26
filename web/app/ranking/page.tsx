import { query } from "../../lib/db";
import { RankingBoard } from "./RankingBoard";
import { QualityPanel, type QualityPanelData, type ClassifierPrecisionRow } from "../../components/QualityPanel";
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
  const [topHomes, qualityData] = await Promise.all([getTopHomes(), getQualityPanelData()]);

  return (
    <div style={{ display: "grid", gap: "var(--space-6)" }}>
      <h1
        style={{
          fontFamily: "var(--type-title-font-family)",
          fontSize: "var(--type-title-font-size)",
          fontWeight: "var(--type-title-font-weight)",
          margin: 0,
        }}
      >
        Ranking
      </h1>
      <div style={{ display: "grid", gridTemplateColumns: "3fr 1fr", gap: "var(--space-6)" }}>
        <RankingBoard rows={topHomes} />
        <QualityPanel data={qualityData} />
      </div>
    </div>
  );
}
