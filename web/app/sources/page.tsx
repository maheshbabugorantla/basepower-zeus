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
        <DataTable>
          <DataTableHead>
            <DataTableRow>
              <DataTableHeaderCell>Dataset</DataTableHeaderCell>
              <DataTableHeaderCell>URL</DataTableHeaderCell>
              <DataTableHeaderCell>Retrieved</DataTableHeaderCell>
              <DataTableHeaderCell>SHA-256</DataTableHeaderCell>
              <DataTableHeaderCell>Bytes</DataTableHeaderCell>
              <DataTableHeaderCell>Rows</DataTableHeaderCell>
              <DataTableHeaderCell>Runner</DataTableHeaderCell>
              <DataTableHeaderCell>Latest run</DataTableHeaderCell>
              <DataTableHeaderCell>Raw file</DataTableHeaderCell>
            </DataTableRow>
          </DataTableHead>
          <DataTableBody>
            {rows.map((row) => (
              <DataTableRow key={row.source_id}>
                <DataTableCell>{row.source}</DataTableCell>
                <DataTableCell>
                  <a href={row.url} target="_blank" rel="noreferrer noopener">
                    {row.url}
                  </a>
                </DataTableCell>
                <DataTableCell>
                  <span style={{ fontFamily: "var(--type-data-font-family)" }}>
                    {String(row.retrieved_at)}
                  </span>
                </DataTableCell>
                <DataTableCell>
                  <span title={row.sha256} style={{ fontFamily: "var(--type-data-font-family)" }}>
                    <code>{truncateSha(row.sha256)}</code>
                  </span>
                  <CopyShaButton sha256={row.sha256} />
                </DataTableCell>
                <DataTableCell>
                  <span style={{ fontFamily: "var(--type-data-font-family)" }}>{row.bytes}</span>
                </DataTableCell>
                <DataTableCell>
                  {row.rows === null ? (
                    <MissingState variant="not-loaded" reason="Row count not recorded by this run" />
                  ) : (
                    <span style={{ fontFamily: "var(--type-data-font-family)" }}>{row.rows}</span>
                  )}
                </DataTableCell>
                <DataTableCell>{row.runner}</DataTableCell>
                <DataTableCell>
                  {row.latest_run_status === null ? (
                    <MissingState variant="not-loaded" reason="No load recorded yet" />
                  ) : (
                    row.latest_run_status
                  )}
                </DataTableCell>
                <DataTableCell>
                  <a href={`/sources/raw/${row.source_id}`}>View raw file</a>
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      )}
    </Panel>
  );
}
