"use client";

import { usePathname, useSearchParams } from "next/navigation";

// M5-W1: "Export CSV" now links to a real streamed CSV instead of the
// disabled M1-W3 placeholder. It reads the CURRENT url's search params
// (client component, so it follows navigation without a full reload) --
// on the coverage screen (/ranking/coverage) it exports coverage zones
// (api.coverage_gaps_bg); anywhere else it exports the ranked-homes list
// for the selected county.
//
// Deviation (reported): only `?county=` is actually on the url today --
// RankingBoard's mode/weights/hide-toggles are React state, never synced
// to the URL (out of this ticket's owns paths -- app/ranking/ is another
// agent's file right now). Every param present on the current url is
// forwarded verbatim to the export route, so once mode/weights DO land
// in the URL this link starts reflecting them for free; until then the
// export uses the route's own defaults (predicted mode, exclude-backup
// on, pre-2000 shown -- see app/export/homes/route.ts's own comment).

export function ExportButton() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const isCoverage = pathname?.startsWith("/ranking/coverage") ?? false;
  const target = isCoverage ? "/export/coverage" : "/export/homes";
  const href = `${target}?${searchParams.toString()}`;
  const label = isCoverage ? "Export coverage CSV" : "Export ranked homes CSV";

  return (
    <a href={href} download className="btn btn--secondary" data-testid="export-csv-link">
      {label}
    </a>
  );
}
