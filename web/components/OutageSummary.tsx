import { Figure } from "./ui/Figure";
import { MissingState } from "./ui/MissingState";
import { ProvenancePopover } from "./ui/ProvenancePopover";

// M0-W1: DESIGN.md §5 Cards/Containers — "A headline figure lives inside a
// sentence ... with its provenance link beside it", never a hero-metric
// stat card. This component never receives or renders a literal example
// number: `value` always comes from a real api.county_outage row (or is
// entirely absent, in which case MissingState carries the reason).

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

export interface OutageSummaryData {
  /** customer-hours without power for the county-year; null means missing. */
  customerHoursOut: number | null;
  /** Required by the DB constraint whenever customerHoursOut is null. */
  nullReason: string | null;
  /** Provenance for the row's source_ids, when resolvable against api.sources. */
  source: OutageSourceProvenance | null;
}

const DEFAULT_NOT_LOADED_REASON =
  "The EAGLE-I outage pipeline has not loaded a Travis County 2025 row yet.";

export function OutageSummary({ data }: { data: OutageSummaryData | null }) {
  const countyHoursOut = data?.customerHoursOut ?? null;

  if (countyHoursOut === null) {
    const reason = data?.nullReason ?? DEFAULT_NOT_LOADED_REASON;
    return (
      <p
        style={{
          fontFamily: "var(--type-body-font-family)",
          fontSize: "var(--type-body-font-size)",
          fontWeight: "var(--type-body-font-weight)",
          lineHeight: "var(--type-body-line-height)",
          color: "var(--theme-ink)",
          maxWidth: "70ch",
        }}
      >
        Travis County (FIPS 48453) 2025 customer-hours without power:{" "}
        <MissingState variant="not-loaded" reason={reason} />. EAGLE-I outage
        data is county-level — this figure covers all of Travis County, not
        individual homes.
      </p>
    );
  }

  const figure = (
    <Figure value={countyHoursOut.toLocaleString()} unit="customer-hours without power" />
  );

  return (
    <p
      style={{
        fontFamily: "var(--type-body-font-family)",
        fontSize: "var(--type-body-font-size)",
        fontWeight: "var(--type-body-font-weight)",
        lineHeight: "var(--type-body-line-height)",
        color: "var(--theme-ink)",
        maxWidth: "70ch",
      }}
    >
      Travis County (FIPS 48453) recorded{" "}
      {data?.source ? (
        <ProvenancePopover
          id={`travis-2025-outage-${data.source.sha256.slice(0, 12)}`}
          dataset={data.source.dataset}
          url={data.source.url}
          retrievedAt={data.source.retrievedAt}
          sha256={data.source.sha256}
          runId={data.source.runId}
          runner={data.source.runner}
          rowsIn={data.source.rowsIn}
          rowsLoaded={data.source.rowsLoaded}
          rawFileHref={data.source.rawFileHref}
        >
          {figure}
        </ProvenancePopover>
      ) : (
        figure
      )}{" "}
      in 2025. EAGLE-I outage data is county-level — this figure covers all of
      Travis County, not individual homes.
    </p>
  );
}
