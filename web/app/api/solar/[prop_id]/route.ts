import { NextResponse } from "next/server";
import { query } from "../../../../lib/db";

// M2-W2: on-demand Google Solar panel data for the /home/[prop_id] page.
//
// This route NEVER writes the Solar API response anywhere — not to the
// DB, not to a file, not to any cache — per Google's API terms. It looks
// up the parcel centroid from core.parcel_geoms (loaded by M1's
// tcad_geometry pipeline), calls Google's buildingInsights:findClosest
// with that lat/lng, and returns a small derived JSON to the client with
// `Cache-Control: no-store` so nothing between here and the browser
// caches it either.
//
// requiredQuality=HIGH is tried first; Google returns 404 when no HIGH-
// quality imagery covers the building, in which case we retry once at
// MEDIUM quality before giving up. A 404 at every quality level (or no
// parcel centroid at all) surfaces as {available:false, reason} rather
// than an HTTP error, so the UI can render a MissingState instead of an
// error boundary.

export const dynamic = "force-dynamic";

interface CentroidRow {
  lat: number;
  lng: number;
}

interface GoogleSolarPotential {
  maxArrayPanelsCount?: number;
  maxArrayAreaMeters2?: number;
  carbonOffsetFactorKgPerMwh?: number;
  wholeRoofStats?: { areaMeters2?: number };
  roofSegmentStats?: unknown[];
}

interface GoogleBuildingInsightsResponse {
  center?: { latitude: number; longitude: number };
  imageryDate?: { year: number; month: number; day: number };
  imageryQuality?: "HIGH" | "MEDIUM" | "LOW";
  solarPotential?: GoogleSolarPotential;
}

export interface SolarPanelData {
  available: true;
  imageryDate: string | null;
  imageryQuality: "HIGH" | "MEDIUM" | "LOW" | null;
  maxPanelCount: number | null;
  maxArrayAreaMeters2: number | null;
  roofSegmentCount: number | null;
  carbonOffsetFactorKgPerMwh: number | null;
  wholeRoofAreaMeters2: number | null;
  center: { lat: number; lng: number } | null;
}

export interface SolarPanelUnavailable {
  available: false;
  reason: string;
}

function jsonNoStore(body: SolarPanelData | SolarPanelUnavailable, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function findClosest(
  lat: number,
  lng: number,
  quality: "HIGH" | "MEDIUM",
  apiKey: string
): Promise<Response> {
  const url = new URL("https://solar.googleapis.com/v1/buildingInsights:findClosest");
  url.searchParams.set("location.latitude", String(lat));
  url.searchParams.set("location.longitude", String(lng));
  url.searchParams.set("requiredQuality", quality);
  url.searchParams.set("key", apiKey);
  return fetch(url.toString(), { cache: "no-store" });
}

function formatImageryDate(d: GoogleBuildingInsightsResponse["imageryDate"]): string | null {
  if (!d || d.year == null || d.month == null || d.day == null) return null;
  const mm = String(d.month).padStart(2, "0");
  const dd = String(d.day).padStart(2, "0");
  return `${d.year}-${mm}-${dd}`;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ prop_id: string }> }
) {
  const { prop_id } = await params;

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return jsonNoStore({
      available: false,
      reason: "GOOGLE_MAPS_API_KEY is not configured on the server",
    });
  }

  const rows = await query<CentroidRow>(
    `select extensions.ST_Y(centroid) as lat, extensions.ST_X(centroid) as lng
     from core.parcel_geoms
     where prop_id = $1 and centroid is not null`,
    [prop_id]
  );

  if (rows.length === 0) {
    return jsonNoStore({
      available: false,
      reason: `No parcel centroid found for prop_id ${prop_id} — core.parcel_geoms may not have loaded this record yet`,
    });
  }

  const { lat, lng } = rows[0];

  let response = await findClosest(lat, lng, "HIGH", apiKey);
  if (response.status === 404) {
    response = await findClosest(lat, lng, "MEDIUM", apiKey);
  }

  if (response.status === 404) {
    return jsonNoStore({
      available: false,
      reason: "No Google Solar coverage for this building",
    });
  }

  if (!response.ok) {
    return jsonNoStore(
      {
        available: false,
        reason: `Google Solar API request failed (HTTP ${response.status})`,
      },
      502
    );
  }

  const body = (await response.json()) as GoogleBuildingInsightsResponse;
  const solarPotential = body.solarPotential;

  const data: SolarPanelData = {
    available: true,
    imageryDate: formatImageryDate(body.imageryDate),
    imageryQuality: body.imageryQuality ?? null,
    maxPanelCount: solarPotential?.maxArrayPanelsCount ?? null,
    maxArrayAreaMeters2: solarPotential?.maxArrayAreaMeters2 ?? null,
    roofSegmentCount: solarPotential?.roofSegmentStats?.length ?? null,
    carbonOffsetFactorKgPerMwh: solarPotential?.carbonOffsetFactorKgPerMwh ?? null,
    wholeRoofAreaMeters2: solarPotential?.wholeRoofStats?.areaMeters2 ?? null,
    center: body.center
      ? { lat: body.center.latitude, lng: body.center.longitude }
      : { lat, lng },
  };

  return jsonNoStore(data);
}
