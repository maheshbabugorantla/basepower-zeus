import { Panel } from "./ui/Panel";
import { MissingState } from "./ui/MissingState";

// M2-W1: "Can Base serve this home?" (api.gate_counts, 0201_m2.sql — the
// home -> Base-served-utility check, distinct from M1's parcel-level
// EligibilityFunnel/api.parcel_gate_counts). "One horizontal funnel with
// counts per exclusion reason, not cards" (ticket text) — rendered as a
// single proportional horizontal bar (segments = reasons) plus a legend
// list, so the whole funnel reads at a glance instead of as a grid of
// stat cards (DESIGN.md §6 Don't).
//
// User feedback: "It is not clear what the 'territory gate' means" — this
// panel (and every other user-visible spot, per its ticket) now avoids
// "gate"/"territory gate" jargon entirely: Base only sells where a home's
// electric utility is on Base's own served-utilities list, and that's the
// plain-language frame every label below uses.
//
// api.gate_counts is fail-open until BOTH core.territories and
// core.utility_crosswalk are loaded: while either is empty, every home's
// reason is 'territories_not_loaded' or 'crosswalk_not_loaded' (an
// unresolved check, not an exclusion) rather than 'passed' or
// 'territory_not_base_served'. That state is rendered honestly here, not
// hidden behind a plain "0 excluded".

export interface GateCountRow {
  reason: string;
  homeCount: number;
}

const REASON_LABEL: Record<string, string> = {
  passed: "In a utility Base serves",
  territory_not_base_served: "In a utility Base doesn't serve",
  territories_not_loaded: "Utility service areas not loaded yet",
  crosswalk_not_loaded: "Base's served-utilities list not loaded yet",
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
        Can Base serve this home?
      </h2>
      <p style={{ margin: "0 0 var(--space-2) 0", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
        Base only sells where the home&rsquo;s electric utility is on Base&rsquo;s service list.
      </p>

      {rows.length === 0 || total === 0 ? (
        <MissingState
          variant="not-loaded"
          reason="Home locations aren't loaded yet"
        />
      ) : (
        <>
          <div className="gate-funnel" role="img" aria-label="Home count by whether Base serves the utility">
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
              This check is fail-open until utility service areas and Base&rsquo;s served-utilities list both load:
              every home counts as in a utility Base serves until then, rather than being wrongly excluded.
            </p>
          ) : null}
          <p style={{ margin: "var(--space-2) 0 0 0", fontSize: "var(--type-label-font-size)", color: "var(--theme-ink-muted)" }}>
            Source: Base&rsquo;s basepowercompany.com/pricing.md snapshot (served utility names) matched against
            HIFLD electric retail service territories and the City of Austin&rsquo;s official Austin Energy service
            area.
          </p>
        </>
      )}
    </Panel>
  );
}
