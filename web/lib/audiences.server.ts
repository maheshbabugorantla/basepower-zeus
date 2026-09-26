import "server-only";
import { query } from "./db";
import { SEGMENT_ORDER, segmentForReasons, type SegmentKey } from "./segments";

// GTM P0: segment sizes and expected adopters, read from the model's own
// output (core.home_propensity) over the same gated population the
// ranking shows (core.mv_home_signals.gate_reason is null) with the
// ranking's default of hiding homes that already have backup
// (core.home_coverage bucket base_customer / other_backup).
//
// "Expected adopters" is the sum of each home's calibrated 12-month
// likelihood (p_install_12m). The model is Platt-calibrated, so the sum
// is the model's estimate of how many of these homes add backup in the
// next 12 months. It is labelled as a model estimate wherever it shows.
//
// Neither query touches core.parcels (tests/m2/no-live-parcel-scans).

export interface SegmentSize {
  key: SegmentKey | "no_clear_driver";
  homes: number;
  expectedAdopters: number;
}

export interface AudienceSummary {
  countyFips: string;
  totalHomes: number;
  totalExpectedAdopters: number;
  segments: SegmentSize[];
}

interface LeadFeatureRow {
  lead_feature: string | null;
  homes: string | number;
  expected: string | number | null;
}

export async function getAudienceSummary(countyFips: string): Promise<AudienceSummary | null> {
  try {
    const rows = await query<LeadFeatureRow>(
      `select lead.feature as lead_feature,
              count(*) as homes,
              sum(hp.p_install_12m) as expected
       from core.home_propensity hp
       join core.mv_home_signals s on s.prop_id = hp.prop_id
       left join core.home_coverage hc on hc.prop_id = hp.prop_id
       left join lateral (
         select r ->> 'feature' as feature
         from jsonb_array_elements(hp.reasons) with ordinality as t(r, ord)
         where r ->> 'direction' = 'raises'
         order by ord
         limit 1
       ) lead on true
       where s.gate_reason is null
         and s.county_fips = $1
         and (hc.bucket is null or hc.bucket not in ('base_customer', 'other_backup'))
       group by lead.feature`,
      [countyFips]
    );

    const bySegment = new Map<SegmentSize["key"], SegmentSize>();
    let totalHomes = 0;
    let totalExpected = 0;
    for (const row of rows) {
      const homes = Number(row.homes);
      const expected = row.expected === null ? 0 : Number(row.expected);
      totalHomes += homes;
      totalExpected += expected;
      const segment = row.lead_feature
        ? segmentForReasons([{ feature: row.lead_feature, direction: "raises" }])
        : null;
      const key: SegmentSize["key"] = segment?.key ?? "no_clear_driver";
      const existing = bySegment.get(key) ?? { key, homes: 0, expectedAdopters: 0 };
      existing.homes += homes;
      existing.expectedAdopters += expected;
      bySegment.set(key, existing);
    }

    const ordered: SegmentSize[] = [];
    for (const key of SEGMENT_ORDER) {
      const s = bySegment.get(key);
      if (s) ordered.push(s);
    }
    const rest = bySegment.get("no_clear_driver");
    if (rest) ordered.push(rest);

    return { countyFips, totalHomes, totalExpectedAdopters: totalExpected, segments: ordered };
  } catch (err) {
    console.error("audiences: failed to load segment sizes", err);
    return null;
  }
}

export interface MarketRow {
  countyFips: string;
  homes: number;
  expectedAdopters: number;
}

/** Homes Base can serve and expected adopters per scored county. */
export async function getMarketRows(countyFips: string[]): Promise<MarketRow[] | null> {
  if (countyFips.length === 0) return [];
  try {
    const rows = await query<{ county_fips: string; homes: string | number; expected: string | number | null }>(
      `select s.county_fips, count(*) as homes, sum(hp.p_install_12m) as expected
       from core.home_propensity hp
       join core.mv_home_signals s on s.prop_id = hp.prop_id
       where s.gate_reason is null
         and s.county_fips = any($1::text[])
       group by s.county_fips`,
      [countyFips]
    );
    return rows.map((r) => ({
      countyFips: r.county_fips,
      homes: Number(r.homes),
      expectedAdopters: r.expected === null ? 0 : Number(r.expected),
    }));
  } catch (err) {
    console.error("markets: failed to load per-county expected adopters", err);
    return null;
  }
}

/** "about 1,240" -- rounded to a readable figure, never a false-precision decimal. */
export function formatExpected(n: number): string {
  if (n < 10) return `about ${Math.round(n)}`;
  const magnitude = n < 1000 ? 10 : 10 ** (Math.floor(Math.log10(n)) - 1);
  return `about ${(Math.round(n / magnitude) * magnitude).toLocaleString("en-US")}`;
}
