import { Chip, type SignalName } from "./ui/Chip";

// M3-W1: "each home shows which signals it was scored on" — every
// non-null score term for this home, not just api.homes_ranked_weighted's
// top-3 `reasons`. Purely presentational: callers derive `signals` from
// fields a row already carries (TopHomeRow / core.mv_home_signals /
// api.home_score_breakdown's `available` column) — no new SQL function,
// per this ticket's scope note.

export interface SignalUsedEntry {
  key: string;
  label: string;
  signal: SignalName;
  /** e.g. "same for all Travis homes" for a county/block-group-level signal. */
  scope?: string;
}

export function SignalsUsed({ signals }: { signals: SignalUsedEntry[] }) {
  if (signals.length === 0) {
    return (
      <p style={{ color: "var(--theme-ink-muted)", fontSize: "var(--type-label-font-size)", margin: 0 }}>
        No signals loaded for this home yet.
      </p>
    );
  }

  return (
    <div
      role="list"
      aria-label="Signals this home was scored on"
      style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}
    >
      {signals.map((s) => (
        <span role="listitem" key={s.key}>
          <Chip label={s.label} signal={s.signal} scope={s.scope} />
        </span>
      ))}
    </div>
  );
}
