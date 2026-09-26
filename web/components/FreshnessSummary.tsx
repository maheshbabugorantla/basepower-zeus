import { StaleBadge } from "./ui/Badge";

// DESIGN.md §5 Navigation: "the freshness summary (quiet unless something
// is stale)". Driven off api.source_freshness (M0-S1): status is one of
// not_loaded / no_cycle / stale / fresh. Only 'stale' ever renders visible
// UI here — every other status (including not_loaded, which is a normal
// pre-pipeline state, not a problem) keeps this component silent, per the
// real-data rule ("missing is a state, not a zero/alarm").

export interface SourceFreshnessRow {
  source: string;
  status: "not_loaded" | "no_cycle" | "stale" | "fresh";
}

export function FreshnessSummary({ rows }: { rows: SourceFreshnessRow[] }) {
  const stale = rows.filter((row) => row.status === "stale");

  if (stale.length === 0) {
    // Quiet: no badge, no text, nothing rendered when nothing is stale.
    return null;
  }

  return (
    <StaleBadge>
      {stale.length === 1
        ? `${stale[0].source} is stale`
        : `${stale.length} sources stale`}
    </StaleBadge>
  );
}
