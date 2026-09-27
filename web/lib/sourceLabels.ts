// Names for the Sources table that tell downloaded files apart.
//
// Several datasets were downloaded more than once on purpose: one ACS file
// per county, one ERCOT file per load zone, five different WCAD datasets that
// are all called rows.csv, the EIA-861 2024 file and its 2025 early release.
// The page used to show only the dataset name and the publisher's host, so
// these read as duplicates. Everything here is derived from the manifest's own
// source url and retrieval time: no pipeline run and no new data.

import { COUNTY_CANDIDATES } from "./counties";

/**
 * What a specific file is, where its url alone does not say. Each entry was
 * checked against the file itself or its publisher's catalog (2026-09-27):
 * - EAGLE-I figshare 53581661 starts at 2024-01-01 and feeds the Hurricane
 *   Beryl (July 2024) figures; 62164877 starts at 2025-01-01 and feeds the
 *   2025 county outage totals.
 * - data.wcad.org view names come from https://data.wcad.org/api/views/<id>.json.
 * - EIA-861 and TCAD names come from the published file names.
 */
const FILE_FACTS: Array<[fragment: string, fact: string]> = [
  ["figshare.com/files/53581661", "2024 outages"],
  ["figshare.com/files/62164877", "2025 outages"],
  ["/f8612024.zip", "2024 final"],
  ["/f8612025er.zip", "2025 early release"],
  ["AppraisalExportLayout", "File layout document"],
  ["Certified%20Appraisal%20Export", "Appraisal data"],
  ["/views/ij43-xknu/", "Property"],
  ["/views/an3x-cnmw/", "Parcel boundaries"],
  ["/views/2ckt-cqwj/", "Land"],
  ["/views/4kxj-e8c3/", "Segments (improvements)"],
  ["/views/nbn7-h4pp/", "Exemptions"],
];

export function fileFact(url: string): string | null {
  const hit = FILE_FACTS.find(([fragment]) => url.includes(fragment));
  return hit ? hit[1] : null;
}

/** Path segments that name an endpoint, not a file; show them with their parent. */
const GENERIC_SEGMENTS = new Set(["rows.csv", "acs5", "spp_node_zone_hub"]);

/** Query keys that never distinguish one file from another. */
const IGNORED_PARAMS = new Set(["get", "key", "accesstype"]);

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The file's own name from its source url: the last path segment, with its
 * parent when the last segment is a generic endpoint or a bare number. */
export function sourceFileName(url: string): string {
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean).map(decode);
    if (segments.length === 0) return u.hostname.replace(/^www\./, "");
    const last = segments[segments.length - 1];
    // ArcGIS REST: ".../rest/services/<Folder>/<Service>/FeatureServer/300/query"
    // names the service, not a file; show the service path.
    const svc = segments.indexOf("services");
    if (last.toLowerCase() === "query" && svc >= 0) {
      const end = segments.findIndex((seg, i) => i > svc && /^(Feature|Map|Image)Server$/i.test(seg));
      const name = segments.slice(svc + 1, end > svc ? end : segments.length - 1).join("/");
      if (name) return name;
    }
    if (segments.length > 1 && (GENERIC_SEGMENTS.has(last.toLowerCase()) || /^\d+$/.test(last))) {
      return `${segments[segments.length - 2]}/${last}`;
    }
    return last;
  } catch {
    return url;
  }
}

/** Human form of one distinguishing query value (a Census "in=state:48
 * county:453" becomes "Travis County"). */
export function describeParamValue(value: string): string {
  const m = value.match(/state:(\d{2})\s+county:(\d{3})/);
  if (m) {
    const county = COUNTY_CANDIDATES.find((c) => c.fips === `${m[1]}${m[2]}`);
    return county ? `${county.name} County` : `county ${m[2]}`;
  }
  return value;
}

export interface SourceLike {
  source_id: string;
  source: string;
  url: string;
  retrieved_at: string | Date;
}

export interface SourceLabel {
  /** the file's own name from its url */
  file: string;
  /** what sets this file apart from other files of the same dataset */
  detail: string[];
  /** the same url was downloaded again later; this row is the earlier copy */
  earlierCopy: boolean;
}

/** One label per manifest row, keyed by source_id. */
export function describeSources(rows: SourceLike[]): Map<string, SourceLabel> {
  const bySource = new Map<string, SourceLike[]>();
  for (const r of rows) {
    const list = bySource.get(r.source) ?? [];
    list.push(r);
    bySource.set(r.source, list);
  }

  const out = new Map<string, SourceLabel>();
  for (const group of bySource.values()) {
    // Query keys whose values differ across this dataset's files.
    const parsed = group.map((r) => {
      try {
        return new URL(r.url).searchParams;
      } catch {
        return new URLSearchParams();
      }
    });
    const keys = new Set<string>();
    for (const p of parsed) for (const k of p.keys()) if (!IGNORED_PARAMS.has(k.toLowerCase())) keys.add(k);
    const differing =
      group.length > 1 ? [...keys].filter((k) => new Set(parsed.map((p) => p.get(k) ?? "")).size > 1) : [];

    group.forEach((r, i) => {
      const fact = fileFact(r.url);
      const detail = [
        ...(fact ? [fact] : []),
        ...differing
          .map((k) => parsed[i].get(k))
          .filter((v): v is string => !!v)
          .map(describeParamValue),
      ];
      const t = new Date(r.retrieved_at).getTime();
      const earlierCopy = group.some((o) => o.source_id !== r.source_id && o.url === r.url && new Date(o.retrieved_at).getTime() > t);
      out.set(r.source_id, { file: sourceFileName(r.url), detail, earlierCopy });
    });
  }
  return out;
}
