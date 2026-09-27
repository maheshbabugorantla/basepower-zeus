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
import { PredictionProof } from "../../components/PredictionProof";
import { getModelCard } from "../../lib/modelCard.server";
import { allTierMeta, REASON_PHRASES } from "../../lib/priorityTier";

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
  const [rows, modelCard] = await Promise.all([
    query<SourceRow>(
      `select source_id, source, url, retrieved_at, sha256, bytes, rows, runner, latest_run_status
       from api.sources
       order by retrieved_at desc`
    ),
    getModelCard(),
  ]);

  return (
    <div style={{ display: "grid", gap: "var(--space-6)" }}>
      <Panel as="details" id="how-leads-are-prioritized" open>
        <summary
          style={{
            cursor: "pointer",
            fontFamily: "var(--type-title-font-family)",
            fontSize: "var(--type-title-font-size)",
            fontWeight: "var(--type-title-font-weight)",
          }}
        >
          How leads are prioritized
        </summary>

        <p style={{ margin: "var(--space-3) 0 var(--space-4) 0", maxWidth: "70ch", textWrap: "pretty" }}>
          Every home is scored by a model trained on which Austin homes actually added battery or generator backup.
          That score orders every lead list and area ranking on this site, but no rep or manager ever sees the raw
          number -- only the plain tier it falls into and the plain-language reasons behind it.
        </p>

        <h2
          style={{
            fontFamily: "var(--type-heading-font-family)",
            fontSize: "var(--type-heading-font-size)",
            fontWeight: "var(--type-heading-font-weight)",
            margin: "0 0 var(--space-2) 0",
          }}
        >
          Priority tiers
        </h2>
        <p style={{ margin: "0 0 var(--space-2) 0", color: "var(--theme-ink-muted)", maxWidth: "70ch" }}>
          Homes are split into ten deciles per county by the model&rsquo;s score (decile 1 = the county&rsquo;s
          highest-likelihood tenth). Deciles map to tiers like this:
        </p>
        <DataTable style={{ marginBottom: "var(--space-4)" }}>
          <DataTableHead>
            <DataTableRow>
              <DataTableHeaderCell>Tier</DataTableHeaderCell>
              <DataTableHeaderCell>Decile</DataTableHeaderCell>
              <DataTableHeaderCell>What it means</DataTableHeaderCell>
            </DataTableRow>
          </DataTableHead>
          <DataTableBody>
            {allTierMeta()
              .filter((t) => t.key !== "unscored")
              .map((t) => (
                <DataTableRow key={t.key}>
                  <DataTableCell style={{ fontWeight: 600 }}>{t.label}</DataTableCell>
                  <DataTableCell>
                    {t.key === "top" ? "1" : t.key === "high" ? "2-3" : t.key === "medium" ? "4-6" : "7-10"}
                  </DataTableCell>
                  <DataTableCell>{t.description}</DataTableCell>
                </DataTableRow>
              ))}
          </DataTableBody>
        </DataTable>

        <h2
          style={{
            fontFamily: "var(--type-heading-font-family)",
            fontSize: "var(--type-heading-font-size)",
            fontWeight: "var(--type-heading-font-weight)",
            margin: "0 0 var(--space-2) 0",
          }}
        >
          What the reasons mean
        </h2>
        <p style={{ margin: "0 0 var(--space-2) 0", color: "var(--theme-ink-muted)", maxWidth: "70ch" }}>
          Each home&rsquo;s reasons are the model&rsquo;s own top-3 contributions, relabeled in plain, rep-facing
          words:
        </p>
        <ul style={{ margin: "0 0 var(--space-4) 0", paddingLeft: "1.2em", color: "var(--theme-ink-muted)", maxWidth: "70ch" }}>
          {Object.entries(REASON_PHRASES).map(([modelLabel, phrase]) => (
            <li key={modelLabel}>
              <strong style={{ color: "var(--theme-ink)" }}>{phrase}</strong> — model term: {modelLabel}
            </li>
          ))}
        </ul>

        <h2
          style={{
            fontFamily: "var(--type-heading-font-family)",
            fontSize: "var(--type-heading-font-size)",
            fontWeight: "var(--type-heading-font-weight)",
            margin: "0 0 var(--space-2) 0",
          }}
        >
          The model&rsquo;s accuracy check
        </h2>
        <PredictionProof modelCard={modelCard} />

        <p style={{ margin: "var(--space-4) 0 0 0", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)", maxWidth: "70ch" }}>
          The model is trained and evaluated on Austin (Travis County) permits only. Predictions for Harris and
          Williamson County homes are transferred from that same model -- they are not locally validated against
          Harris or Williamson installs.
        </p>

        <h2
          style={{
            fontFamily: "var(--type-heading-font-family)",
            fontSize: "var(--type-heading-font-size)",
            fontWeight: "var(--type-heading-font-weight)",
            margin: "var(--space-4) 0 var(--space-2) 0",
          }}
        >
          What &ldquo;not available&rdquo; means
        </h2>
        <p style={{ margin: 0, color: "var(--theme-ink-muted)", maxWidth: "70ch" }}>
          A home&rsquo;s missing signal is never treated as zero and never estimated. &ldquo;Not loaded&rdquo; means
          the pipeline that would fill it hasn&rsquo;t run yet; &ldquo;not available&rdquo; means the publisher
          itself doesn&rsquo;t report that figure for this home. Either way, that signal is left out of the home&rsquo;s
          score rather than counted against it.
        </p>
      </Panel>

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
    </div>
  );
}
