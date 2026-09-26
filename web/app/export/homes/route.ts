import { NextRequest } from "next/server";
import { query } from "../../../lib/db";
import { COUNTY_CANDIDATES, DEFAULT_COUNTY } from "../../../lib/counties";
import {
  CSV_CAP,
  csvFilename,
  csvResponseHeaders,
  csvRow,
  formatPredictedReasons,
  formatWeightedPermitPath,
  formatWeightedReasons,
  isoDate,
  makeSourcesResolver,
  permitPathFromTerritory,
  type PropensityReason,
} from "../shared";
import {
  isHoldout,
  predictedFeaturesForSegment,
  segmentByKey,
  segmentForReasons,
  segmentForSignalKeys,
  type Segment,
} from "../../../lib/segments";

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
// Deviation from the ticket text (reported, not silently done): the
// ranking screen's mode/weights/hide-old-homes/hide-existing-backup
// toggles are React state in RankingBoard, never written to the URL
// (only `?county=` is -- see app/ranking/page.tsx, app/ranking/
// RankingBoard.tsx, both read-only to this ticket). This route defines
// its own query-param contract so the export can still be driven from a
// URL, and ExportButton forwards the CURRENT url's params verbatim:
//   mode=predicted|weighted   (default predicted, the ranking default)
//   backup=hide|show          (default hide, matches the ranking screen's default)
//   pre2000=show|hide         (default show, matches the ranking screen's default)
//   w_<signal_key>=<number>   (weighted mode only; any key omitted falls
//                              back to api.default_weights, then equal=5)
// Until RankingBoard syncs its own state into the URL, only `county`
// actually reflects what's on screen; mode/weights/filters export the
// page's own first-paint values unless a caller sets these params by hand.

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
  "segment",
  "suggested_message",
  "holdout_group",
  "sources",
];

// GTM P0: segment (lib/segments.ts, from the home's strongest raising
// reason), the team's suggested message for it, and a stable 10% holdout
// flag ("holdout" = do not contact; measure lift against it). Messages are
// team copy, not data. `?segment=<key>` limits the export to one segment.
function segmentCells(segment: Segment | null, propId: string): string[] {
  return [
    segment?.name ?? "",
    segment?.message ?? "",
    isHoldout(propId) ? "holdout" : "contact",
  ];
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const county = resolveCountyOption(params.get("county"));
  const mode: "predicted" | "weighted" = params.get("mode") === "weighted" ? "weighted" : "predicted";
  const excludeBackup = params.get("backup") !== "show"; // default hide
  const hideOldHomes = params.get("pre2000") === "hide"; // default show
  const segmentFilter = segmentByKey(params.get("segment"));

  const today = isoDate(new Date());
  const view = segmentFilter ? `${segmentFilter.key.replace(/_/g, "-")}-${mode}` : `ranked-homes-${mode}`;
  const filename = csvFilename(county.name, view, today);
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

  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(
          encoder.encode(
            `# Base Power Zeus ranked-homes export -- ${county.name} County -- ${mode} mode${
              segmentFilter ? ` -- segment: ${segmentFilter.name}` : ""
            } -- capped at ${CSV_CAP} rows -- generated ${today}\r\n`
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
                      s.distributor_name, s.territory_eia_id, s.outage_minutes, s.outage_basis,
                      s.source_ids, hp.source_ids as model_source_ids
               from core.home_propensity hp
               join core.mv_home_signals s on s.prop_id = hp.prop_id
               join core.parcels pc on pc.prop_id = hp.prop_id
               left join core.home_coverage hc on hc.prop_id = hp.prop_id
               where s.gate_reason is null
                 and s.county_fips = $1
                 and ($2::boolean = false or coalesce(hc.bucket, 'prospect') not in ('base_customer', 'other_backup'))
                 and ($3::boolean = false or s.yr_built is null or s.yr_built >= ${HIDE_OLD_HOMES_CUTOFF_YEAR})
                 and (
                   $4::numeric is null
                   or hp.p_install_12m < $4::numeric
                   or (hp.p_install_12m = $4::numeric and hp.prop_id > $5::text)
                 )
                 and (
                   $7::text[] is null
                   or (
                     select r ->> 'feature'
                     from jsonb_array_elements(hp.reasons) with ordinality as t(r, ord)
                     where r ->> 'direction' = 'raises'
                     order by ord
                     limit 1
                   ) = any($7::text[])
                 )
               order by hp.p_install_12m desc, hp.prop_id asc
               limit $6`,
              [
                county.fips,
                excludeBackup,
                hideOldHomes,
                afterP,
                afterPropId,
                PAGE_SIZE,
                segmentFilter ? predictedFeaturesForSegment(segmentFilter.key) : null,
              ]
            );
            if (rows.length === 0) break;

            const marketByEiaId = await lookupMarket(rows.map((r: PredictedDbRow) => r.territory_eia_id));

            for (const row of rows) {
              if (emittedRows >= CSV_CAP) break;
              const segment = segmentForReasons(row.reasons);
              if (segmentFilter && segment?.key !== segmentFilter.key) continue;
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
                    "Confirmed Base-served utility match",
                    row.extrapolated_from ?? "",
                    ...segmentCells(segment, row.prop_id),
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
               from api.homes_ranked_weighted($1::jsonb, $2::text, null, $3::numeric, $4::text, $5::int, $6::boolean)`,
              [JSON.stringify(weights), county.fips, afterScore, afterPropId, PAGE_SIZE, excludeBackup]
            );
            if (rows.length === 0) break;

            const marketByEiaId = await lookupMarket(rows.map((r: WeightedDbRow) => r.territory_eia_id));

            for (const row of rows) {
              if (emittedRows >= CSV_CAP) break;
              if (hideOldHomes && row.yr_built !== null && row.yr_built < HIDE_OLD_HOMES_CUTOFF_YEAR) continue;
              const segment = segmentForSignalKeys(row.reasons);
              if (segmentFilter && segment?.key !== segmentFilter.key) continue;
              rank += 1;
              const market = marketByEiaId.get(row.territory_eia_id ?? "");
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
                    "Confirmed Base-served utility match",
                    "",
                    ...segmentCells(segment, row.prop_id),
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
