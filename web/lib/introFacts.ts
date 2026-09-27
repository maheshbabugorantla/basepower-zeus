// The real figures the intro reel shows, as served by /api/intro-facts, and
// the formatting the reel applies to them. Nothing here is a value: every
// number arrives from the database at run time, and a null stays null (the
// reel then leaves that phrase out rather than showing an estimate).

export interface IntroStorm {
  countyName: string;
  /** api.outage_metrics_county longest_event_start_epoch (seconds) */
  startEpoch: number | null;
  hours: number | null;
  peakCustomers: number | null;
}

export interface IntroFunnelStage {
  key: "parcels" | "singleFamily" | "homestead" | "mapped" | "served";
  label: string;
  count: number | null;
}

export interface IntroFacts {
  countyFips: string;
  countyName: string;
  storm: IntroStorm | null;
  funnel: IntroFunnelStage[];
}

const fmtInt = new Intl.NumberFormat("en-US");

export function formatCount(n: number): string {
  return fmtInt.format(Math.round(n));
}

/** "May 29, 2025", in the county's own time zone */
export function formatStormDate(epochSeconds: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Chicago",
  }).format(new Date(epochSeconds * 1000));
}

/** "30 hours", "14 hours", "4 hours" */
export function formatStormHours(hours: number): string {
  const h = Math.round(hours);
  return `${h} ${h === 1 ? "hour" : "hours"}`;
}

/** The storm caption's phrases, dropping any whose figure is missing. */
export function stormPhrases(storm: IntroStorm | null): string[] {
  if (!storm) return [];
  const out: string[] = [];
  if (storm.startEpoch !== null) out.push(formatStormDate(storm.startEpoch));
  if (storm.hours !== null) out.push(`${formatStormHours(storm.hours)} without power`);
  if (storm.peakCustomers !== null) out.push(`${formatCount(storm.peakCustomers)} customers out at the peak`);
  return out;
}

/** The funnel stages that were actually counted, in order. */
export function countedStages(funnel: IntroFunnelStage[]): Array<IntroFunnelStage & { count: number }> {
  return funnel.filter((s): s is IntroFunnelStage & { count: number } => s.count !== null);
}
