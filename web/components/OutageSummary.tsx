import { Figure } from "./ui/Figure";
import { MissingState } from "./ui/MissingState";
import { ProvenancePopover } from "./ui/ProvenancePopover";
import { StaleBadge } from "./ui/Badge";

// M2-W-fix (user feedback): "The EAGLE-I outage exposure on the home page
// needs to be fixed" — production led with a Travis-wide EAGLE-I total
// ("2,439,878.25 customer-hours") as the headline. That figure is a sum
// across every customer in the county; no single home experiences it, so
// it can never be the lead (DESIGN.md's Unit Rule: every figure needs its
// real unit and altitude, not just its unit string). The headline is now
// each Base-served distributor's own EIA-861 SAIDI — minutes without
// power per customer per year, the real per-customer outage figure — one
// sentence per distributor, matching DESIGN.md §5's "a headline figure
// lives inside a sentence" pattern (never a hero stat-card grid). The old
// line saying this per-distributor data was still upcoming is gone —
// it shipped in M2.
//
// This component never receives or renders a literal example number:
// every value comes from a real core.utility_reliability /
// api.county_outage row (or MissingState carries the reason).

export interface OutageSourceProvenance {
  dataset: string;
  url: string;
  retrievedAt: string;
  sha256: string;
  runId: string;
  runner: "cron" | "cli";
  rowsIn: number | null;
  rowsLoaded: number | null;
  rawFileHref: string;
}

export interface DistributorReliabilityRow {
  baseName: string;
  /** County this distributor's Travis/Harris-loaded coverage is judged against. */
  county: string;
  /** Whether this distributor's HIFLD territory reaches a loaded county's homes. */
  inLoadedCounty: boolean;
  year: number | null;
  saidiInclMajor: number | null;
  earlyRelease: boolean;
  source: OutageSourceProvenance | null;
}

export interface CountyOutageContext {
  countyName: string;
  year: number;
  hoursPerCustomer: number | null;
  hoursPerCustomerNullReason: string | null;
  /** Never rendered directly — kept only so a future detail view can cite it. */
  customerHoursOut: number | null;
  customerHoursOutNullReason: string | null;
  source: OutageSourceProvenance | null;
}

export interface OutageSummaryData {
  distributors: DistributorReliabilityRow[];
  countyContext: CountyOutageContext | null;
}

const NOT_AVAILABLE_REASON = "Not reported to EIA-861 (IEEE)";

const textStyle = (color: string) => ({
  fontFamily: "var(--type-body-font-family)",
  fontSize: "var(--type-body-font-size)",
  fontWeight: "var(--type-body-font-weight)",
  lineHeight: "var(--type-body-line-height)",
  color,
  maxWidth: "70ch",
});

function DistributorRow({ row }: { row: DistributorReliabilityRow }) {
  if (!row.inLoadedCounty) {
    return (
      <p style={textStyle("var(--theme-ink-muted)")}>
        {row.baseName} ({row.county} County) — arriving in M3.
      </p>
    );
  }

  const yearLabel = row.year ?? "an unloaded year";
  const figureOrMissing =
    row.saidiInclMajor === null ? (
      <MissingState variant="not-available" reason={NOT_AVAILABLE_REASON} />
    ) : (
      <Figure value={row.saidiInclMajor.toLocaleString()} unit="minutes without power per customer" />
    );

  const wrapped =
    row.source && row.saidiInclMajor !== null ? (
      <ProvenancePopover
        id={`distributor-saidi-${row.source.sha256.slice(0, 12)}-${row.baseName}`}
        dataset={row.source.dataset}
        url={row.source.url}
        retrievedAt={row.source.retrievedAt}
        sha256={row.source.sha256}
        runId={row.source.runId}
        runner={row.source.runner}
        rowsIn={row.source.rowsIn}
        rowsLoaded={row.source.rowsLoaded}
        rawFileHref={row.source.rawFileHref}
      >
        {figureOrMissing}
      </ProvenancePopover>
    ) : (
      figureOrMissing
    );

  return (
    <p style={textStyle("var(--theme-ink)")}>
      <strong>{row.baseName}:</strong> {wrapped} in {yearLabel} (SAIDI, incl. major events).
      {row.year === 2025 && row.earlyRelease ? (
        <>
          {" "}
          <StaleBadge>Early release, not fully edited</StaleBadge>
        </>
      ) : null}
    </p>
  );
}

function CountyContextLine({ context }: { context: CountyOutageContext | null }) {
  if (context === null) {
    return (
      <p style={textStyle("var(--theme-ink-muted)")}>
        County context (EAGLE-I):{" "}
        <MissingState
          variant="not-loaded"
          reason="The EAGLE-I outage pipeline has not loaded a county row yet."
        />
      </p>
    );
  }

  if (context.hoursPerCustomer === null) {
    return (
      <p style={textStyle("var(--theme-ink-muted)")}>
        County context (EAGLE-I): ≈{" "}
        <MissingState
          variant="not-loaded"
          reason={context.hoursPerCustomerNullReason ?? "Not loaded"}
        />{" "}
        h without power per customer in {context.countyName} in {context.year}.
      </p>
    );
  }

  const figure = <>≈{context.hoursPerCustomer.toFixed(1)} h without power per customer</>;

  return (
    <p style={textStyle("var(--theme-ink-muted)")}>
      County context (EAGLE-I):{" "}
      {context.source ? (
        <ProvenancePopover
          id={`county-outage-${context.source.sha256.slice(0, 12)}`}
          dataset={context.source.dataset}
          url={context.source.url}
          retrievedAt={context.source.retrievedAt}
          sha256={context.source.sha256}
          runId={context.source.runId}
          runner={context.source.runner}
          rowsIn={context.source.rowsIn}
          rowsLoaded={context.source.rowsLoaded}
          rawFileHref={context.source.rawFileHref}
        >
          {figure}
        </ProvenancePopover>
      ) : (
        figure
      )}{" "}
      in {context.countyName} in {context.year}. A county-wide average across every customer, not
      a per-home figure.
    </p>
  );
}

export function OutageSummary({ data }: { data: OutageSummaryData }) {
  return (
    <>
      {data.distributors.map((row) => (
        <DistributorRow key={row.baseName} row={row} />
      ))}
      <CountyContextLine context={data.countyContext} />
    </>
  );
}
