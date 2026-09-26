"use client";

// M1-W3 fix: "Export is a disabled grey button with no explanation." A
// truly `disabled` button never fires hover/focus events reliably in every
// browser, and its `title` attribute is easy to miss — this ticket's
// acceptance criterion is an *explanatory* Export control, so the button
// stays focusable (aria-disabled, not disabled) and its click is a no-op,
// with the explanation visible on hover/focus via a small text tooltip
// rather than relying only on `title`.

export function ExportButton() {
  return (
    <span className="export-button-wrap">
      <button
        type="button"
        className="btn btn--secondary"
        aria-disabled="true"
        aria-describedby="export-explanation"
        onClick={(event) => event.preventDefault()}
      >
        Export CSV
      </button>
      <span id="export-explanation" role="tooltip" className="export-button-tooltip">
        CSV export ships in milestone M5
      </span>
    </span>
  );
}
