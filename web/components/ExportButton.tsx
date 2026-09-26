"use client";

import { usePathname, useSearchParams } from "next/navigation";

// M5-W1: "Export CSV" now links to a real streamed CSV instead of the
// disabled M1-W3 placeholder. It reads the CURRENT url's search params
// (client component, so it follows navigation without a full reload) --
// on the coverage screen (/ranking/coverage) it exports coverage zones
// (api.coverage_gaps_bg); anywhere else it exports the ranked-homes list
// for the selected county.
//
// M-urlstate (item 4): RankingBoard now syncs mode/weights/backup/pre2000/
// city/zip/bg into the url (window.history.replaceState), so every param
// present on the current url -- forwarded here verbatim -- reflects
// exactly what's on screen; see app/export/homes/route.ts's own comment
// for the full param contract.

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
