import { Button } from "./ui/Button";
import { FreshnessSummary, type SourceFreshnessRow } from "./FreshnessSummary";

// DESIGN.md §5 Navigation: "The top bar holds the wordmark, the county
// switcher (Travis, Harris), the freshness summary (quiet unless something
// is stale) and Export." Only Travis exists through M3, so the switcher
// has exactly one real option — it is still a real, focusable <select>
// (not a disabled control) so keyboard navigation reaches it, per this
// ticket's acceptance criterion. Export ships in M5, so its button is
// disabled with a tooltip saying so; DESIGN.md's Button already renders
// the disabled state (ink-disabled on surface-sunken).

export function TopBar({ freshness }: { freshness: SourceFreshnessRow[] }) {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--space-4)",
        padding: "var(--space-3) var(--space-6)",
        backgroundColor: "var(--theme-surface)",
        borderBottom: "1px solid var(--theme-divider)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-6)",
        }}
      >
        <span
          style={{
            fontFamily: "var(--type-heading-font-family)",
            fontSize: "var(--type-heading-font-size)",
            fontWeight: "var(--type-heading-font-weight)",
            color: "var(--theme-ink)",
          }}
        >
          Base Power Zeus
        </span>

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            fontFamily: "var(--type-label-font-family)",
            fontSize: "var(--type-label-font-size)",
            color: "var(--theme-ink-muted)",
          }}
        >
          County
          <select
            aria-label="County"
            defaultValue="travis"
            style={{
              height: "36px",
              borderRadius: "var(--rounded-sm)",
              border: "1px solid var(--color-control-border)",
              backgroundColor: "var(--theme-surface)",
              color: "var(--theme-ink)",
              padding: "0 var(--space-2)",
              fontFamily: "var(--type-label-font-family)",
              fontSize: "var(--type-label-font-size)",
            }}
          >
            <option value="travis">Travis</option>
          </select>
        </label>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-4)",
        }}
      >
        <FreshnessSummary rows={freshness} />
        <Button variant="secondary" disabled title="Available in M5">
          Export
        </Button>
      </div>
    </header>
  );
}
