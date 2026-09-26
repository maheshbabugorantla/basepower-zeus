import { NextRequest } from "next/server";
import { query } from "../../../lib/db";
import { COUNTY_CANDIDATES, DEFAULT_COUNTY } from "../../../lib/counties";
import { blockGroupLabel, csvFilename, csvResponseHeaders, csvRow, isoDate } from "../shared";

// M5-W1: coverage-zones CSV export -- api.coverage_gaps_bg (0216_
// scoring_pass.sql), block-group-level counts only. Never an individual
// Base-customer address (that view itself is defined as zone-level
// aggregates, no prop_id column exists to leak). Small table (~500-ish
// rows per county), so no keyset pagination is needed -- one bounded
// query, filtered to the requested county by its block-group GEOID
// prefix (the first 5 digits of a 12-digit block-group GEOID are the
// state+county FIPS -- api.coverage_gaps_bg has no county_fips column
// of its own).

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface CoverageGapRow {
  block_group_geoid: string;
  homes: string | number;
  base_customers: string | number;
  other_backup: string | number;
  prospects: string | number;
  gap_score: string | number | null;
}

function resolveCountyOption(fips: string | null) {
  return COUNTY_CANDIDATES.find((c) => c.fips === fips) ?? DEFAULT_COUNTY;
}

const HEADER = ["zone", "homes", "base_customers", "other_backup", "prospects", "gap_score"];

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const county = resolveCountyOption(params.get("county"));
  const today = isoDate(new Date());
  const filename = csvFilename(county.name, "coverage-zones", today);

  const rows = await query<CoverageGapRow>(
    `select block_group_geoid, homes, base_customers, other_backup, prospects, gap_score
     from api.coverage_gaps_bg
     where block_group_geoid like $1
     order by block_group_geoid asc`,
    [`${county.fips}%`]
  );

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `# Base Power Zeus coverage-zones export -- ${county.name} County -- zone counts only, no individual addresses -- generated ${today}\r\n`
        )
      );
      controller.enqueue(encoder.encode(csvRow(HEADER)));
      for (const row of rows) {
        controller.enqueue(
          encoder.encode(
            csvRow([
              blockGroupLabel(row.block_group_geoid),
              Number(row.homes),
              Number(row.base_customers),
              Number(row.other_backup),
              Number(row.prospects),
              row.gap_score !== null ? Number(row.gap_score).toFixed(4) : "",
            ])
          )
        );
      }
      controller.close();
    },
  });

  return new Response(body, { headers: csvResponseHeaders(filename) });
}
