import { Panel } from "./ui/Panel";
import { StatList, StatRow } from "./ui/StatRow";

// The ranking page's data-quality panel, written for a GTM reader: each
// row says what was checked, the figure, and one plain line on what it
// means. Reads api.join_rate, api.classifier_precision (per label) and
// api.parcel_gate_counts. A null value renders "not available" with a
// plain reason — never a 0, blank, or dash (DESIGN.md "The Missing Is
// Grey Rule"). No pipeline, ticket, or table names on screen.

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

const LABEL_NOUN: Record<string, string> = {
  battery: "Home-battery permits",
  generator: "Generator permits",
};

function plainReason(reason: string | null): string {
  if (reason === "no_claude_labels_yet") return "Not checked yet";
  if (reason === "no_permits_loaded_yet") return "Permits not loaded yet";
  return "Not available";
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        margin: "calc(-1 * var(--space-2)) 0 var(--space-2)",
        fontFamily: "var(--type-body-font-family)",
        fontSize: "var(--type-label-font-size)",
        color: "var(--theme-ink-muted)",
        textWrap: "pretty",
      }}
    >
      {children}
    </p>
  );
}

export function QualityPanel({ data, countyName = "Travis" }: { data: QualityPanelData; countyName?: string }) {
  const isAustinTrainingCounty = countyName === "Travis";
  return (
    <Panel>
      <h2
        style={{
          fontFamily: "var(--type-heading-font-family)",
          fontSize: "var(--type-heading-font-size)",
          fontWeight: "var(--type-heading-font-weight)",
          margin: "0 0 var(--space-1)",
        }}
      >
        How far to trust this list
      </h2>
      <p
        style={{
          margin: "0 0 var(--space-2)",
          fontFamily: "var(--type-body-font-family)",
          fontSize: "var(--type-label-font-size)",
          color: "var(--theme-ink-muted)",
        }}
      >
        Spot checks on the data behind the ranking.
      </p>

      <StatList>
        <StatRow
          id="quality-permit-match"
          label="City permits matched to a home"
          value={data.joinRate === null ? null : pct(data.joinRate)}
          unit="of permits"
          missingReason={plainReason(data.joinRateNullReason)}
        />
        {data.joinRate !== null ? (
          <Note>
            {data.matchedToParcels.toLocaleString()} of {data.permitsWithTcadId.toLocaleString()} Austin permits
            were tied to a {countyName} County home. Unmatched permits simply don&rsquo;t count toward any home.
          </Note>
        ) : null}

        {!isAustinTrainingCounty ? (
          <Note>
            This model was trained and evaluated on Austin (Travis County) permits only. Predictions for{" "}
            {countyName} County homes are transferred from that same model, not locally validated against{" "}
            {countyName} County installs.
          </Note>
        ) : null}

        {data.precisionByLabel.map((row) => (
          <div key={row.label}>
            <StatRow
              id={`quality-precision-${row.label}`}
              label={`${LABEL_NOUN[row.label] ?? row.label} spotted correctly`}
              value={row.precision === null ? null : pct(row.precision)}
              unit="correct"
              missingReason={plainReason(row.precisionNullReason)}
            />
            {row.precision !== null ? (
              <Note>
                We double-checked {row.claudeLabelledCount} flagged permits against their full permit text; {row.truePositiveCount} really were{" "}
                {row.label === "battery" ? "a home battery" : row.label === "generator" ? "a backup generator" : row.label}.
              </Note>
            ) : null}
          </div>
        ))}

        <StatRow
          id="quality-homes"
          label="Single-family homes on file"
          value={data.gateCounts === null ? null : data.gateCounts.singleFamilyCount.toLocaleString()}
          unit="homes"
          missingReason="County parcel records not loaded yet"
        />
        {data.gateCounts !== null ? (
          <Note>
            Out of {data.gateCounts.totalParcels.toLocaleString()} {countyName} County parcels in the county
            appraisal district&rsquo;s roll. Apartments, land and commercial parcels are left out.
          </Note>
        ) : null}
      </StatList>
    </Panel>
  );
}
