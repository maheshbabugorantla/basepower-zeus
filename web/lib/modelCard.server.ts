import "server-only";
import { query } from "./db";
import type { ModelCardData } from "../components/PredictionProof";

// M4-W2, consolidated for the redesign: api.model_card is the single row
// every "How leads are prioritized" accuracy number comes from. Used to
// live duplicated (identical query + mapping) in app/page.tsx and
// app/ranking/page.tsx because each page rendered its own copy of the
// "How we know it works" panel; the redesign moves that panel to
// app/sources/page.tsx alone, so this is the one place left that reads
// api.model_card.

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

export async function getModelCard(): Promise<ModelCardData | null> {
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
    console.error("modelCard.server: failed to load api.model_card", err);
    return null;
  }
}
