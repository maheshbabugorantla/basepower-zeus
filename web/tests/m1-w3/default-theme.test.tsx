import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RootLayout from "../../app/layout";

// M1-W3 acceptance: "Light theme by default with a working toggle."
// DESIGN.md §1: "Zeus is light by default" — the app must not silently
// follow the OS/browser dark preference. Renders the real RootLayout
// (async server component) and checks the actual server-rendered <html>
// markup rather than asserting against a hand-written string, so a
// regression to `<html>` (no explicit theme, following the OS again)
// would fail this test.

describe("RootLayout — default theme", () => {
  it('server-renders <html data-theme="light"> regardless of OS/browser preference', async () => {
    const jsx = await RootLayout({ children: <div>child</div> });
    const html = renderToStaticMarkup(jsx);

    expect(html).toMatch(/^<html[^>]*data-theme="light"/);
    // Never `color-scheme: light dark` on the root element inline (that
    // would let native controls auto-flip on a dark OS even though the
    // app chrome stayed light) — the actual color-scheme rule lives in
    // globals.css, scoped to the explicit data-theme attribute.
    expect(html).not.toContain('data-theme="dark"');
  });

  it("includes an inline pre-hydration script that only ever opts INTO dark, never away from the light default", async () => {
    const jsx = await RootLayout({ children: <div>child</div> });
    const html = renderToStaticMarkup(jsx);

    // The inline script is the only thing allowed to change the
    // server-rendered light default before paint, and it must gate that
    // change on an explicit prior user choice (localStorage), not on
    // matchMedia/prefers-color-scheme.
    expect(html).toContain("zeus-theme");
    expect(html).not.toContain("prefers-color-scheme");
    expect(html).not.toContain("matchMedia");
  });
});
