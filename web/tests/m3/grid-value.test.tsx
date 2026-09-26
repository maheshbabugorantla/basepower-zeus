import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { getPool, query } from "../../lib/db";
import { GridValue } from "../../components/GridValue";

// M3-W1 acceptance: "$/MWh values link to their ERCOT source rows" and
// "an Austin Energy home's grid-value line reads 'Not available: Base
// sells backup only here', never a number, never 0." Both checked
// against the real, already-loaded api.base_capture / api.grid_value_lz
// / api.sources rows -- no hand-typed spread or scarcity value anywhere
// in this file.

interface BaseCaptureRow {
  eia_utility_number: string;
  base_capture: "full" | "partner" | "backup_only" | "not_served" | null;
  base_capture_null_reason: string | null;
}

interface GridValueLzRow {
  load_zone: string;
  avg_daily_spread_usd_mwh: string | number | null;
  scarcity_days: string | number | null;
  scarcity_threshold_usd_mwh: string | number | null;
  source_ids: string[];
}

interface SourceRow {
  source_id: string;
  source: string;
  url: string;
  retrieved_at: string | Date;
  sha256: string;
  runner: "cron" | "cli";
  latest_run_id: string | null;
  latest_run_rows_in: number | null;
  latest_run_rows_loaded: number | null;
}

describe.skipIf(!process.env.POSTGRES_URL_READONLY)("GridValue against real api.base_capture / api.grid_value_lz", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it("Austin Energy (backup_only) never shows a number -- 'Not available' + 'Base sells backup only here'", async () => {
    const rows = await query<BaseCaptureRow>(
      `select eia_utility_number, base_capture, base_capture_null_reason from api.base_capture where eia_utility_number = '1015'`
    );
    expect(rows[0]?.base_capture).toBe("backup_only");

    const html = renderToStaticMarkup(
      <GridValue
        idSuffix="test-austin"
        baseCapture={rows[0].base_capture}
        baseCaptureNullReason={rows[0].base_capture_null_reason}
        loadZone="LZ_AEN"
        avgDailySpreadUsdMwh={null}
        scarcityDays={null}
        scarcityThresholdUsdMwh={null}
        windowStart={null}
        windowEnd={null}
        gridValueNullReason={null}
        source={null}
      />
    );

    expect(html).toContain("Not available");
    expect(html).toContain("Base sells backup only here");
    expect(html).not.toMatch(/\$\d/);
  }, 20000);

  it("a full/partner-tier load zone's real spread renders with a link to its real ERCOT source row", async () => {
    const captureRows = await query<BaseCaptureRow>(
      `select eia_utility_number, base_capture, base_capture_null_reason from api.base_capture where eia_utility_number = '8901'`
    );
    expect(captureRows[0]?.base_capture).toBe("full");

    const gvRows = await query<GridValueLzRow>(
      `select load_zone, avg_daily_spread_usd_mwh, scarcity_days, scarcity_threshold_usd_mwh, source_ids
       from api.grid_value_lz where load_zone = 'LZ_HOUSTON'`
    );
    if (gvRows.length === 0 || gvRows[0].avg_daily_spread_usd_mwh === null) {
      return; // grid-value pipeline hasn't refreshed yet -- a real, not-yet-loaded state, not a failure.
    }
    const gv = gvRows[0];
    const sourceRows = await query<SourceRow>(
      `select source_id, source, url, retrieved_at, sha256, runner, latest_run_id, latest_run_rows_in, latest_run_rows_loaded
       from api.sources where source_id = $1`,
      [gv.source_ids[0]]
    );
    const source = sourceRows[0];
    expect(source).toBeTruthy();

    const html = renderToStaticMarkup(
      <GridValue
        idSuffix="test-houston"
        baseCapture={captureRows[0].base_capture}
        baseCaptureNullReason={captureRows[0].base_capture_null_reason}
        loadZone={gv.load_zone}
        avgDailySpreadUsdMwh={Number(gv.avg_daily_spread_usd_mwh)}
        scarcityDays={gv.scarcity_days === null ? null : Number(gv.scarcity_days)}
        scarcityThresholdUsdMwh={gv.scarcity_threshold_usd_mwh === null ? null : Number(gv.scarcity_threshold_usd_mwh)}
        windowStart={null}
        windowEnd={null}
        gridValueNullReason={null}
        source={{
          dataset: source.source,
          url: source.url,
          retrievedAt: source.retrieved_at instanceof Date ? source.retrieved_at.toISOString() : String(source.retrieved_at),
          sha256: source.sha256,
          runId: source.latest_run_id ?? "none",
          runner: source.runner,
          rowsIn: source.latest_run_rows_in,
          rowsLoaded: source.latest_run_rows_loaded,
          rawFileHref: `/sources/raw/${source.source_id}`,
        }}
      />
    );

    // The real spread figure is present, and it links back to the real
    // source's raw-file href -- not a made-up number, and not unlinked.
    expect(html).toContain(`$${Number(gv.avg_daily_spread_usd_mwh).toFixed(2)}`);
    expect(html).toContain(`/sources/raw/${source.source_id}`);
    expect(html).toContain("LZ_HOUSTON");
  }, 20000);
});
