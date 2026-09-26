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
  score: string | number;
}

// M2-W1: core.mv_home_signals (0201_m2.sql) — every M2 per-home gate +
// need signal, read directly rather than through an `api` view: no view
// over this mv exists yet (api.top_homes_weighted only returns the top
// 50), and the ticket explicitly calls for "a small server query or an
// api view if one exists". Every join in the mv is LEFT JOIN, so a row
// always exists once the home is in the M1 gated universe
// (core.mv_home_block_group) — gate_reason/null_reason columns say why a
// given signal is missing, never a silent 0.
interface HomeSignalsRow {
  gate_reason: string | null;
  territory_null_reason: string | null;
  territory_eia_id: string | null;
  distributor_name: string | null;
  distributor_saidi: string | number | null;
  distributor_saidi_year: number | null;
  distributor_saidi_early_release: boolean | null;
  distributor_saidi_null_reason: string | null;
  flood_flag: boolean | null;
  flood_null_reason: string | null;
  empower_rate: string | number | null;
  empower_null_reason: string | null;
  acs_pct_65_plus: string | number | null;
  acs_65_null_reason: string | null;
  acs_pct_electric_heat: string | number | null;
  acs_heat_null_reason: string | null;
  backup_intent_rate: string | number | null;
  backup_intent_null_reason: string | null;
  source_ids: string[] | null;
}

const GATE_REASON_LABEL: Record<string, string> = {
  territory_not_base_served: "Not in a utility Base serves (HIFLD polygon match, or Base's served-utilities list does not mark it mapped=yes)",
};

// M2-W4: regulated (no retail choice, e.g. Austin Energy municipal) vs
// deregulated (retail choice, e.g. Oncor) market, from api.retail_market
// (0206_retail_market.sql) -- a single row keyed by eia_utility_number,
// the same EIA-861 number homeSignals.territory_eia_id already carries.
// A PK/unique-index lookup, well under the 50 ms budget.
interface RetailMarketRow {
  eia_utility_number: string;
  utility_name: string | null;
  retail_market: "deregulated" | "not_deregulated";
  plain_language: string;
  source_url: string;
  quote: string;
  retrieved_at: string | Date;
  source_id: string;
}

async function getRetailMarket(eiaId: string): Promise<RetailMarketRow | null> {
  try {
    const rows = await query<RetailMarketRow>(
      `select eia_utility_number, utility_name, retail_market, plain_language,
              source_url, quote, retrieved_at, source_id
       from api.retail_market
       where eia_utility_number = $1`,
      [eiaId]
    );
    return rows[0] ?? null;
  } catch (err) {
    console.error("home-detail: failed to load api.retail_market", err);
    return null;
  }
}

async function getHomeSignals(propId: string): Promise<HomeSignalsRow | null> {
  try {
    const rows = await query<HomeSignalsRow>(
      `select gate_reason, territory_null_reason, territory_eia_id,
              distributor_name, distributor_saidi, distributor_saidi_year,
              distributor_saidi_early_release, distributor_saidi_null_reason,
              flood_flag, flood_null_reason,
              empower_rate, empower_null_reason,
              acs_pct_65_plus, acs_65_null_reason,
              acs_pct_electric_heat, acs_heat_null_reason,
              backup_intent_rate, backup_intent_null_reason,
              source_ids
       from core.mv_home_signals
       where prop_id = $1`,
      [propId]
    );
    return rows[0] ?? null;
  } catch (err) {
    console.error("home-detail: failed to load core.mv_home_signals", err);
    return null;
  }
}

// core.mv_home_signals.distributor_saidi_null_reason only distinguishes
// "no territory match" / "EIA-861 not loaded at all" / a generic
// "no_eia861_figure_for_distributor" — it can't carry EIA's own reason
// for a specific distributor+year (e.g. Oncor 44372's real reason is the
// literal "not_reported", loaded as core.utility_reliability.
// saidi_incl_major_null_reason, per M2-P7/0201_m2.sql) because the mv's
// lateral join only selects rows where saidi_incl_major IS NOT NULL. A
// distributor that IS matched but has no reported figure is "not
// available" (a real, permanent absence from EIA), not "not loaded" (a
// pipeline that hasn't run yet) — so this looks up the real reason
// directly when a territory match exists but distributor_saidi is null.
async function getDistributorSaidiNullReason(eiaId: string): Promise<string | null> {
  try {
    const rows = await query<{ saidi_incl_major_null_reason: string | null }>(
      `select saidi_incl_major_null_reason
       from core.utility_reliability
       where eia_id = $1
       order by year desc
       limit 1`,
      [eiaId]
    );
    return rows[0]?.saidi_incl_major_null_reason ?? null;
  } catch (err) {
    console.error("home-detail: failed to load core.utility_reliability null reason", err);
    return null;
  }
}

/** Finds the api.sources row whose `source` label contains one of `needles` (case-insensitive). */
function findSourceByName(
  sourcesById: Map<string, SourceRow>,
  sourceIds: string[] | null | undefined,
  needles: string[]
): SourceRow | undefined {
  if (!sourceIds) return undefined;
  for (const id of sourceIds) {
    const row = sourcesById.get(id);
    if (row && needles.some((n) => row.source.toLowerCase().includes(n))) return row;
  }
  return undefined;
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
      // Same ranking the /ranking page shows by default (equal weights),
      // so the header can never disagree with the table.
      `with ranked as (
         select prop_id, score,
                row_number() over () as rank,
                count(*) over () as total
         from api.top_homes_weighted(
           '{"outage":1,"flood":1,"empower":1,"age65":1,"electric_heat":1,"backup_intent":1}'::jsonb,
           (select county_fips from core.mv_home_signals where prop_id = $1)
         )
       )
       select rank, total, score from ranked where prop_id = $1`,
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
          reason={`No Travis County parcel with ID ${prop_id}`}
        />
      </Panel>
    );
  }

  const home = rows[0];
  const homeSignals = await getHomeSignals(home.prop_id);
  const distributorSaidiRealNullReason =
    homeSignals && homeSignals.distributor_saidi === null && homeSignals.territory_eia_id
      ? await getDistributorSaidiNullReason(homeSignals.territory_eia_id)
      : null;
  const retailMarket = homeSignals?.territory_eia_id
    ? await getRetailMarket(homeSignals.territory_eia_id)
    : null;
  const permitSourceIds = home.permits.map((p) => p.source_id).filter((s): s is string => !!s);
  const allSourceIds = Array.from(
    new Set([
      ...(home.source_ids ?? []),
      ...permitSourceIds,
      ...(homeSignals?.source_ids ?? []),
      ...(retailMarket ? [retailMarket.source_id] : []),
    ])
  );

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
              Travis CAD property {home.prop_id}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "var(--space-1)" }}>
            <span style={{ fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>Score (equal weights)</span>
            {topHomeRank ? (
              <>
                <span
                  style={{
                    fontFamily: "var(--type-figure-font-family)",
                    fontSize: "var(--type-figure-font-size)",
                    fontWeight: "var(--type-figure-font-weight)",
                  }}
                >
                  {Number(topHomeRank.score).toFixed(3)}
                </span>
                <span style={{ fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
                  #{Number(topHomeRank.rank)} in Travis County at equal weights
                </span>
              </>
            ) : (
              <a href="/ranking" style={{ fontSize: "var(--type-label-font-size)", maxWidth: "220px", textAlign: "right" }}>
                See where it ranks
              </a>
            )}
          </div>
        </div>

        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginTop: "var(--space-4)" }}>
          {home.is_single_family ? <span className="chip">Single-family home</span> : null}
          {home.is_homestead ? <span className="chip">Owner-occupied (homestead)</span> : null}
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

        {homeSignals === null ? (
          <MissingState
            variant="not-loaded"
            reason="Not scored: only owner-occupied single-family homes with a mapped lot inside Travis County are ranked"
          />
        ) : homeSignals.gate_reason ? (
          <div
            style={{
              backgroundColor: "var(--color-excluded-fill)",
              color: "var(--theme-ink)",
              borderRadius: "var(--rounded-sm)",
              padding: "var(--space-3)",
              marginBottom: "var(--space-4)",
            }}
          >
            <strong>Excluded from ranking:</strong>{" "}
            {GATE_REASON_LABEL[homeSignals.gate_reason] ?? homeSignals.gate_reason}
          </div>
        ) : homeSignals.territory_null_reason ? (
          <div style={{ marginBottom: "var(--space-4)" }}>
            <MissingState
              variant="not-loaded"
              reason={`Whether Base serves this home's utility isn't resolvable yet (${homeSignals.territory_null_reason}) — it passes by default until it is`}
            />
          </div>
        ) : null}

        {homeSignals ? (
          <dl style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: "var(--space-4) var(--space-6)", margin: 0 }}>
            <div>
              <dt style={{ color: "var(--theme-ink-muted)", fontSize: "var(--type-label-font-size)" }}>Outage exposure</dt>
              <dd style={{ margin: "var(--space-1) 0 0 0" }}>
                {homeSignals.distributor_saidi === null ? (
                  distributorSaidiRealNullReason ? (
                    // A real EIA-861 distributor is matched (e.g. Oncor
                    // 44372) but EIA itself reports no figure for it —
                    // "not available", not "not loaded": the pipeline has
                    // run and this is EIA's own stated reason (e.g.
                    // "not_reported"), never a made-up one.
                    <MissingState variant="not-available" reason={distributorSaidiRealNullReason} />
                  ) : (
                    <MissingState
                      variant="not-loaded"
                      reason={homeSignals.distributor_saidi_null_reason ?? "No distributor SAIDI figure"}
                    />
                  )
                ) : (
                  <>
                    <ProvenanceFor
                      sourceRow={findSourceByName(sourcesById, homeSignals.source_ids, ["eia861", "eia-861", "reliability"])}
                      id={`${home.prop_id}-outage`}
                    >
                      <span>
                        {homeSignals.distributor_name ?? "This distributor"}'s customers averaged{" "}
                        <span style={{ fontFamily: "var(--type-data-font-family)", fontWeight: 600 }}>
                          {Number(homeSignals.distributor_saidi).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </span>{" "}
                        minutes without power in {homeSignals.distributor_saidi_year} (SAIDI, incl. major events)
                      </span>
                    </ProvenanceFor>
                    {homeSignals.distributor_saidi_early_release ? (
                      <div style={{ fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
                        Early release, not fully edited (EIA-861)
                      </div>
                    ) : null}
                  </>
                )}
              </dd>
            </div>

            <div>
              <dt style={{ color: "var(--theme-ink-muted)", fontSize: "var(--type-label-font-size)" }}>Electricity market</dt>
              <dd style={{ margin: "var(--space-1) 0 0 0" }}>
                {homeSignals.territory_eia_id === null ? (
                  <MissingState
                    variant="not-loaded"
                    reason="No utility territory match for this home yet — the electricity market can't be shown without one"
                  />
                ) : retailMarket === null ? (
                  <MissingState
                    variant="not-available"
                    reason="This home's utility isn't in Base's cited retail-market list yet"
                  />
                ) : (
                  (() => {
                    const marketManifest = sourcesById.get(retailMarket.source_id);
                    // Reuses the existing ProvenancePopover as-is (DESIGN.md:
                    // reuse tokens/base components, never invent new ones) —
                    // its "Dataset" row is repurposed to carry Base's own
                    // verbatim quote as the link text, hrefed to Base's
                    // source page (retailMarket.source_url), while
                    // retrieved/SHA-256/run/raw-file still describe the
                    // loaded data/manual/retail_market.csv snapshot.
                    if (!marketManifest) return <span>{retailMarket.plain_language}</span>;
                    return (
                      <ProvenancePopover
                        id={`${home.prop_id}-retail-market`}
                        dataset={`"${retailMarket.quote}"`}
                        url={retailMarket.source_url}
                        retrievedAt={
                          marketManifest.retrieved_at instanceof Date
                            ? marketManifest.retrieved_at.toISOString()
                            : String(marketManifest.retrieved_at)
                        }
                        sha256={marketManifest.sha256}
                        runId={marketManifest.latest_run_id ?? "none"}
                        runner={marketManifest.runner}
                        rowsIn={marketManifest.latest_run_rows_in ?? null}
                        rowsLoaded={marketManifest.latest_run_rows_loaded ?? null}
                        rawFileHref={`/sources/raw/${marketManifest.source_id}`}
                      >
                        <span>{retailMarket.plain_language}</span>
                      </ProvenancePopover>
                    );
                  })()
                )}
              </dd>
            </div>

            <div>
              <dt style={{ color: "var(--theme-ink-muted)", fontSize: "var(--type-label-font-size)" }}>Flood zone</dt>
              <dd style={{ margin: "var(--space-1) 0 0 0" }}>
                {homeSignals.flood_flag === null ? (
                  <MissingState variant="not-loaded" reason={homeSignals.flood_null_reason ?? "Flood zones not loaded"} />
                ) : (
                  <ProvenanceFor
                    sourceRow={findSourceByName(sourcesById, homeSignals.source_ids, ["nfhl", "flood"])}
                    id={`${home.prop_id}-flood`}
                  >
                    <span>{homeSignals.flood_flag ? "Inside a FEMA high-risk flood zone" : "Outside FEMA high-risk flood zones"}</span>
                  </ProvenanceFor>
                )}
              </dd>
            </div>

            <div>
              <dt style={{ color: "var(--theme-ink-muted)", fontSize: "var(--type-label-font-size)" }}>Medical need (emPOWER)</dt>
              <dd style={{ margin: "var(--space-1) 0 0 0" }}>
                {homeSignals.empower_rate === null ? (
                  <MissingState
                    variant={homeSignals.empower_null_reason === "suppressed_1_to_10" ? "not-available" : "not-loaded"}
                    reason={homeSignals.empower_null_reason ?? "No emPOWER figure"}
                  />
                ) : (
                  <ProvenanceFor
                    sourceRow={findSourceByName(sourcesById, homeSignals.source_ids, ["empower"])}
                    id={`${home.prop_id}-empower`}
                  >
                    <span>
                      <span style={{ fontFamily: "var(--type-data-font-family)", fontWeight: 600 }}>
                        {(Number(homeSignals.empower_rate) * 1000).toFixed(1)}
                      </span>{" "}
                      power-dependent Medicare devices per 1,000 Medicare beneficiaries in this ZIP
                    </span>
                  </ProvenanceFor>
                )}
              </dd>
            </div>

            <div>
              <dt style={{ color: "var(--theme-ink-muted)", fontSize: "var(--type-label-font-size)" }}>Age 65+ (ACS)</dt>
              <dd style={{ margin: "var(--space-1) 0 0 0" }}>
                {homeSignals.acs_pct_65_plus === null ? (
                  <MissingState variant="not-loaded" reason={homeSignals.acs_65_null_reason ?? "No ACS figure"} />
                ) : (
                  <ProvenanceFor
                    sourceRow={findSourceByName(sourcesById, homeSignals.source_ids, ["acs", "census"])}
                    id={`${home.prop_id}-age65`}
                  >
                    <span>
                      <span style={{ fontFamily: "var(--type-data-font-family)", fontWeight: 600 }}>
                        {(Number(homeSignals.acs_pct_65_plus) * 100).toFixed(1)}%
                      </span>{" "}
                      of this block group's population is 65+ (ACS 2024, same for all homes in block group)
                    </span>
                  </ProvenanceFor>
                )}
              </dd>
            </div>

            <div>
              <dt style={{ color: "var(--theme-ink-muted)", fontSize: "var(--type-label-font-size)" }}>Electric heat (ACS)</dt>
              <dd style={{ margin: "var(--space-1) 0 0 0" }}>
                {homeSignals.acs_pct_electric_heat === null ? (
                  <MissingState variant="not-loaded" reason={homeSignals.acs_heat_null_reason ?? "No ACS figure"} />
                ) : (
                  <ProvenanceFor
                    sourceRow={findSourceByName(sourcesById, homeSignals.source_ids, ["acs", "census"])}
                    id={`${home.prop_id}-heat`}
                  >
                    <span>
                      <span style={{ fontFamily: "var(--type-data-font-family)", fontWeight: 600 }}>
                        {(Number(homeSignals.acs_pct_electric_heat) * 100).toFixed(1)}%
                      </span>{" "}
                      of housing units in this block group heat with electricity (ACS 2024, same for all homes in block group)
                    </span>
                  </ProvenanceFor>
                )}
              </dd>
            </div>

            <div>
              <dt style={{ color: "var(--theme-ink-muted)", fontSize: "var(--type-label-font-size)" }}>Backup intent</dt>
              <dd style={{ margin: "var(--space-1) 0 0 0" }}>
                {homeSignals.backup_intent_rate === null ? (
                  <MissingState
                    variant="not-loaded"
                    reason={homeSignals.backup_intent_null_reason ?? "Rate not computed for this block group"}
                  />
                ) : (
                  <span>
                    <span style={{ fontFamily: "var(--type-data-font-family)", fontWeight: 600 }}>
                      {Number(homeSignals.backup_intent_rate).toFixed(2)}
                    </span>{" "}
                    battery or generator permits per 1,000 owner-occupied homes in this neighborhood (36 months, same for all homes in block group)
                  </span>
                )}
              </dd>
            </div>
          </dl>
        ) : null}
      </Panel>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: "var(--space-6)", alignItems: "start" }}>
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
            homeSignals?.backup_intent_null_reason === "no_permit_coverage" ? (
              <MissingState variant="not-available" reason="no_permit_coverage" />
            ) : (
              <p style={{ margin: 0, color: "var(--theme-ink-muted)" }}>No City of Austin permits on file for this home.</p>
            )
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
              <MissingState variant="not-loaded" reason="No lot outline on file for this parcel" />
            )}
            <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "var(--space-2) var(--space-4)", marginTop: "var(--space-3)" }}>
              <dt style={{ color: "var(--theme-ink-muted)" }}>Property type</dt>
              <dd style={{ margin: 0 }}>
                {stateCode === null ? (
                  <MissingState variant="not-loaded" reason="No property type on this parcel record" />
                ) : (
                  <ProvenanceFor sourceRow={sourcesById.get(parcelSourceId ?? "")} id={`${home.prop_id}-state-cd`}>
                    <span>{stateCode === "A1" ? "Single-family home" : stateCode} <span style={{ fontFamily: "var(--type-data-font-family)", color: "var(--theme-ink-muted)" }}>({stateCode})</span></span>
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
