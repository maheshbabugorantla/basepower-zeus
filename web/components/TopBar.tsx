"use client";

import { Suspense } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { PrimaryNav } from "./PrimaryNav";
import { ExportButton } from "./ExportButton";
import { ThemeToggle } from "./ThemeToggle";
import { FreshnessSummary, type SourceFreshnessRow } from "./FreshnessSummary";
import type { CountyOption } from "../lib/counties";

// DESIGN.md §5 Navigation: "The top bar holds the wordmark, the county
// switcher (Travis, Harris), the freshness summary (quiet unless something
// is stale) and Export" — matches the mockup's single header row
// (Main.dc.html), which is why the primary nav now lives here rather than
// in its own bar under the header (M1-W3 fix #4/#5: "nav is plain
// underlined links with no active state").
//
// M3-W1: data-driven county switcher. `counties` is the real list of
// counties that have at least one scored home right now
// (lib/counties.ts's getCountiesWithScoredHomes(), read once server-side
// in app/layout.tsx) — never a fixed Travis/Harris pair. The active
// county is read from the `?county=` search param on the CURRENT page
// (client component, so it can follow navigation without a full reload);
// each button links to the same pathname with that param set, so
// Overview/Ranking/Coverage all follow the same control per DESIGN.md.

function CountySwitcherInner({ counties }: { counties: CountyOption[] }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // T4 fix: /home/[prop_id] has no ?county= concept at all -- that page
  // is keyed by prop_id, and a home's county comes from ITS OWN record,
  // never the search params. The switcher used to rewrite ?county= on
  // the current /home/W... url, which changed nothing about which
  // property showed (still the same Travis home) while ExportButton (it
  // DOES read ?county=) started building a Williamson export link --
  // "changed export geography but kept the Travis property." On a home
  // page the switcher instead navigates AWAY to that county's own lead
  // list, and never claims a home page is "in" any county.
  const onHomeDetail = pathname?.startsWith("/home/") ?? false;
  const activeFips = onHomeDetail ? null : searchParams.get("county") ?? counties[0]?.fips ?? "48453";

  return (
    <div role="group" aria-label="County" className="county-switcher">
      <span className="county-switcher__label">{onHomeDetail ? "Go to county" : "County"}</span>
      {counties.map((county) => {
        let href: string;
        if (onHomeDetail) {
          href = `/ranking?county=${county.fips}`;
        } else {
          const params = new URLSearchParams(searchParams.toString());
          params.set("county", county.fips);
          // M-urlstate (item 4): a different county may not even contain
          // the previously-selected city/ZIP/block group (or the
          // weighted-mode filters that go with them), so switching
          // counties clears the drill-down state rather than carrying
          // stale filters over.
          params.delete("city");
          params.delete("zip");
          params.delete("bg");
          href = `${pathname}?${params.toString()}`;
        }
        const isActive = county.fips === activeFips;
        return (
          <Link
            key={county.fips}
            href={href}
            aria-pressed={isActive}
            className={
              "county-switcher__button" + (isActive ? " county-switcher__button--active" : "")
            }
          >
            {county.name}
          </Link>
        );
      })}
    </div>
  );
}

export function TopBar({
  freshness,
  counties,
}: {
  freshness: SourceFreshnessRow[];
  counties: CountyOption[];
}) {
  return (
    <header className="top-bar">
      <div className="top-bar__brand">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--theme-brand-accent-text)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
        </svg>
        <span className="top-bar__wordmark">Base Power Zeus</span>
      </div>

      <PrimaryNav />

      <div className="top-bar__spacer" />

      <Suspense fallback={null}>
        <CountySwitcherInner counties={counties} />
      </Suspense>

      <FreshnessSummary rows={freshness} />
      <ThemeToggle />
      {/* M5-W1: ExportButton calls useSearchParams() (it needs the
          current url's params to build the export link), so it needs
          the same Suspense boundary CountySwitcherInner already has --
          without it, `next build` fails to statically bail out this
          page. */}
      <Suspense fallback={null}>
        <ExportButton />
      </Suspense>
    </header>
  );
}
