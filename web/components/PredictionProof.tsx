import { MissingState } from "./ui/MissingState";

// M4-W2: "How we know it works" -- every number here comes straight from
// api.model_card (core.model_card, filled by pipelines/models/pipeline.py,
// matching checks/M4-P4.md). Nothing is hard-coded: no literal AUC, no
// literal lift, no literal decile row. core.model_card has no
// evaluation-cutoff column (trained_through is the day the *production*
// model was last refit, not the out-of-time train/test split date from
// checks/M4-P4.md) -- so the "trained on installs before X" wording the
// ticket asked for can't cite an exact date without inventing one; this
// renders the true, undated claim ("earlier installs" / "later ones it
// never saw") instead.

export interface CalibrationRow {
  decile: number;
  n: number;
  predictedMeanP: number;
  observedRate: number;
}

export interface ModelCardData {
  modelVersion: string;
  algorithm: string;
  aucOot: number | null;
  prAucOot: number | null;
  topDecileLiftOot: number | null;
  calibration: CalibrationRow[] | null;
  nTest: number | null;
  nPositiveTest: number | null;
  /** core.model_card.notes -- a citation string (checks/M4-P4.md), not a
   * ready-to-render caption, so it is kept out of the rendered proof
   * (shown only via title text) rather than printed verbatim. */
  notes: string | null;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/** Same convention checks/M4-P4.md and core.model_card.calibration use:
 * decile 1 = highest predicted probability. (Unrelated to core.home_
 * propensity.decile, which is assigned the opposite way -- this component
 * never reads that column.) */
function calibrationCaption(rows: CalibrationRow[]): string {
  const withSignal = rows.filter((r) => r.predictedMeanP > 0);
  if (withSignal.length === 0) return "Calibration by decile is not available yet.";
  const worstRelativeError = withSignal.reduce((worst, r) => {
    const relErr = Math.abs(r.observedRate - r.predictedMeanP) / r.predictedMeanP;
    return Math.max(worst, relErr);
  }, 0);
  const topThreeClose = rows
    .slice(0, 3)
    .every((r) => r.predictedMeanP === 0 || Math.abs(r.observedRate - r.predictedMeanP) / r.predictedMeanP <= 0.75);
  return topThreeClose
    ? `The deciles that drive outreach ranking (the top 3) track observed rates most closely; ` +
        `the lowest deciles, where a rare event lands a handful of adopters in a much larger bucket, are noisier ` +
        `(up to ${Math.round(worstRelativeError * 100)}% relative error there).`
    : "Calibration varies by decile -- see the table below.";
}

export function PredictionProof({ modelCard }: { modelCard: ModelCardData | null }) {
  if (modelCard === null) {
    return <MissingState variant="not-loaded" reason="Model evaluation not available yet" />;
  }

  const { aucOot, topDecileLiftOot, nPositiveTest, calibration } = modelCard;

  return (
    <div className="prediction-proof">
      <p style={{ margin: "0 0 var(--space-3) 0", maxWidth: "70ch" }}>
        Trained on earlier real installs, then tested only on{" "}
        {nPositiveTest === null ? (
          <MissingState variant="not-loaded" reason="Test-period adopter count not available" />
        ) : (
          <span style={{ fontFamily: "var(--type-data-font-family)", fontWeight: 600 }}>
            {nPositiveTest.toLocaleString()}
          </span>
        )}{" "}
        later installs the model never saw during training.
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-6)", marginBottom: "var(--space-4)" }}>
        <div>
          <div style={{ fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
            Accuracy at telling homes apart (AUC)
          </div>
          {aucOot === null ? (
            <MissingState variant="not-loaded" reason="AUC not available" />
          ) : (
            <div style={{ fontFamily: "var(--type-figure-font-family)", fontSize: "var(--type-figure-font-size)", fontWeight: "var(--type-figure-font-weight)" }}>
              {aucOot.toFixed(3)}
            </div>
          )}
        </div>
        <div>
          <div style={{ fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
            In the holdout period, the model&rsquo;s top 10% installed backup at
          </div>
          {topDecileLiftOot === null ? (
            <MissingState variant="not-loaded" reason="Top-decile lift not available" />
          ) : (
            <div style={{ fontFamily: "var(--type-figure-font-family)", fontSize: "var(--type-figure-font-size)", fontWeight: "var(--type-figure-font-weight)" }}>
              {topDecileLiftOot.toFixed(2)}&times; the average rate
            </div>
          )}
          <p style={{ margin: "var(--space-1) 0 0 0", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)", maxWidth: "36ch" }}>
            A measure of historical adoption concentration in that holdout, not a promise about future outreach
            results.
          </p>
        </div>
      </div>

      <h3
        style={{
          fontFamily: "var(--type-heading-font-family)",
          fontSize: "var(--type-body-font-size)",
          fontWeight: 600,
          margin: "0 0 var(--space-2) 0",
        }}
      >
        Calibration by decile
      </h3>

      {calibration === null || calibration.length === 0 ? (
        <MissingState variant="not-loaded" reason="Calibration table not available" />
      ) : (
        <>
          <div role="table" aria-label="Predicted vs. observed adoption rate by decile" style={{ display: "grid", gap: "var(--space-1)" }}>
            <div role="row" style={{ display: "grid", gridTemplateColumns: "60px 1fr 1fr", gap: "var(--space-2)", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
              <span role="columnheader">Decile</span>
              <span role="columnheader">Predicted</span>
              <span role="columnheader">Observed</span>
            </div>
            {calibration
              .slice()
              .sort((a, b) => a.decile - b.decile)
              .map((row) => {
                const maxRate = Math.max(...calibration.map((r) => Math.max(r.predictedMeanP, r.observedRate)), 0.0001);
                return (
                  <div
                    key={row.decile}
                    role="row"
                    data-testid={`calibration-decile-${row.decile}`}
                    style={{ display: "grid", gridTemplateColumns: "60px 1fr 1fr", gap: "var(--space-2)", alignItems: "center" }}
                  >
                    <span role="cell" style={{ fontFamily: "var(--type-data-font-family)" }}>
                      {row.decile}
                    </span>
                    <span role="cell" style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
                      <span
                        aria-hidden="true"
                        style={{
                          display: "inline-block",
                          height: 8,
                          borderRadius: "var(--rounded-sm)",
                          backgroundColor: "var(--color-signal-install)",
                          width: `${Math.max(2, (row.predictedMeanP / maxRate) * 100)}%`,
                        }}
                      />
                      <span style={{ fontSize: "var(--type-label-font-size)", fontFamily: "var(--type-data-font-family)" }}>
                        {formatPercent(row.predictedMeanP)}
                      </span>
                    </span>
                    <span role="cell" style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
                      <span
                        aria-hidden="true"
                        style={{
                          display: "inline-block",
                          height: 8,
                          borderRadius: "var(--rounded-sm)",
                          // Same signal hue, an unfilled/outlined treatment so the
                          // pair reads as one color-blind-safe comparison (shape +
                          // position, not a second hue) rather than a red/green pair.
                          border: "1px solid var(--color-signal-install)",
                          backgroundColor: "transparent",
                          width: `${Math.max(2, (row.observedRate / maxRate) * 100)}%`,
                        }}
                      />
                      <span style={{ fontSize: "var(--type-label-font-size)", fontFamily: "var(--type-data-font-family)" }}>
                        {formatPercent(row.observedRate)}
                      </span>
                    </span>
                  </div>
                );
              })}
          </div>
          <p style={{ margin: "var(--space-2) 0 0 0", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
            {calibrationCaption(calibration)}
          </p>
        </>
      )}
    </div>
  );
}
