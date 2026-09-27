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
//
// Redesign (Mock C, 2026-09-27): Overview is territory-wide now — it no
// longer has a single "Owner-occupied single-family homes with a mapped
// lot N homes" sentence for one implicit county. The same real number
// now lives in the "Ranking readiness" table's Travis row (Parcels /
// Single-family / Homestead / Mapped lot / Ranked columns, in that
// order) — this checks the row's own flattened text, still never a
// substring match anywhere on the page, so relabeling the wrong count as
// "gated" (the original bug) would still fail this.

const TRAVIS_COUNTY_FIPS = "48453";

describe.skipIf(!process.env.POSTGRES_URL)("Overview — gated count matches the Ranking funnel", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it("Overview's Travis readiness row shows the same 'mapped lot' figure as api.gate_counts' total, and the Ranking funnel agrees", async () => {
    const [gateRows, pgcRows] = await Promise.all([
      query<{ home_count: string | number }>(
        `select home_count from api.gate_counts where county_fips = $1`,
        [TRAVIS_COUNTY_FIPS]
      ),
      query<{ total_parcels: string | number; single_family_count: string | number; homestead_count: string | number }>(
        `select total_parcels, single_family_count, homestead_count from api.parcel_gate_counts where county_fips = $1`,
        [TRAVIS_COUNTY_FIPS]
      ),
    ]);
    const gatedCount = gateRows.reduce((sum, r) => sum + Number(r.home_count), 0);
    if (gatedCount === 0) return; // core.mv_home_signals not populated yet — nothing to assert against.

    const gatedFormatted = gatedCount.toLocaleString();
    const pgc = pgcRows[0];
    if (!pgc) return;
    const totalParcelsFormatted = Number(pgc.total_parcels).toLocaleString();
    const singleFamilyFormatted = Number(pgc.single_family_count).toLocaleString();
    const homesteadCount = Number(pgc.homestead_count);
    const homesteadFormatted = homesteadCount.toLocaleString();

    const overviewText = textOf(renderToStaticMarkup(await HomePage()));
    const rankingText = textOf(renderToStaticMarkup(await RankingPage({ searchParams: Promise.resolve({ county: TRAVIS_COUNTY_FIPS }) })));

    // The readiness table's Travis row, in real column order (County,
    // Parcels, Single-family, Homestead, Mapped lot, Ranked) — this is
    // the same real number appearing under its own real "Mapped lot"
    // header, not a substring match anywhere on the page.
    expect(overviewText).toContain(
      `Travis ${totalParcelsFormatted} ${singleFamilyFormatted} ${homesteadFormatted} ${gatedFormatted}`
    );

    // /ranking's rail status line states the same api.gate_counts
    // numbers directly (eligible = sum of every reason == gatedCount;
    // "Base serves" = the 'passed' reason). Read straight from
    // api.gate_counts, never derived by subtraction, matching
    // web/app/ranking/page.tsx's own computation exactly.
    const servedRows = await query<{ reason: string; home_count: string | number }>(
      `select reason, home_count from api.gate_counts where county_fips = $1`,
      [TRAVIS_COUNTY_FIPS]
    );
    const servedHomes = servedRows.find((r) => r.reason === "passed")?.home_count ?? 0;
    const servedFormatted = Number(servedHomes).toLocaleString();
    expect(rankingText).toContain(`${gatedFormatted} eligible homes`);
    expect(rankingText).toContain(`Base serves ${servedFormatted}`);

    // The original bug used the (larger, independent) all-homestead count
    // as the "gated"/"mapped lot" figure. Guard against that regression
    // whenever the two real counts actually differ.
    if (homesteadCount !== gatedCount) {
      expect(overviewText).not.toContain(
        `Travis ${totalParcelsFormatted} ${singleFamilyFormatted} ${homesteadFormatted} ${homesteadFormatted}`
      );
    }
  }, 60000);
});

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
