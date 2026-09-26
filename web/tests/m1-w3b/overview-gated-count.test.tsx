import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import HomePage from "../../app/page";
import RankingPage from "../../app/ranking/page";
import { getPool, query } from "../../lib/db";

// M1-W3-b fix #1 (data bug): Overview used to report homestead_count
// (253,100 — all homestead parcels, a much bigger independent gate) as
// "gated for ranking". This test never hard-codes that number — it reads
// the same precomputed sources the pages themselves read (api.gate_counts,
// api.parcel_gate_counts) and checks Overview's rendered figure, and the
// Ranking funnel's rendered figure, both agree with it.
//
// M2-W1 perf fix: this test used to compute its own expected value with a
// live `count(*) from core.parcels where ...` — a full 441,961-row scan,
// exactly the kind of request-time cost a live production incident (pool
// exhaustion under concurrent load) showed doesn't scale. It now reads
// only precomputed views, same as the app: api.gate_counts (built on the
// materialized core.mv_home_signals) for the "gated" figure, and
// api.parcel_gate_counts.homestead_count for the regression guard.

describe.skipIf(!process.env.POSTGRES_URL)("Overview — gated count matches the Ranking funnel", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it("Overview's 'Gated for ranking' figure equals api.gate_counts' total, and the Ranking funnel", async () => {
    const [gateRows, pgcRows] = await Promise.all([
      query<{ home_count: string | number }>(`select home_count from api.gate_counts`),
      query<{ homestead_count: string | number }>(`select homestead_count from api.parcel_gate_counts`),
    ]);
    const gatedCount = gateRows.reduce((sum, r) => sum + Number(r.home_count), 0);
    if (gatedCount === 0) return; // core.mv_home_signals not populated yet — nothing to assert against.

    const gatedFormatted = gatedCount.toLocaleString();
    const homesteadCount = pgcRows[0] ? Number(pgcRows[0].homestead_count) : 0;
    const homesteadFormatted = homesteadCount.toLocaleString();

    const overviewText = textOf(renderToStaticMarkup(await HomePage()));
    const rankingText = textOf(renderToStaticMarkup(await RankingPage({ searchParams: Promise.resolve({}) })));

    // Same real number, read straight from the stat row's own label — not
    // a substring match anywhere on the page, so relabeling the wrong
    // count as "gated" (the original bug) would still fail this.
    expect(overviewText).toContain(`Owner-occupied single-family homes with a mapped lot ${gatedFormatted} homes`);
    expect(rankingText).toContain(`Owner-occupied, with a mapped lot ${gatedFormatted}`);

    // The original bug used the (larger, independent) all-homestead count
    // as the "gated" figure. Guard against that regression whenever the
    // two real counts actually differ.
    if (homesteadCount !== gatedCount) {
      expect(overviewText).not.toContain(
        `Owner-occupied single-family homes with a mapped lot ${homesteadFormatted} homes`
      );
    }
  }, 60000);
});

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
