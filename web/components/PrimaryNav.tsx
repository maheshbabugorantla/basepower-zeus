"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// M1-W3 fix: nav had "plain underlined links with no active state."
// DESIGN.md §5 Navigation lists Overview, Ranking, a detail page per home,
// Segments and Sources — only routes that exist today (M0-W2's rule,
// carried forward) get a link: Overview, Ranking, Sources. A home detail
// page is reached from Ranking, not from its own top-level nav item, so
// /home/* highlights "Ranking" as its active route.

//
// GTM P0: the nav now follows the order a growth team decides in -- where
// to play (Markets, formerly Overview), which neighborhoods and homes
// (Neighborhoods, formerly Ranking), who gets which message (Audiences),
// where Base is absent but demand is proven (Attack list, formerly
// Coverage gaps), and why to trust it (Proof, formerly Sources). Routes
// are unchanged so existing links keep working.
const ROUTES = [
  { href: "/", label: "Markets" },
  { href: "/ranking", label: "Neighborhoods" },
  { href: "/audiences", label: "Audiences" },
  { href: "/ranking/coverage", label: "Attack list" },
  { href: "/sources", label: "Proof" },
] as const;

function isActive(pathname: string | null, href: string): boolean {
  if (pathname === null) return false;
  if (href === "/") return pathname === "/";
  if (href === "/ranking") {
    if (pathname.startsWith("/ranking/coverage")) return false;
    return pathname === "/ranking" || pathname.startsWith("/home/");
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function PrimaryNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Primary" className="primary-nav">
      {ROUTES.map((route) => {
        const active = isActive(pathname, route.href);
        return (
          <Link
            key={route.href}
            href={route.href}
            aria-current={active ? "page" : undefined}
            className={active ? "primary-nav__link primary-nav__link--active" : "primary-nav__link"}
          >
            {route.label}
          </Link>
        );
      })}
    </nav>
  );
}
