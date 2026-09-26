import { NextResponse } from "next/server";
import { query } from "../../../lib/db";
import { sanitizeWeights } from "../../api/top-homes/route";

// M2-W5: the live, weights-following score breakdown behind
// ScoreExplainer.tsx (web/components/ScoreExplainer.tsx). A read-only
// primary-key call — a single home's row from core.mv_home_signals, at
// the caller's weights — never a write, and never Gemini (that only
// happens offline, in pipelines/sources/home_summaries.py; see
// web/app/api/home-summary/route.ts for the stored-summary read).
//
// Same per-signal terms as api.homes_ranked_weighted/api.top_homes_weighted
// (0201_m2.sql, 0204_flood_direction.sql): contribution = weight *
// percentile / sum(weight over AVAILABLE signals) — summing every
// non-null contribution reproduces the home's ranked score exactly.

export const dynamic = "force-dynamic";

interface BreakdownDbRow {
  key: string;
  label: string;
  raw_value: string | number | null;
  raw_unit: string;
  percentile: string | number | null;
  weight: string | number | null;
  contribution: string | number | null;
  available: boolean;
  null_reason: string | null;
  term: string | number | null;
  anchor_value: string | number | null;
  anchor_basis: string | null;
}

export interface BreakdownSignal {
  key: string;
  label: string;
  rawValue: number | null;
  rawUnit: string;
  percentile: number | null;
  weight: number;
  contribution: number | null;
  available: boolean;
  nullReason: string | null;
  term: number | null;
  anchorValue: number | null;
  anchorBasis: string | null;
}

function toNumberOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function mapBreakdownRow(row: BreakdownDbRow): BreakdownSignal {
  return {
    key: row.key,
    label: row.label,
    rawValue: toNumberOrNull(row.raw_value),
    rawUnit: row.raw_unit,
    percentile: toNumberOrNull(row.percentile),
    weight: Number(row.weight ?? 0),
    contribution: toNumberOrNull(row.contribution),
    available: row.available,
    nullReason: row.null_reason,
    term: toNumberOrNull(row.term),
    anchorValue: toNumberOrNull(row.anchor_value),
    anchorBasis: row.anchor_basis,
  };
}

interface OutageBasisRow {
  outage_basis: string | null;
  distributor_name: string | null;
}

/** M2-P8: api.home_score_breakdown's generic per-signal shape has no room
 * for the outage row's own basis (distributor SAIDI vs the EAGLE-I county
 * proxy) — a single primary-key lookup on core.mv_home_signals adds it,
 * same pattern the home-detail page already uses for this same mv. */
async function getOutageBasis(propId: string): Promise<OutageBasisRow | null> {
  try {
    const rows = await query<OutageBasisRow>(
      `select outage_basis, distributor_name from core.mv_home_signals where prop_id = $1`,
      [propId]
    );
    return rows[0] ?? null;
  } catch (err) {
    console.error("ranking/breakdown: failed to load outage basis", err);
    return null;
  }
}

interface BreakdownRequestBody {
  propId?: unknown;
  weights?: unknown;
}

export async function POST(request: Request) {
  let body: BreakdownRequestBody = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const propId = typeof body.propId === "string" && body.propId.length > 0 ? body.propId : null;
  if (!propId) {
    return NextResponse.json({ error: "propId is required" }, { status: 400 });
  }

  const weights = sanitizeWeights(body.weights);

  const [rows, outageBasisRow] = await Promise.all([
    query<BreakdownDbRow>(
      `select key, label, raw_value, raw_unit, percentile, weight, contribution, available, null_reason,
              term, anchor_value, anchor_basis
       from api.home_score_breakdown($1, $2::jsonb)`,
      [propId, JSON.stringify(weights)]
    ),
    getOutageBasis(propId),
  ]);

  return NextResponse.json(
    {
      propId,
      signals: rows.map(mapBreakdownRow),
      outageBasis: outageBasisRow?.outage_basis ?? null,
      outageDistributorName: outageBasisRow?.distributor_name ?? null,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
