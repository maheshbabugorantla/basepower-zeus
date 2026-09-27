import type { ReactNode } from "react";
import { MissingState } from "./ui/MissingState";
import { ProvenancePopover } from "./ui/ProvenancePopover";
import type {
  CountyOutageContext,
  DistributorReliabilityRow,
  OutageSourceProvenance,
} from "./OutageSummary";

// Overview (Mock C): outage exposure as compact bar rows -- label | bar |
// value -- one row per distributor, grouped under its county, sorted by
// minutes descending, not-reported distributors last on the hatch track
// with the reason written out. Replaces the figure-in-sentence stack on
// the Overview only (OutageSummary keeps its sentence form for any other
// caller). Every value comes from core.utility_reliability /
// api.county_outage via app/page.tsx; nothing here is a literal figure.

function Prov({ id, source, children }: { id: string; source: OutageSourceProvenance | null; children: ReactNode }) {
  if (!source) return <>{children}</>;
  return (
    <ProvenancePopover
      id={id}
      dataset={source.dataset}
      url={source.url}
      retrievedAt={source.retrievedAt}
      sha256={source.sha256}
      runId={source.runId}
      runner={source.runner}
      rowsIn={source.rowsIn}
      rowsLoaded={source.rowsLoaded}
      rawFileHref={source.rawFileHref}
    >
      {children}
    </ProvenancePopover>
  );
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function groupByCounty(rows: DistributorReliabilityRow[]): [string, DistributorReliabilityRow[]][] {
  const byCounty = new Map<string, DistributorReliabilityRow[]>();
  for (const row of rows) {
    if (!byCounty.has(row.county)) byCounty.set(row.county, []);
    const list = byCounty.get(row.county)!;
    // one row per distributor within a county, never repeated
    if (!list.some((r) => r.baseName === row.baseName)) list.push(row);
  }
  for (const list of byCounty.values()) {
    list.sort((a, b) => {
      if (a.saidiInclMajor === null && b.saidiInclMajor === null) return a.baseName.localeCompare(b.baseName);
      if (a.saidiInclMajor === null) return 1;
      if (b.saidiInclMajor === null) return -1;
      return b.saidiInclMajor - a.saidiInclMajor;
    });
  }
  return Array.from(byCounty.entries());
}

export interface OutageBarsProps {
  distributors: DistributorReliabilityRow[];
  countyContexts: CountyOutageContext[];
  /** the reporting year most rows carry (a row from another year says so) */
  year: number;
}

export function OutageBars({ distributors, countyContexts, year }: OutageBarsProps) {
  const groups = groupByCounty(distributors);
  const max = Math.max(1, ...distributors.map((d) => d.saidiInclMajor ?? 0));
  const contextByCounty = new Map(countyContexts.map((c) => [c.countyName, c]));

  return (
    <div className="outage-bars">
      {groups.map(([county, rows]) => {
        const ctx = contextByCounty.get(county) ?? null;
        return (
          <div className="outage-bars__county" key={county}>
            <div className="outage-bars__county-name">{county} County</div>
            {rows.map((r) => (
              <div className="outage-bars__row" key={`${county}-${r.baseName}`}>
                <span className="outage-bars__label" title={r.baseName}>
                  {r.baseName}
                </span>
                {r.saidiInclMajor === null ? (
                  <MissingState
                    className="outage-bars__missing"
                    variant="not-available"
                    reason="Not reported to EIA-861"
                    asMapFill
                  />
                ) : (
                  <>
                    <span className="outage-bars__track" aria-hidden="true">
                      <span className="outage-bars__fill" style={{ width: `${(r.saidiInclMajor / max) * 100}%` }} />
                    </span>
                    <span className="outage-bars__value">
                      <Prov id={`ov-saidi-${slug(county)}-${slug(r.baseName)}`} source={r.source}>
                        {Math.round(r.saidiInclMajor).toLocaleString()}
                        {r.year !== null && r.year !== year ? <span className="outage-bars__year"> {r.year}</span> : null}
                      </Prov>
                    </span>
                  </>
                )}
              </div>
            ))}
            <div className="outage-bars__context">
              County context (EAGLE-I):{" "}
              {ctx === null ? (
                <MissingState className="missing-state--inline" variant="not-loaded" reason="EAGLE-I county row not loaded yet" />
              ) : ctx.hoursPerCustomer === null ? (
                <MissingState
                  className="missing-state--inline"
                  variant="not-loaded"
                  reason={ctx.hoursPerCustomerNullReason ?? "Not loaded"}
                />
              ) : (
                <Prov id={`ov-eaglei-${slug(county)}`} source={ctx.source}>
                  ≈{ctx.hoursPerCustomer.toFixed(1)} h without power per customer in {ctx.year}
                </Prov>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
