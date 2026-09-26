import type { ReactNode } from "react";
// M0-W0: the one import this ticket is allowed to add here (per M0-W0's
// ticket instructions) — without it, `next build` never compiles
// globals.css/styles/tokens.css, so a broken @import or syntax error in
// the design system would surface only when M0-W2 rebuilds this file.
import "./globals.css";
import { query } from "../lib/db";
import { TopBar } from "../components/TopBar";
import type { SourceFreshnessRow } from "../components/FreshnessSummary";
import { getCountiesWithScoredHomes } from "../lib/counties.server";

// M0-W2: the real app shell. M1-W3 fix #3: DESIGN.md §1 "Zeus is light by
// default, with a dark theme for long desk sessions" — pages were instead
// following the OS/browser dark preference. `data-theme="light"` is
// server-rendered on <html> so the very first paint (and every headless
// screenshot) is light regardless of OS setting; the inline script below
// runs before hydration/paint and flips to "dark" only if the visitor
// explicitly chose it before (localStorage, read with try/catch so a
// blocked/absent storage never breaks the page). suppressHydrationWarning
// is required because this script can change the attribute React itself
// set during SSR before React hydrates.

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Base Power Zeus",
};

const THEME_INIT_SCRIPT = `
(function () {
  try {
    var stored = window.localStorage.getItem("zeus-theme");
    if (stored === "dark") {
      document.documentElement.setAttribute("data-theme", "dark");
    }
  } catch (e) {
    // Storage unavailable (private window, blocked site data, etc.) —
    // the server-rendered "light" default stands, per DESIGN.md.
  }
})();
`;

async function getFreshness(): Promise<SourceFreshnessRow[]> {
  try {
    return await query<SourceFreshnessRow>(
      "select source, status from api.source_freshness"
    );
  } catch (err) {
    // Real-data rule: an unreachable/unconfigured database is not a
    // fabricated freshness state — it just means the shell has nothing to
    // report yet, so the summary stays quiet rather than the whole app
    // shell failing to render.
    console.error("layout: failed to load api.source_freshness", err);
    return [];
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [freshness, counties] = await Promise.all([getFreshness(), getCountiesWithScoredHomes()]);

  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        {/* eslint-disable-next-line react/no-danger */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <TopBar freshness={freshness} counties={counties} />
        <main
          id="main"
          tabIndex={-1}
          style={{
            padding: "var(--space-6)",
          }}
        >
          {children}
        </main>
      </body>
    </html>
  );
}
