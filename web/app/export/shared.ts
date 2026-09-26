import "server-only";

// M5-W1: shared plumbing for /export/homes and /export/coverage --
// plain-CSV, streamed, read-only role, real DB rows only (no synthetic
// data, per the repo's real-data rule). Kept out of web/app/api/top-homes
// (a different ticket's file) so nothing here can conflict with it --
// the two ranking-mode queries below are deliberately independent, not
// reused from fetchRankedHomes/fetchPredictedHomes, because the export's
// byte-identical acceptance criterion needs its own pagination cursor
// discipline (see CSV_CAP note on the weighted-mode loop).

export const CSV_CAP = 5000;

/** RFC 4180: wrap in quotes only when needed, double any embedded quote.
 * Never trims/alters the value otherwise -- an empty/null value is "". */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : String(value);
  if (s === "") return "";
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function csvRow(cells: (string | number | boolean | null | undefined)[]): string {
  return cells.map(csvCell).join(",") + "\r\n";
}

// Dataset key -> plain dataset name, matching web/app/sources/page.tsx's
// own DATASET_NAMES map exactly (that file is owned by a different
// ticket, so this is a deliberate, small duplication rather than an
// import of a non-exported const).
export const DATASET_NAMES: Record<string, string> = {
  acs: "Census ACS 2024: age and home heating by neighborhood",
  austin_energy_service_area: "Austin Energy service area (City of Austin)",
  austin_permits: "City of Austin building permits",
  base_service_areas: "Base Power pricing page (served utilities)",
  eaglei: "EAGLE-I power outages by county, 2025",
  eaglei_mcc: "EAGLE-I customers per county",
  eia861_reliability: "EIA-861 utility reliability (outage minutes)",
  empower: "HHS emPOWER: power-dependent Medicare devices by ZIP",
  fema_flood: "FEMA flood hazard zones",
  retail_market: "Retail choice by utility (from Base's pages)",
  tcad_export: "Travis CAD 2026 certified appraisal roll",
  tcad_geometry: "Travis County parcel outlines",
  territories: "Electric utility service territories (HIFLD)",
  tiger_bg: "Census TIGER 2024 block group boundaries",
  utility_crosswalk: "Base-served utilities matched to EIA IDs",
  zcta: "Census ZIP code areas",
};

export function datasetName(source: string): string {
  return DATASET_NAMES[source] ?? source.replace(/_/g, " ");
}

/** "Tract 329, block group 1" from a 12-digit block-group GEOID --
 * matches app/ranking/RankingBoard.tsx's blockGroupLabel exactly. */
export function blockGroupLabel(geoid: string): string {
  if (!/^\d{12}$/.test(geoid)) return `Block group ${geoid}`;
  const tractRaw = geoid.slice(5, 11);
  const tract = `${Number(tractRaw.slice(0, 4))}${tractRaw.slice(4) === "00" ? "" : `.${tractRaw.slice(4)}`}`;
  return `Tract ${tract}, block group ${geoid.slice(11)}`;
}

/** YYYY-MM-DD, UTC, for the retrieved_at column and the filename date. */
export function isoDate(value: string | Date): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().slice(0, 10);
}

/** Batch-resolve a page's row.source_id[] (ops.source_manifest ids) to
 * "Dataset name (retrieved YYYY-MM-DD)" strings, sorted, deduped, joined
 * with "; " -- reads api.sources (read access confirmed: migration 0210
 * gives zeus_web_ro a schema-wide SELECT privilege on every api table).
 * Never
 * invents a source for an id it can't find (an unresolved id is
 * silently dropped from the joined string rather than guessed). */
export async function makeSourcesResolver(
  queryFn: <T = unknown>(text: string, params?: unknown[]) => Promise<T[]>
): Promise<(sourceIds: (string | null)[]) => Promise<string>> {
  const cache = new Map<string, string>();

  return async (sourceIds: (string | null)[]): Promise<string> => {
    const ids = Array.from(new Set(sourceIds.filter((id): id is string => !!id)));
    const missing = ids.filter((id) => !cache.has(id));
    if (missing.length > 0) {
      const rows = await queryFn<{ source_id: string; source: string; retrieved_at: string | Date }>(
        `select source_id, source, retrieved_at from api.sources where source_id = any($1::uuid[])`,
        [missing]
      );
      for (const row of rows) {
        cache.set(row.source_id, `${datasetName(row.source)} (retrieved ${isoDate(row.retrieved_at)})`);
      }
    }
    const labels = Array.from(new Set(ids.map((id) => cache.get(id)).filter((v): v is string => !!v)));
    labels.sort();
    return labels.join("; ");
  };
}

export function csvFilename(countyName: string, view: string, dateIso: string): string {
  const countySlug = countyName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `base-power-zeus_${countySlug}_${view}_${dateIso}.csv`;
}

// api.homes_ranked_weighted's reason codes -> plain words, matching
// web/components/TopHomesTable.tsx's REASON_META labels exactly (that
// file is "use client" and outside this ticket's owns paths, so the
// labels are duplicated here rather than imported).
export const WEIGHTED_REASON_LABELS: Record<string, string> = {
  outage: "Outage exposure",
  flood: "Outside flood zone",
  empower: "Medical need",
  age65: "Age 65+",
  electric_heat: "Electric heat",
  backup_intent: "Neighbors installing backup",
  owner_65: "Homeowner 65+",
  home_permits: "Own solar/EV/generator permit",
  installability: "Installability",
  home_value: "Home value",
  income_100k: "Household income $100k+",
  age_35_64: "Prime working age 35-64",
  permit_risk: "Permit friction",
};

export function formatWeightedReasons(reasons: string[]): string {
  return reasons.map((r) => WEIGHTED_REASON_LABELS[r] ?? r.replace(/_/g, " ")).join("; ");
}

export interface PropensityReason {
  feature: string;
  direction: "raises" | "lowers";
  value: number | null;
}

export function formatPredictedReasons(reasons: PropensityReason[]): string {
  return reasons.map((r) => `${r.feature} (${r.direction})`).join("; ");
}

/** territory_eia_id -> permit path, the same CASE logic
 * supabase/migrations/0216_scoring_pass.sql computes inline (Austin
 * Energy's territory = '1015' is the one with a city battery-permit
 * path on file; every other Base-served territory falls back to state
 * rules only; no territory match leaves it null). */
export function permitPathFromTerritory(territoryEiaId: string | null): string | null {
  if (territoryEiaId === "1015") return "City of Austin battery permit path";
  if (territoryEiaId !== null) return "State rules only (no city permit path on file)";
  return null;
}

/** api.homes_ranked_weighted's own permit_path column returns the raw
 * code ('city_battery_permit' / 'state_rules_only' / null) computed by
 * the same CASE as permitPathFromTerritory -- mapped to identical plain
 * words here so both ranking modes' CSV say the same thing. */
export function formatWeightedPermitPath(code: string | null): string | null {
  if (code === "city_battery_permit") return "City of Austin battery permit path";
  if (code === "state_rules_only") return "State rules only (no city permit path on file)";
  return null;
}

/** Utility-status column (M-utility-gate): the CSV's plain-language
 * equivalent of the home page's utility-confirmation copy, driven by
 * territory_basis / territory_null_reason -- never a raw null_reason
 * code or "gate"/"territory" jargon (CLAUDE.md's "Added after M2-W3"
 * rule). Matches web/app/home/[prop_id]/page.tsx's wording exactly. */
export function formatUtilityStatus(
  territoryBasis: string | null,
  territoryNullReason: string | null,
  distributorName: string | null
): string {
  if (territoryNullReason === "utility_not_confirmed") {
    return "Utility not confirmed — check the address with the utility";
  }
  if (territoryNullReason) {
    return "Not resolvable yet";
  }
  if (territoryBasis === "most_likely_county_utility") {
    return `Most likely utility: ${distributorName ?? "unknown"} — confirm at the address`;
  }
  if (territoryBasis === "service_area_polygon") {
    return "Confirmed Base-served utility match";
  }
  return "";
}

export function csvResponseHeaders(filename: string): HeadersInit {
  return {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
  };
}
