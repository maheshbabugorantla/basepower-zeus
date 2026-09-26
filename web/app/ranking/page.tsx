import { query } from "../../lib/db";
import { RankingBoard } from "./RankingBoard";
import { QualityPanel, type QualityPanelData, type ClassifierPrecisionRow } from "../../components/QualityPanel";
import { EligibilityFunnel, type FunnelStep } from "../../components/EligibilityFunnel";
import { GateCounts, type GateCountRow } from "../../components/GateCounts";
import type { TopHomeRow } from "../../components/TopHomesTable";
import { fetchRankedHomes } from "../api/top-homes/route";

// M1-W1: MapLibre choropleth of Travis block groups (api.blockgroup_scores,
// via the app/ranking/blockgroups route handler) + top-50 table
// (api.top_homes) + Quality panel (api.join_rate, api.classifier_precision,
// api.parcel_gate_counts). force-dynamic: parcels/permits/geometry
// pipelines may be loading concurrently, so every request must reflect
// the live view state, never a build-time snapshot.

export const dynamic = "force-dynamic";

const TRAVIS_COUNTY_FIPS = "48453";

// Equal weights across every signal api.top_homes_weighted supports — the
// same starting point WeightSliders' equalWeights() uses client-side, so
// the server-rendered first paint matches what "Reset to equal" produces.
const EQUAL_WEIGHTS = {
  outage: 1,
  flood: 1,
  empower: 1,
  age65: 1,
  electric_heat: 1,
  backup_intent: 1,
};

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

interface ParcelGateCountsRow {
  total_parcels: string | number;
  single_family_count: string | number;
}

interface GateCountsRow {
  reason: string;
  home_count: string | number;
}

async function getFunnelSteps(): Promise<FunnelStep[]> {
  // M2-W1 perf fix: this used to run a live `select count(*) ... FILTER
  // (...) from core.parcels` (a full 441,961-row scan) plus a second
  // `count(*) from core.mv_home_block_group` on every /ranking request —
  // duplicating Overview's own (also-live) count and, under concurrent
  // load, contributing to a real statement-timeout cascade on the shared
  // Supabase pooler. Every count below now comes from an already-precomputed
  // source: api.parcel_gate_counts for the first two steps, and
  // api.gate_counts (0201_m2.sql, built on the materialized
  // core.mv_home_signals) for the last — sum(home_count) across every
  // reason is exactly the single-family + homestead + parcel-geometry
  // population, since core.mv_home_signals has one row per home in that
  // population regardless of the M2 territory-gate outcome.
  const [pgcRows, gateRows] = await Promise.all([
    query<ParcelGateCountsRow>(`select total_parcels, single_family_count from api.parcel_gate_counts`),
    query<GateCountsRow>(`select reason, home_count from api.gate_counts`),
  ]);
  const pgc = pgcRows[0];
  if (!pgc) return [];
  const total = Number(pgc.total_parcels);
  if (total === 0) return [];
  const gatedForScoring = gateRows.reduce((sum, r) => sum + Number(r.home_count), 0);

  const values = [
    { label: "Residential parcels (TCAD, Travis)", value: total },
    { label: "Single-family (state code A1)", value: Number(pgc.single_family_count) },
    { label: "Single-family + homestead + parcel geometry (scoreable)", value: gatedForScoring },
  ];
  return values.map((v) => ({ ...v, ratio: v.value / total }));
}

async function getTopHomes(): Promise<{ rows: TopHomeRow[]; total: number }> {
  // M2-W1: score v1 (api.homes_ranked_weighted, 0201/0204/0205_*.sql)
  // replaces the v0 api.top_homes view. Server-rendered with equal
  // weights, page 1, no block-group selection, so the first paint (no
  // JS, or before hydration) matches WeightSliders'/RankingBoard's
  // default state; every re-rank/page/selection change after that goes
  // through /api/top-homes.
  const { rows, total } = await fetchRankedHomes({
    weights: EQUAL_WEIGHTS,
    countyFips: TRAVIS_COUNTY_FIPS,
    withTotal: true,
  });
  return { rows, total: total ?? 0 };
}

async function getGateCounts(): Promise<GateCountRow[]> {
  try {
    const rows = await query<{ reason: string; home_count: string | number }>(
      `select reason, home_count from api.gate_counts order by home_count desc`
    );
    return rows.map((row) => ({ reason: row.reason, homeCount: Number(row.home_count) }));
  } catch (err) {
    console.error("ranking: failed to load api.gate_counts", err);
    return [];
  }
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
  const [topHomes, qualityData, funnelSteps, gateCounts] = await Promise.all([
    getTopHomes(),
    getQualityPanelData(),
    getFunnelSteps(),
    getGateCounts(),
  ]);
  const { rows: topHomeRows, total: topHomesTotal } = topHomes;

  const leftRail = (
    <>
      <EligibilityFunnel steps={funnelSteps} />
      <GateCounts rows={gateCounts} />
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
      <RankingBoard rows={topHomeRows} initialTotal={topHomesTotal} leftRail={leftRail} />
    </div>
  );
}
