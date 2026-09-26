import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { getPool, query } from "../../lib/db";
import { PredictionProof, type ModelCardData } from "../../components/PredictionProof";

// M4-W2 acceptance: "Out-of-time panel numbers match core.model_card" --
// every figure PredictionProof renders is read from the live
// api.model_card row here and compared against what's on screen. No
// literal 0.761/3.46 anywhere in this file.

describe.skipIf(!process.env.POSTGRES_URL_READONLY)("PredictionProof matches api.model_card", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it("renders the real AUC, top-decile lift, and n_positive_test from api.model_card", async () => {
    const rows = await query<{
      model_version: string;
      algorithm: string;
      auc_oot: string | number | null;
      pr_auc_oot: string | number | null;
      top_decile_lift_oot: string | number | null;
      calibration: { decile: number; n: number; predicted_mean_p: number; observed_rate: number }[] | null;
      n_test: number | null;
      n_positive_test: number | null;
      notes: string | null;
    }>(
      `select model_version, algorithm, auc_oot, pr_auc_oot, top_decile_lift_oot, calibration, n_test, n_positive_test, notes
       from api.model_card
       order by trained_through desc, model_version desc
       limit 1`
    );
    const row = rows[0];
    expect(row).toBeTruthy();

    const modelCard: ModelCardData = {
      modelVersion: row.model_version,
      algorithm: row.algorithm,
      aucOot: row.auc_oot === null ? null : Number(row.auc_oot),
      prAucOot: row.pr_auc_oot === null ? null : Number(row.pr_auc_oot),
      topDecileLiftOot: row.top_decile_lift_oot === null ? null : Number(row.top_decile_lift_oot),
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

    const html = renderToStaticMarkup(<PredictionProof modelCard={modelCard} />);

    if (modelCard.aucOot !== null) {
      expect(html).toContain(modelCard.aucOot.toFixed(3));
    }
    if (modelCard.topDecileLiftOot !== null) {
      expect(html).toContain(modelCard.topDecileLiftOot.toFixed(2));
    }
    if (modelCard.nPositiveTest !== null) {
      expect(html).toContain(modelCard.nPositiveTest.toLocaleString());
    }
    if (modelCard.calibration) {
      for (const calibrationRow of modelCard.calibration) {
        expect(html).toContain(`calibration-decile-${calibrationRow.decile}`);
      }
    }
    // The literal notes string (a checks/*.md citation) must never be printed verbatim.
    if (modelCard.notes) {
      expect(html).not.toContain(modelCard.notes);
    }
  });

  it("renders a MissingState, never a crash, when the model card is unavailable", () => {
    const html = renderToStaticMarkup(<PredictionProof modelCard={null} />);
    expect(html).toMatch(/not available yet/i);
  });
});
