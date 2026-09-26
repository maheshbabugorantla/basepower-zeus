"use client";

import { useState } from "react";

// The interactive half of the provenance popover's SHA-256 row: copies the
// full (untruncated) hash to the clipboard. Isolated in its own "use
// client" island so ProvenancePopover.tsx itself can stay a plain server
// component wherever a page doesn't otherwise need client interactivity.

export function CopyShaButton({ sha256 }: { sha256: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="provenance-popover__copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(sha256);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard access can be denied by the browser; the full hash
          // is still visible in the DOM (title attribute) as a fallback.
        }
      }}
    >
      {copied ? "Copied" : "Copy full"}
    </button>
  );
}
