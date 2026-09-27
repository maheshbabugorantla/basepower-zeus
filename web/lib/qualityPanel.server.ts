import "server-only";
import { query } from "./db";
import type { QualityPanelData, ClassifierPrecisionRow } from "../components/QualityPanel";

// Layout-review fix: QualityPanel ("How far to trust this list") is
// methodology, not a lead-list concern -- it used to render on /ranking,
// ABOVE the map and list on phone (the worst possible position for a rep
// who opened the page to see homes). Moved to /sources under "How leads
// are prioritized". This file is the one place both callers -- there
// currently is none other, but /sources is the only remaining one -- read
// api.join_rate/api.classifier_precision/api.parcel_gate_counts from, so
// a future second caller doesn't duplicate the query.

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

export async function getQualityPanelData(countyFips: string): Promise<QualityPanelData> {
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
       from api.parcel_gate_counts where county_fips = $1`,
      [countyFips]
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
