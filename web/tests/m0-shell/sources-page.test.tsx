import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import SourcesPage from "../../app/sources/page";
import { getPool, query } from "../../lib/db";

// M0-W2 acceptance: "Sources page renders the real api.sources rows (or
// 'not loaded' when empty)." This is a Server Component (an async
// function), so it is invoked directly (as Next itself would) rather than
// passed to a React renderer that expects a synchronous component. Its
// output is checked against whatever api.sources actually contains right
// now — never a fabricated row — so this test exercises whichever branch
// (rows or MissingState) is really live, and is skipped entirely (not
// faked) when POSTGRES_URL isn't configured, exactly as CI does without
// secrets.

describe.skipIf(!process.env.POSTGRES_URL)("Sources page", () => {
  afterAll(async () => {
    await getPool().end();
  });

  it("renders real api.sources rows when the table is non-empty, or MissingState when empty", async () => {
    const rows = await query<{ source: string; sha256: string }>(
      "select source, sha256 from api.sources"
    );

    const jsx = await SourcesPage();
    const html = renderToStaticMarkup(jsx);

    if (rows.length === 0) {
      expect(html).toContain("missing-state--not-loaded");
      expect(html).toContain("Not loaded");
    } else {
      // Every real source name and its real (truncated) SHA-256 prefix
      // must actually be present — the page must not be showing an
      // empty/placeholder table while rows exist.
      for (const row of rows) {
        expect(html).toContain(row.source);
        expect(html).toContain(row.sha256.slice(0, 16));
      }
      expect(html).toContain("View raw file");
      expect(html).not.toContain("missing-state--not-loaded");
    }
  });
});
