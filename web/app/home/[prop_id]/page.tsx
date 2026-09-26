import type { ReactNode } from "react";
import Link from "next/link";
import { query } from "../../../lib/db";
import { Panel } from "../../../components/ui/Panel";
import { MissingState } from "../../../components/ui/MissingState";
import { ProvenancePopover } from "../../../components/ui/ProvenancePopover";
import { PermitLabel } from "../../../components/PermitLabel";
import { ParcelMap } from "../../../components/ParcelMap";
import { SolarPanel } from "../../../components/SolarPanel";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
} from "../../../components/ui/DataTable";

// M1-W1/M1-W3: /home/[prop_id], from api.home_detail — parcel facts (state
// code, homestead, situs, market value) and its permits, each with a
// provenance popover, plus (M1-W3 fix #4, HomeDetail.dc.html): score,
// rank, block group, a "Why this home" reasoning section, a mini parcel
// map, and a breadcrumb back to Ranking. Product rule (explicit,
// non-negotiable for M1): no outage figure appears on this page. The
// county EAGLE-I total customer-hours (api.county_outage) is a
// *county-level* number and does not apply to a single home; a
// per-distributor outage signal for homes arrives in a later milestone.
// Do not add one here.

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

interface ScoreContextRow {
  block_group_geoid: string | null;
  score: string | number | null;
  score_null_reason: string | null;
  rate_per_1000: string | number | null;
  homes_gated: string | number | null;
  bg_rank: string | number | null;
  bg_scored_count: string | number | null;
}

interface TopHomeRankRow {
  rank: string | number;
  total: string | number;
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

// Reads core.mv_home_block_group (perf(M1) materialization — see
// 0102_m1_materialize.sql), not a live ST_Within join: that spatial join
// is exactly what used to time out /ranking before it was materialized,
// and this per-home lookup would hit the same cost without it. The mv
// only contains gated (single-family + homestead) homes with geometry —
// a home outside that gate has no row here, which reads as "not gated
// for scoring", a real and distinct reason from "gated but not scored
// yet". Wrapped in try/catch so an unrefreshed/unavailable mv degrades to
// an honest MissingState instead of a 500.
async function getScoreContext(propId: string): Promise<ScoreContextRow | null> {
  try {
    const rows = await query<ScoreContextRow>(
      `with ranked_bgs as (
         select block_group_geoid, score,
                rank() over (order by score desc) as bg_rank,
                count(*) over () as bg_scored_count
         from api.blockgroup_scores
         where score is not null
       )
       select
         hbg.block_group_geoid,
         bs.score,
         coalesce(bs.score_null_reason, 'no_permit_coverage') as score_null_reason,
         bs.rate_per_1000,
         bs.homes_gated,
         rb.bg_rank,
         rb.bg_scored_count
       from core.mv_home_block_group hbg
       left join api.blockgroup_scores bs on bs.block_group_geoid = hbg.block_group_geoid
       left join ranked_bgs rb on rb.block_group_geoid = hbg.block_group_geoid
       where hbg.prop_id = $1`,
      [propId]
    );
    return rows[0] ?? null;
  } catch (err) {
    console.error("home-detail: failed to load score context", err);
    return null;
  }
}

async function getTopHomeRank(propId: string): Promise<TopHomeRankRow | null> {
  try {
    const rows = await query<TopHomeRankRow>(
      `with ranked as (
         select prop_id,
                row_number() over (order by score desc, market_value desc nulls last) as rank,
                count(*) over () as total
         from api.top_homes
       )
       select rank, total from ranked where prop_id = $1`,
      [propId]
    );
    return rows[0] ?? null;
  } catch (err) {
    console.error("home-detail: failed to load top_homes rank", err);
    return null;
  }
}

async function getParcelGeojson(propId: string): Promise<GeoJSON.Polygon | GeoJSON.MultiPolygon | null> {
  try {
    const rows = await query<{ geojson: string | null }>(
      `select extensions.ST_AsGeoJSON(pg.geom) as geojson
       from core.parcel_geoms pg
       where pg.prop_id = $1`,
      [propId]
    );
    const raw = rows[0]?.geojson ?? null;
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error("home-detail: failed to load parcel geometry", err);
    return null;
  }
}

async function classifierHasRun(): Promise<boolean> {
  try {
    const rows = await query<{ ran: boolean }>(
      `select exists(select 1 from core.permit_labels where labeller = 'rules') as ran`
    );
    return rows[0]?.ran ?? false;
  } catch (err) {
    console.error("home-detail: failed to check classifier state", err);
    return false;
  }
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

function NotRecorded() {
  return <span style={{ color: "var(--theme-ink-muted)" }}>Not recorded</span>;
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

  const [sourcesById, scoreContext, topHomeRank, parcelGeojson, rulesHaveRun] = await Promise.all([
    getSourcesByIds(allSourceIds),
    getScoreContext(home.prop_id),
    getTopHomeRank(home.prop_id),
    getParcelGeojson(home.prop_id),
    classifierHasRun(),
  ]);

  const address = [home.situs_num, home.situs_street].filter(Boolean).join(" ");
  const cityZip = [home.situs_city, home.situs_zip].filter(Boolean).join(" ");
  const stateCode = home.imprv_state_cd ?? home.land_state_cd;
  const parcelSourceId = home.source_ids?.[0];

  const score = scoreContext?.score === null || scoreContext?.score === undefined ? null : Number(scoreContext.score);
  const ratePer1000 =
    scoreContext?.rate_per_1000 === null || scoreContext?.rate_per_1000 === undefined
      ? null
      : Number(scoreContext.rate_per_1000);

  return (
    <div style={{ display: "grid", gap: "var(--space-6)" }}>
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link href="/ranking">Ranking</Link>
        <span className="breadcrumb__separator" aria-hidden="true">
          /
        </span>
        <span>{address || home.prop_id}</span>
      </nav>

      <Panel>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--space-6)" }}>
          <div>
            <h1
              style={{
                fontFamily: "var(--type-title-font-family)",
                fontSize: "var(--type-title-font-size)",
                fontWeight: "var(--type-title-font-weight)",
                margin: 0,
              }}
            >
              {address || home.prop_id}
            </h1>
            {cityZip ? <p style={{ color: "var(--theme-ink-muted)", margin: "var(--space-1) 0" }}>{cityZip}</p> : null}
            <div style={{ fontFamily: "var(--type-data-font-family)", fontSize: "var(--type-data-font-size)", color: "var(--theme-ink-muted)" }}>
              prop_id {home.prop_id}
              {home.geo_id ? ` · geo_id ${home.geo_id}` : ""}
              {scoreContext?.block_group_geoid ? ` · block group ${scoreContext.block_group_geoid}` : ""}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "var(--space-1)" }}>
            <span style={{ fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>Score</span>
            {score === null ? (
              <MissingState
                variant="not-loaded"
                reason={scoreContext?.score_null_reason ?? "This home's block group has no score yet"}
              />
            ) : (
              <span
                style={{
                  fontFamily: "var(--type-figure-font-family)",
                  fontSize: "var(--type-figure-font-size)",
                  fontWeight: "var(--type-figure-font-weight)",
                }}
              >
                {score.toFixed(3)}
              </span>
            )}
            {topHomeRank ? (
              <span style={{ fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
                Rank {Number(topHomeRank.rank)} of {Number(topHomeRank.total)} in top homes
              </span>
            ) : scoreContext?.bg_rank ? (
              <span style={{ fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
                Block group ranks {Number(scoreContext.bg_rank)} of {Number(scoreContext.bg_scored_count)} scored
              </span>
            ) : null}
          </div>
        </div>

        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginTop: "var(--space-4)" }}>
          {home.is_single_family ? <span className="chip">Single-family (A1)</span> : null}
          {home.is_homestead ? <span className="chip">Homestead</span> : null}
        </div>
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
          Why this home
        </h2>
        {score === null ? (
          <MissingState
            variant="not-loaded"
            reason={scoreContext?.score_null_reason ?? "Not yet scored — block group score not computed"}
          />
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 160px", gap: "var(--space-4)", alignItems: "center" }}>
            <span>
              {ratePer1000 === null ? (
                <MissingState variant="not-loaded" reason="Rate not computed for this block group" />
              ) : (
                <>
                  <span style={{ fontWeight: 600, fontFamily: "var(--type-data-font-family)" }}>
                    {ratePer1000.toFixed(2)}
                  </span>{" "}
                  battery/generator permits per 1,000 gated homes in block group{" "}
                  {scoreContext?.block_group_geoid ?? "—"} (36 months)
                </>
              )}
            </span>
            <span style={{ fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
              Percentile {(score * 100).toFixed(0)} · same for all homes in this block group
            </span>
          </div>
        )}
      </Panel>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: "var(--space-6)" }}>
        <Panel>
          <h2
            style={{
              fontFamily: "var(--type-heading-font-family)",
              fontSize: "var(--type-heading-font-size)",
              fontWeight: "var(--type-heading-font-weight)",
              marginTop: 0,
            }}
          >
            Permits on this parcel
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
                    <DataTableCell>{permit.issue_date ?? <NotRecorded />}</DataTableCell>
                    <DataTableCell>{permit.permit_class ?? permit.work_class ?? <NotRecorded />}</DataTableCell>
                    <DataTableCell>{permit.description ?? <NotRecorded />}</DataTableCell>
                    <DataTableCell>{permit.status_current ?? <NotRecorded />}</DataTableCell>
                    <DataTableCell>
                      <PermitLabel label={permit.label} labeller={permit.labeller} classifierHasRun={rulesHaveRun} />
                    </DataTableCell>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          )}
        </Panel>

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
          <Panel>
            <h2
              style={{
                fontFamily: "var(--type-heading-font-family)",
                fontSize: "var(--type-heading-font-size)",
                fontWeight: "var(--type-heading-font-weight)",
                marginTop: 0,
              }}
            >
              Parcel
            </h2>
            {parcelGeojson ? (
              <ParcelMap geojson={parcelGeojson} />
            ) : (
              <MissingState variant="not-loaded" reason="No parcel geometry loaded for this prop_id yet" />
            )}
            <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "var(--space-2) var(--space-4)", marginTop: "var(--space-3)" }}>
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

          <SolarPanel propId={home.prop_id} />
        </div>
      </div>
    </div>
  );
}
