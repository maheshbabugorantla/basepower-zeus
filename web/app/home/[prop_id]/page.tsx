import type { ReactNode } from "react";
import { query } from "../../../lib/db";
import { Panel } from "../../../components/ui/Panel";
import { MissingState } from "../../../components/ui/MissingState";
import { ProvenancePopover } from "../../../components/ui/ProvenancePopover";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
} from "../../../components/ui/DataTable";

// M1-W1: /home/[prop_id], from api.home_detail — parcel facts (state
// code, homestead, situs, market value) and its permits, each with a
// provenance popover. Product rule (explicit, non-negotiable for M1): no
// outage figure appears on this page. The county EAGLE-I total
// customer-hours (api.county_outage) is a *county-level* number and does
// not apply to a single home; a per-distributor outage signal for homes
// arrives in a later milestone. Do not add one here.

export const dynamic = "force-dynamic";

interface PermitJson {
  permit_number: string;
  issue_date: string | null;
  work_class: string | null;
  permit_class: string | null;
  description: string | null;
  status_current: string | null;
  label: string | null;
  labeller: string | null;
  source_id: string | null;
}

interface HomeDetailRow {
  prop_id: string;
  geo_id: string | null;
  county_fips: string | null;
  prop_type_cd: string | null;
  imprv_state_cd: string | null;
  land_state_cd: string | null;
  hs_exempt: string | null;
  ov65_exempt: string | null;
  is_single_family: boolean;
  is_homestead: boolean;
  situs_num: string | null;
  situs_street: string | null;
  situs_city: string | null;
  situs_zip: string | null;
  market_value: string | number | null;
  tax_year: number | null;
  permits: PermitJson[];
  source_ids: string[];
}

interface SourceRow {
  source_id: string;
  source: string;
  url: string;
  retrieved_at: string | Date;
  sha256: string;
  rows: string | number | null;
  runner: "cron" | "cli";
  latest_run_id: string | null;
  latest_run_rows_in: number | null;
  latest_run_rows_loaded: number | null;
}

async function getSourcesByIds(sourceIds: string[]): Promise<Map<string, SourceRow>> {
  if (sourceIds.length === 0) return new Map();
  const rows = await query<SourceRow>(
    `select source_id, source, url, retrieved_at, sha256, rows, runner,
            latest_run_id, latest_run_rows_in, latest_run_rows_loaded
     from api.sources
     where source_id = any($1::uuid[])`,
    [sourceIds]
  );
  return new Map(rows.map((r) => [r.source_id, r]));
}

function ProvenanceFor({
  sourceRow,
  id,
  children,
}: {
  sourceRow: SourceRow | undefined;
  id: string;
  children: ReactNode;
}) {
  if (!sourceRow) return <>{children}</>;
  return (
    <ProvenancePopover
      id={id}
      dataset={sourceRow.source}
      url={sourceRow.url}
      retrievedAt={
        sourceRow.retrieved_at instanceof Date
          ? sourceRow.retrieved_at.toISOString()
          : String(sourceRow.retrieved_at)
      }
      sha256={sourceRow.sha256}
      runId={sourceRow.latest_run_id ?? "none"}
      runner={sourceRow.runner}
      rowsIn={sourceRow.latest_run_rows_in ?? null}
      rowsLoaded={sourceRow.latest_run_rows_loaded ?? null}
      rawFileHref={`/sources/raw/${sourceRow.source_id}`}
    >
      {children}
    </ProvenancePopover>
  );
}

export default async function HomeDetailPage({
  params,
}: {
  params: Promise<{ prop_id: string }>;
}) {
  const { prop_id } = await params;

  const rows = await query<HomeDetailRow>(
    `select prop_id, geo_id, county_fips, prop_type_cd, imprv_state_cd, land_state_cd,
            hs_exempt, ov65_exempt, is_single_family, is_homestead,
            situs_num, situs_street, situs_city, situs_zip, market_value, tax_year,
            permits, source_ids
     from api.home_detail
     where prop_id = $1`,
    [prop_id]
  );

  if (rows.length === 0) {
    return (
      <Panel>
        <MissingState
          variant="not-loaded"
          reason={`No parcel found for prop_id ${prop_id} — core.parcels may not have loaded this record yet`}
        />
      </Panel>
    );
  }

  const home = rows[0];
  const permitSourceIds = home.permits.map((p) => p.source_id).filter((s): s is string => !!s);
  const allSourceIds = Array.from(new Set([...(home.source_ids ?? []), ...permitSourceIds]));
  const sourcesById = await getSourcesByIds(allSourceIds);

  const address = [home.situs_num, home.situs_street].filter(Boolean).join(" ");
  const cityZip = [home.situs_city, home.situs_zip].filter(Boolean).join(" ");
  const stateCode = home.imprv_state_cd ?? home.land_state_cd;
  const parcelSourceId = home.source_ids?.[0];

  return (
    <div style={{ display: "grid", gap: "var(--space-6)" }}>
      <Panel>
        <h1
          style={{
            fontFamily: "var(--type-title-font-family)",
            fontSize: "var(--type-title-font-size)",
            fontWeight: "var(--type-title-font-weight)",
            marginTop: 0,
          }}
        >
          {address || home.prop_id}
        </h1>
        {cityZip ? <p style={{ color: "var(--theme-ink-muted)", marginTop: 0 }}>{cityZip}</p> : null}

        <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "var(--space-2) var(--space-4)" }}>
          <dt style={{ color: "var(--theme-ink-muted)" }}>State code</dt>
          <dd style={{ margin: 0 }}>
            {stateCode === null ? (
              <MissingState variant="not-loaded" reason="No imprv_state_cd/land_state_cd on this parcel record" />
            ) : (
              <ProvenanceFor sourceRow={sourcesById.get(parcelSourceId ?? "")} id={`${home.prop_id}-state-cd`}>
                <span style={{ fontFamily: "var(--type-data-font-family)" }}>{stateCode}</span>
              </ProvenanceFor>
            )}
          </dd>

          <dt style={{ color: "var(--theme-ink-muted)" }}>Homestead</dt>
          <dd style={{ margin: 0 }}>{home.is_homestead ? "Yes" : "No"}</dd>

          <dt style={{ color: "var(--theme-ink-muted)" }}>Single-family</dt>
          <dd style={{ margin: 0 }}>{home.is_single_family ? "Yes" : "No"}</dd>

          <dt style={{ color: "var(--theme-ink-muted)" }}>Market value</dt>
          <dd style={{ margin: 0 }}>
            {home.market_value === null ? (
              <MissingState variant="not-loaded" reason="Market value not recorded for this parcel" />
            ) : (
              <ProvenanceFor sourceRow={sourcesById.get(parcelSourceId ?? "")} id={`${home.prop_id}-market-value`}>
                <span style={{ fontFamily: "var(--type-data-font-family)" }}>
                  ${Number(home.market_value).toLocaleString()}
                </span>
              </ProvenanceFor>
            )}
          </dd>
        </dl>
      </Panel>

      <Panel>
        <h2
          style={{
            fontFamily: "var(--type-heading-font-family)",
            fontSize: "var(--type-heading-font-size)",
            fontWeight: "var(--type-heading-font-weight)",
            marginTop: 0,
          }}
        >
          Permits
        </h2>
        {home.permits.length === 0 ? (
          <MissingState
            variant="not-loaded"
            reason="No permits joined to this parcel yet (either none exist, or the permits pipeline hasn't loaded)"
          />
        ) : (
          <DataTable>
            <DataTableHead>
              <DataTableRow>
                <DataTableHeaderCell>Permit</DataTableHeaderCell>
                <DataTableHeaderCell>Issued</DataTableHeaderCell>
                <DataTableHeaderCell>Class</DataTableHeaderCell>
                <DataTableHeaderCell>Description</DataTableHeaderCell>
                <DataTableHeaderCell>Status</DataTableHeaderCell>
                <DataTableHeaderCell>Label</DataTableHeaderCell>
              </DataTableRow>
            </DataTableHead>
            <DataTableBody>
              {home.permits.map((permit) => (
                <DataTableRow key={permit.permit_number}>
                  <DataTableCell>
                    <ProvenanceFor
                      sourceRow={sourcesById.get(permit.source_id ?? "")}
                      id={`permit-${permit.permit_number}`}
                    >
                      <span style={{ fontFamily: "var(--type-data-font-family)" }}>{permit.permit_number}</span>
                    </ProvenanceFor>
                  </DataTableCell>
                  <DataTableCell>{permit.issue_date ?? "—"}</DataTableCell>
                  <DataTableCell>{permit.permit_class ?? permit.work_class ?? "—"}</DataTableCell>
                  <DataTableCell>{permit.description ?? "—"}</DataTableCell>
                  <DataTableCell>{permit.status_current ?? "—"}</DataTableCell>
                  <DataTableCell>
                    {permit.label === null ? (
                      <MissingState variant="not-loaded" reason="Not classified by the rules classifier yet" />
                    ) : (
                      <span>
                        {permit.label} ({permit.labeller})
                      </span>
                    )}
                  </DataTableCell>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </Panel>
    </div>
  );
}
