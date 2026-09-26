import { query } from "../../lib/db";
import { Panel } from "../../components/ui/Panel";
import { MissingState } from "../../components/ui/MissingState";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
} from "../../components/ui/DataTable";
import { CopyShaButton } from "../../components/ui/CopyShaButton";

// M0-W2: "the demo's proof that every number is real." Lists every
// api.sources row (M0-S1) — every ops.source_manifest row joined to its
// latest ops.pipeline_runs row. Rendered at request time (force-dynamic),
// never statically cached, so a fresh pipeline run shows up immediately.
// Empty is a real, first-class state (no pipeline has landed a source
// yet), not an error — rendered with MissingState, never a blank table.

export const dynamic = "force-dynamic";

interface SourceRow {
  source_id: string;
  source: string;
  url: string;
  retrieved_at: string | Date;
  sha256: string;
  bytes: string | number;
  rows: string | number | null;
  runner: "cron" | "cli";
  latest_run_status: "running" | "success" | "failed" | null;
}

const DATASET_NAMES: Record<string, string> = {
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

function datasetName(source: string): string {
  return DATASET_NAMES[source] ?? source.replace(/_/g, " ");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function fetchedOn(value: string | Date): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function sizeOf(bytes: string | number): string {
  const n = Number(bytes);
  if (!Number.isFinite(n)) return String(bytes);
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

function truncateSha(sha256: string): string {
  return sha256.length > 16 ? `${sha256.slice(0, 16)}…` : sha256;
}

export default async function SourcesPage() {
  const rows = await query<SourceRow>(
    `select source_id, source, url, retrieved_at, sha256, bytes, rows, runner, latest_run_status
     from api.sources
     order by retrieved_at desc`
  );

  return (
    <Panel>
      <h1
        style={{
          fontFamily: "var(--type-title-font-family)",
          fontSize: "var(--type-title-font-size)",
          fontWeight: "var(--type-title-font-weight)",
          marginTop: 0,
        }}
      >
        Sources
      </h1>

      {rows.length === 0 ? (
        <MissingState
          variant="not-loaded"
          reason="No pipeline has recorded a source manifest row yet"
        />
      ) : (
        <>
          <p style={{ margin: "0 0 var(--space-4)", color: "var(--theme-ink-muted)", maxWidth: "70ch", textWrap: "pretty" }}>
            Every number in Zeus comes from one of these downloaded files. Each file is kept unchanged, with the time
            it was fetched and a SHA-256 fingerprint, so anyone can check it against the publisher&rsquo;s copy.
          </p>
          <div style={{ overflowX: "auto" }}>
            <DataTable>
              <DataTableHead>
                <DataTableRow>
                  <DataTableHeaderCell>Dataset</DataTableHeaderCell>
                  <DataTableHeaderCell>Published by</DataTableHeaderCell>
                  <DataTableHeaderCell>Fetched</DataTableHeaderCell>
                  <DataTableHeaderCell>Size</DataTableHeaderCell>
                  <DataTableHeaderCell>Rows loaded</DataTableHeaderCell>
                  <DataTableHeaderCell>Fingerprint</DataTableHeaderCell>
                  <DataTableHeaderCell>File</DataTableHeaderCell>
                </DataTableRow>
              </DataTableHead>
              <DataTableBody>
                {rows.map((row) => (
                  <DataTableRow key={row.source_id}>
                    <DataTableCell>
                      <span style={{ fontWeight: 500 }} data-source={row.source}>{datasetName(row.source)}</span>
                      {row.latest_run_status && row.latest_run_status !== "success" ? (
                        <div style={{ fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
                          Last load: {row.latest_run_status}
                        </div>
                      ) : null}
                    </DataTableCell>
                    <DataTableCell>
                      <a href={row.url} target="_blank" rel="noreferrer noopener" title={row.url}>
                        {hostOf(row.url)}
                      </a>
                    </DataTableCell>
                    <DataTableCell>
                      <span style={{ fontFamily: "var(--type-data-font-family)", whiteSpace: "nowrap" }}>
                        {fetchedOn(row.retrieved_at)}
                      </span>
                    </DataTableCell>
                    <DataTableCell>
                      <span style={{ fontFamily: "var(--type-data-font-family)", whiteSpace: "nowrap" }}>{sizeOf(row.bytes)}</span>
                    </DataTableCell>
                    <DataTableCell>
                      {row.rows === null ? (
                        <MissingState variant="not-loaded" reason="Row count not recorded for this file" />
                      ) : (
                        <span style={{ fontFamily: "var(--type-data-font-family)" }}>{Number(row.rows).toLocaleString()}</span>
                      )}
                    </DataTableCell>
                    <DataTableCell>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)", whiteSpace: "nowrap" }}>
                        <code title={row.sha256} style={{ fontFamily: "var(--type-data-font-family)" }}>
                          {truncateSha(row.sha256)}
                        </code>
                        <CopyShaButton sha256={row.sha256} />
                      </span>
                    </DataTableCell>
                    <DataTableCell>
                      <a href={`/sources/raw/${row.source_id}`} style={{ whiteSpace: "nowrap" }}>
                        Download
                      </a>
                    </DataTableCell>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          </div>
        </>
      )}
    </Panel>
  );
}
