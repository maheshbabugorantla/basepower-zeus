import { Figure } from "./ui/Figure";

// M3-W1: compact "Storm record" panel, one card per county with scored
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

function CountyStormCard({ county }: { county: StormRecordCounty }) {
  const hasLongestEvent =
    county.longestEventHours !== null &&
    county.longestEventPeakCustomers !== null &&
    county.longestEventStartEpoch !== null;
  const hasBeryl = county.berylPeakCustomers !== null;

  return (
    <div style={{ borderLeft: "3px solid var(--theme-divider)", paddingLeft: "var(--space-3)" }}>
      <p style={{ margin: 0, fontFamily: "var(--type-label-font-family)", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
        {county.countyName} County
      </p>
      {hasLongestEvent ? (
        <p style={{ margin: "var(--space-1) 0 0 0" }}>
          Longest major outage: <Figure value={county.longestEventHours!.toFixed(1)} unit="hours" /> starting{" "}
          {formatChicago(county.longestEventStartEpoch!)}, peak{" "}
          <Figure value={county.longestEventPeakCustomers!.toLocaleString()} unit="customers out" /> -- &ge;1% of the
          county&rsquo;s customers out at once, a team threshold.
        </p>
      ) : (
        <p style={{ margin: "var(--space-1) 0 0 0", color: "var(--theme-ink-muted)" }}>
          Longest major outage: not loaded yet
        </p>
      )}
      {hasBeryl ? (
        <p style={{ margin: "var(--space-1) 0 0 0" }}>
          Hurricane Beryl (Jul 2024) peak:{" "}
          <Figure value={county.berylPeakCustomers!.toLocaleString()} unit="customers out" />
          {county.berylPeakShare !== null ? (
            <>
              {" "}
              (
              <Figure value={`${(county.berylPeakShare * 100).toFixed(0)}%`} unit="of the county's customers" />
              {county.berylPeakShare > 1 ? " -- more than the source file's own customer count for this county, shown as reported" : ""}
              )
            </>
          ) : null}
        </p>
      ) : (
        <p style={{ margin: "var(--space-1) 0 0 0", color: "var(--theme-ink-muted)" }}>
          Hurricane Beryl (Jul 2024) peak: not loaded yet
        </p>
      )}
    </div>
  );
}

export function StormRecordPanel({ counties }: { counties: StormRecordCounty[] }) {
  if (counties.length === 0) {
    return (
      <p style={{ color: "var(--theme-ink-muted)", margin: 0 }}>
        Storm record not loaded yet.
      </p>
    );
  }
  return (
    <div style={{ display: "grid", gap: "var(--space-4)" }}>
      {counties.map((c) => (
        <CountyStormCard key={c.countyFips} county={c} />
      ))}
    </div>
  );
}
