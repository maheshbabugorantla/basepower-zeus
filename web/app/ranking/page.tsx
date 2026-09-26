import Link from "next/link";
import { query } from "../../lib/db";
import { RankingBoard } from "./RankingBoard";
import { QualityPanel, type QualityPanelData, type ClassifierPrecisionRow } from "../../components/QualityPanel";
import { EligibilityFunnel, type FunnelStep } from "../../components/EligibilityFunnel";
import { GateCounts, type GateCountRow } from "../../components/GateCounts";
import type { TopHomeRow } from "../../components/TopHomesTable";
import { fetchRankedHomes, fetchPredictedHomes, SIGNAL_KEYS, type SignalKey, type PredictedHomeRow } from "../api/top-homes/route";
import type { ModelCardData } from "../../components/PredictionProof";
import { getCountiesWithScoredHomes } from "../../lib/counties.server";
import { resolveCounty } from "../../lib/counties";

// M1-W1: MapLibre choropleth of Travis block groups (api.blockgroup_scores,
// via the app/ranking/blockgroups route handler) + top-50 table
// (api.top_homes) + Quality panel (api.join_rate, api.classifier_precision,
// api.parcel_gate_counts). force-dynamic: parcels/permits/geometry
// pipelines may be loading concurrently, so every request must reflect
// the live view state, never a build-time snapshot.
//
// M3-W1: the ranking table, map and funnel now all follow the top bar's
// `?county=` county switcher (data-driven — only a county with scored
// homes is selectable, see lib/counties.server.ts). The Quality panel's
// permit-join-rate/classifier-precision figures stay Travis-specific
// (the only city permit feed loaded, per PRODUCT.md) regardless of the
// selected county — they are not re-labelled per county, since they are
// never county-scoped data in the first place.

export const dynamic = "force-dynamic";

const TRAVIS_COUNTY_FIPS = "48453";

// Equal-weight fallback across every signal api.top_homes_weighted
// supports, used only if api.default_weights can't be read (M2-P8: the
// evidence-based defaults are the real starting point now).
const EQUAL_WEIGHTS_FALLBACK = 5;

interface DefaultWeightRow {
  signal_key: string;
  weight: string | number;
  basis: string;
}

/** api.default_weights (M2-P8, core.default_weights — a 2026-09-26
 * time-split study on real Austin permits; see checks/M2-P8-ranking-
 * evidence.md). Read server-side so the first paint already ranks by the
 * team's evidence-based defaults, not equal weights. Falls back to
 * equal=5 for every key only if the view can't be read at all. */
async function getDefaultWeights(): Promise<Record<SignalKey, number>> {
  const fallback = {} as Record<SignalKey, number>;
  for (const key of SIGNAL_KEYS) fallback[key] = EQUAL_WEIGHTS_FALLBACK;
  try {
    const rows = await query<DefaultWeightRow>(`select signal_key, weight, basis from api.default_weights`);
    const out = { ...fallback };
    for (const row of rows) {
      if ((SIGNAL_KEYS as readonly string[]).includes(row.signal_key)) {
        out[row.signal_key as SignalKey] = Number(row.weight);
      }
    }
    return out;
  } catch (err) {
    console.error("ranking: failed to load api.default_weights, falling back to equal weights", err);
    return fallback;
  }
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
    { label: "Parcels on the appraisal rolls loaded so far", value: total },
    { label: "Single-family homes", value: Number(pgc.single_family_count) },
    { label: "Owner-occupied, with a mapped lot", value: gatedForScoring },
  ];
  return values.map((v) => ({ ...v, ratio: v.value / total }));
}

// M4-W2: predicted mode is the ranking default -- server-rendered so the
// first paint already shows it, never a client round trip after
// hydration. Reads only api.home_propensity (core.home_propensity, PK
// joins), never api.homes_ranked_weighted_count (measured ~1.85s on prod
// scoring all ~155k homes) -- see fetchPredictedHomes' own comment.
async function getPredictedHomes(countyFips: string): Promise<{ rows: PredictedHomeRow[]; total: number | null }> {
  return fetchPredictedHomes({ countyFips, withTotal: true });
}

interface ModelCardDbRow {
  model_version: string;
  algorithm: string;
  auc_oot: string | number | null;
  pr_auc_oot: string | number | null;
  top_decile_lift_oot: string | number | null;
  calibration: { decile: number; n: number; predicted_mean_p: number; observed_rate: number }[] | null;
  n_test: number | null;
  n_positive_test: number | null;
  notes: string | null;
}

function toNum(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

/** api.model_card -- the single row the "How we know it works" panel reads every number from. */
async function getModelCard(): Promise<ModelCardData | null> {
  try {
    const rows = await query<ModelCardDbRow>(
      `select model_version, algorithm, auc_oot, pr_auc_oot, top_decile_lift_oot, calibration, n_test, n_positive_test, notes
       from api.model_card
       order by trained_through desc, model_version desc
       limit 1`
    );
    const row = rows[0];
    if (!row) return null;
    return {
      modelVersion: row.model_version,
      algorithm: row.algorithm,
      aucOot: toNum(row.auc_oot),
      prAucOot: toNum(row.pr_auc_oot),
      topDecileLiftOot: toNum(row.top_decile_lift_oot),
      calibration: row.calibration
        ? row.calibration.map((c) => ({
            decile: c.decile,
            n: c.n,
            predictedMeanP: c.predicted_mean_p,
            observedRate: c.observed_rate,
          }))
        : null,
      nTest: row.n_test,
      nPositiveTest: row.n_positive_test,
      notes: row.notes,
    };
  } catch (err) {
    console.error("ranking: failed to load api.model_card", err);
    return null;
  }
}

async function getTopHomes(weights: Record<SignalKey, number>): Promise<{ rows: TopHomeRow[]; total: number }> {
  // M2-W1/M2-P8: score v2 (api.homes_ranked_weighted, 0212*.sql).
  // Server-rendered with the evidence-based default weights, page 1, no
  // block-group selection, so the first paint (no JS, or before
  // hydration) matches WeightSliders'/RankingBoard's default state;
  // every re-rank/page/selection change after that goes through
  // /api/top-homes.
  const { rows, total } = await fetchRankedHomes({
    weights,
    countyFips: TRAVIS_COUNTY_FIPS,
    withTotal: true,
  });
  return { rows, total: total ?? 0 };
}
// getTopHomes is unused by this ticket's server render (RankingBoard's
// weighted mode is always fetched client-side, see RankingPage below);
// kept only because RankingBoard's props require *some* initial value
// and other tickets may wire it back in.

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

export default async function RankingPage({
  searchParams,
}: {
  searchParams: Promise<{ county?: string }>;
}) {
  const [{ county: requestedCounty }, availableCounties] = await Promise.all([
    searchParams,
    getCountiesWithScoredHomes(),
  ]);
  const county = resolveCounty(requestedCounty, availableCounties);

  const defaultWeights = await getDefaultWeights();
  // M4-W2 perf: the first paint is predicted mode (the ranking default),
  // so this no longer eagerly calls api.homes_ranked_weighted_count
  // (~1.85s on prod, scoring every gated home) for a table that may never
  // be shown. Team-weighted mode's rows/total are fetched client-side,
  // the first time a visitor actually switches to it (RankingBoard's own
  // effect) -- the empty arrays below are only the state until then.
  const [predictedHomes, modelCard, qualityData, funnelSteps, gateCounts] = await Promise.all([
    getPredictedHomes(county.fips),
    getModelCard(),
    getQualityPanelData(),
    getFunnelSteps(),
    getGateCounts(),
  ]);
  const { rows: predictedRows, total: predictedTotal } = predictedHomes;

  // BUG fix (visible on prod once Harris/Williamson loaded): api.gate_counts
  // and api.parcel_gate_counts (core.mv_gate_counts / core.mv_parcel_gate_counts,
  // 0203_perf_precompute.sql / 0209_gate_counts_by_located_county.sql) have
  // no county_fips column -- they are single combined totals across every
  // loaded county, not just the selected one. Filtering them by county here
  // would require a request-time scan of core.parcels/core.mv_home_signals
  // (the exact cost those precomputed views exist to avoid), so instead of
  // silently mislabeling a combined total as county.name's own count, this
  // says so plainly until a per-county rollup lands (SQL change reported
  // separately, not applied by this ticket -- it owns web/ only).
  const countPanelNote =
    availableCounties.length > 1
      ? `Combined across every loaded county (${availableCounties.map((c) => c.name).join(", ")}) -- not yet split by county.`
      : undefined;

  const leftRail = (
    <>
      <EligibilityFunnel steps={funnelSteps} note={countPanelNote} />
      <GateCounts rows={gateCounts} note={countPanelNote} />
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
          Ranking owner-occupied single-family homes inside {county.name} County on outage
          exposure, grid value, installability and household fit.
        </p>
        <p style={{ margin: "var(--space-1) 0 0 0" }}>
          <Link href={`/ranking/coverage?county=${county.fips}`}>
            See coverage gaps -- where Base isn&rsquo;t yet, but backup demand is proven →
          </Link>
        </p>
      </div>
      <RankingBoard
        key={county.fips}
        rows={[]}
        initialTotal={0}
        leftRail={leftRail}
        defaultWeights={defaultWeights}
        predictedRows={predictedRows}
        predictedTotal={predictedTotal}
        modelCard={modelCard}
        countyName={county.name}
        countyFips={county.fips}
      />
    </div>
  );
}
