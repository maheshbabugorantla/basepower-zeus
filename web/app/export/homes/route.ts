import { NextRequest } from "next/server";
import { query } from "../../../lib/db";
import { COUNTY_CANDIDATES, DEFAULT_COUNTY } from "../../../lib/counties";
import {
  CSV_CAP,
  csvFilename,
  csvResponseHeaders,
  csvRow,
  formatPredictedReasons,
  formatUtilityStatus,
  formatWeightedPermitPath,
  formatWeightedReasons,
  isoDate,
  makeSourcesResolver,
  permitPathFromTerritory,
  type PropensityReason,
} from "../shared";

// M5-W1: ranked-homes CSV export for territory planning. Real rows only
// -- every home comes from the same gated population (core.mv_home_
// signals.gate_reason is null: single-family, owner-occupied, inside a
// Base-served territory) the ranking screen itself shows, and every
// "sources" cell resolves to a real ops.source_manifest row via
// api.sources. Two exports with no pipeline run in between are
// byte-identical (the ticket's acceptance criterion): no wall-clock
// value goes in the body (the generation date is in the filename's
// first-comment-row date only, which is stable within a day), every
// query orders on a full tiebreak (score/p desc, prop_id asc), and every
// number is formatted with a fixed .toFixed rule, never toLocaleString.
//
// M-urlstate (item 4): RankingBoard now syncs mode/weights/backup/pre2000/
// city/zip/bg into the URL (window.history.replaceState), and ExportButton
// forwards the CURRENT url's params verbatim, so this route's own
// query-param contract below is exactly what's on screen, not a set of
// defaults a caller has to know to override by hand:
//   mode=predicted|weighted   (default predicted, the ranking default)
//   backup=hide|show          (default hide, matches the ranking screen's default)
//   pre2000=show|hide         (default show, matches the ranking screen's default)
//   city=<value>, zip=<value>, bg=<block-group-geoid> (drill-down filters;
//                              omitted = no filter, empty string = the
//                              "no value on file" bucket)
//   w_<signal_key>=<number>   (weighted mode only; any key omitted falls
//                              back to api.default_weights, then equal=5)

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PAGE_SIZE = 1000;
const HIDE_OLD_HOMES_CUTOFF_YEAR = 2000;

const SIGNAL_KEYS = [
  "outage",
  "home_value",
  "backup_intent",
  "age65",
  "home_permits",
  "electric_heat",
  "empower",
  "owner_65",
  "installability",
  "flood",
  "income_100k",
  "age_35_64",
  "permit_risk",
] as const;
type SignalKey = (typeof SIGNAL_KEYS)[number];

function resolveCountyOption(fips: string | null) {
  return COUNTY_CANDIDATES.find((c) => c.fips === fips) ?? DEFAULT_COUNTY;
}

async function getWeightsFromParams(params: URLSearchParams): Promise<Record<SignalKey, number>> {
  const out = {} as Record<SignalKey, number>;
  let anyFromUrl = false;
  for (const key of SIGNAL_KEYS) {
    const raw = params.get(`w_${key}`);
    const n = raw !== null ? Number(raw) : NaN;
    if (Number.isFinite(n) && n > 0) {
      out[key] = n;
      anyFromUrl = true;
    }
  }
  if (anyFromUrl) {
    for (const key of SIGNAL_KEYS) if (!(key in out)) out[key] = 0;
    return out;
  }
  // No weights on the URL -- fall back to the ranking screen's own
  // first-paint defaults (api.default_weights), then equal=5 for every
  // key only if that view can't be read at all.
  try {
    const rows = await query<{ signal_key: string; weight: string | number }>(
      `select signal_key, weight from api.default_weights`
    );
    const byKey = new Map(rows.map((r) => [r.signal_key, Number(r.weight)]));
    for (const key of SIGNAL_KEYS) out[key] = byKey.get(key) ?? 5;
  } catch {
    for (const key of SIGNAL_KEYS) out[key] = 5;
  }
  return out;
}

interface PredictedDbRow {
  prop_id: string;
  situs_num: string | null;
  situs_street: string | null;
  situs_city: string | null;
  situs_zip: string | null;
  p_install_12m: string;
  relative_to_county: string | number | null;
  reasons: PropensityReason[] | null;
  extrapolated_from: string | null;
  distributor_name: string | null;
  territory_eia_id: string | null;
  territory_basis: string | null;
  territory_null_reason: string | null;
  outage_minutes: string | number | null;
  outage_basis: string | null;
  source_ids: string[] | null;
  model_source_ids: string[] | null;
}

interface WeightedDbRow {
  prop_id: string;
  situs_num: string | null;
  situs_street: string | null;
  situs_city: string | null;
  situs_zip: string | null;
  score: string | number | null;
  reasons: string[] | null;
  distributor_name: string | null;
  territory_eia_id: string | null;
  territory_basis: string | null;
  territory_null_reason: string | null;
  outage_minutes: string | number | null;
  outage_basis: string | null;
  permit_path: string | null;
  yr_built: number | null;
  source_ids: string[] | null;
  outage_source_ids: string[] | null;
}

function formatNumber(n: number | string | null, decimals: number): string {
  if (n === null) return "";
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  return v.toFixed(decimals);
}

function formatAddress(row: { situs_num: string | null; situs_street: string | null }): string {
  return [row.situs_num, row.situs_street].filter(Boolean).join(" ");
}

const HEADER = [
  "rank",
  "address",
  "city",
  "zip",
  "county",
  "likelihood_p_install_12m",
  "times_county_average",
  "top_reasons",
  "score_weighted_mode",
  "outage_basis",
  "outage_minutes",
  "market",
  "permit_path",
  "utility",
  "utility_confirmation_status",
  "extrapolated_from",
  "sources",
];

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const county = resolveCountyOption(params.get("county"));
  const mode: "predicted" | "weighted" = params.get("mode") === "weighted" ? "weighted" : "predicted";
  const excludeBackup = params.get("backup") !== "show"; // default hide
  const hideOldHomes = params.get("pre2000") === "hide"; // default show
  // M-urlstate (item 4): city/ZIP/block-group drill-down, forwarded by
  // ExportButton from the current url exactly like mode/backup/pre2000
  // above -- null = no filter, "" = the "no value on file" bucket (same
  // convention as app/api/top-homes/route.ts's situsCity/situsZip).
  const blockGroupGeoid = params.get("bg");
  const situsCity = params.get("city");
  const situsZip = params.get("zip");

  const today = isoDate(new Date());
  const filename = csvFilename(county.name, `ranked-homes-${mode}`, today);
  const resolveSources = await makeSourcesResolver(query);
  const weights = mode === "weighted" ? await getWeightsFromParams(params) : null;

  async function lookupMarket(territoryEiaIds: (string | null)[]): Promise<Map<string, string>> {
    const ids = Array.from(new Set(territoryEiaIds.filter((id): id is string => !!id)));
    if (ids.length === 0) return new Map();
    const rows = await query<{ eia_utility_number: string; plain_language: string }>(
      `select eia_utility_number, plain_language from api.retail_market where eia_utility_number = any($1::text[])`,
      [ids]
    );
    return new Map(rows.map((r) => [r.eia_utility_number, r.plain_language]));
  }

  // api.homes_ranked_weighted's return table has no territory_basis/
  // territory_null_reason column (only api.home_detail's underlying
  // core.mv_home_signals carries those, per 0303) -- looked up here in one
  // extra PK-batch query per page so weighted-mode CSV rows get the same
  // utility_status column predicted-mode rows get straight from the join.
  async function lookupTerritoryBasis(
    propIds: string[]
  ): Promise<Map<string, { basis: string | null; nullReason: string | null }>> {
    if (propIds.length === 0) return new Map();
    const rows = await query<{ prop_id: string; territory_basis: string | null; territory_null_reason: string | null }>(
      `select prop_id, territory_basis, territory_null_reason from core.mv_home_signals where prop_id = any($1::text[])`,
      [propIds]
    );
    return new Map(rows.map((r) => [r.prop_id, { basis: r.territory_basis, nullReason: r.territory_null_reason }]));
  }

  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(
          encoder.encode(
            `# Base Power Zeus ranked-homes export -- ${county.name} County -- ${mode} mode -- capped at ${CSV_CAP} rows -- generated ${today}\r\n`
          )
        );
        controller.enqueue(encoder.encode(csvRow(HEADER)));

        let rank = 0;
        let emittedRows = 0;

        if (mode === "predicted") {
          let afterP: string | null = null;
          let afterPropId: string | null = null;
          while (emittedRows < CSV_CAP) {
            const rows: PredictedDbRow[] = await query<PredictedDbRow>(
              `select hp.prop_id, pc.situs_num, pc.situs_street, pc.situs_city, pc.situs_zip,
                      hp.p_install_12m::text as p_install_12m, hp.relative_to_county, hp.reasons, hp.extrapolated_from,
                      s.distributor_name, s.territory_eia_id, s.territory_basis, s.territory_null_reason,
                      s.outage_minutes, s.outage_basis,
                      s.source_ids, hp.source_ids as model_source_ids
               from core.home_propensity hp
               join core.mv_home_signals s on s.prop_id = hp.prop_id
               join core.parcels pc on pc.prop_id = hp.prop_id
               left join core.home_coverage hc on hc.prop_id = hp.prop_id
               where s.gate_reason is null
                 and s.county_fips = $1
                 and ($2::boolean = false or coalesce(hc.bucket, 'prospect') not in ('base_customer', 'other_backup'))
                 and ($3::boolean = false or s.yr_built is null or s.yr_built >= ${HIDE_OLD_HOMES_CUTOFF_YEAR})
                 and ($7::text is null or s.block_group_geoid = $7)
                 and ($8::text is null or coalesce(pc.situs_city, '') = $8)
                 and ($9::text is null or coalesce(pc.situs_zip, '') = $9)
                 and (
                   $4::numeric is null
                   or hp.p_install_12m < $4::numeric
                   or (hp.p_install_12m = $4::numeric and hp.prop_id > $5::text)
                 )
               order by hp.p_install_12m desc, hp.prop_id asc
               limit $6`,
              [county.fips, excludeBackup, hideOldHomes, afterP, afterPropId, PAGE_SIZE, blockGroupGeoid, situsCity, situsZip]
            );
            if (rows.length === 0) break;

            const marketByEiaId = await lookupMarket(rows.map((r: PredictedDbRow) => r.territory_eia_id));

            for (const row of rows) {
              if (emittedRows >= CSV_CAP) break;
              rank += 1;
              const market = marketByEiaId.get(row.territory_eia_id ?? "");
              const sources = await resolveSources([...(row.source_ids ?? []), ...(row.model_source_ids ?? [])]);
              controller.enqueue(
                encoder.encode(
                  csvRow([
                    rank,
                    formatAddress(row),
                    row.situs_city,
                    row.situs_zip,
                    county.name,
                    formatNumber(row.p_install_12m, 4),
                    row.relative_to_county !== null ? `${Number(row.relative_to_county).toFixed(1)}x` : "",
                    row.reasons ? formatPredictedReasons(row.reasons) : "",
                    "",
                    row.outage_basis ?? "",
                    formatNumber(row.outage_minutes, 1),
                    market ?? "",
                    permitPathFromTerritory(row.territory_eia_id) ?? "",
                    row.distributor_name ?? "",
                    formatUtilityStatus(row.territory_basis, row.territory_null_reason, row.distributor_name),
                    row.extrapolated_from ?? "",
                    sources,
                  ])
                )
              );
              emittedRows += 1;
            }

            const last: PredictedDbRow = rows[rows.length - 1];
            afterP = last.p_install_12m;
            afterPropId = last.prop_id;
            if (rows.length < PAGE_SIZE) break;
          }
        } else {
          let afterScore: string | null = null;
          let afterPropId: string | null = null;
          let exhausted = false;
          while (emittedRows < CSV_CAP && !exhausted) {
            const rows: WeightedDbRow[] = await query<WeightedDbRow>(
              `select prop_id, situs_num, situs_street, situs_city, situs_zip, score::text as score,
                      reasons, distributor_name, territory_eia_id, outage_minutes, outage_basis,
                      permit_path, yr_built, source_ids, outage_source_ids
               from api.homes_ranked_weighted($1::jsonb, $2::text, $7::text, $3::numeric, $4::text, $5::int, $6::boolean, $8::text, $9::text)`,
              // api.homes_ranked_weighted's p_situs_city/p_situs_zip are
              // `is null or col = param` -- they can't select "column IS
              // NULL" rows, so "" (this route's own null-bucket sentinel)
              // is coerced to "no filter" here, same fix/deviation as
              // app/api/top-homes/route.ts's fetchRankedHomes.
              [JSON.stringify(weights), county.fips, afterScore, afterPropId, PAGE_SIZE, excludeBackup, blockGroupGeoid, situsCity || null, situsZip || null]
            );
            if (rows.length === 0) break;

            const marketByEiaId = await lookupMarket(rows.map((r: WeightedDbRow) => r.territory_eia_id));
            const territoryBasisByPropId = await lookupTerritoryBasis(rows.map((r: WeightedDbRow) => r.prop_id));

            for (const row of rows) {
              if (emittedRows >= CSV_CAP) break;
              if (hideOldHomes && row.yr_built !== null && row.yr_built < HIDE_OLD_HOMES_CUTOFF_YEAR) continue;
              rank += 1;
              const market = marketByEiaId.get(row.territory_eia_id ?? "");
              const territoryBasis = territoryBasisByPropId.get(row.prop_id);
              const sources = await resolveSources([...(row.source_ids ?? []), ...(row.outage_source_ids ?? [])]);
              controller.enqueue(
                encoder.encode(
                  csvRow([
                    rank,
                    formatAddress(row),
                    row.situs_city,
                    row.situs_zip,
                    county.name,
                    "",
                    "",
                    row.reasons ? formatWeightedReasons(row.reasons) : "",
                    formatNumber(row.score, 4),
                    row.outage_basis ?? "",
                    formatNumber(row.outage_minutes, 1),
                    market ?? "",
                    formatWeightedPermitPath(row.permit_path) ?? "",
                    row.distributor_name ?? "",
                    formatUtilityStatus(territoryBasis?.basis ?? null, territoryBasis?.nullReason ?? null, row.distributor_name),
                    "",
                    sources,
                  ])
                )
              );
              emittedRows += 1;
            }

            const last: WeightedDbRow = rows[rows.length - 1];
            afterScore = last.score !== null ? String(last.score) : null;
            afterPropId = last.prop_id;
            exhausted = rows.length < PAGE_SIZE;
          }
        }

        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(body, { headers: csvResponseHeaders(filename) });
}
