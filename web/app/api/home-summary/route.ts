import { NextResponse } from "next/server";
import { query } from "../../../lib/db";

// M2-W5: a PRIMARY-KEY READ ONLY of the offline-generated "why this home"
// summary. This route never calls Gemini and never writes anything — the
// only write path for core.home_summary is
// pipelines/sources/home_summaries.py, run CLI/cron-side with
// GEMINI_API_KEY + BRIEF_MODEL, credentials this route never reads (see
// web/lib/db.ts: the web app connects as the read-only role zeus_web_ro
// and holds no service-role/session-pooler credentials at all). If no row
// has been generated yet for this home, `summary` is null and
// ScoreExplainer.tsx falls back to a deterministic template sentence
// built client-side from the live breakdown — never an LLM call from here.

export const dynamic = "force-dynamic";

interface HomeSummaryDbRow {
  summary: string;
  is_template: boolean;
  guard_failed: boolean;
  model: string | null;
  generated_at: string | Date;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const propId = searchParams.get("propId");
  if (!propId) {
    return NextResponse.json({ error: "propId is required" }, { status: 400 });
  }

  const rows = await query<HomeSummaryDbRow>(
    `select summary, is_template, guard_failed, model, generated_at from api.home_summary($1)`,
    [propId]
  );
  const row = rows[0];

  if (!row) {
    return NextResponse.json({ summary: null }, { headers: { "Cache-Control": "no-store" } });
  }

  return NextResponse.json(
    {
      summary: row.summary,
      isTemplate: row.is_template,
      guardFailed: row.guard_failed,
      model: row.model,
      generatedAt: row.generated_at instanceof Date ? row.generated_at.toISOString() : String(row.generated_at),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
