import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MissingState } from "../../components/ui/MissingState";

// DESIGN.md "The Missing Is Grey Rule" + M0-W0 acceptance criteria:
// "not loaded" and "not available" render differently and both show a
// reason. No literal example data value is asserted here — only
// structure/text supplied directly as props by this test.

describe("MissingState", () => {
  it("renders the not-loaded variant with its reason", () => {
    const html = renderToStaticMarkup(
      <MissingState variant="not-loaded" reason="EAGLE-I pipeline has not run yet" />
    );
    expect(html).toContain("Not loaded");
    expect(html).toContain("EAGLE-I pipeline has not run yet");
    expect(html).toContain('data-state="not-loaded"');
  });

  it("renders the not-available variant with its reason", () => {
    const html = renderToStaticMarkup(
      <MissingState variant="not-available" reason="Harris County publishes no public permit feed" />
    );
    expect(html).toContain("Not available");
    expect(html).toContain("Harris County publishes no public permit feed");
    expect(html).toContain('data-state="not-available"');
  });

  it("the two variants render visibly different markup", () => {
    const notLoaded = renderToStaticMarkup(
      <MissingState variant="not-loaded" reason="Pipeline has not run yet" />
    );
    const notAvailable = renderToStaticMarkup(
      <MissingState variant="not-available" reason="No public source exists" />
    );
    expect(notLoaded).not.toBe(notAvailable);
    expect(notLoaded).toContain("missing-state--not-loaded");
    expect(notAvailable).toContain("missing-state--not-available");
  });

  it("supports a map-fill hatch class for missing map polygons", () => {
    const html = renderToStaticMarkup(
      <MissingState variant="not-loaded" reason="Pipeline has not run yet" asMapFill />
    );
    expect(html).toContain("hatch-missing");
  });

  it("throws at runtime when reason is empty or whitespace-only", () => {
    expect(() => renderToStaticMarkup(<MissingState variant="not-loaded" reason="" />)).toThrow(
      /reason/i
    );
    expect(() => renderToStaticMarkup(<MissingState variant="not-loaded" reason="   " />)).toThrow(
      /reason/i
    );
  });

  it("requires `reason` at the type level (compile-time check)", () => {
    // @ts-expect-error — reason is a required prop; omitting it must fail typecheck.
    const missingReason = <MissingState variant="not-loaded" />;
    expect(missingReason).toBeDefined();
  });
});
