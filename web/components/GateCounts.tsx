import { Panel } from "./ui/Panel";
import { MissingState } from "./ui/MissingState";

// M2-W1: the territory gate funnel (api.gate_counts, 0201_m2.sql — the
// home -> Base-served-territory gate, distinct from M1's parcel-level
// EligibilityFunnel/api.parcel_gate_counts). "One horizontal funnel with
// counts per exclusion reason, not cards" (ticket text) — rendered as a
// single proportional horizontal bar (segments = reasons) plus a legend
// list, so the whole funnel reads at a glance instead of as a grid of
// stat cards (DESIGN.md §6 Don't).
//
// api.gate_counts is fail-open until BOTH core.territories and
// core.utility_crosswalk are loaded: while either is empty, every home's
// reason is 'territories_not_loaded' or 'crosswalk_not_loaded' (an
// unresolved gate, not an exclusion) rather than 'passed' or
// 'territory_not_base_served'. That state is rendered honestly here, not
// hidden behind a plain "0 excluded".

export interface GateCountRow {
  reason: string;
  homeCount: number;
}

const REASON_LABEL: Record<string, string> = {
  passed: "Passed the territory gate",
  territory_not_base_served: "Territory not Base-served",
  territories_not_loaded: "Territories not loaded",
  crosswalk_not_loaded: "Utility crosswalk not loaded",
};

function labelFor(reason: string): string {
  return REASON_LABEL[reason] ?? reason;
}

const NOT_LOADED_REASONS = new Set(["territories_not_loaded", "crosswalk_not_loaded"]);

function segmentClass(reason: string): string {
  if (reason === "passed") return "gate-funnel__segment--passed";
  if (NOT_LOADED_REASONS.has(reason)) return "gate-funnel__segment--not-loaded";
  return "gate-funnel__segment--excluded";
}

export function GateCounts({ rows }: { rows: GateCountRow[] }) {
  const total = rows.reduce((sum, r) => sum + r.homeCount, 0);
  const hasUnresolvedGate = rows.some((r) => NOT_LOADED_REASONS.has(r.reason));

  return (
    <Panel>
      <h2
        style={{
          fontFamily: "var(--type-heading-font-family)",
          fontSize: "var(--type-heading-font-size)",
          fontWeight: "var(--type-heading-font-weight)",
          marginTop: 0,
        }}
      >
        Territory gate
      </h2>

      {rows.length === 0 || total === 0 ? (
        <MissingState
          variant="not-loaded"
          reason="core.mv_home_signals has no rows yet — the M1 home/block-group join hasn't run"
        />
      ) : (
        <>
          <div className="gate-funnel" role="img" aria-label="Territory gate funnel by reason">
            {rows.map((row) => (
              <span
                key={row.reason}
                className={`gate-funnel__segment ${segmentClass(row.reason)}`}
                style={{ width: `${(row.homeCount / total) * 100}%` }}
                title={`${labelFor(row.reason)}: ${row.homeCount.toLocaleString()}`}
              />
            ))}
          </div>

          <ul className="gate-funnel__legend">
            {rows.map((row) => (
              <li key={row.reason} className="gate-funnel__legend-item">
                <span className={`gate-funnel__dot ${segmentClass(row.reason)}`} aria-hidden="true" />
                <span>{labelFor(row.reason)}</span>
                <span style={{ fontFamily: "var(--type-data-font-family)", marginLeft: "auto" }}>
                  {row.homeCount.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>

          {hasUnresolvedGate ? (
            <p style={{ margin: "var(--space-3) 0 0 0", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
              The gate is fail-open until territories and the utility crosswalk both load: every home passes by
              default until then, rather than being wrongly excluded.
            </p>
          ) : null}
        </>
      )}
    </Panel>
  );
}
