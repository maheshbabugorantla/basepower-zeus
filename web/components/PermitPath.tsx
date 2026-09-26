import type { ReactNode } from "react";
import { MissingState } from "./ui/MissingState";
import { ProvenancePopover } from "./ui/ProvenancePopover";

// M2-P9 (web follow-up): the home page's plain "Permit path" line --
// which battery-permit regime applies to this home, and (for a city
// battery permit) how long that has taken lately -- built from
// core.mv_home_signals.territory_eia_id (this home's utility territory)
// plus api.permit_path_stats (jurisdiction='ALL', label='battery',
// period_type='sb1252', period='after_sb1252', is_base_power=false --
// the latest SB 1252 period, citywide, all installers) and
// api.permit_rules (SB 1252 + the Austin Energy permit requirement, for
// the provenance popover's citation). Texas SB 1252 (effective
// 2025-09-01) bars cities from regulating residential battery/backup
// permits EXCEPT a municipally owned utility (Austin Energy) within its
// own service area -- so an Austin Energy home still needs a city
// Auxiliary Power Electrical Permit, while every other (Oncor-area) city
// in Travis County follows state rules only, per PermitRulesRow below.

export type PermitPathKind = "city_battery_permit" | "state_rules_only" | null;

export interface PermitPathStatsRow {
  medianDays: number | null;
  p90Days: number | null;
  shareNeverFinished: number | null;
  shareIssuedOnline: number | null;
  provenance: {
    dataset: string;
    url: string;
    retrievedAt: string;
    sha256: string;
    runId: string;
    runner: "cron" | "cli";
    rowsIn: number | null;
    rowsLoaded: number | null;
    rawFileHref: string;
  } | null;
}

export interface PermitRulesCitation {
  quote: string;
  sourceUrl: string;
}

export interface PermitPathProps {
  propId: string;
  permitPath: PermitPathKind;
  stats: PermitPathStatsRow | null;
  /** The most relevant permit_rules row for this path (SB 1252's
   * municipal_regulation_barred for state_rules_only, Austin Energy's
   * residential_ess_permit_required for city_battery_permit). */
  ruleCitation: PermitRulesCitation | null;
}

function formatPct(share: number | null): string | null {
  if (share === null) return null;
  return `${(share * 100).toFixed(1)}%`;
}

export function PermitPath({ propId, permitPath, stats, ruleCitation }: PermitPathProps) {
  if (permitPath === null) {
    return (
      <MissingState
        variant="not-loaded"
        reason="No utility territory match for this home yet -- the permit path can't be determined without one"
      />
    );
  }

  if (permitPath === "state_rules_only") {
    const sentence = (
      <span>
        State rules only (Texas SB 1252): no city battery permit required.
      </span>
    );
    if (!ruleCitation) return sentence;
    return (
      <ProvenancePopoverForRule id={`${propId}-permit-path`} quote={ruleCitation.quote} sourceUrl={ruleCitation.sourceUrl}>
        {sentence}
      </ProvenancePopoverForRule>
    );
  }

  // city_battery_permit
  if (!stats || stats.medianDays === null) {
    return (
      <>
        <div>City of Austin (Austin Energy): city battery permit required.</div>
        <MissingState variant="not-loaded" reason="not published -- no recent permit-timeline figure yet" />
      </>
    );
  }

  const inPerson = (stats.shareIssuedOnline ?? 0) < 0.5;
  const neverFinishedPct = formatPct(stats.shareNeverFinished);

  const sentence = (
    <span>
      City of Austin (Austin Energy): city battery permit required — typically{" "}
      <span style={{ fontFamily: "var(--type-data-font-family)", fontWeight: 600 }}>~{stats.medianDays}</span> days
      {stats.p90Days !== null ? (
        <>
          , slowest 10%:{" "}
          <span style={{ fontFamily: "var(--type-data-font-family)", fontWeight: 600 }}>{stats.p90Days}+</span> days
        </>
      ) : null}
      , {inPerson ? "in person" : "online"}
      {neverFinishedPct ? ` (${neverFinishedPct} never finish)` : ""}.
    </span>
  );

  if (!stats.provenance) return sentence;

  return (
    <ProvenancePopover
      id={`${propId}-permit-path`}
      dataset={stats.provenance.dataset}
      url={stats.provenance.url}
      retrievedAt={stats.provenance.retrievedAt}
      sha256={stats.provenance.sha256}
      runId={stats.provenance.runId}
      runner={stats.provenance.runner}
      rowsIn={stats.provenance.rowsIn}
      rowsLoaded={stats.provenance.rowsLoaded}
      rawFileHref={stats.provenance.rawFileHref}
    >
      {sentence}
    </ProvenancePopover>
  );
}

/** For the state_rules_only path there is no permit-timeline figure to
 * attach a full raw-file ProvenancePopover to (there is no city permit
 * process to time) -- the citation is Base's own manifested
 * data/manual/permit_rules.csv quote, shown as a plain sourced link
 * (same reuse pattern web/app/home/[prop_id]/page.tsx already applies to
 * api.retail_market's plain_language/quote). */
function ProvenancePopoverForRule({
  id,
  quote,
  sourceUrl,
  children,
}: {
  id: string;
  quote: string;
  sourceUrl: string;
  children: ReactNode;
}) {
  return (
    <span>
      {children}{" "}
      <a href={sourceUrl} target="_blank" rel="noreferrer" title={quote} id={id} style={{ fontSize: "var(--type-label-font-size)" }}>
        (Texas SB 1252)
      </a>
    </span>
  );
}
