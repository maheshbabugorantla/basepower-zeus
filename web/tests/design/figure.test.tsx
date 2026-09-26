import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Figure } from "../../components/ui/Figure";

// DESIGN.md §3 "The Unit Rule": every figure carries its unit. The value
// and unit here are test-supplied structural props, never a hard-coded
// example of a real metric.

describe("Figure", () => {
  it("renders the value and its unit", () => {
    const html = renderToStaticMarkup(<Figure value="test-value" unit="widgets" />);
    expect(html).toContain("widgets");
    expect(html).toContain("test-value");
  });

  it("throws at runtime when unit is empty or whitespace-only", () => {
    expect(() => renderToStaticMarkup(<Figure value={1} unit="" />)).toThrow(/unit/i);
    expect(() => renderToStaticMarkup(<Figure value={1} unit="   " />)).toThrow(/unit/i);
  });

  it("requires `unit` at the type level (compile-time check)", () => {
    // @ts-expect-error — unit is a required prop; omitting it must fail typecheck.
    const missingUnit = <Figure value={1} />;
    expect(missingUnit).toBeDefined();
  });
});
