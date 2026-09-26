// M2-P11: pure zone-bucket classification + metadata, shared by the
// server route (app/ranking/coverage/blockgroups/route.ts) and the
// client map/legend (components/CoverageGaps.tsx) so both agree on the
// same 4 buckets from the same real counts. Kept in its own plain module
// (no "use client", no maplibre import) so the server route can import it
// without pulling browser-only map code into its bundle.

export type ZoneBucket = "covered_by_base" | "demand_absent" | "untapped" | "not_observable";

export const ZONE_BUCKET_META: Record<ZoneBucket, { label: string; color: string }> = {
  covered_by_base: { label: "Covered by Base", color: "#1e4d2b" },
  demand_absent: { label: "Demand proven, Base absent", color: "#f7c33c" },
  untapped: { label: "Untapped", color: "#06507e" },
  not_observable: { label: "Not observable (no city permit data)", color: "#e6e4e0" },
};

/** Pure classification from real per-block-group counts only. A block
 * group with no api.coverage_gaps_bg row (homes === null) has no permit
 * coverage at all. */
export function zoneBucket(input: {
  homes: number | null;
  baseCustomers: number | null;
  otherBackup: number | null;
  prospects: number | null;
}): ZoneBucket {
  if (input.homes === null) return "not_observable";
  if ((input.baseCustomers ?? 0) > 0) return "covered_by_base";
  if ((input.otherBackup ?? 0) > 0) return "demand_absent";
  return "untapped";
}

export interface CoverageBucketCount {
  bucket: "base_customer" | "other_backup" | "prospect" | "not_observable";
  homeCount: number;
}

export const HOME_BUCKET_TO_ZONE: Record<CoverageBucketCount["bucket"], ZoneBucket> = {
  base_customer: "covered_by_base",
  other_backup: "demand_absent",
  prospect: "untapped",
  not_observable: "not_observable",
};
