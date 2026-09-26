import { Panel } from "./ui/Panel";
import { MissingState } from "./ui/MissingState";

// M1-W1: the ranking page's Quality panel. Reads api.join_rate,
// api.classifier_precision (per label) and api.parcel_gate_counts. Every
// null value renders that view's own written reason via MissingState —
// "not loaded"/"not yet labelled" — never a 0, blank, or dash
// (DESIGN.md "The Missing Is Grey Rule").

export interface ClassifierPrecisionRow {
  label: string;
  claudeLabelledCount: number | null;
  truePositiveCount: number | null;
  precision: number | null;
  precisionNullReason: string | null;
}

export interface QualityPanelData {
  joinRate: number | null;
  joinRateNullReason: string | null;
  permitsWithTcadId: number;
  matchedToParcels: number;
  precisionByLabel: ClassifierPrecisionRow[];
  gateCounts: {
    totalParcels: number;
    singleFamilyCount: number;
    notSingleFamilyCount: number;
    homesteadCount: number;
    notHomesteadCount: number;
  } | null;
}

function missingReasonLabel(reason: string): string {
  // api.classifier_precision's reason is "no_claude_labels_yet" — DESIGN's
  // ticket text calls this state "not yet labelled".
  if (reason === "no_claude_labels_yet") return "Not yet labelled by M1-H1";
  if (reason === "no_permits_loaded_yet") return "Permits pipeline has not loaded any rows yet";
  return reason;
}

export function QualityPanel({ data }: { data: QualityPanelData }) {
  return (
    <Panel>
      <h2
        style={{
          fontFamily: "var(--type-heading-font-family)",
          fontSize: "var(--type-heading-font-size)",
          fontWeight: "var(--type-heading-font-weight)",
          marginTop: 0,
        }}
      >
        Quality
      </h2>

      <section style={{ marginBottom: "var(--space-3)" }}>
        <h3 style={{ fontFamily: "var(--type-label-font-family)", fontSize: "var(--type-label-font-size)" }}>
          Permit join rate
        </h3>
        {data.joinRate === null ? (
          <MissingState
            variant="not-loaded"
            reason={
              data.joinRateNullReason ? missingReasonLabel(data.joinRateNullReason) : "Join rate not available"
            }
          />
        ) : (
          <p style={{ margin: 0, fontFamily: "var(--type-body-font-family)", fontSize: "var(--type-body-font-size)" }}>
            Permit join rate {(data.joinRate * 100).toFixed(1)}% ({data.matchedToParcels.toLocaleString()} of{" "}
            {data.permitsWithTcadId.toLocaleString()})
          </p>
        )}
      </section>

      <section style={{ marginBottom: "var(--space-3)" }}>
        <h3 style={{ fontFamily: "var(--type-label-font-family)", fontSize: "var(--type-label-font-size)" }}>
          Classifier precision
        </h3>
        <ul style={{ margin: 0, paddingLeft: "var(--space-4)" }}>
          {data.precisionByLabel.map((row) => (
            <li
              key={row.label}
              style={{ fontFamily: "var(--type-body-font-family)", fontSize: "var(--type-body-font-size)" }}
            >
              {row.precision === null ? (
                <>
                  <span style={{ textTransform: "capitalize" }}>{row.label}</span> precision:{" "}
                  <MissingState
                    variant="not-loaded"
                    reason={row.precisionNullReason ? missingReasonLabel(row.precisionNullReason) : "not yet labelled"}
                  />
                </>
              ) : (
                <span style={{ textTransform: "capitalize" }}>
                  {row.label} precision {(row.precision * 100).toFixed(1)}% ({row.truePositiveCount}/
                  {row.claudeLabelledCount} Claude labels)
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 style={{ fontFamily: "var(--type-label-font-family)", fontSize: "var(--type-label-font-size)" }}>
          Parcel gate counts
        </h3>
        {data.gateCounts === null ? (
          <MissingState variant="not-loaded" reason="core.parcels has no rows yet — M1-P1 has not loaded" />
        ) : (
          <p style={{ margin: 0, fontFamily: "var(--type-body-font-family)", fontSize: "var(--type-body-font-size)" }}>
            {data.gateCounts.totalParcels.toLocaleString()} parcels — {data.gateCounts.singleFamilyCount.toLocaleString()}{" "}
            single-family, {data.gateCounts.notSingleFamilyCount.toLocaleString()} not single-family;{" "}
            {data.gateCounts.homesteadCount.toLocaleString()} homestead, {data.gateCounts.notHomesteadCount.toLocaleString()}{" "}
            not homestead
          </p>
        )}
      </section>
    </Panel>
  );
}
