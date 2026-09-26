import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { GateCounts, type GateCountRow } from "../../components/GateCounts";
import { getPool, query } from "../../lib/db";

// M2-W1 acceptance: "Gate counts render the 'not loaded' state before the
// gate pipeline runs" — and, more generally, that GateCounts renders the
// real api.gate_counts state honestly, whatever it currently is (empty,
// fail-open/not-loaded, or resolved). Exercised against the real view;
// skipped without POSTGRES_URL.

describe.skipIf(!process.env.POSTGRES_URL)("GateCounts against api.gate_counts", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it(
    "renders the not-loaded state when api.gate_counts has no rows, or every real reason/count otherwise",
    async () => {
      const rows = await query<{ reason: string; home_count: string | number }>(
        `select reason, home_count from api.gate_counts order by home_count desc`
      );
      const gateCountRows: GateCountRow[] = rows.map((r) => ({ reason: r.reason, homeCount: Number(r.home_count) }));

      const html = renderToStaticMarkup(<GateCounts rows={gateCountRows} />);

      if (gateCountRows.length === 0) {
        expect(html).toContain("missing-state--not-loaded");
        expect(html).toContain("Not loaded");
      } else {
        for (const row of gateCountRows) {
          expect(html).toContain(row.homeCount.toLocaleString());
        }
        if (rows.some((r) => r.reason === "territories_not_loaded" || r.reason === "crosswalk_not_loaded")) {
          expect(html).toContain("fail-open");
        }
      }
    },
    20000
  );
});

describe("GateCounts (structural)", () => {
  it("renders the not-loaded state for an empty gate_counts result, with a written reason", () => {
    const html = renderToStaticMarkup(<GateCounts rows={[]} />);
    expect(html).toContain("missing-state--not-loaded");
    expect(html.toLowerCase()).toContain("core.mv_home_signals");
  });

  it("renders one horizontal funnel (not cards) with a count per real reason", () => {
    const rows: GateCountRow[] = [
      { reason: "passed", homeCount: 100 },
      { reason: "territory_not_base_served", homeCount: 25 },
    ];
    const html = renderToStaticMarkup(<GateCounts rows={rows} />);
    expect(html).toContain("gate-funnel");
    expect(html).toContain("100");
    expect(html).toContain("25");
    expect(html).toContain("Territory not Base-served");
  });
});
