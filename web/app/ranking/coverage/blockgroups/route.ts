import { NextResponse } from "next/server";
import { query } from "../../../../lib/db";
import { zoneBucket, ZONE_BUCKET_META, type ZoneBucket } from "../../../../components/coverageZones";

// M2-P11: block-group polygons (api.blockgroup_geojson, same geometry
// cache /ranking/blockgroups uses) left-joined to api.coverage_gaps_bg's
// per-block-group counts/gap_score, with a zone bucket + its fill color
// computed here (server-side, from real counts only) so the client map
// never re-derives it. A block group absent from api.coverage_gaps_bg has
// no permit coverage at all -- "not_observable", never shown as a gap.

export const dynamic = "force-dynamic";

const TRAVIS_COUNTY_FIPS = "48453";

interface CoverageBlockGroupRow {
  geoid: string;
  geometry: string;
  homes: string | number | null;
  base_customers: string | number | null;
  other_backup: string | number | null;
  prospects: string | number | null;
  base_share_of_backup: string | number | null;
  backup_penetration: string | number | null;
  gap_score: string | number | null;
}

function toNumberOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

export async function GET() {
  const rows = await query<CoverageBlockGroupRow>(
    `select g.geoid, g.geometry,
            c.homes, c.base_customers, c.other_backup, c.prospects,
            c.base_share_of_backup, c.backup_penetration, c.gap_score
     from api.blockgroup_geojson g
     left join api.coverage_gaps_bg c on c.block_group_geoid = g.geoid
     where g.county_fips = $1`,
    [TRAVIS_COUNTY_FIPS]
  );

  const features = rows.map((row) => {
    const baseCustomers = toNumberOrNull(row.base_customers);
    const otherBackup = toNumberOrNull(row.other_backup);
    const prospects = toNumberOrNull(row.prospects);
    const homes = toNumberOrNull(row.homes);
    const bucket: ZoneBucket = zoneBucket({ homes, baseCustomers, otherBackup, prospects });
    return {
      type: "Feature" as const,
      geometry: JSON.parse(row.geometry),
      properties: {
        geoid: row.geoid,
        bucket,
        fillColor: ZONE_BUCKET_META[bucket].color,
        homes,
        baseCustomers,
        otherBackup,
        prospects,
        baseShareOfBackup: toNumberOrNull(row.base_share_of_backup),
        backupPenetration: toNumberOrNull(row.backup_penetration),
        gapScore: toNumberOrNull(row.gap_score),
      },
    };
  });

  return NextResponse.json(
    { type: "FeatureCollection" as const, features },
    { headers: { "Cache-Control": "no-store" } }
  );
}
