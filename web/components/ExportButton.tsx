"use client";

import type { MouseEvent, FocusEvent } from "react";
import { usePathname, useSearchParams } from "next/navigation";

// Export follows exactly what the ranking view is showing. RankingBoard keeps
// its filters (mode, weights, backup, pre2000, city, zip, bg, tier) in the url
// with window.history.replaceState, which useSearchParams() does not observe,
// so a link built only at render time went stale and exported the whole
// county. The link is rebuilt from the live location on hover, focus and
// click, so the file always matches the filtered view.
function exportHref(target: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete("intro"); // reel control flag, not a filter
  const qs = params.toString();
  return qs ? `${target}?${qs}` : target;
}

export function ExportButton() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  if (pathname?.startsWith("/home/")) return null;

  const isCoverage = pathname?.startsWith("/ranking/coverage") ?? false;
  const target = isCoverage ? "/export/coverage" : "/export/homes";
  const label = isCoverage ? "Export coverage CSV" : "Export ranked homes CSV";

  function syncHref(e: MouseEvent<HTMLAnchorElement> | FocusEvent<HTMLAnchorElement>) {
    e.currentTarget.href = exportHref(target, window.location.search);
  }

  return (
    <a
      href={exportHref(target, searchParams.toString())}
      download
      className="btn btn--secondary"
      data-testid="export-csv-link"
      title="Downloads the homes in the current view with its filters, top 5,000 rows at most"
      onMouseEnter={syncHref}
      onFocus={syncHref}
      onClick={syncHref}
    >
      {label}
    </a>
  );
}
