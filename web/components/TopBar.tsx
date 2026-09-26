import { PrimaryNav } from "./PrimaryNav";
import { ExportButton } from "./ExportButton";
import { ThemeToggle } from "./ThemeToggle";
import { FreshnessSummary, type SourceFreshnessRow } from "./FreshnessSummary";

// DESIGN.md §5 Navigation: "The top bar holds the wordmark, the county
// switcher (Travis, Harris), the freshness summary (quiet unless something
// is stale) and Export" — matches the mockup's single header row
// (Main.dc.html), which is why the primary nav now lives here rather than
// in its own bar under the header (M1-W3 fix #4/#5: "nav is plain
// underlined links with no active state").
//
// Only Travis has any loaded parcel/geometry data through M1 (Harris lands
// in a later milestone), so the county control is a real, focusable
// segmented group with exactly one enabled, pressed option — not a
// disabled/fake control, and not a raw <select> (M1-W3 fix #5).

export function TopBar({ freshness }: { freshness: SourceFreshnessRow[] }) {
  return (
    <header className="top-bar">
      <div className="top-bar__brand">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--theme-brand-accent-text)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
        </svg>
        <span className="top-bar__wordmark">Base Power Zeus</span>
      </div>

      <PrimaryNav />

      <div className="top-bar__spacer" />

      <div role="group" aria-label="County" className="county-switcher">
        <button type="button" aria-pressed="true" className="county-switcher__button">
          Travis
        </button>
      </div>

      <FreshnessSummary rows={freshness} />
      <ThemeToggle />
      <ExportButton />
    </header>
  );
}
