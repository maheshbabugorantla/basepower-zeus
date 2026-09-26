import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import HomePage from "../../app/page";
import RankingPage from "../../app/ranking/page";
import { getPool, query } from "../../lib/db";

// M1-W3-b fix #1 (data bug): Overview used to report homestead_count
// (253,100 — all homestead parcels, a much bigger independent gate) as
// "gated for ranking". Gated actually means single-family (state code A1)
// AND homestead, exactly the predicate app/ranking/page.tsx's eligibility
// funnel uses for its "Single-family + homestead" step (217,489 live).
// This test never hard-codes that number — it computes the intersection
// directly from core.parcels (the same source of truth both pages read
// from) and checks Overview's rendered figure, and the Ranking funnel's
// rendered figure, both agree with it.

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

describe.skipIf(!process.env.POSTGRES_URL)("Overview — gated count matches the Ranking funnel", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it("Overview's 'Gated for ranking' figure equals the real single-family+homestead intersection, and the Ranking funnel", async () => {
    const [gatedRows, homesteadRows] = await Promise.all([
      query<{ n: string | number }>(
        `select count(*) as n
         from core.parcels
         where (imprv_state_cd like 'A1%' or land_state_cd like 'A1%')
           and hs_exempt = 'T'`
      ),
      query<{ n: string | number }>(`select count(*) as n from core.parcels where hs_exempt = 'T'`),
    ]);
    const gatedCount = Number(gatedRows[0]?.n ?? 0);
    if (gatedCount === 0) return; // core.parcels not loaded yet — nothing to assert against.

    const gatedFormatted = gatedCount.toLocaleString();
    const homesteadCount = Number(homesteadRows[0]?.n ?? 0);
    const homesteadFormatted = homesteadCount.toLocaleString();

    const overviewText = textOf(renderToStaticMarkup(await HomePage()));
    const rankingText = textOf(renderToStaticMarkup(await RankingPage()));

    // Same real number, read straight from the stat row's own label — not
    // a substring match anywhere on the page, so relabeling the wrong
    // count as "gated" (the original bug) would still fail this.
    expect(overviewText).toContain(`Gated for ranking (single-family + homestead) ${gatedFormatted} homes`);
    expect(rankingText).toContain(`Single-family + homestead ${gatedFormatted}`);

    // The original bug used the (larger, independent) all-homestead count
    // as the "gated" figure. Guard against that regression whenever the
    // two live counts actually differ.
    if (homesteadCount !== gatedCount) {
      expect(overviewText).not.toContain(`Gated for ranking (single-family + homestead) ${homesteadFormatted} homes`);
    }
  }, 20000);
});
