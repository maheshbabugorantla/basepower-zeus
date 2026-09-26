"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// M1-W3 fix: nav had "plain underlined links with no active state."
// DESIGN.md §5 Navigation lists Overview, Ranking, a detail page per home,
// Segments and Sources — only routes that exist today (M0-W2's rule,
// carried forward) get a link: Overview, Ranking, Sources. A home detail
// page is reached from Ranking, not from its own top-level nav item, so
// /home/* highlights "Ranking" as its active route.

const ROUTES = [
  { href: "/", label: "Overview" },
  { href: "/ranking", label: "Ranking" },
  { href: "/sources", label: "Sources" },
] as const;

function isActive(pathname: string | null, href: string): boolean {
  if (pathname === null) return false;
  if (href === "/") return pathname === "/";
  if (href === "/ranking") return pathname === "/ranking" || pathname.startsWith("/home/");
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
