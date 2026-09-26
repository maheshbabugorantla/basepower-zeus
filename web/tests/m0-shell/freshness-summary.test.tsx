import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FreshnessSummary } from "../../components/FreshnessSummary";

// M0-W2 acceptance: "the freshness summary shows a stale badge only for
// stale sources." Every row shape below is a structural test fixture
// (status enum values from api.source_freshness), not a fabricated data
// value presented as real.

describe("FreshnessSummary", () => {
  it("renders nothing when no source is stale", () => {
    const html = renderToStaticMarkup(
      <FreshnessSummary
        rows={[
          { source: "eaglei", status: "no_cycle" },
          { source: "austin_permits", status: "not_loaded" },
          { source: "ercot_spp", status: "fresh" },
        ]}
      />
    );
    expect(html).toBe("");
  });

  it("renders a stale badge when a source is stale", () => {
    const html = renderToStaticMarkup(
      <FreshnessSummary rows={[{ source: "austin_permits", status: "stale" }]} />
    );
    expect(html).toContain("badge--stale");
    expect(html).toContain("austin_permits");
  });

  it("only counts rows whose status is exactly 'stale' (not not_loaded/no_cycle/fresh)", () => {
    const html = renderToStaticMarkup(
      <FreshnessSummary
        rows={[
          { source: "a", status: "not_loaded" },
          { source: "b", status: "no_cycle" },
          { source: "c", status: "fresh" },
          { source: "d", status: "stale" },
        ]}
      />
    );
    expect(html).toContain("badge--stale");
    expect(html).toContain("d is stale");
    expect(html).not.toContain(">a<");
  });

  it("renders an empty array as quiet (no badge)", () => {
    const html = renderToStaticMarkup(<FreshnessSummary rows={[]} />);
    expect(html).toBe("");
  });
});
