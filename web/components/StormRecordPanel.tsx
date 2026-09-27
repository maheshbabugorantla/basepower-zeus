import { Figure } from "./ui/Figure";
import { MissingState } from "./ui/MissingState";

// M3-W1: compact "Storm record" panel, one row per county with scored
// homes, from api.outage_metrics_county (M3-P3, streamed straight from
// the raw EAGLE-I CSVs). Two real, sourced figures per county:
//   - the longest continuous outage event where >=1% of the county's
//     estimated customers were out at once (eaglei_metrics.py's
//     MAJOR_EVENT_MIN_SHARE = 0.01 -- a team threshold we chose, not
//     something EAGLE-I or ERCOT defines, so the copy says so plainly).
//   - Hurricane Beryl's July 2024 peak customers out and their share of
//     the county's customers -- Harris's share can read over 100% (a
//     real anomaly in the source file, see 0302_m3_outage_metrics.sql),
//     never clamped or "corrected".
//
// Redesign (Mock C, 2026-09-27, critique "storm record as a fixed grid"):
// a fixed four-column grid (county / longest major outage / peak
// customers out / Beryl peak) rather than a stack of per-county cards --
// three counties, twelve numbers, alignment matters more than prose
// here (the figure-in-sentence pattern stays on the home record where
// one number matters).

export interface StormRecordCounty {
  countyFips: string;
  countyName: string;
  longestEventHours: number | null;
  longestEventPeakCustomers: number | null;
  longestEventStartEpoch: number | null;
  longestEventEndEpoch: number | null;
  berylPeakCustomers: number | null;
  berylPeakShare: number | null;
}

function formatChicago(epochSeconds: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(epochSeconds * 1000));
}

function StormRow({ county }: { county: StormRecordCounty }) {
  const hasLongestEvent =
    county.longestEventHours !== null &&
    county.longestEventPeakCustomers !== null &&
    county.longestEventStartEpoch !== null;
  const hasBeryl = county.berylPeakCustomers !== null;

  return (
    <div className="storm-grid__row" role="row">
      <div role="cell" className="storm-grid__county">
        {county.countyName}
      </div>
      <div role="cell">
        {hasLongestEvent ? (
          <>
            <Figure value={county.longestEventHours!.toFixed(1)} unit="hours" /> from{" "}
            {formatChicago(county.longestEventStartEpoch!)}
          </>
        ) : (
          <MissingState variant="not-loaded" reason="Not loaded yet" />
        )}
      </div>
      <div role="cell">
        {hasLongestEvent ? (
          <Figure value={county.longestEventPeakCustomers!.toLocaleString()} unit="customers" />
        ) : (
          <MissingState variant="not-loaded" reason="Not loaded yet" />
        )}
      </div>
      <div role="cell">
        {hasBeryl ? (
          <>
            <Figure value={county.berylPeakCustomers!.toLocaleString()} unit="customers" />
            {county.berylPeakShare !== null ? (
              <span className="storm-grid__muted">
                {" "}
                ({(county.berylPeakShare * 100).toFixed(0)}%
                {county.berylPeakShare > 1 ? " -- exceeds the source file's own customer count" : ""})
              </span>
            ) : null}
          </>
        ) : (
          <MissingState variant="not-loaded" reason="Not loaded yet" />
        )}
      </div>
    </div>
  );
}

export function StormRecordPanel({ counties }: { counties: StormRecordCounty[] }) {
  if (counties.length === 0) {
    return <p style={{ color: "var(--theme-ink-muted)", margin: 0 }}>Storm record not loaded yet.</p>;
  }
  return (
    <div>
      <p style={{ margin: "0 0 var(--space-2) 0", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
        Longest major outage per county since 2024, and the Hurricane Beryl peak (July 2024). Major = at least 1% of
        the county&rsquo;s customers out at once, a team threshold.
      </p>
      <div className="storm-grid" role="table" aria-label="Storm record by county">
        <div className="storm-grid__row storm-grid__row--head" role="row">
          <div role="columnheader">County</div>
          <div role="columnheader">Longest major outage</div>
          <div role="columnheader">Peak customers out</div>
          <div role="columnheader">Beryl peak</div>
        </div>
        {counties.map((c) => (
          <StormRow key={c.countyFips} county={c} />
        ))}
      </div>
    </div>
  );
}
