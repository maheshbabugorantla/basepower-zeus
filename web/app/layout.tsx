import type { ReactNode } from "react";
import Link from "next/link";
// M0-W0: the one import this ticket is allowed to add here (per M0-W0's
// ticket instructions) — without it, `next build` never compiles
// globals.css/styles/tokens.css, so a broken @import or syntax error in
// the design system would surface only when M0-W2 rebuilds this file.
import "./globals.css";
import { query } from "../lib/db";
import { TopBar } from "../components/TopBar";
import type { SourceFreshnessRow } from "../components/FreshnessSummary";

// M0-W2: the real app shell. DESIGN.md §5 Navigation: "Routes are
// Overview, Ranking, a detail page per home, Segments and Sources" — but
// this milestone (M0) only has Overview and Sources built, so nav shows
// only those two ("Navigation shows only routes that exist"). The
// freshness summary in TopBar is fed from api.source_freshness here, at
// request time, so every page shares one real (never fabricated) view of
// source staleness.

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Base Power Zeus",
};

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
  const freshness = await getFreshness();

  return (
    <html lang="en">
      <body>
        <TopBar freshness={freshness} />
        <nav
          aria-label="Primary"
          style={{
            display: "flex",
            gap: "var(--space-4)",
            padding: "var(--space-3) var(--space-6)",
            backgroundColor: "var(--theme-canvas)",
            borderBottom: "1px solid var(--theme-divider)",
            fontFamily: "var(--type-label-font-family)",
            fontSize: "var(--type-label-font-size)",
          }}
        >
          <Link href="/">Overview</Link>
          <Link href="/sources">Sources</Link>
        </nav>
        <main
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
