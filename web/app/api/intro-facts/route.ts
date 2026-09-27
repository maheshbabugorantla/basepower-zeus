import { NextResponse } from "next/server";
import { query } from "../../../lib/db";
import { getCountiesWithScoredHomes } from "../../../lib/counties.server";
import { resolveCounty } from "../../../lib/counties";
import type { IntroFacts, IntroFunnelStage, IntroStorm } from "../../../lib/introFacts";

// The figures the first-visit intro reel shows, read live for the county the
// reel lands on (the /ranking default, or ?county=). Fetched by the reel only
// when it is about to play, so returning visitors never request it.
//
//   storm:  api.outage_metrics_county (EAGLE-I), the county's longest major
//           outage since 2024 -- the same rows the Overview's storm record uses.
//   funnel: api.parcel_gate_counts + api.gate_counts -- the same counts as the
//           Overview's ranking-readiness row. A stage the county's loader never
//           counted separately (a roll pre-filtered to single-family homesteads)
//           is null, never the downstream count repeated.

export const dynamic = "force-dynamic";

interface MetricRow {
  metric: string;
  value: string | number | null;
}

interface GateRow {
  total_parcels: string | number;
  single_family_count: string | number;
  not_single_family_count: string | number;
  homestead_count: string | number;
  not_homestead_count: string | number;
  gated_count: string | number | null;
  passed_count: string | number | null;
}

const num = (v: string | number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

async function getStorm(countyFips: string, countyName: string): Promise<IntroStorm | null> {
  const rows = await query<MetricRow>(
    `select metric, value from api.outage_metrics_county
     where county_fips = $1
       and metric in ('longest_event_start_epoch', 'longest_event_hours', 'longest_event_peak_customers')`,
    [countyFips]
  );
  if (rows.length === 0) return null;
  const by = new Map(rows.map((r) => [r.metric, num(r.value)]));
  return {
    countyName,
    startEpoch: by.get("longest_event_start_epoch") ?? null,
    hours: by.get("longest_event_hours") ?? null,
    peakCustomers: by.get("longest_event_peak_customers") ?? null,
  };
}

async function getFunnel(countyFips: string): Promise<IntroFunnelStage[]> {
  const rows = await query<GateRow>(
    `select
       pgc.total_parcels,
       pgc.single_family_count,
       pgc.not_single_family_count,
       pgc.homestead_count,
       pgc.not_homestead_count,
       (select sum(home_count) from api.gate_counts where county_fips = $1) as gated_count,
       (select home_count from api.gate_counts where county_fips = $1 and reason = 'passed') as passed_count
     from api.parcel_gate_counts pgc
     where pgc.county_fips = $1`,
    [countyFips]
  );
  const r = rows[0];
  const prefiltered = !!r && Number(r.not_single_family_count) === 0 && Number(r.not_homestead_count) === 0;
  return [
    { key: "parcels", label: "On the appraisal roll", count: r && !prefiltered ? num(r.total_parcels) : null },
    { key: "singleFamily", label: "Single-family homes", count: r && !prefiltered ? num(r.single_family_count) : null },
    { key: "homestead", label: "Owner-occupied", count: r ? num(r.homestead_count) : null },
    { key: "mapped", label: "With a mapped lot", count: r ? num(r.gated_count) : null },
    { key: "served", label: "Base can serve", count: r ? num(r.passed_count) : null },
  ];
}

export async function GET(request: Request) {
  const requested = new URL(request.url).searchParams.get("county") ?? undefined;
  const counties = await getCountiesWithScoredHomes();
  const county = resolveCounty(requested, counties);
  try {
    const [storm, funnel] = await Promise.all([getStorm(county.fips, county.name), getFunnel(county.fips)]);
    const body: IntroFacts = { countyFips: county.fips, countyName: county.name, storm, funnel };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("intro-facts: failed to load", err);
    // the reel then plays without figures; it never shows an estimate
    const body: IntroFacts = { countyFips: county.fips, countyName: county.name, storm: null, funnel: [] };
    return NextResponse.json(body, { status: 200, headers: { "Cache-Control": "no-store" } });
  }
}
