// Which api.sources row stands behind each case-sentence signal, so every
// highlighted figure in "the case for a knock" opens the file it came from
// (DESIGN.md: "Provenance is the interface"). Pure: the route passes in the
// real rows it read; nothing here names a row that the database did not
// return, and a signal with no matching row simply gets no popover.

export interface SourceRow {
  source_id: string;
  source: string;
  url: string;
  retrieved_at: string | Date;
  sha256: string;
  runner: "cron" | "cli";
  latest_run_id: string | null;
  latest_run_rows_in: number | null;
  latest_run_rows_loaded: number | null;
}

/** Provenance popover props for one figure, as the breakdown route returns them. */
export interface CaseSource {
  sourceId: string;
  dataset: string;
  url: string;
  retrievedAt: string;
  sha256: string;
  runId: string;
  runner: "cron" | "cli";
  rowsIn: number | null;
  rowsLoaded: number | null;
}

type Matcher = (name: string) => boolean;

/** dataset name(s) behind each signal key */
const HOME_MATCHERS: Record<string, Matcher> = {
  backup_intent: (n) => n === "austin_permits",
  home_permits: (n) => n === "austin_permits",
  permit_risk: (n) => n === "austin_permits",
  installability: (n) => /_(export|real_acct)$/.test(n),
  home_value: (n) => /_(export|real_acct)$/.test(n),
  owner_65: (n) => /_(export|real_acct)$/.test(n),
  age65: (n) => n === "acs",
  electric_heat: (n) => n === "acs",
};

/** signals whose dataset is statewide, not listed on the home's own source_ids */
export const GLOBAL_SOURCE_BY_SIGNAL: Record<string, string> = {
  income_100k: "acs_income_age",
  age_35_64: "acs_income_age",
  empower: "empower",
  flood: "fema_flood",
};

export function toCaseSource(r: SourceRow): CaseSource {
  return {
    sourceId: r.source_id,
    dataset: r.source,
    url: r.url,
    retrievedAt: r.retrieved_at instanceof Date ? r.retrieved_at.toISOString() : String(r.retrieved_at),
    sha256: r.sha256,
    runId: r.latest_run_id ?? "none",
    runner: r.runner,
    rowsIn: r.latest_run_rows_in ?? null,
    rowsLoaded: r.latest_run_rows_loaded ?? null,
  };
}

/**
 * @param homeRows   api.sources rows for the home's own source_ids, in order
 * @param outageRow  api.sources row for the home's outage_source_ids[0], if any
 * @param globalRows latest api.sources row per statewide dataset name
 */
export function pickSignalSources(
  homeRows: SourceRow[],
  outageRow: SourceRow | null,
  globalRows: Map<string, SourceRow>
): Record<string, CaseSource> {
  const out: Record<string, CaseSource> = {};
  if (outageRow) out.outage = toCaseSource(outageRow);
  for (const [key, match] of Object.entries(HOME_MATCHERS)) {
    const row = homeRows.find((r) => match(r.source));
    if (row) out[key] = toCaseSource(row);
  }
  for (const [key, name] of Object.entries(GLOBAL_SOURCE_BY_SIGNAL)) {
    const row = globalRows.get(name);
    if (row) out[key] = toCaseSource(row);
  }
  return out;
}
